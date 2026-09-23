const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const { findCustomer } = require('./customers');
const periodUtil = require('./period');

// 账期口径：按运单创建时刻的北京时间（UTC+8）年月归属，月初凌晨的运单仍然算当月
const periodOf = periodUtil.periodOf;

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
}

// 账单里的分区判断：拿收件城市跟各分区登记的城市直接比
function zoneOf(data, city) {
  const target = cleanCity(city);
  const matched = data.zones.find((zone) => (zone.cities || []).some((item) => cleanCity(item) === target));
  return matched || data.zones[0] || null;
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 出账前核对信息：该账期的起止时刻、候选运单条数与最早/最晚创建时刻
function periodCheck(data, period, customerId) {
  const bounds = periodUtil.periodBounds(period);
  const scope = customerId
    ? data.waybills.filter((waybill) => waybill.customerId === customerId)
    : data.waybills;
  const inPeriod = scope.filter((waybill) => periodOf(waybill) === period);
  const range = periodUtil.waybillRange(inPeriod);
  return {
    period,
    periodStartAt: bounds.startAt,
    periodEndAt: bounds.endAt,
    periodStartText: periodUtil.localText(bounds.startAt),
    periodEndText: periodUtil.localText(new Date(new Date(bounds.endAt).getTime() - 1000).toISOString()),
    waybillCount: inPeriod.length,
    firstWaybillAt: range.firstAt,
    lastWaybillAt: range.lastAt,
    firstWaybillText: periodUtil.localText(range.firstAt),
    lastWaybillText: periodUtil.localText(range.lastAt),
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
  const bounds = periodUtil.periodBounds(bill.period) || { startAt: '', endAt: '' };
  const range = periodUtil.waybillRange(waybills);
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    // 账期起止（北京时间）与本张账单实际运单的最早/最晚创建时刻，放一起核对边界运单
    periodStartAt: bounds.startAt,
    periodEndAt: bounds.endAt,
    periodStartText: periodUtil.localText(bounds.startAt),
    periodEndText: bounds.endAt
      ? periodUtil.localText(new Date(new Date(bounds.endAt).getTime() - 1000).toISOString())
      : '',
    firstWaybillAt: range.firstAt,
    lastWaybillAt: range.lastAt,
    firstWaybillText: periodUtil.localText(range.firstAt),
    lastWaybillText: periodUtil.localText(range.lastAt),
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
      createdAtText: periodUtil.localText(waybill.createdAt),
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
  if (!periodUtil.isValidPeriod(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const check = periodCheck(data, period, customerId);
  return {
    customer: { id: customer.id, code: customer.code, name: customer.name, settle: customer.settle },
    check,
    canGenerate: check.waybillCount > 0,
    message: check.waybillCount > 0
      ? '账期 ' + period + ' 内客户「' + customer.name + '」有 ' + check.waybillCount + ' 条运单，可以出账'
      : '账期 ' + period + ' 内客户「' + customer.name + '」没有可以出账的运单',
  };
}

function generateBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!periodUtil.isValidPeriod(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户没有可以出账的运单', { field: 'period' });
  const priced = priceBill(data, customer, targets);
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
  };
  data.bills.push(bill);
  targets.forEach((waybill) => {
    waybill.billId = bill.id;
  });
  save(data);
  const summary = summarizeBill(bill, load());
  // 把这次出账实际覆盖的条数与最早/最晚时刻一起带回去，出账成功后也能跟账期起止对一遍
  summary.check = periodCheck(load(), period, customerId);
  return summary;
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

// 账期清单：每个账期给出北京时间起止时刻，以及落在该账期的运单条数和最早/最晚创建时刻
function listPeriods() {
  const data = load();
  const grouped = new Map();
  data.waybills.forEach((waybill) => {
    const period = periodOf(waybill);
    if (!period) return;
    if (!grouped.has(period)) grouped.set(period, []);
    grouped.get(period).push(waybill);
  });
  data.bills.forEach((bill) => {
    if (!periodUtil.isValidPeriod(bill.period)) return;
    if (!grouped.has(bill.period)) grouped.set(bill.period, []);
  });
  const periods = Array.from(grouped.keys()).sort().map((period) => {
    const waybills = grouped.get(period);
    const bounds = periodUtil.periodBounds(period);
    const range = periodUtil.waybillRange(waybills);
    return {
      period,
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      startText: periodUtil.localText(bounds.startAt),
      endText: periodUtil.localText(new Date(new Date(bounds.endAt).getTime() - 1000).toISOString()),
      waybillCount: waybills.length,
      firstWaybillAt: range.firstAt,
      lastWaybillAt: range.lastAt,
      firstWaybillText: periodUtil.localText(range.firstAt),
      lastWaybillText: periodUtil.localText(range.lastAt),
    };
  });
  return { periods };
}

module.exports = {
  listBills, getBill, generateBill, previewBill, voidBill, listPeriods,
  periodOf, periodCheck, candidateWaybills, priceBill, zoneOf,
};
