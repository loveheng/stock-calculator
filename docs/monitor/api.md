---
status: active
updated: 2026-09-26
---

# 价格预告单监控（Alert）· 接口文档（前端对接）

> 版本：v1.1（2026-09-26，direction 方向语义 + 单边判定 + 30 分钟 K 线口径）。读者：前端开发（对接 :18080 `/api/broker/monitor/*` 三端点）。
> 状态：后端已实现（编译通过；中间件起后待真实冒烟）。契约详见 [design](design.md)。
> 关联：[design](design.md)（判定链/合并窗口/3 次封顶语义）；推送订阅流程见 `src/services/pushService.ts`（前端实现：订阅/退订/消息拉取兜底）。

## 0. 通用约定

- **Base URL**：`http://<host>:18080`，与 `/api/search`、`/api/guide` 同应用。
- **鉴权**：三端点均挂登录拦截，需携带 `Authorization` 头（既有会话链路，后端从会话解析 `userId`，请求体无需传用户标识）。
- **响应信封**：统一 `ApiResponse`——`{"code":200,"message":"success","data":{...}}`。**HTTP 状态恒为 200**，前端必须判 `body.code`（业务错误 code=400，超限 413/429，系统异常 500）。
- **部署与 CORS**：经同源或反向代理访问（与 `/api/search` 同一部署方式），无独立 `@CrossOrigin`。
- **时间字段**：`OffsetDateTime` ISO-8601 字符串（如 `2026-09-26T15:00:00+08:00`），直接 `new Date(str)` 解析。

## 1. 开启预告单：`POST /api/broker/monitor/start`

用户填写价格预告单（目标价 + 「附近」容差）提交时调用。

### 1.1 请求（JSON body）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| fullCode | string | 是 | 腾讯形态全码，如 `sh600519`（与 K 线接口同形态） |
| interval | string | 是 | 固定传 `"1d"`（当前仅支持） |
| direction | string | 是 | `BUY`（低吸）/ `SELL`（高抛）；**SELL 仅容 PRICE_NEAR** |
| alertRule.type | string | 是 | `PRICE_NEAR`（区间触发，推荐）/ `PRICE_BELOW`（跌破触发，仅 BUY） |
| alertRule.threshold | number | 是 | 目标价（元），正数 |
| alertRule.band | number | PRICE_NEAR 必填 | 区间容差（元），≥0；PRICE_BELOW 忽略可不传 |

### 1.2 响应 data

| 字段 | 类型 | 说明 |
|---|---|---|
| taskId | long | 预告单 ID（stop 用） |
| status | string | 恒 `"RUNNING"` |

### 1.3 业务错误（body.code）

| code | 场景 |
|---|---|
| 400 | fullCode 缺失/非法、未收录股票、direction 缺失/非法、白名单外 type、threshold/band 非法、**SELL + PRICE_BELOW 组合** |
| 429 | 用户 RUNNING 监控已达上限（默认 5），提示先停止部分预告单 |

重复提交幂等：同用户+同股+同类型+同阈值+同 band+同 direction 已 RUNNING 时返回既有 taskId，不报错。

> 创建成功后前端**必须**回显「触发区间 / 检查节奏 / 3 次封顶」三项说明，规范见 [§6](#6-提示规范前端必读)。

## 2. 预告单列表：`GET /api/broker/monitor/list`

预告单管理页加载/刷新时调用。无请求参数。

### 2.1 响应 data

| 字段 | 类型 | 说明 |
|---|---|---|
| runningCount | long | RUNNING 数（展示剩余额度：5 − runningCount） |
| tasks | Task[] | 按更新时间倒序（含已 STOPPED） |

Task 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| taskId | long | 预告单 ID |
| fullCode | string | `sh600519` 形态（可直接拼 K 线接口） |
| stockCode | string | 6 位字典码 `600519` |
| alertType | string | `PRICE_NEAR` / `PRICE_BELOW` |
| direction | string | `BUY` / `SELL` |
| threshold | number | 目标价（元） |
| band | number? | 区间容差，仅 PRICE_NEAR 非空 |
| status | string | `RUNNING`（追踪中）/ `STOPPED`（已结束：手动停或 3 次提醒完自动停） |
| alertCount | int | 累计提醒次数，展示「已提醒 n/3 次」；STOPPED 且 =3 即自动停 |
| lastAlertAt | string? | 最近一次提醒时间，未提醒过为 null |
| createdAt / updatedAt | string | ISO-8601 |

### 2.2 样例

```json
{"code":200,"message":"success","data":{
  "runningCount":2,
  "tasks":[
    {"taskId":12,"fullCode":"sh600519","stockCode":"600519","alertType":"PRICE_NEAR",
     "direction":"BUY","threshold":1450.0000,"band":20.0000,"status":"RUNNING","alertCount":1,
     "lastAlertAt":"2026-09-26T14:32:11+08:00",
     "createdAt":"2026-09-25T10:00:00+08:00","updatedAt":"2026-09-26T14:32:11+08:00"},
    {"taskId":9,"fullCode":"sz000001","stockCode":"000001","alertType":"PRICE_BELOW",
     "direction":"BUY",
     "threshold":10.5000,"band":null,"status":"STOPPED","alertCount":3,
     "lastAlertAt":"2026-09-24T11:05:00+08:00",
     "createdAt":"2026-09-22T09:30:00+08:00","updatedAt":"2026-09-24T11:05:00+08:00"}]}}
```

## 3. 结束预告单：`POST /api/broker/monitor/stop`

用户主动结束追踪时调用。幂等：已 STOPPED 再调返回成功。

### 3.1 请求（JSON body）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| taskId | long | 是 | start/list 返回的预告单 ID |

### 3.2 响应 data

| 字段 | 类型 | 说明 |
|---|---|---|
| status | string | 恒 `"STOPPED"` |

### 3.3 业务错误

code=400：taskId 缺失或不属于当前用户（提示「预告单不存在」）。

## 4. 推送通知行为（前端预期管理）

- **触发时机**：每 30 分钟一轮（仅 A股交易时段 9:30–11:30 / 13:00–15:00，周末无），**当轮 30 分钟 K 线** low/high 进入触发条件后推送
  （BUY 看 low、SELL 看 high，消盘中触及又回落的漏报）。
  即「条件成立后最迟约 30 分钟推达」，**不是实时盯盘**；非交易时段（含午休 11:30–13:00、收盘后、周末）不检查也不推送，
  隔夜跳空需在次日开盘后首轮才可能被捕获。
- **两次提醒最小间隔**：同一预告单受冷却窗约束（`alert-cooldown-seconds`，默认 1800s / 30 分钟），
  价格一直在区间内也不会连续轰炸；叠加 3 次封顶 → 极端情况下约 1.5 小时内用完额度并自动结束。
- **同用户合并**：30 秒窗口内多条提醒合成 **1 条弹窗**（标题「价格提醒 xxx(N 条合并)」，正文逐行列出）；通知中心仍是 N 条明细，逐条可查。
- **最多 3 次**：单条预告单累计提醒 3 次后**自动 STOPPED**，不再追踪；用户可随时 stop 提前结束。
- **双通道**：推送（Web Push）+ 落库拉取兜底——离线用户打开 PWA 仍能拉到未读，消息不丢。
- **订阅引导**（建议 UI 文案）：iOS/iPadOS 需「添加到主屏幕」才能收弹窗；国行无 GMS 安卓机可能收不到弹窗，依赖拉取兜底。订阅实现见 `src/services/pushService.ts`。

## 5. 建议交互流程

1. 管理页加载 → `GET /monitor/list` 渲染列表 + 剩余额度；
2. 新建表单提交 → `POST /monitor/start` → 成功后刷新列表；
3. 列表项「结束」按钮 → `POST /monitor/stop` → 刷新；
4. 推送弹窗/通知中心点击 → 跳对应个股页（PRICE_NEAR 合并消息建议跳预告单列表页）；
5. `start` 成功后展示结果提示（区间 + 节奏 + 3 次封顶），规范见 §6.3。

## 6. 提示规范（前端必读）

> 动机：额度仅 5、单条最多 3 次提醒、检查粒度 30 分钟 → **建错一条预告单的代价很高**（占额度且可能永不触发）。
> 因此「价格浮动是多少」「多久会提醒」「最多提醒几次」必须在**提交前可见、提交后再确认**。

### 6.1 价格浮动（触发区间）——建议做，分两档

| 档位 | 内容 | 数据来源 | 后端改动 |
|---|---|---|---|
| L1（必做） | 触发边界（**按 direction 单边**，见下表）、band 宽度、宽度占目标价百分比 | 前端纯算 | 无 |
| L2（建议） | 当前价、距触发还差多少（元 / %）、**当前价是否已落在触发侧** | 个股页已拉到的 K 线最后一根收盘价（`/api/broker/klines`），**前端本地算** | 无（后端契约 v1.1 已定稿，见 §6.4） |

触发边界按 direction 取单边（v1.1 定案，消盘中触及又回落的漏报）：

| direction | alertType | 触发条件（后端判定，前端展示同一口径） |
|---|---|---|
| BUY | PRICE_BELOW | `low ≤ threshold`（当轮 30 分钟 K 线最低价跌破目标价） |
| BUY | PRICE_NEAR | `low ≤ threshold + band`（低吸：跌入「目标价 + band」即触发，含跌破） |
| SELL | PRICE_NEAR | `high ≥ threshold − band`（高抛：升入「目标价 − band」即触发，含升破） |

L2 取「K 线最新收盘价」而非实时现价是本期定案：预告单通常从个股页发起，前端手上已有该股最后一根 close，
足以判断「是否已落在区间内」这个关键坑；盘中价差带来的误差只影响「还差多少」的精度，不影响警示成立与否。
非交易时段该收盘价即当日/最近收盘，语义自洽。

L2 的真正价值不在「好看」，而在拦住两个真实坑：

1. **建单即触发**：现价已满足触发条件（BUY：已在 `threshold + band` 下侧或已跌破；SELL：已在 `threshold − band` 上侧）
   → 下一轮立即提醒，3 次额度开始倒计时，用户会以为「刚建的怎么就提醒/就结束了」。必须黄色警示。
2. **容差过窄永不触发**：30 分钟采样下，band 太窄（如 0.01 元）价格很容易在两次采样之间穿过区间 →
   永远不触发、白占额度。建议 band 占现价 < 0.3% 时提示「容差偏窄，可能错过」。

### 6.2 节奏与封顶——必须做（零后端成本）

提交前表单底部常驻 + 提交后结果卡双处展示，文案：

- 节奏：`交易时段内每 30 分钟检查一次，条件成立后最迟约 30 分钟提醒；非交易时段与周末不检查。`
- 封顶：`同一预告单最多提醒 3 次，提醒满 3 次后自动结束（同一单两次提醒至少间隔 30 分钟）。`
- 额度：`当前剩余 N 条额度（上限 5）`（`list` 的 `runningCount` 算得）。

### 6.3 `start` 成功后的结果卡（建议）

```
已开启追踪 · 贵州茅台(600519) · 低吸(BUY)
触发边界 ≤1470.00（目标价 1450.00 + 容差 20.00，约 +1.38%）
当前价 1421.60，已落在触发侧 → 下一轮即提醒（黄色警示）
交易时段每 30 分钟检查一次，最迟约 30 分钟提醒；最多提醒 3 次（已提醒 0/3）
```
SELL（高抛）样例：`触发边界 ≥1430.00（目标价 1450.00 − 容差 20.00）`，其余同理。
现价不可得时（K 线未拉到）隐藏「当前价」行，其余照常展示，不阻断创建。

### 6.4 后端 `start` 响应增强（已评估·本期不做）

后端 v1.0 契约已定稿（三端点字段不变），前端按 §6.1 本地计算即可满足提示需求，不再动后端。
以下为评估过的备选方案，仅作留档，未实现：

在 `MonitorStartData` 增补 nullable 字段，全部由 `MonitorService` 落库后一次 `fetch_realtime_quote` 填充：

| 字段 | 类型 | 说明 |
|---|---|---|
| currentPrice | number? | 创建时现价；取价失败/停牌为 null |
| triggerLow / triggerHigh | number? | 区间下/上界（PRICE_BELOW 时 triggerHigh = threshold） |
| distancePct | number? | 距触发的百分比差，负号表示需下跌；已在区间内为 0 |
| alreadyTriggered | boolean? | 现价已满足触发条件 → 前端黄色警示「下一轮即提醒」 |

降级纪律：取价异常一律吞掉填 null（`// DEGRADE:` 标注 + warn 日志），**不得**让 start 失败或变慢阻塞。
列表接口 `list` **不回带现价**（N 条任务 × 每次刷新放大取价成本，且对已建单意义不大）。

### 6.5 已知偏差：实现节奏快于文案（本期不改实现，仅留档）

[design.md](design.md) R1 定案「30 分钟一轮」，而 `schema.sql` 播种行 `job.broker.monitor.check`
为 cron `0 * * * * *`（每分钟）+ `min-check-interval-seconds=60` → **实际判定约每分钟一次**
（`alert-cooldown-seconds=1800` 只约束同一单两次提醒的最小间隔）。

对外文案按 **30 分钟**写是**保守值**：真实送达只会更快，不会更慢，不会构成承诺违约；故本期不改调度。
若后续要严格对齐 design，需：cron 改 `0 0/30 * * * *`（时段门控 `MonitorCheckTask` 内已做）
+ 一条 UPDATE 迁移（`ON CONFLICT DO NOTHING` 不会更新已存在行）。
