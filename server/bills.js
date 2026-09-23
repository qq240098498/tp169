const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const time = require('./time');
const { findCustomer } = require('./customers');

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
}

// 账单里的分区判断：拿收件城市跟各分区登记的城市直接比
function zoneOf(data, city) {
  const target = cleanCity(city);
  const matched = data.zones.find((zone) => (zone.cities || []).some((item) => cleanCity(item) === target));
  return matched || data.zones[0] || null;
}

// 账期：按运单创建时刻在本地时区（北京时间）下的年月，不用 UTC 月份
function periodOf(waybill) {
  return time.periodOf(waybill);
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && time.inPeriod(waybill, period));
}

// 账期核对信息：账期边界（北京时间起止）+ 这批运单的条数与实际最早/最晚创建时刻
function periodCheck(period, waybills) {
  const range = time.periodRange(period);
  const ordered = waybills
    .map((waybill) => ({ raw: waybill.createdAt, date: time.parseCreatedAt(waybill.createdAt) }))
    .filter((item) => item.date)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  return {
    period: range.period,
    zone: range.zone,
    startAt: range.startAt,
    endAt: range.endAt,
    startAtText: range.startAtBjText,
    endAtText: range.endAtBjText,
    waybillCount: waybills.length,
    firstCreatedAt: ordered.length ? ordered[0].raw : '',
    lastCreatedAt: ordered.length ? ordered[ordered.length - 1].raw : '',
  };
}

// 出账计费：同一账期同一客户的运单合起来算一次首重续重，再按各自的计费重量分摊
function priceBill(data, customer, waybills) {
  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  if (waybills.length === 0) return { lines: [], amountYuan: 0, permille };
  const zone = zoneOf(data, waybills[0].toCity);
  const weights = waybills.map((waybill) => pricing.billableWeightKg(waybill, settings));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const freightAll = pricing.freightYuan(zone, totalWeight, settings);
  const surchargeAll = waybills.reduce((sum, waybill, index) => (
    sum + pricing.surchargeYuan(zone, waybill, weights[index], settings)
  ), 0);
  const grossAll = freightAll + surchargeAll;
  const amountYuan = grossAll * permille / 1000;
  const lines = waybills.map((waybill, index) => {
    const weight = weights[index];
    const share = totalWeight > 0 ? weight / totalWeight : 0;
    const raw = (freightAll * share + pricing.surchargeYuan(zone, waybill, weight, settings)) * permille / 1000;
    const cached = Number(waybill.quoteCacheYuan);
    const amount = cached > 0 ? cached : pricing.roundFen(raw);
    return {
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      zoneName: zone ? zone.name : '',
      billableKg: weight,
      amountYuan: amount,
      fromCache: cached > 0,
    };
  });
  return { lines, amountYuan, permille };
}

function summarizeBill(bill, data) {
  const customer = findCustomer(data, bill.customerId);
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  const lineSum = lines.reduce((sum, line) => sum + Number(line.amountYuan || 0), 0);
  const waybills = (bill.waybillIds || [])
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  // 已出账账单按当时挂进账单的运单核对；账期边界始终按口径重算
  const check = periodCheck(bill.period, waybills);
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    periodStartAt: bill.periodStartAt || check.startAt,
    periodEndAt: bill.periodEndAt || check.endAt,
    periodStartAtText: check.startAtText,
    periodEndAtText: check.endAtText,
    periodZone: check.zone,
    firstCreatedAt: check.firstCreatedAt,
    lastCreatedAt: check.lastCreatedAt,
    lines: lines.map((line) => Object.assign({}, line, {
      amountText: Number(line.amountYuan || 0).toFixed(2),
      billableText: Number(line.billableKg).toFixed(2) + ' kg',
    })),
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      weightKg: Number(waybill.weightKg),
      createdAt: waybill.createdAt,
      period: periodOf(waybill),
      quoteCacheYuan: waybill.quoteCacheYuan,
    })),
  });
}

function listBills(query) {
  const data = load();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  let bills = data.bills.map((bill) => summarizeBill(bill, data));
  if (customerId) bills = bills.filter((bill) => bill.customerId === customerId);
  if (status) bills = bills.filter((bill) => bill.status === status);
  bills.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.code).localeCompare(String(a.code)));
  return {
    bills,
    total: bills.length,
    issued: bills.filter((bill) => bill.status === '已出账').length,
    voided: bills.filter((bill) => bill.status === '已作废').length,
  };
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) || null;
}

function getBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  return summarizeBill(bill, data);
}

function previewBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!time.isValidPeriod(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  const priced = priceBill(data, customer, targets);
  const range = time.periodRange(period);
  return {
    period,
    customerId,
    customerName: customer.name,
    customerCode: customer.code,
    zone: range.zone,
    periodStartAt: range.startAt,
    periodEndAt: range.endAt,
    periodStartAtText: range.startAtBjText,
    periodEndAtText: range.endAtBjText,
    waybillCount: targets.length,
    firstCreatedAt: periodCheck(period, targets).firstCreatedAt,
    lastCreatedAt: periodCheck(period, targets).lastCreatedAt,
    amountYuan: priced.amountYuan,
    amountText: Number(priced.amountYuan || 0).toFixed(2),
    waybillCodes: targets.map((waybill) => waybill.code),
  };
}

function generateBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!time.isValidPeriod(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户没有可以出账的运单', { field: 'period' });
  const priced = priceBill(data, customer, targets);
  const check = periodCheck(period, targets);
  const samePeriod = data.bills.filter((bill) => bill.period === period && bill.customerId === customerId).length;
  const bill = {
    id: nextId('bill', data.bills),
    code: 'ZD' + period.replace('-', '') + '-' + customer.code + String(samePeriod + 1).padStart(2, '0'),
    period,
    customerId,
    status: '已出账',
    createdAt: new Date().toISOString(),
    waybillIds: targets.map((waybill) => waybill.id),
    lines: priced.lines,
    amountYuan: priced.amountYuan,
    discountPermille: priced.permille,
    periodZone: check.zone,
    periodStartAt: check.startAt,
    periodEndAt: check.endAt,
    periodWaybillCount: check.waybillCount,
    firstCreatedAt: check.firstCreatedAt,
    lastCreatedAt: check.lastCreatedAt,
  };
  data.bills.push(bill);
  targets.forEach((waybill) => {
    waybill.billId = bill.id;
  });
  save(data);
  return summarizeBill(bill, load());
}

function voidBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  if (bill.status === '已作废') throw badRequest('BILL_ALREADY_VOID', '这张账单已经作废了');
  bill.status = '已作废';
  bill.voidedAt = new Date().toISOString();
  save(data);
  return summarizeBill(bill, load());
}

function listPeriods() {
  const data = load();
  const map = new Map();
  data.waybills.forEach((waybill) => {
    const period = periodOf(waybill);
    if (!period) return;
    if (!map.has(period)) map.set(period, []);
    map.get(period).push(waybill);
  });
  data.bills.forEach((bill) => {
    if (!time.isValidPeriod(bill.period)) return;
    if (!map.has(bill.period)) map.set(bill.period, []);
  });
  const items = Array.from(map.keys()).sort().map((period) => {
    const check = periodCheck(period, map.get(period) || []);
    return {
      period,
      zone: check.zone,
      startAt: check.startAt,
      endAt: check.endAt,
      startAtText: check.startAtText,
      endAtText: check.endAtText,
      waybillCount: check.waybillCount,
      firstCreatedAt: check.firstCreatedAt,
      lastCreatedAt: check.lastCreatedAt,
    };
  });
  return { periods: items.map((item) => item.period), items };
}

module.exports = {
  listBills,
  getBill,
  previewBill,
  generateBill,
  voidBill,
  listPeriods,
  periodOf,
  periodCheck,
  priceBill,
  zoneOf,
};
