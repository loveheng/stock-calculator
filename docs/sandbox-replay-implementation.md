# 沙盘推演（事后复盘 / What-if）— 实现现状与开发上手文档

> **版本**：实现盘点 v1（2026-08-21）
> **定位**：本文档描述沙盘推演功能的**当前已落盘实现**（含文件清单、每个文件职责、整体运行逻辑、完成度），
>          供**开发人员快速上手**。设计层面的完整规格见 `docs/sandbox-replay-spec.md`。
> **关联**：`docs/position-ledger-spec.md`（基线数据源）、`docs/behavior-spec.md`（做T批次语义）
> **路由**：`/sandbox`，主导航文案「沙盘复盘」

---

## 0. 一句话定位

> 以**真实资金占用峰值为硬件预算**的「如果当时……」沙盘：把真实持仓批次履历派生为只读基线，再叠加
> 多套标准策略 / 用户手动改的单，在同一个前复权 K 线时间线上重演买卖，量化对比各方案的收益/风险/成本，
> 回答「当年这么做 / 换成那套规则 / 我要是…」这类问题。

---

## 1. 完成度总览（一句话结论）

**核心功能已全部落地，实现完整度约 95%**：数据层、基线提取、推演引擎、9 套策略生成器、K 线三级缓存、
Zustand 状态层、8 个 UI 组件 + 主页面、数据库（STORES_V11 三张表）与路由均已实现，并有 9 个测试文件。

预算口径边缘场景（预设单与基线合并、共享同一模拟预算时越限被拒）已按**方案 2** 修复（见 §2.3）：
生成器预算先扣基线峰值占用，预设/复制的用户分支不再越预算。当前**全部 9 个沙盒测试文件**以及
**全量测试套件（23 个测试文件 / 254 用例）**均已**通过**（2026-08 实测）。

各子模块完成度：

| 模块 | 文件 | 状态 |
|---|---|---|
| 类型定义 | `src/types/sandbox.ts` | ✅ 完整（含 DCA 注入、加权收益口径） |
| 数据库（表 + CRUD + 缓存） | `db/schema.ts`（STORES_V11）、`db/index.ts` | ✅ 完整 |
| 基线提取 | `utils/baselineExtractor.ts` | ✅ 完整 |
| 推演引擎 | `utils/sandboxEngine.ts` | ✅ 完整 |
| 指标 / B&H / 对比 | `utils/metricsEngine.ts` | ✅ 完整 |
| 策略生成器（9 套） | `utils/strategyGenerators.ts` | ✅ 完整 |
| K 线获取（三级缓存） | `services/klineService.ts` | ✅ 完整 |
| 状态层（含 DCA、过期检测） | `store/sandboxStore.ts` | ✅ 完整（998 行） |
| UI 组件 + 页面 | `components/sandbox/*`（8 个）+ `views/SandboxPlayback.tsx` | ✅ 完整 |
| 路由 / 构建接入 | `App.tsx`、`vite.config.ts`、`middleware.js` | ✅ 完整 |
| 测试 | `__tests__/sandbox*.test.ts*` 等 9 个 | ✅ 全绿（方案 2 预算口径修复后） |

---

## 2. 测试现状

### 2.1 测试文件清单

| 测试文件 | 覆盖 | 结果 |
|---|---|---|
| `__tests__/sandboxEngine.test.ts` | 资金约束 / T+1 / 持仓不足 / 超评估日 / 统一评估日 / 动态抖动可复现 / 规费一致 / 基线自洽 | ✅ 绿 |
| `__tests__/strategyGenerators.test.ts` | 9 套策略不变量（100 股取整、现金约束、确定性） | ✅ 绿 |
| `__tests__/presetAudit.test.ts` | 静态审计：载入真实前复权 K 线逐策略跑出买卖/触发原因，核对资金不变量（除 model-recommend 之外的 7 策略） | ✅ 绿 |
| `__tests__/sandboxStore.test.ts` | 前复权换算 / 基线与预设合并 / K 线起点 / 三源过期检测 / memo 复用 | ✅ 绿 |
| `__tests__/sandboxDb.test.ts` | 分支 CRUD / 订单批量幂等 / K 线缓存往返 | ✅ 绿 |
| `__tests__/klineService.test.ts` | 解析、复权系数表、增量合并/漂移检测 | ✅ 绿 |
| `__tests__/sandboxPositionDiscrepancy.test.ts` | 基线重演少股排查（正常/OOA/批次缺失/在途出借） | ✅ 绿 |
| `__tests__/sandboxE2E.test.ts` | 全链路 + 过期检测 + 结构化拒绝 + 撤销/保存 | ✅ 10 用例全绿（方案 2 修复） |
| `__tests__/sandboxPlayback.ui.test.tsx` | 新手/专业模式、未保存浮动栏、拒绝弹窗（UI 层） | 随全量运行 |
| `__tests__/helpers/sandboxFixture.ts` | 共享夹具（持续持仓+归并标的，90 根前复权 K 线） | 夹具 |

> 运行：`npx vitest run src/__tests__/sandbox*.test.ts src/__tests__/strategyGenerators.test.ts src/__tests__/klineService.test.ts src/__tests__/presetAudit.test.ts`
> 或全量 `npm test`。测试用 `fake-indexeddb`，K 线网络层被 mock，**无需真实网络**。

### 2.2 该用例（根因与修复）

```
复制预设为可编辑 → 编辑草稿 → 撤销还原 → 保存 → 落库重载
  ✓ expect(saved.status).toBe('completed')
```

**原根因（已修复）**：从 `pure-dca` 预设复制得到 `user` 分支，`simulatedCash = 30000`，订单是「基线 + 生成单」
合并的同一条时间线。原实现让策略生成器按「`simulatedCash` 全部归策略」规划买入大小，导致合并**基线自身的
买卖**后总支出 > ¥30,000：引擎返回 `INSUFFICIENT_CASH`（最高缺 ¥6,882），`computeBranchResult().result == null`
→ `runSimulation` 依规则置 `draft`。

**方案 2 · 预算口径修复（store 层）**：在 `sandboxStore.computeBranchResult` 里，向生成器传入的
`simulatedCash = Math.max(0, generatedAtCash − (baselineOrders.length > 0 ? peakCapitalLock : 0))`——
预设单并入唯一合并时间线时，先为基线组合**预留其资金占用峰值**，策略只在余量内分仓（仍是 100 股整数、
价格锚定 K 线日期、确定性不变）。该改动只在 store 层扣减预算，**7 个策略生成器与引擎零改动**。

### 2.3 是否需要修（开发决策项）

这暴露一个**产品级口径**问题，而非崩溃：

> 策略生成器生成订单时按「simulatedCash 全部归策略」的买入大小；但**合并基线的总时间线**在同一预算内
> 还要留给基线自己的买卖。当用户资金基线本身占比较高（如 30k 预算却已有基线 18k 用作建仓）时，策略单会越预算被拒。

**已选方案 2 并落地**（sandboxStore.computeBranchResult 实现，7 个生成器与引擎零改动；另列备选如下）：
1. **保持现状** + 文档说明「预设单会与基线共享预算，被拒绝时按结构化行动指引减量」（当前行为）；
2. **生成器预算扣减基线占用**：在 `StrategyContext` 已有 `peakCapitalLock`；让 `simulatedCash` 生成时
   先扣基线峰值占用，再按余量分仓（需要动 7 个生成器 + 单测）；
3. **该用例改用更小的模拟资金**，仅验证「复制→编辑→撤销→保存」流程本身（改测试）。

---

## 3. 文件清单与每个文件的功能

### 3.1 核心源文件（按数据流依赖顺序）

| 文件 | 层 | 功能 | 行数 |
|---|---|---|---|
| `src/types/sandbox.ts` | 类型 | 全部沙盘类型：`SandboxBranch`（三类分支）、`SandboxOrder`、`KlineItem`、`SandboxResult`、`SandboxSnapshot`、`ComparisonRow`、`CashInjection`/`InjectionType`（DCA） | ~238 |
| `src/db/schema.ts` | DAO | `STORES_V11` 新增三张表：`sandboxBranches` / `sandboxOrders` / `klineCache`；实体类型 `*Entity` |（+3 表，库名 TradingLedgerDB_v3） |
| `src/db/index.ts` | DAO | 沙盘 CRUD：分支写/读/软删级联、订单批量幂等写、日 K 缓存读写；`toSandboxBranchEntity/Row`、`toSandboxOrderEntity/Row`、`cleanUndefined` | |
| `src/utils/baselineExtractor.ts` | 逻辑 | 把真实持仓批次履历 → 沙盘订单时间线 + 资金占用峰值 + 基线指纹 + 净持仓（自校验） | ~105 |
| `src/utils/sandboxEngine.ts` | 引擎 | 时间线重演核心：资金硬约束（禁止透支）、T+1 锁定、统一评估日清算、动态价格抖动、结构化拒绝（含行动指引）、DCA 现金注入、多口径收益 | 602 |
| `src/utils/metricsEngine.ts` | 指标 | 回撤 / 波动率 / B&H 基准 / `enrichResult` 补全引擎结果 / `buildComparisonRows` 四维对比（最优分支标注） | 185 |
| `src/utils/strategyGenerators.ts` | 生成器 | **9 套**策略注册表（ma20-bounce、pyramid、grid、stop-profit、max-opportunity、pure-dca、hybrid-regime、model-recommend、manual-blank）；统一 `StrategyGenerator` 接口；另含通用策略引擎 `runStrategyEngine`、`budgetQty`/`computeRemainingCash`、选股打分 `extractFactors`/`evaluateSignals`、资金分配器 `CapitalAllocator`、市场状态检测 `detectMarketRegime`（早期 gap-fill 补全建议生成器已移除） | 1320 |
| `src/utils/presetAudit.ts` | 逻辑/工具 | 预设策略静态审计：载入真实前复权 K 线，逐策略跑出每笔买卖与触发原因，核对资金不变量；`auditPresetOrders` / `renderAudit` | ~210 |
| `src/services/klineService.ts` | 数据服务 | 腾讯 ifzq 前复权日 K 线获取 + 三级缓存（内存→IndexedDB→网络）+ 增量合并 + 除权漂移检测 + 复权系数表 | ~361 |
| `src/store/sandboxStore.ts` | 状态层 | 三类分支管理、非响应式 memo 缓存（`computeBranchResult`）、三源过期检测、DCA 操作、预设生成/复制/重配、运行推演、对比 | ~998 |

### 3.2 UI 层（`src/components/sandbox/`）

| 组件 | 职责 |
|---|---|
| `ScenarioList.tsx` | 左侧方案列表（三态分组：基线→预设→用户）；组头「✨生成预设」「＋新建演练」 |
| `ScenarioCard.tsx` | 方案卡片（三态徽章 + 时效戳 + ⚠️/⚡/🔄 过期提示 + 操作按钮） |
| `KlineChart.tsx` | lightweight-charts v5 封装：前复权蜡烛 + 成本线 + 买卖标记；user 分支可点线下单 |
| `OrderTimeline.tsx` | 操作时间线编辑（行内步进 + 日期微调 + 批量变换）；只读 Tooltip 引导 |
| `MetricsPanel.tsx` | 指标面板（极简 4 数字 / 专业全量 + 资金进度条） |
| `ComparisonTable.tsx` | 多方案四维对比表 + 收益/风险散点图 |
| `PresetDialog.tsx` | 预设生成对话框（勾选策略 + 全局「模拟资金 / 滑点」+ 每策略参数） |
| `EmptyStateGuide.tsx` | 空状态三步引导卡 + 白话术语表 `TERMS` |

### 3.3 页面与接入

| 文件 | 职责 |
|---|---|
| `src/views/SandboxPlayback.tsx` | 主页面三态工作台：组件组装、拒绝弹窗、未保存浮动栏、离开确认、`/sandbox` 路由（936 行） |
| `src/App.tsx` | 路由 `/sandbox` + 导航项「沙盘复盘」 |

### 3.4 数据库（`STORES_V11` 三张新表）

| 表 | 主键 | 说明 |
|---|---|---|
| `sandboxBranches` | id | 三类分支统一存储；基线存 `baselinePositionId`，预设存策略元数据，用户存元数据+订单 |
| `sandboxOrders` | id | 仅用户分支落库（`branchId` 索引）；预设/基线为派生，不落库 |
| `klineCache` | fullCode | 前复权日 K 线 + 复权系数表 + `lastDate`（增量 + 漂移检测） |

---

## 3.5 架构设计（分层 / 模块协作）

### 3.5.1 分层视图

```
┌─ UI 层（views/SandboxPlayback.tsx + components/sandbox/*，只读消费，不写逻辑）
├─────┼─────────────────────────────────────────────
├─ 状态层（store/sandboxStore.ts · Zustand）
│     分支生命周期·非响应式 memo·三源过期检测·DCA·预设生成/复制/运行/对比
│     ── 唯一直接调引擎/生成器/DB 的入口 ──
├─ 引擎层（纯函数，确定性，可单测）
│      sandboxEngine · metricsEngine · strategyGenerators · baselineExtractor
├─ 数据服务（klineService：内存→IndexedDB→网络三级缓存）
└─ DAO 层（db/schema.ts 表定义 + db/index.ts CRUD）
      Storage V11：sandboxBranches / sandboxOrders / klineCache
```

**核心原则**：引擎层全部为**无副作用纯函数 + 确定性**（同输入必同输出，便于测试与离线重演）；
状态层是唯一的“业务编排者”，UI 只调用 store 的 action，绝不自己调引擎/DB。

### 3.5.2 模块协作时序（生成 → 运行 → 对比）

```
组件事件 ──▶ useSandboxStore.generatePreset(id)
      └─► computeBranchResult(branch, ctx)          // store 内核心纯函数（带 LRU memo）
             ├─ 基线订单：extractBaseline(...) → adjustBaselineOrdersToQfq(...)  // 前复权
             ├─ 生成单：generateStrategyOrders(id, strategyCtx)      // 8 套策略
             │        （strategyCtx.simulatedCash 已按方案2 扣 peakCapitalLock）
             ├─ 合并：mergeBaselineAndGenerated(baseline, generated) // 基线与派生幂等
             ├─ 撮合：runSandboxEngine(orders, kline, opts)          // 引擎状态机
             ├─ 指标：enrichResult(result, orders, kline)            // metricsEngine
             └─ 基线自校验 → warnings
保存：safePersist(putSandboxBranch / bulkPutSandboxOrders)
```

### 3.5.3 store action 全集（`SandboxStoreActions`）

| action | 作用 |
|---|---|
| `loadBranches` / `selectStock` | 载入分支/切换标的（读 DB + K 线 + 建/选基线） |
| `selectBranch` / `toggleCompare` | 选中某分支并即时计算结果显示 / 勾选对比 |
| `setSimulatedCash` / `raiseCashToRequired` | 调“模拟资金”预算（基线锁定峰值） / 一键提到最低需求 |
| `adjustOrderQty` / `scaleAllBuyOrders` | 单笔改量 / 批量缩放所有买入 |
| `addCashInjection` / `setMonthlyDCA` / `clearCashInjections` | DCA 手动注入 / 按月 / 清空 |
| `generatePreset` / `updatePreset` / `rescalePreset` | 生成预设 / 改参重跑 / 缩放后重跑 |
| `copyBranch` / `deleteBranch` | 复制为可编辑 user 分支（深拷贝） / 删除 |
| `updateUserOrders` / `discardChanges` | 编辑草稿（内存+未保存标记） / 撤销还原 |
| `runSimulation` | 引擎重演 + 结果落库 + 盖章评估日（结果即快照） |
| `rebuildBaseline` / `refreshKline` | 🔄重建基线（重抽持仓） / ⚠️刷新行情 |
| `getComputed` / `staleFlagsFor` / `clearSandboxState` | 非响应式取结果 / 时效标记 / 全部清理 |

### 3.5.4 引擎状态机（`runSandboxEngine` 单次推演）

- **状态**：`{ cash, position, avgCost, realizedPnL, boughtToday, tradeCount, totalFees, totalStampTax, cumInjected }`。
- **逐 K 线心跳**：先 `settleInjectionsUpTo(当日)`（DCA 盘前入金）→ 再执行该日全部订单（时间+seq 升序）→ 打当日快照。
- **buy**：校验 `cash ≥ 成交额+规费`；不足时先尝试 L1 自动降档（非基线、缺口 ≤ max(¥50, 成交额 0.2%)）、否则给 `INSUFFICIENT_CASH` 拒绝（附「减至最大可买量/插一笔卖出/调高模拟资金」行动指引）。
- **sell**：校验持仓（`INSUFFICIENT_POSITION`）；T+1 用 `可卖 = position − boughtToday`，倒T出借(kind=borrow)豁免（`T1_LOCK`）；超评估日 → `BEYOND_ASOF`。
- **抖动**：非基线订单按 `seedPrefix|orderId` 确定性抖动成交价；基线锚定真实盘价不做滑点。
- **评估日清算**：已实现+浮动，收益基准 = 累计投入本金 `simulatedCash + Σ注入`；回撤 = 相对峰值资产的户权；含“中途浮盈回吹”警示；`principal/capitalWeighted/timeWeighted` 三口径。
- **返回** `{ ok, result, rejections[], warnings[], peakRequiredCash }`；任一 reject → `ok=false`、result 置空。

---

## 4. 整体运行逻辑（数据流）

```
① 用户打开 /sandbox  →  EmptyStateGuide（未选标的）
② 选标的（搜索/账本快捷）
     │  经 useSandboxStore.selectStock
     ├─ 读真实持仓 Position.batches
     ├─ extractBaseline(position)        ← 生成基线订单 + 峰值资金 + 指纹
     ├─ 拉前复权 K 线（getKline，三级缓存）  ← 起点 = 首笔建仓日；终点 = 已平仓→平仓日 / 未平仓→最新 K 线
     └─ 建「基线」分支（只读）并排除运行 → 立即计算指标
③ 派生与编辑
     ├─ 生成预设：generatePreset(id, params, cash) →
     │    策略生成器（确定性纯函数）→ 合并基线+生成单 → 引擎 → preset 分支（订单不落库）
     └─ 复制预设 → copyBranch → user 分支（深拷贝订单，可编辑、落库）
        编辑（点线/时间线/批量）→ updateUserOrders（内存草稿 + 标记未保存）
④ 运行与保存
     runSimulation(branchId) → 引擎重演 → result 落库 + 盖章评估日 + 清未保存标记
⑤ 对比
     toggleCompare 勾选 ≥2 分支 → buildComparisonRows（四维最优）＋散点图
⑥ 时效与重建
     checkBranchStale 检测 ⚠️(行情) / ⚡(资金) / 🔄(基线) → 点击后 refreshKline / rescale / rebuildBaseline
```

引擎单次推演的核心循环（`runSandboxEngine`）：

```
输入：订单时间线 + 前复权 K 线 + { simulatedCash, feeConfig, jitter, asOfDate, cashInjections }
状态机: { cash, position, avgCost, realizedPnL, boughtToday, 已实现/浮动 }
遍历订单（时间+seq 升序）:
  buy  → 校验 cash >= 成交额 + 规费（不足 → INSUFFICIENT_CASH + 行动指引）
         cash -= 支出；position += qty；移动加权更新 avgCost；T+1（当日买入当日卖出拦截）
  sell → 校验 position >= qty（不足 → INSUFFICIENT_POSITION）
         校验评估日（超 asOfDate → BEYOND_ASOF）
         cash += 回收 - 规费；position -= qty；累计已实现盈亏
  成交价 = 期望价 × 抖动（基线 jitter=0 锚定真实价；预设按周围 K 波动率抖动，同 seed 可复现）
日出金（DCA）: 先结算当日到期现金注入（盘前），再撮合 → 不突破预算
评估日清算:
  未实现盈亏 = 剩余持仓 × (评估日收盘 − 均价)
  最终收益 = 已实现 + 未实现（三口径：principal / capitalWeighted / timeWeighted）
  回撤/波动率/B&H 等由 metricsEngine 在原上补全
返回 { ok, result, rejections[], warnings[], peakRequiredCash }
```

---

## 5. 快速上手（开发指南）

### 5.1 前置

- 依赖 `lightweight-charts`（package.json 已加）、`dexie`、`zustand`。
- 本地 K 线代理：`vite.config.ts` `/api-kline` → `https://ifzq.gtimg.cn`；线上在 `middleware.js`
  `UPSTREAMS` 加 `/api-kline` + matcher，SW `navigateFallbackDenylist`加 `/^\/api-kline/`。

### 5.2 改代码前先理解三种拒口

1. **三级缓存**（内存 → IndexedDB → 网络）：改 `klineService` 不影响 UI，但注意 `klineCache` 表结构；
2. **非响应式 memo**：`sandboxStore` 的 `computeBranchResult` 用 Map + LRU 上限缓存派生结果，
   **不要把它塞进呼应式 Zustand state**，否则渲染风暴；调用走 `getComputed()` 非响应式 getter；
3. **基线自校验**：基线末端股数必须=账本 `currentAmount`，否则给出「基线校验异常」警告。

### 5.3 改策略生成器

- 统一实现 `StrategyGenerator`（`id/name/description/defaultParams/paramLabels/generate`），
  注册进 `STRATEGY_GENERATORS` 注册表即出现在预设对话框。
- 必须满足不变量：数量 100 股整数倍、买入 ≤ 可用现金、订单落在 K 线日期、**结果确定性**（纯函数）。
- 需要 DCA 感知时读取 `ctx.simulatedCash + Σ cashInjections.amount`（定投类）或 `ctx.cashInjections`（手动追加）。

### 5.4 修改 DCA

DCA 相关字段：`SandboxBranch.injectionType`（none/monthly/custom）、`cashInjections[]`、
`store` 的 `addCashInjection` / `setMonthlyDCA` / `clearCashInjections`；引擎在 `settleInjectionsUpTo` 处盘前结算。
新增注入频率时需同时改类型、`PresetContext`、store 三个入口。

### 5.5 常用命令

```bash
npm install                              # 安装依赖（lightweight-charts 等）
npm run dev                              # 本地开发（Vite + PWA）
npm test                                 # 全量单测（fixture 全内存）
npx vitest run src/__tests__/sandbox*.test.ts   # 仅沙盘相关
npm run build                            # 构建 + postbuild（SW）
```

### 5.6 测试方法与如何新增用例

**测试架构**：全部单测用 `fake-indexeddb`（DAO/缓存，无需真实 IndexedDB），K 线网络层被 mock
（`klineService` 的 fetch 打桩），共享夹具 `src/__tests__/helpers/sandboxFixture.ts`（基线 4 笔批次、
90 根前复权 K 线 10→13.5、A 股费率套餐）。因此**离线可跑、确定性可复现**。

**9 个沙盘相关文件**：

| 文件 | 测什么 | 典型断言 |
|---|---|---|
| `sandboxEngine.test.ts` | 引擎纯逻辑 | 资金约束/T+1/持仓不足/超评估日/统一评估日/抖动可复现/规费一致/基线自洽 |
| `strategyGenerators.test.ts` | 8 套生成器不变量 | 100 股取整、现金不超支、确定性、顺序一致 |
| `sandboxStore.test.ts` | 状态层 | 前复权换算、基线与预设合并、K 线起点、三源过期、memo 复用 |
| `sandboxDb.test.ts` | DAO | 分支 CRUD、订单批量幂等、K 线缓存往返 |
| `sandboxE2E.test.ts` | 全链路 | 预设生成→复制→编辑→撤销→保存→落库重载（§2 关键用例） |
| `sandboxPlayback.ui.test.tsx` | UI | 新手/专业模式、未保存浮动栏、拒绝弹窗 |
| `sandboxPositionDiscrepancy.test.ts` | 基线一致性 | 基线重演少股排查（正常/OOA/批次缺失/在途出借） |
| `klineService.test.ts` | 数据服务 | 解析、复权系数表、增量合并/漂移检测 |
| `presetAudit.test.ts` | 策略静态审计 | 真实前复权 K 线逐策略跑出买卖/触发原因，核对资金不变量 |

**如何新增用例**：
1. 引擎/生成器/metrics 这类纯函数：直接构造 `orders + kline` 夹具 call，断言 rejections/warnings/result 即可；
2. store 行为：`useSandboxStore.getState().xxx(...)` 串行驱动，临时 `expect` 状态或 `getComputed()`；
3. 涉及 DB：`fake-indexeddb/auto` 初始化后 `putX`/`loadX` 往返断言；
4. UI：`@testing-library/react` 渲染 `SandboxPlayback`，mock store，断言文案/DOM。
5. 跑：`npx vitest run src/__tests__/sandbox*.test.ts src/__tests__/strategyGenerators.test.ts src/__tests__/klineService.test.ts src/__tests__/presetAudit.test.ts`（或全量 `npm test`）。

---

## 6. 已知边界与本文件后续维护

- **预算口径边缘**：合并基线+生成策略时，策略买入大小按「独立预算」计划，与基线共用同一模拟资金，
  可能触发 `INSUFFICIENT_CASH`；该口径已在 §2.3 按**方案 2** 修复（仅当存在基线订单时扣峰值锁预算，边界删除基线卖单导致的现金回笼消失属符合语义的拒绝）。
- 倒T出借（`borrow`）/归并（`merge`）批次已纳入基线时间线（不会让做T利润"凭空消失"）。
- 长历史（>5 年前）可能出现数据源范围外，结合分页拉取；除权会导致前复权历史重锚 → 边界漂移检测兜底。

## 7. 代码注释与注解补充（关键不变量索引）

> 以下批注在**源码注释里已成文**，此处汇总成索引，便于新人对“为什么这样写”快速建立心智模型。

| 位置（文件/符号） | 注释/不变量要点 |
|---|---|
| `sandboxStore.ts` → 方案2 预算 | `strategyCtx.simulatedCash = max(0, generatedAtCash − (baselineOrders.length>0 ? peakCapitalLock : 0))`；预设单并入唯一合并时间线与基线共用预算时先留基线峰值资金，避免越限。 |
| `sandboxStore.ts → memoCache` | `computeBranchResult` 用 **Map+LRU 上限**缓存派生结果；非响应式 getter `getComputed()`，勿塞进响应式 state 以免渲染风暴。 |
| `sandboxStore.ts → mergeBaselineAndGenerated` | 基线与生成单合并为同一条时间线（同一 `Kline` 撮合），基线只读锚点。 |
| `sandboxEngine.ts → jitterPrice` | 显示顺序确定性种子 `seedPrefix|orderId`；基线 `isBaseline` 一律 jitter=0（锚定真实盘价），否则峰值资金自洽性会漂移。 |
| `sandboxEngine.ts → buy` | 现金/成交额按 `round2`（分）比较，避免浮点 epsilon 把“恰好够”误判为不足；L1 自动降档阈值 `≤ max(¥50, 成交额 0.2%)`。 |
| `sandboxEngine.ts → sell` | T+1 用 `可卖 = position − boughtToday`；`kind==='borrow'`（倒T出借）豁免。 |
| `sandboxEngine.ts → settleInjectionsUpTo` | DCA 盘前结算注入（当日先入金再撮合）；以注入日游标 O(n) 结算，同一日期幂等。 |
| `sandboxEngine.ts → 评估日` | 兜底“仍有订单晚于行情末根”→ 显式拒 `BEYOND_ASOF`，不静默丢弃。 |
| `sandboxStore.ts → 基线自校验` | 基线分支引擎末端持仓 = 账本 `currentAmount`，否则告警“基线校验异常/重演不完整”。 |
| `strategyGenerators.ts` | 不变量：100 股整数倍、买入 ≤ 可用现金、订单落在 K 线日期、**确定性纯函数**；DCA 感知：`ctx.simulatedCash + Σ injections`。 |
| `metricsEngine.ts → enrichResult` | volatility 等统计由 metrics 从快照补算，避免引擎依赖统计逻辑。 |

---

## 8. 相关文档索引

- `docs/sandbox-replay-spec.md` — 完整设计规格（含目标、数据模型、UI 设计、测试计划）。
- `docs/position-ledger-spec.md` — 基线数据源（持仓批次语义）。
- `docs/behavior-spec.md` — 做T批次行为基线。