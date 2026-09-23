// 账期时间口径：一律按本地时间（北京时间 UTC+8）的年月归属。
// 运单创建时刻在数据里带时区偏移（例如 2026-09-01T02:30:00+08:00），
// 不能拿 UTC 的月份，否则月初凌晨那几个小时会被算到上一个月。
const ZONE_OFFSET_MINUTES = 8 * 60;
const ZONE_LABEL = '北京时间（UTC+8）';

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 把各种写法解析成 Date；页面填的「2026-09-01 10:30」这类没有时区的，
// 按北京时间补上 +08:00，避免被当成 UTC 或服务器本地时区。
function parseCreatedAt(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  let normalized = text.replace(' ', 'T');
  if (!/[zZ]$|[+-][0-9]{2}:?[0-9]{2}$/.test(normalized)) {
    normalized += '+08:00';
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 北京时区墙上的时钟分量：{ y, m, d, hh, mm }
function bjParts(date) {
  const shifted = new Date(date.getTime() + ZONE_OFFSET_MINUTES * 60000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
  };
}

// 账期：创建时刻在北京时区下的年月，形如 2026-09
function periodOf(waybill) {
  const date = parseCreatedAt(waybill && waybill.createdAt);
  if (!date) return '';
  const p = bjParts(date);
  return p.y + '-' + pad2(p.m);
}

function isValidPeriod(period) {
  return /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(String(period || ''));
}

// 账期在北京时区的边界时刻，返回 UTC（ISO）与北京时间两套写法，供页面核对
// start：当月 1 日 00:00（含）；end：次月 1 日 00:00（不含，即当月最后一刻的下一秒）
function periodRange(period) {
  const match = String(period || '').match(/^([0-9]{4})-([0-9]{2})$/);
  if (!match || !isValidPeriod(period)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const next = new Date(Date.UTC(year, month, 1)); // 12 月会自动进位到次年 1 月
  const nextText = next.getUTCFullYear() + '-' + pad2(next.getUTCMonth() + 1) + '-01 00:00';
  const startUtcMs = Date.UTC(year, month - 1, 1, 0, 0, 0) - ZONE_OFFSET_MINUTES * 60000;
  const endUtcMs = next.getTime() - ZONE_OFFSET_MINUTES * 60000;
  return {
    period: year + '-' + pad2(month),
    startAt: new Date(startUtcMs).toISOString(),
    endAt: new Date(endUtcMs).toISOString(),
    startAtBjText: year + '-' + pad2(month) + '-01 00:00',
    endAtBjText: nextText,
    zone: ZONE_LABEL,
  };
}

// 一条运单是否落在该账期：创建时刻 >= 账期起点且 < 账期终点（半开区间）
function inPeriod(waybill, period) {
  const range = periodRange(period);
  const date = parseCreatedAt(waybill && waybill.createdAt);
  if (!range || !date) return false;
  const ms = date.getTime();
  return ms >= new Date(range.startAt).getTime() && ms < new Date(range.endAt).getTime();
}

// 把 ISO 时刻显示成北京时间文本（yyyy-MM-dd HH:mm），页面上一律用它看创建时刻
function bjText(value) {
  const date = parseCreatedAt(value);
  if (!date) return '';
  const p = bjParts(date);
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d) + ' ' + pad2(p.hh) + ':' + pad2(p.mm);
}

// 存库前把创建时刻规范成北京时区 ISO：2026-09-01T02:30:00+08:00
function canonicalCreatedAt(value) {
  const date = parseCreatedAt(value);
  if (!date) return '';
  const p = bjParts(date);
  const ss = date.getUTCSeconds();
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d) + 'T' + pad2(p.hh) + ':' + pad2(p.mm) + ':' + pad2(ss) + '+08:00';
}

module.exports = {
  ZONE_LABEL,
  parseCreatedAt,
  canonicalCreatedAt,
  periodOf,
  isValidPeriod,
  periodRange,
  inPeriod,
  bjParts,
  bjText,
};
