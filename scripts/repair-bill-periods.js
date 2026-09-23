// 一次性数据修复：账期口径从「创建时刻的 UTC 月份」改为「创建时刻的北京时间（UTC+8）月份」。
// 旧口径下月初凌晨（北京时间 00:00-08:00）创建的运单会被算进上个月，可能挂在错误账期的账单里。
// 本脚本逐张账单按新口径核对：
//   1. 把不属于该账单账期（或不属于该客户）的运单从 waybillIds / lines 中移除；
//   2. 用现行计费口径重算账单明细与金额；
//   3. 被移除的运单解除入账锁定（billId 置空），可在正确账期重新出账。
// 用法：node scripts/repair-bill-periods.js
const store = require('../server/store');
const bills = require('../server/bills');
const { findCustomer } = require('../server/customers');

function run() {
  const data = store.load();
  const report = [];

  data.bills.forEach((bill) => {
    const currentIds = Array.isArray(bill.waybillIds) ? bill.waybillIds.slice() : [];
    const linked = currentIds
      .map((id) => data.waybills.find((waybill) => waybill.id === id))
      .filter(Boolean);
    const keep = linked.filter((waybill) => (
      waybill.customerId === bill.customerId && bills.periodOf(waybill) === bill.period
    ));
    const removed = linked.filter((waybill) => keep.indexOf(waybill) < 0);
    if (removed.length === 0 && keep.length === linked.length) return;

    const beforeAmount = Number(bill.amountYuan || 0);
    const customer = findCustomer(data, bill.customerId);
    const priced = bills.priceBill(data, customer, keep);
    bill.waybillIds = keep.map((waybill) => waybill.id);
    bill.lines = priced.lines;
    bill.amountYuan = priced.amountYuan;
    removed.forEach((waybill) => {
      if (waybill.billId === bill.id) waybill.billId = null;
    });
    report.push({
      billCode: bill.code,
      period: bill.period,
      removed: removed.map((waybill) => ({ code: waybill.code, period: bills.periodOf(waybill), createdAt: waybill.createdAt })),
      kept: keep.length,
      beforeAmount,
      afterAmount: priced.amountYuan,
    });
  });

  // 兜底：运单上的 billId 若指向一张已经不含它的账单，一律解锁
  data.waybills.forEach((waybill) => {
    if (!waybill.billId) return;
    const bill = data.bills.find((item) => item.id === waybill.billId);
    if (bill && Array.isArray(bill.waybillIds) && bill.waybillIds.includes(waybill.id)) return;
    report.push({ unlock: waybill.code, billId: waybill.billId });
    waybill.billId = null;
  });

  if (report.length === 0) {
    console.log('没有需要修复的账单，所有运单都已按北京时间账期归属。');
    return;
  }
  store.save(data);
  console.log('已修复 ' + report.length + ' 项：');
  report.forEach((item) => {
    if (item.billCode) {
      console.log('- 账单 ' + item.billCode + '（账期 ' + item.period + '）保留 ' + item.kept + ' 条，金额 ' +
        item.beforeAmount + ' -> ' + item.afterAmount + '；移出错账期运单：');
      item.removed.forEach((waybill) => {
        console.log('    · ' + waybill.code + ' 创建于 ' + waybill.createdAt + '，按新口径属于 ' + waybill.period);
      });
    } else {
      console.log('- 运单 ' + item.unlock + ' 解除失效锁定（原指向 ' + item.billId + '）');
    }
  });
}

run();
