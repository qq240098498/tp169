// 账期口径：按运单创建时刻的「本地年月」归属，本地固定为北京时间（UTC+8），不随服务器时区走。
// 例如 2026-09-01 02:30（北京时间）属于 2026-09 账期，
// 而创建时刻在 UTC 下还停留在 8 月 31 日——不能再按 UTC 月份归集。
const LOCAL_OFFSET_MINUTES = 8 * 60;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 把 ISO 时刻换算成北京时间墙上的各分量
function localParts(date) {
  const ms = date.getTime() + LOCAL_OFFSET_MINUTES * 60000;
  const shifted = new Date(ms);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1, // 1-12
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

// 账期：创建时刻按北京时间取年月，形如 2026-09
function periodOfAt(value) {
  const date = new Date(String(value == null ? '' : value));
  if (Number.isNaN(date.getTime())) return '';
  const p = localParts(date);
  return p.year + '-' + pad2(p.month);
}

function periodOf(waybill) {
  return periodOfAt(waybill && waybill.createdAt);
}

// 账期对应的北京时间起止时刻（半开区间 [startAt, endAt)），返回 ISO 字符串
function periodBounds(period) {
  const match = String(period || '').match(/^([0-9]{4})-([0-9]{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  // 北京时间 1 号 00:00 = 前一个自然日 16:00 UTC
  const startMs = Date.UTC(year, month - 1, 1) - LOCAL_OFFSET_MINUTES * 60000;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endMs = Date.UTC(nextYear, nextMonth - 1, 1) - LOCAL_OFFSET_MINUTES * 60000;
  return {
    period,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
  };
}

function isValidPeriod(value) {
  return Boolean(periodBounds(value));
}

// 把 ISO 时刻格式化成北京时间字符串 YYYY-MM-DD HH:mm
function localText(iso) {
  if (!iso) return '';
  const date = new Date(String(iso));
  if (Number.isNaN(date.getTime())) return '';
  const p = localParts(date);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + ' ' + pad2(p.hour) + ':' + pad2(p.minute);
}

// 账期内运单的最早 / 最晚创建时刻（原样 ISO，需要展示时用 localText）
// 注意：数据里混有 +08:00 和 Z 两种写法，不能按字符串比较，要换算成时间戳
function waybillRange(waybills) {
  let first = '';
  let last = '';
  let firstMs = Infinity;
  let lastMs = -Infinity;
  (waybills || []).forEach((waybill) => {
    const at = String(waybill.createdAt || '');
    const ms = new Date(at).getTime();
    if (!Number.isFinite(ms)) return;
    if (ms < firstMs) { firstMs = ms; first = at; }
    if (ms > lastMs) { lastMs = ms; last = at; }
  });
  return { firstAt: first, lastAt: last };
}

module.exports = {
  LOCAL_OFFSET_MINUTES,
  periodOfAt,
  periodOf,
  periodBounds,
  isValidPeriod,
  localText,
  waybillRange,
};
