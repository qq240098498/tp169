# 运单计费与账单核对台

面向物流结算岗位的运单计费与账单核对工具。运单录进来，按分区与重量口径算出运费与附加费，按月出账，出账之后要能核对账单总额与逐单明细是否对得上。

## 怎么跑

```
npm install
npm start
```

启动后打开 http://localhost:5150 。数据存在 `data/db.json`，页面上的改动会直接写回这个文件。

## 页面能做什么

- 概览：分区、客户、运单、账单的数量与金额合计，运单状态分布，已有账期（每个账期显示运单条数，点账期可跳到运单按账期筛选），未归属城市的运单数
- 运单：登记与维护运单（客户、寄件城市、收件城市、实际重量、体积、件数、保价金额、附加服务、状态、创建时刻），支持按关键词、客户、账期、状态筛选，可以只看收件城市还没归属分区的运单；选中账期后左侧列出账期起止时刻与当前清单运单的最早/最晚创建时刻，用来核对月初月末边界运单
- 运单计费：对单条运单算一次费用，结果会记在这条运单上，页面上直接能看到上次算出来的数
- 分区：维护分区编码、名称、覆盖城市与城市别名、首重与续重价格、偏远附加、启用状态
- 客户：维护客户编码、名称、结算方式（月结／现结）、折扣、账期日
- 账单：出账前按账期与客户核对候选运单条数、账期起止与运单最早/最晚创建时刻，再出账；查看账单总额与逐条明细（每条都带创建时刻与账期，边界运单一目了然），可以把账单作废

## 计费口径

1. 计费重量 = max(实际重量, 体积重量)；体积重量 = 体积(m³) × 1000000 ÷ 体积系数（默认 6000），结果向上取到 0.5kg
2. 首重以内收首重价；超出首重的部分按续重单位向上进位，每个单位收续重价
3. 运费不低于最低收费（默认 8 元）
4. 附加费 = 偏远附加（按分区）+ 超规附加（计费重量超过 30kg 或件数达到 3 件，20 元）+ 保价费（保价金额 × 2%）
5. 月结客户按折扣作用于运费与附加费合计，现结客户不打折；金额以元为单位，页面保留两位小数
6. **账期按运单创建时刻的北京时间（UTC+8）年月归属**：账期从本地月初 00:00 起到月末 24:00 止。例如 `2026-09-01 02:30（北京时间）` 创建的运单属于 `2026-09`，不会因为同一时刻在 UTC 还是 8 月 31 日而挂进 8 月账单。页面录入的创建时刻一律按北京时间解释；运单进账单之后会被锁定，不能再直接删改

## 目录

```
server/index.js     服务入口
server/api.js       接口路由与错误处理
server/store.js     数据读写
server/pricing.js   计费口径
server/period.js    账期口径（北京时间 UTC+8 年月与账期起止）
server/zones.js     分区与城市归属
server/customers.js 客户
server/waybills.js  运单与单条计费
server/bills.js     出账与账单
scripts/            一次性数据修复脚本
public/             页面
data/db.json        数据
```

## 接口一览

```
GET    /api/health
GET    /api/summary
GET    /api/settings             PATCH /api/settings
GET    /api/zones                POST /api/zones      PATCH|DELETE /api/zones/:id
GET    /api/customers            POST /api/customers  PATCH|DELETE /api/customers/:id
GET    /api/waybills?period=     POST /api/waybills   PATCH|DELETE /api/waybills/:id
POST   /api/waybills/:id/quote
GET    /api/bills                GET /api/bills/:id
POST   /api/bills/preview        POST /api/bills/generate       POST /api/bills/:id/void
GET    /api/periods
```

- `GET /api/waybills?period=2026-09`：按北京时间账期筛运单；每条运单带 `period` 字段
- `GET /api/periods`：账期清单，每项含账期起止时刻（`startText/endText`，北京时间）、运单条数与最早/最晚运单创建时刻
- `POST /api/bills/preview`：出账前核对，入参与出账相同，返回该账期起止、候选运单条数与最早/最晚创建时刻
- `GET /api/bills/:id`：账单详情同样带账期起止与本张账单运单的最早/最晚创建时刻

出账入参：`{ "period": "2026-09", "customerId": "cust-0001" }`

## 历史数据修复

账期口径早期按创建时刻的 UTC 月份归集，北京时间月初凌晨（00:00–08:00）创建的运单会被错挂到上个月的账单。已提供一次性修复脚本：

```
node scripts/repair-bill-periods.js
```

脚本会把每张账单里不属于其账期（新口径）的运单移出、按现行计费口径重算明细与金额，并解锁这些运单以便在正确账期重新出账。运行前建议先备份 `data/db.json`。
