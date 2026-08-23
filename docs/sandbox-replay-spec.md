# 事后复盘（沙盘推演 / What-if）功能规格

> **实现状态：本方案已实现**（核心功能全部落地，见附录 §16「实现现状与追加」）。
> 各规格章节仍为**设计目标**；如需当前已落盘的文件/行数/测试/运行逻辑，阅读附录 §16 或
> `docs/sandbox-replay-implementation.md`（实现与开发上手）。

---

> 版本：草案 v1（完整落地方案）
> 范围：独立页面；仅对中长期仓位开放推演；基线纳入做T归并/出借批次
> 核心价值：以历史真实资金为硬约束，允许用户在时间线上自由修改买卖节点与仓位，动态重演并量化不同决策路径的优劣
> 关联：`docs/position-ledger-spec.md`（基线数据源）、`docs/behavior-spec.md`（做T批次语义）、`docs/sandbox-replay-implementation.md`（实现与开发上手）

---

## 0. 功能定位与使用场景

### 0.1 一句话定位

> **以真实资金为硬约束的"如果当时……"沙盘：锁定历史最大资金占用峰值作为预算，重演不同买卖决策路径，量化对比收益/风险/成本。**

### 0.2 目标用户场景

| 场景 | 典型问题 | 本功能答案 |
|---|---|---|
| 操作习惯复盘 | "我越跌越死扛是不是错了？" | 基线 vs 预设策略对比 |
| 交易纪律验证 | "网格/金字塔/止损规则到底有没有用？" | 4 种预设策略自动生成 + 对比 |
| 资金管理推演 | "如果当初资金多/少一些，配比怎么调整？" | 模拟资金调整 + ⚡ 一键重配 |
| 持续持仓诊断 | "我现在该加仓还是该等？" | 统一评估日清算 + 假设推演 |
| 波段 vs 死拿 | "频繁操作真的跑赢 Buy & Hold 了吗？" | B&H 基准对比 |

### 0.3 明确的范围边界

- ✅ 只对**中长期仓位**开放（`positions` / `positionBatches`），**不含短线日内流水池推演**
- ✅ 基线**纳入**做T归并（`kind='merge'`）与出借（`kind='borrow'`）批次——中长期仓位常由短线归并而来，剔除会导致做T利润在推演中"凭空消失"
- ✅ 支持**持续未平仓仓位**（统一评估日 + 市价标记清算）
- ❌ 不支持区间复盘（如"只看 2024 年"），Phase 2 再做
- ❌ 系统**永不自动调整**任何方案，所有变化由用户手势触发

### 0.4 用户体验目标（认知降维）

系统逻辑强大但存在较高认知门槛。若不做体验降维，用户容易产生四类困惑，必须在设计中预置解答：

| 困惑维度 | 典型场景 | 对策（详见对应章节） |
|---|---|---|
| 概念与规则 | "为什么我不允许买？"（资金硬顶 / T+1） | 拦截给出**行动指引**而非干瘪报错（§4.1.1） |
| 指标与算法 | "为什么这笔推演赚得少/亏得多？"（评估日浮亏 / 滑点） | 结果给出**原因解释**（已实现/浮动拆分 + 滑点气泡）（§4.2 / §4.4） |
| 操作与状态 | "我改的东西去哪了？"（只读无法改 / 预览未保存） | 状态给出**去向引导**（复制引导 Tooltip + 未保存浮动栏）（§9.6 / §9.7） |
| 认知负荷 | 术语复杂、参数繁多 | 默认**极简新手模式** + 白话术语（§9.4 / §1.5） |

---

## 1. 核心设计原则

### 1.1 三大支柱

```
┌─────────────────────────────────────────────────────────────────┐
│  支柱一：真实资金硬上限（Peak Capital Lock）                      │
│    自动锁定该标的历史最大资金占用峰值作为沙盘总预算               │
│    推演中每次买入受可用现金约束，禁止透支/加杠杆                   │
│    （基线永远用峰值；预设方案可调"模拟资金"，UI 明确标注"模拟"）   │
│                                                                 │
│  支柱二：只读模板 + 可写沙盒（三层分支模型）                      │
│    baseline（基线·只读）→ 实时从真实持仓派生，永不可编辑          │
│    preset（预设·只读）→ strategyId+params 派生，可"复制并微调"    │
│    user（用户方案·可写）→ 订单落库，完全可编辑                    │
│                                                                 │
│  支柱三：统一评估日 + 市价标记（As-of Date + Mark-to-Market）     │
│    所有方案在同一评估日、同一收盘价下清算                         │
│    持续持仓的浮盈/浮亏计入最终收益，回撤含浮盈回吐                │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 三条铁律（交互规范）

```
1. 系统永不自动修改订单/参数 —— 所有变化都由用户手势触发
2. 系统永不自动重跑推演 —— 实时预览 ≠ 落库，提交必须点【运行推演】
3. 系统永不自动覆盖用户副本 —— ⚡/⚠️/🔄 过期提示只展示，不执行
```

### 1.3 复盘的时效性认知

**策略会过期**：K 线每天更新 → MA20/MA60、箱体、ATR 全部漂移 → 预制方案点位失效。
所有方案必须携带**数据时效戳**，且过期提示全部由用户点击确认后刷新（见 §8）。

### 1.4 认知降维四原则

1. **拦截给行动指引**：任何拒绝（资金不足 / T+1 锁定 / 超评估日）都必须附带可执行的补救选项，而非只报错；
2. **结果给原因解释**：任何可能让用户觉得"算错了"的数值（浮盈亏、滑点成交价）都必须就地解释；
3. **状态给去向引导**：任何"不能做 / 没保存"的状态都必须告诉用户"接下来该怎么做"；
4. **默认简化呈现**：高阶参数默认折叠，新手默认只看 4 个核心数字。

### 1.5 术语白话对照表（全站文案契约）

> 本表内的技术术语在本功能**所有 UI 文案中必须使用白话版**，技术术语仅用于代码与文档。

| 技术术语 | 白话文案（UI 展示） |
|---|---|
| Peak Capital Lock | 历史最高占用资金（预算上限） |
| As-of Mark-to-Market 清算 | 统一折算至今日现价 |
| 统一评估日（As-of Date） | 对比截止日（所有方案折算到同一天） |
| Jitter Slippage | 模拟实盘滑点误差 |
| 抖动系数 | 滑点大小（新手默认 0.25，可不改） |
| Max Drawdown | 最大回撤（中途最惨时亏了多少） |
| Buy & Hold 基准 | 死拿不动对照组 |
| 前复权 K 线 | 已扣掉分红除权影响的历史价格 |
| 模拟资金 | 假如当初资金是这么多（非真实，仅推演） |
| 沙盒分支 / 用户方案 | 你的演练版本 |
| 基线（Baseline） | 你当年的真实操作 |
| 预设方案（Preset） | 系统标准策略（不可改，可复制） |

---

## 2. 数据模型设计

### 2.1 类型定义（`src/types/sandbox.ts`）

```typescript
/** 分支类型：基线 / 预设 / 用户方案 */
export type SandboxBranchType = 'baseline' | 'preset' | 'user';

/** 沙盘分支（一张表统一三种类型） */
export interface SandboxBranch {
  id: string;
  fullCode: string;                 // 关联标的（含市场前缀，如 sh601318）
  stockName: string;
  branchType: SandboxBranchType;
  branchName: string;
  status: 'draft' | 'completed';

  // ---- 资金 ----
  peakCapitalLock: number;          // 历史资金占用峰值（全量批次口径，含做T调整）
  simulatedCash: number;            // 模拟资金（默认=峰值，可调，UI 标注"模拟"）

  // ---- 时效戳（策略过期的三大来源，全部可追溯） ----
  dataAsOfDate: string;             // 生成/推演时最后一根 K 线日期（YYYY-MM-DD）
  lastRunAt: number;                // 最后推演时间戳（epoch ms）
  generatedAtCash: number;          // 上次生成时资金 → ⚡ 检测
  lastBaselineSignature: string;    // 基线指纹（批次数量|末笔时间|当前股数）→ 🔄 检测

  // ---- 预设专属（branchType === 'preset'） ----
  presetStrategyId?: string;        // 'ma20-bounce' | 'pyramid' | 'grid' | 'stop-profit'
  presetParams?: Record<string, number>;

  // ---- 用户方案专属（branchType === 'user'） ----
  parentPresetId?: string;          // 溯源：来自哪个预设
  decoupledFromPreset?: boolean;    // 已"保存为我的策略"（解除关联）

  // ---- 抖动配置 ----
  jitterFactor: number;             // 默认 0.25（基准波动率 × 系数 = 抖动范围）
  jitterWindowSize: number;         // 默认 5（取目标日期前后各 N 根 K 线统计）

  resultJson?: string;              // 推演结果（SandboxResult 序列化）
  createdAt: number;
  updatedAt: number;
  isDeleted: 0 | 1;                 // 软删除（与现有表约定一致）
}

/** 沙盘订单（仅 user 分支落库；preset 订单为派生数据） */
export interface SandboxOrder {
  id: string;
  branchId: string;
  seqIndex: number;                 // 时间线序号
  action: 'buy' | 'sell';
  timestamp: string;                // ISO 时间戳（可编辑）
  price: number;                    // 期望价（抖动前）
  quantity: number;                 // 数量（股）
  fee?: number;                     // 规费（推演时计算）
  kind?: 'borrow' | 'merge';        // 做T调整标注（倒T出借/归并）
  sourceRoundId?: string;           // 溯源做T轮次
  note?: string;
  isBaseline?: boolean;             // 来自基线（还原用）
}

/** K 线条目（日线，前复权） */
export interface KlineItem {
  date: string;                     // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 推演结果 */
export interface SandboxResult {
  asOfDate: string;                 // 评估日
  finalProfit: number;              // 最终收益 = 已实现 + 未实现
  realizedProfit: number;           // 已实现盈亏
  unrealizedProfit: number;         // 未实现盈亏（剩余持仓 ×（评估日收盘−均价））
  returnRate: number;               // 累计收益率 = finalProfit / simulatedCash
  maxDrawdown: number;              // 最大回撤（%）
  volatility: number;               // 持仓波动率（日收益标准差）
  totalFees: number;                // 累计规费
  totalStampTax: number;            // 累计印花税
  tradeCount: number;               // 交易笔数
  capitalOccupationDays: number;    // 资金占用周期
  finalPosition: number;            // 评估日剩余持股数
  finalCash: number;                // 评估日剩余现金
  buyAndHold: {
    finalProfit: number;
    returnRate: number;
    maxDrawdown: number;
  };
  snapshots: SandboxSnapshot[];     // 市值曲线快照
}

/** 时间线快照（每个操作节点 + 每根 K 线） */
export interface SandboxSnapshot {
  timestamp: string;
  position: number;                 // 当前持股
  cost: number;                     // 当前持仓成本（移动加权）
  marketPrice: number;              // 当日收盘价
  cash: number;                     // 剩余现金
  totalAsset: number;               // 总资产 = cash + position × marketPrice
  unrealizedPnL: number;            // 浮动盈亏
  drawdown: number;                 // 相对峰值回撤（%）
}

/** 四维对比指标（对比表一行） */
export interface ComparisonRow {
  metric: string;                   // 指标名
  key: string;                      // 指标键
  values: Record<string, number>;   // branchId → 值
  bestBranchId: string | null;      // 该维度最优方案
  direction: 'higher' | 'lower';    // 最优方向
}
```

### 2.2 DB 表（`src/db/schema.ts` 升级 `STORES_V11`）

```typescript
// 表 1：sandboxBranches
interface SandboxBranchEntity {
  id: string;                 // @@ primary key
  fullCode: string;           // @@ index
  stockName: string;
  branchType: 'baseline' | 'preset' | 'user';
  branchName: string;
  status: 'draft' | 'completed';
  peakCapitalLock: number;
  simulatedCash: number;
  dataAsOfDate: string;
  lastRunAt: number;
  generatedAtCash: number;
  lastBaselineSignature: string;
  presetStrategyId?: string;
  presetParamsJson?: string;  // Record<string, number> 序列化
  parentPresetId?: string;
  decoupledFromPreset?: number; // 0 | 1
  jitterFactor: number;
  jitterWindowSize: number;
  resultJson?: string;
  createdAt: number;
  updatedAt: number;
  isDeleted: 0 | 1;
}

// 表 2：sandboxOrders（仅 user 分支落库）
interface SandboxOrderEntity {
  id: string;                 // @@ primary key
  branchId: string;           // @@ index
  seqIndex: number;
  action: 'buy' | 'sell';
  timestamp: number;          // epoch ms
  price: number;
  quantity: number;
  fee?: number;
  kind?: 'borrow' | 'merge';
  sourceRoundId?: string;
  note?: string;
  isBaseline?: number;        // 0 | 1
  isDeleted: 0 | 1;
}
```

### 2.3 三类分支的数据落库约定

| 分支类型 | 订单来源 | 可编辑 | 资金变时 | 落库内容 |
|---|---|---|---|---|
| `baseline` | 从 `Position.batches` 实时派生 | ❌ | 不变（历史事实） | 只存 `baselinePositionId` 关联，不存订单 |
| `preset` | 从 `strategyId + params` 确定性生成 | ❌ | ⚡ 点击重算 | 只存元数据，不存订单（订单=派生数据） |
| `user` | 用户手动编辑（复制时深拷贝） | ✅ | ❌ 永不自动改 | 元数据 + 订单全部落库 |

> **派生订单的确定性**：K 线是历史固定数据，`generate(strategyId, params, kline, cash)` 是纯函数，结果确定 → 重配只需换参重跑，不存在"订单过期"。

---

## 3. 基线提取逻辑（`src/utils/baselineExtractor.ts`）

### 3.1 提取规则

```
输入：Position（含批次履历）
输出：{ orders, peakCapitalLock, signature }

规则：
① 全量纳入 —— 不过滤 kind，borrow/merge 做T调整批次全部进入时间线
② 时间升序排序
③ 方向映射：open/add/merge → buy；reduce/close/borrow → sell
④ 数量取绝对值；amount < 0 兼容为卖出（与 recalculatePosition 口径一致）
⑤ 每条订单保留 kind + sourceRoundId，UI 标注"倒T出借/倒T归并"
⑥ 峰值资金 = 全量批次时间线上的最大资金占用（含做T现金节奏）
⑦ 基线指纹 = `${批次数量}|${末笔时间戳}|${当前持股数}` → 用于 🔄 过期检测
```

### 3.2 自校验护栏

基线跑完推演后，引擎末端持仓数量**必须等于** `Position.currentAmount`（真实当前持股数）。不等 → 提示"基线提取异常"并阻断推演。

---

## 4. 推演引擎（`src/utils/sandboxEngine.ts`）

### 4.1 引擎状态机

```
状态：{ cash, position, avgCost, realizedPnL, snapshots[], boughtToday }
初始：cash = simulatedCash, position = 0（全历史复盘从零开始）
boughtToday = 当日累计买入数量（用于 T+1 锁定，跨日重置为 0）

遍历订单（时间升序）：
  buy  → 校验 cash ≥ 成交额 + 规费 → 不足返回 INSUFFICIENT_CASH
          cash -= 成交额 + 规费；position += 数量；boughtToday += 数量；移动加权更新 avgCost
  sell → 可卖数量 = position − boughtToday（T+1：当日买入不可当日卖出）
          校验 可卖数量 ≥ 卖出数量 → 不足返回 INSUFFICIENT_POSITION 或 T1_LOCK
          cash += 成交额 − 规费；position -= 数量；realizedPnL += 净回款 − 成本基数
  （日期变化时 boughtToday 重置为 0）

每个交易日节点 → 追加快照：totalAsset = cash + position × 当日收盘价
末端（评估日）→ 清算未实现盈亏
```

> **T+1 规则**：A 股当日买入的股份当日不可卖出。引擎按日跟踪 `boughtToday`，只有"昨日及以前持有的仓位"当日可卖。基线中带 `kind='borrow'`（倒T出借）的卖出属于昨日底仓，不受影响。

### 4.1.1 结构化拒绝与行动指引（拦截解释）

引擎拒绝时**不返回干瘪错误**，返回结构化对象，UI 据此渲染"行动指引对话框"：

```typescript
interface EngineRejection {
  code: 'INSUFFICIENT_CASH' | 'INSUFFICIENT_POSITION' | 'T1_LOCK' | 'BEYOND_ASOF';
  orderId: string;
  /** 白话原因 */
  message: string;
  /** 可执行的补救选项（UI 渲染为按钮，点击直接执行） */
  actions: Array<{
    label: string;                 // 如 "减至 300 股" "去顶部调高模拟资金"
    kind: 'reduce-qty' | 'insert-sell' | 'raise-cash' | 'move-date' | 'cancel';
    payload?: Record<string, number>;
  }>;
}
```

| 拒绝码 | 白话原因（message 示例） | 行动选项（actions） |
|---|---|---|
| `INSUFFICIENT_CASH` | "这笔买入超出当前方案预算上限 ¥20,000（历史最高占用资金）。" | ① 减至 300 股（按可用资金反算最大可买量）；② 先插入一笔卖出释放现金；③ 去顶部把"模拟资金"调高 |

> **「减至最大可买量」的算式精度（编码硬性要求）**：反算最大可买量必须**先扣除该笔买入的预估规费**（净佣金 + 最低保底 + 经手费 + 证管费 + 过户费，按 `calcTradeFees()` 试算），再向下取整到 100 股整数倍，即：
>
> ```
> maxQty = floor( 可用现金 / ( 期望价 × (1 + 预估费率) + 每股固定规费 ) / 100 ) × 100
> ```
>
> 直接 `floor(cash / price / 100) × 100` 会因漏算规费产生"以为买得起、实际结算时透支"的边界误差，属于必须规避的已知坑。
| `T1_LOCK` | "A 股实行 T+1：当天买入的 1000 股，需下一个交易日才能卖出（除非用昨日已持有的底仓）。" | ① 把卖出移到下一个交易日；② 改卖昨日底仓数量 |
| `INSUFFICIENT_POSITION` | "当前持仓只有 500 股，无法卖出 800 股。" | ① 减至 500 股；② 先插入一笔买入 |
| `BEYOND_ASOF` | "订单日期超出 K 线范围，无法推演未来。" | ① 移到最近交易日 |

### 4.2 统一评估日（As-of Date）

```
asOfDate = min(
  所有参与对比方案中的最后一笔操作日,
  最后一根 K 线日期,
  今日
)

统一清算：
  总资产 = 累计现金 + 剩余持仓 × 评估日收盘价
  最终收益 = 总资产 − 初始资金（simulatedCash 口径）
```

**为什么必须统一评估日**：基线可能 2024-03 之后一直持有、分支A 2024-06 清仓、分支B 持有到今天——不统一则时间跨度不同，收益不同量纲，对比无意义。统一后在同一个日期、同一个收盘价下清算，天然公平。

**展示要求（消除"推演亏了"的困惑）**：
- 指标卡片上**显式拆分**"已实现盈亏"与"持仓浮动盈亏"（如：已实现 +12,530 / 浮动 −3,240）
- 时间线末端打醒目标记："📌 统一于 2026-08-20 按现价折算清算"（白话版：统一折算至今日现价）
- 若方案中间盈利高于基线但评估日亏损（近期大跌导致），结果旁提示："该方案中途最高浮盈 +X，因持有至今遇回调，评估日结算为 −Y。可在时间线上提前插入卖出落袋。"

### 4.3 规费对齐

复用现有 `calcTradeFees()`（`utils/mathUtils.ts`），自动内嵌：净佣金 + 最低保底门槛 + 经手费 + 证管费 + 过户费 + 印花税；`matchSecurityKind()` 按证券类型走对应费率（股票/ETF/港股等）。推演盈亏与实盘交割完全一致。

### 4.4 动态价格抖动（基于周围 K 线波动率）

```
输入：期望价 P、目标日期 D、K 线数组、抖动系数 jitterFactor、窗口 windowSize
流程：
 ① 定位 D 在 K 线中的索引（不存在则向前取最近交易日）
 ② 取前后各 windowSize 根 K 线（共 2×windowSize+1 根）
 ③ 每根振幅 = (high − low) / close
 ④ 基准波动率 = 振幅序列的中位数
 ⑤ 抖动范围 = 基准波动率 × jitterFactor
 ⑥ 实际成交价 = P × (1 + random(−抖动范围, +抖动范围))
 ⑦ 使用固定随机种子（seed = branchId + orderId），保证可复现
效果：
 - 横盘震荡期 → 振幅小 → 抖动小 → 成交接近期望价
 - 剧烈波动期 → 振幅大 → 抖动大 → 滑点如实反映
 - 涨停/跌停日 → 振幅极端 → 抖动大 → 提示可能无法成交

**展示要求（消除"系统算错"的困惑）**：
- 成交价旁显示滑点气泡："期望价 ¥16.50 → 模拟实盘滑点成交 ¥16.58"
- 气泡内附白话说明："滑点来自当日及周边 K 线的真实波动幅度；若不想模拟滑点，可去顶部把滑点大小设为 0"
```

### 4.5 指标计算（`src/utils/metricsEngine.ts`）

| 维度 | 指标 | 口径 |
|---|---|---|
| 收益表现 | 最终收益额 / 累计收益率 | 已实现 + 未实现（评估日市价标记） |
| 风险控制 | 最大回撤 / 持仓波动率 | 市值曲线（**含浮盈回吐**）；日收益标准差 |
| 持仓基准 | Buy & Hold 超额 | 首笔金额首笔价买入 → 持有到评估日清算，同一量纲 |
| 交易成本 | 累计规费 / 印花税 / 资金占用周期 | 引擎逐笔累计 |

---

## 5. 预设策略生成器（`src/utils/strategyGenerators.ts`）

统一接口 + 注册表：

```typescript
interface StrategyGenerator {
  id: string;                       // 'ma20-bounce' | 'pyramid' | 'grid' | 'stop-profit'
  name: string;
  description: string;
  defaultParams: Record<string, number>;
  paramLabels: Record<string, string>;
  generate: (ctx: StrategyContext) => SandboxOrder[];
}

interface StrategyContext {
  klineData: KlineItem[];
  baselineOrders: SandboxOrder[];   // 历史/兼容保留（当前无生成器使用）
  peakCapitalLock: number;
  simulatedCash: number;
  currentPrice: number;             // 最后一根 K 线收盘
  currentCost: number;
  currentQuantity: number;
  feeConfig: FeeConfig;
  securityKind: SecurityKind;
}
```

### 5.1 四大经典策略

| # | 策略 | 触发价位规则 | 资金分配算法 | 适用场景 |
|---|---|---|---|---|
| 1 | **支撑均线低吸** `ma20-bounce` | P₁=MA20、P₂=MA60（仅取低于现价的支撑位） | 剩余资金 50%:50% 等额分批 | 上升趋势回踩加仓 |
| 2 | **金字塔左侧摊薄** `pyramid` | 现价每跌 3%~5% 设一个补仓点（或 ATR 动态步长） | 1:2:3（20%:30%:50%）越跌买越多 | 深套解套、波段自救 |
| 3 | **波动区间网格** `grid` | 近 N 日箱体：买=下沿+0.382 黄金分割，卖=上沿−0.618 | 资金 4~6 等份，触下轨买 1 份、触上轨卖 1 份 | 震荡市、ETF 做T |
| 4 | **破位止损/达标止盈** `stop-profit` | 止损=近 20 日最低 或 亏损 5% 取较宽松者；止盈=2R 风险报酬比 | 2% 账户风险原则反推平仓股数 | 趋势交易、严格风控 |

**共性约束**：数量向下取整至 100 股整数倍；买入总额 ≤ 可用现金；订单全部落在 K 线日期上。

### 5.2 生成交互

- 用户点击 **【✨ 一键生成预设方案】** → 弹出对话框（勾选策略 + 全局参数：抖动系数、初始资金）
- 每个策略独立运行：`generate()` → 推演 → 建 preset 分支 → 卡片展示结果
- 预设卡片只读，提供 **【📋 复制并微调】** → 深拷贝订单成 user 分支

---

## 6. 缓存与性能架构（三级 + 非响应式 Memo）

### 6.1 计算量评估

| 环节 | 耗时 | 结论 |
|---|---|---|
| 5 个策略生成器 + 推演引擎 | 2~10 ms | 纯 CPU 轻量逻辑，无需优化 |
| K 线网络请求 | 100~500 ms | **真正瓶颈，必须缓存** |
| 图表 DOM 渲染 | 10~50 ms | lightweight-charts canvas 批渲染 |

### 6.2 三级缓存

```
第 1 级：IndexedDB（klineCache 表）
  key = fullCode + period（日线）
  value = { bars[], lastFetchedAt }
  持久化，PWA 离线可回放

第 2 级：内存 Map（klineMemo）
  页面生命周期内共享，避免重复解析

第 3 级：网络（增量）
  打开某标的沙盘 → 读本地 → 无数据则全量拉 → 有数据则增量拉
  增量 = 以本地最后一根 K 线日期为起点请求 → 按日期去重合并
```

### 6.3 非响应式 Memo（关键设计）

**缓存是纯派生数据，不放进响应式 Zustand 状态**（避免渲染期 setState 造成 re-render 风暴）：

```typescript
// src/store/sandboxStore.ts —— 模块级非响应式缓存
const memoCache = new Map<string, BranchComputed>();
const MEMO_LIMIT = 300; // LRU 上限

export function computeBranchResult(branch, kline, savedOrders?): BranchComputed {
  const last = kline[kline.length - 1];
  // 缓存键：分支 + 模拟资金 + K线版本（长度 + 末根日期 + 末根收盘）
  const key = `${branch.id}|${branch.simulatedCash}|${kline.length}|${last?.date ?? '-'}|${last?.close ?? 0}`;
  const hit = memoCache.get(key);
  if (hit) return hit;
  // ... 派生订单（preset）或读取 savedOrders（user）→ runSandboxEngine → 写入 Map
}

// 响应式状态只放 UI 消费的最小集
interface SandboxStoreState {
  branches: SandboxBranch[];
  selectedBranchId: string | null;
  comparedBranchIds: string[];
  activeComputed: BranchComputed | null;   // 当前显示结果
  selectBranch(id): void;                  // action 内同步计算后 set 一次
  toggleCompare(id): void;
  // ... 分支 CRUD / 生成预设 / 复制 / 重配 / 运行推演
}
```

**缓存失效自动性**：缓存键含 `simulatedCash` 与 K 线版本 → 资金变、K 线更新都会生成新键自动失效；历史数据修正靠末根 close 变化兜底。

### 6.4 懒计算

- 打开沙盘页 → **不拉任何 K 线**，只算基线（基线订单来自真实持仓，资金类指标无需 K 线）
- 用户选择标的 → 才拉该标的 K 线（配合缓存，二次进入零等待）
- 生成预设 / 展开对比 → 批量命中 memoCache，无感

---

## 7. 持续持仓（未平仓仓位）处理

### 7.1 核心设计：统一评估日 + 市价标记（见 §4.2）

### 7.2 指标口径（持续持仓）

```
最终收益 = 已实现盈亏 + 未实现盈亏
         └─ 未实现 = 剩余持仓 × (评估日收盘价 − 持仓均价)
最大回撤 = 市值曲线（含浮盈回吐）的最大回撤   ← 暴露"扛单"真实风险
B&H     = 首笔金额首笔价买入，持有到评估日清算（同一量纲）
```

### 7.3 K 线数据范围

```
起始 = 首笔建仓日（第一条 type='open' 批次；缺失则退回最早任意批次）
结束 = 已平仓 → 平仓日 closedAt；仍持仓 → 最新一根 K 线（可能推演到今天）
长历史按年分页拉取（单次请求上限约 640 根），按日期去重合并
必须用前复权数据（分红除权会破坏价格连续性）
```

### 7.4 边界情况

| 情况 | 处理 |
|---|---|
| 多轮开→平→再开 | 完整保留多周期时间线，无需特殊处理 |
| 只有一笔 open 从未操作 | 基线 1 笔订单，全靠 B&H 与预设对比 |
| 评估日停牌无 K 线 | 取评估日前最近一根 K 线收盘价 |
| 分支末笔订单晚于今日 | 截断到最后一根 K 线日期（禁止推演未来） |
| 持仓 0 股但未标 isClosed | 视为已平仓，基线纯历史，无未实现部分 |

---

## 8. 时效性管理（策略过期检测）

### 8.1 三个过期源，统一检测

| 过期源 | 检测条件 | 卡片提示 | 点击后动作 |
|---|---|---|---|
| **K 线更新** | 当前 K 线末日期 > `dataAsOfDate` | ⚠️ K线已更新至 08-25，点击刷新 | 重新 generate + 重跑推演 |
| **资金变动** | `simulatedCash ≠ generatedAtCash` | ⚡ 资金已变动，点击重算 | 按新资金重算股数（价格点位不变） |
| **持仓变化** | `lastBaselineSignature ≠ 当前指纹` | 🔄 基线已变化，点击重建 | 重建基线 + 重跑 |

> 全部由用户点击触发；**系统绝不自动刷新任何方案**（铁律）。

### 8.2 卡片时效展示

```
┌──────────────────────────────────┐
│  🆕 金字塔补仓    [预设]          │
│  收益  +15,800                    │
│  📅 基于 2026-08-20 K线 · 08-21 推演 │
│  ⚠️ K线已更新至 08-25，点击刷新    │
└──────────────────────────────────┘
```

---

## 9. UI 页面设计（单页三态工作台）

### 9.1 页面结构

- **路由**：`/sandbox`；**主导航文案**：「沙盘复盘」（白话、可点击性优先，技术名「沙盘推演 / What-if」仅用于文档与代码）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 顶部操作栏                                                           │
│  [标的选择器 ▼]  [抖动系数: 0.25 ▼]  [✨ 一键生成预设方案]  [帮助]     │
├──────────────────────────┬───────────────────────────────────────────┤
│  📋 方案列表 (280px)      │  ◆ 主工作区（三态切换）                    │
│                          │  状态 1：未选择 → 引导提示                 │
│  ⚡ 真实操作【只读】       │  状态 2：选中单方案 → 编辑器视图            │
│    已实现 +12,530         │      ├─ K线图（蜡烛 + 成本线 + 买卖标记）  │
│    未实现 +3,240 (2000股) │      ├─ 操作时间线（可编辑）               │
│                          │      └─ 指标面板 + 资金进度条              │
│  ── 预设方案 ──           │  状态 3：选中 2+ 方案 → 对比报表           │
│  [✨ 生成预设方案]         │      ├─ 多方案对比表（四维）              │
│  🆕 均线低吸  [预设]      │      └─ 收益/风险散点图                   │
│  🆕 金字塔    [预设]      │                                           │
│  🆕 网格      [预设]      │  ────────────────────────────────────    │
│  🆕 止损止盈  [预设]      │  底部（选中 2+ 方案 + 点【对比选中方案】后）│
│                          │  多方案对比表（可折叠）                    │
│                          │                                           │
│  ── 我的方案 ──           │                                           │
│  [新建方案]               │                                           │
│  🆕 方案A · 手动调整      │                                           │
│  ☐ ☑ 勾选参与对比         │                                           │
└──────────────────────────┴───────────────────────────────────────────┘
```

### 9.2 编辑器快速调整工具（手动，非自动）

```
① 图表点选下单：点击某根 K 线 → [买入][卖出] 面板
   价格 = 该日收盘价（可切 高/低/收），数量步进 100 → 插入时间线
② 订单行内编辑：价格/数量 inline 步进器（长按连加）
   日期微调：[◀前1日][前5日][后5日][后1日▶]；【恢复为基线值】
③ 批量变换：所有买单 ×50%/×150%/×200%；价格全局偏移 ±2%；卖单平移 N 交易日
④ 实时预览 + 显式提交：调整 → 指标面板实时刷新（5ms 缓存命中）
   落库结果 + 对比表只在点【▶ 运行推演】后更新，未提交时高亮提示
```

### 9.3 方案卡片（三态区分）

| 类型 | 徽章 | 操作按钮 |
|---|---|---|
| baseline | ⚡ 真实操作 · 只读 · 📌 持仓中/已平仓 | 仅【查看】 |
| preset | [预设] + 📅 时效戳 + ⚠️/⚡/🔄 过期提示 | 【预览】【📋 复制并微调】 |
| user | [我的方案]（或 [预设副本]） | 【编辑】【▶ 运行】【保存为我的策略】【删除】 |

### 9.4 极简新手模式（默认）与高级设置

- **默认只展示 4 个核心数字**：最终收益额、累计收益率、持仓均价变化、最大回撤
- 波动率、夏普、抖动窗口、资金占用周期等**高阶参数默认折叠**在"高级设置（可折叠）"里
- 新手模式下的白话呈现：
  - 抖动系数显示为："滑点大小（默认 0.25，可不改）"
  - 资金口径显示为："预算上限 ¥20,000（历史最高占用资金）"
- 提供「极简 / 专业」模式切换，选择记忆在 localStorage

### 9.5 空状态引导卡（首次进入）

不展示空荡的工作台，直接渲染三步引导卡：

```
┌──────────────────────────────────────────────────┐
│  🎯 三步看懂这套沙盘                              │
│  ① 看左侧：系统根据你当年的真实操作和 K 线，        │
│     自动生成了 5 套标准策略（网格/金字塔/止损…）    │
│  ② 点"复制"：创建你的演练版本（随便改，改乱了       │
│     删掉重新复制一份即可）                        │
│  ③ 调整买卖点：拖点位、改数量，点【运行推演】，     │
│     看能不能跑赢你当年的实盘                      │
│  [进入沙盘]  [看帮助文档]                         │
└──────────────────────────────────────────────────┘
```

### 9.6 未保存浮动栏（显式提交 + 去向引导）

- 任何编辑动作产生未保存修改 → 底部浮动栏：
  - "检测到 3 处修改未保存：[▶ 运行并保存推演] [撤销修改]"
- 实时预览照常刷新（缓存命中 5ms），但**落库结果只在点【运行并保存】后更新**
- 刷新 / 离开页面时若仍有未保存修改 → 弹确认框，杜绝"改的东西去哪了"的困惑

### 9.7 只读引导 Tooltip

- 鼠标悬浮在预设方案的只读订单 / 灰色按钮上 → Tooltip：
  - "这是系统标准策略基准，不可直接修改。请点击右上角【📋 复制并微调】，创建你的专属沙盒。"
- 悬浮在"模拟资金"输入框上 → Tooltip：
  - "这是推演用的假设资金（非你的真实资金）。默认=历史最高占用资金。调高可测试'如果当初资金更多'的场景。"

---

## 10. K 线数据接入

### 10.1 上游与代理（2026-08-20 实测修正）

```
上游：腾讯 ifzq.gtimg.cn（免费、无需 API Key、与现有行情同源）

【实测结论（替代早期假设）】
 - /appstock/app/kline/mkline 与带 fq 后缀的 /kline 均返回参数错误，不可用；
 - /appstock/app/kline/kline?param={code},day,{start},{end},{count}
   返回【未复权】day（平安 2024-01-02 开 40.30）；
 - /appstock/app/fqkline/get?param={code},day,{start},{end},{count},qfq
   返回【前复权】qfqday（同日开 33.589，已扣分红除权）→ 沙盘统一使用该口径；
 - 数组字段序 = [日期, 开盘, 收盘, 最高, 最低, 成交量, ...]（收盘在最高/最低之前）；
 - qfq 锚点为"今日"：跨窗口请求同一历史日期数值一致 → 增量追加安全；
   新除权发生后整条历史会重锚定 → 用边界 K 线对比检测漂移并全量刷新；
 - 响应为 UTF-8 JSON（Content-Type: text/html; charset=UTF-8）。

【复权系数表（关键设计）】
 真实成交价（未复权）与 qfq K 线不同量纲：基线订单价格需在入轨前换算到
 前复权口径 —— factor(日期) = qfq收盘 / raw收盘，随 K 线一并拉取/缓存，
 由 store 层在基线订单入轨时应用（getAdjustFactor），保证推演、成本线、
 图表同一价格基准（未复权价格 × factor = 前复权价格）。

本地开发：vite.config.ts 增加 '/api-kline' → https://ifzq.gtimg.cn
线上部署：middleware.js UPSTREAMS 增加 '/api-kline' 条目 + matcher
Service Worker：navigateFallbackDenylist 增加 /^\/api-kline/（与现有 /api-qt 一致）
```

### 10.2 服务层（`src/services/klineService.ts`）

```
getKline(fullCode, { startDate }) → Promise<KlineBundle> // { klines, adjustFactors }
  ① 内存 Map 命中 → 直接返回（会话内零网络）
  ② IndexedDB 缓存命中 → 增量拉 [lastDate, 今日] 合并：
     - 边界日 qfq 收盘对比检测除权漂移（>0.5% → 全量刷新）
     - 请求起点早于缓存起点 → 全量重拉
     - 网络失败 → 回退缓存继续（三级缓存兜底）
  ③ 均未命中 → 按年分页全量拉取（raw + qfq 每年并行，年度并发 3）→ 写入两级缓存
  UTF-8 解码 → 解析 → 按日期去重合并 → 升序
  startDate 缺省近 10 年；store 层传「首笔真实操作日 − 90 自然日」更精确
```

---

## 11. 文件清单与工作量

### 11.1 新增文件（14 个）

| 文件 | 预估行数 | 内容 |
|---|---|---|
| `src/types/sandbox.ts` | ~170 | 全部沙盘类型 |
| `src/utils/baselineExtractor.ts` | ~120 | 基线提取（含 borrow/merge 纳入 + 指纹 + 自校验） |
| `src/utils/sandboxEngine.ts` | ~400 | 推演引擎（资金约束 + T+1 锁定 + 统一评估日 + 动态抖动 + 结构化拒绝） |
| `src/utils/metricsEngine.ts` | ~200 | 回撤/波动率/B&H/四维对比 |
| `src/utils/strategyGenerators.ts` | ~480 | 生成器注册表 + 通用策略引擎 |
| `src/services/klineService.ts` | ~130 | K 线获取 + 三级缓存 + 增量合并 |
| `src/store/sandboxStore.ts` | ~330 | 三态分支管理 + 非响应式 memo + 过期检测 |
| `src/components/sandbox/KlineChart.tsx` | ~260 | lightweight-charts 封装（蜡烛+成本线+标记） |
| `src/components/sandbox/ScenarioList.tsx` | ~150 | 方案列表（三态分组） |
| `src/components/sandbox/ScenarioCard.tsx` | ~130 | 方案卡片（时效戳+过期提示+操作） |
| `src/components/sandbox/OrderTimeline.tsx` | ~220 | 时间线编辑区（步进器+批量变换） |
| `src/components/sandbox/MetricsPanel.tsx` | ~100 | 指标面板 + 资金进度条 |
| `src/components/sandbox/ComparisonTable.tsx` | ~220 | 多方案对比表 + 散点图 |
| `src/components/sandbox/PresetDialog.tsx` | ~120 | 预设生成对话框 |
| `src/components/sandbox/EmptyStateGuide.tsx` | ~60 | 空状态三步引导卡 |
| `src/views/SandboxPlayback.tsx` | ~640 | 主页面（组装全部组件，三态切换 + 新手模式 + 未保存浮动栏） |
| **小计** | **~3,700** | |

### 11.2 修改文件（6 个）

| 文件 | 变更 | 说明 |
|---|---|---|
| `src/db/schema.ts` | +45 | `STORES_V11`：sandboxBranches + sandboxOrders |
| `src/db/index.ts` | +90 | 分支/订单 CRUD + klineCache 表读写 |
| `src/App.tsx` | +30 | 路由 `/sandbox` + 导航项「沙盘复盘」 |
| `vite.config.ts` | +10 | `/api-kline` 代理 |
| `middleware.js` | +8 | `/api-kline` 上游 + matcher |
| `package.json` | +1 | `lightweight-charts` 依赖 |

### 11.3 测试文件（2 个）

| 文件 | 覆盖 |
|---|---|
| `src/__tests__/sandboxEngine.test.ts` | 资金约束、统一评估日、动态抖动可复现、快照正确性 |
| `src/__tests__/strategyGenerators.test.ts` | 策略不变量：100 股取整、现金约束 |

**总量：新增 ~3,720 行 + 修改 ~180 行 + 测试 ~330 行，约 4,230 行。**

---

## 12. 实施路线图

```
第 1 步（基础设施，半天）
  npm install lightweight-charts
  types/sandbox.ts + db/schema.ts（STORES_V11）+ db/index.ts（CRUD）
  vite.config.ts + middleware.js（/api-kline 代理）

第 2 步（数据与引擎，1 天）
  services/klineService.ts（三级缓存 + 增量）
  utils/baselineExtractor.ts（基线提取 + 指纹 + 自校验）
  utils/sandboxEngine.ts（推演引擎 + 动态抖动）
  utils/metricsEngine.ts（四维指标）
  utils/strategyGenerators.ts（5 个生成器）

第 3 步（状态层，半天）
  store/sandboxStore.ts（三态分支 + 非响应式 memo + 过期检测）

第 4 步（UI，1.5 天）
  components/sandbox/*（8 个组件）
  views/SandboxPlayback.tsx（主页面组装）
  App.tsx（路由 + 导航）

第 5 步（测试与联调，半天）
  单元测试（引擎 + 生成器）
  端到端流程验证（基线 → 生成预设 → 复制微调 → 运行 → 对比 → 过期刷新）

总计：约 4 天
```

---

## 13. 测试计划

### 13.1 引擎单测

- [ ] 资金约束：超预算买入被拒绝并返回 `INSUFFICIENT_CASH`，且 actions 中"反算最大可买量"正确
- [ ] T+1 锁定：当日买入当日卖出被拒并返回 `T1_LOCK`；次日可正常卖出
- [ ] 结构化拒绝：四种拒绝码均返回白话 message + 可执行 actions
- [ ] 统一评估日：持续持仓的未实现盈亏正确计入
- [ ] 动态抖动：同一种子结果可复现；高波动 K 线区抖动 > 低波动区
- [ ] 规费：与 `calcTradeFees` 逐笔一致
- [ ] 基线自校验：引擎末端持仓数 = Position.currentAmount

### 13.2 生成器单测

- [ ] 100 股取整；现金约束
- [ ] 止损止盈：2R 风险报酬比数值正确

### 13.3 端到端

- [ ] 全流程：选标的 → 基线加载 → 生成预设 → 复制微调 → 运行 → 勾选对比
- [ ] 持续持仓标的：基线卡片显示"持仓中"与已实现/未实现拆分
- [ ] 过期检测：修改 K 线缓存日期后 ⚠️ 出现，点击刷新后指标更新
- [ ] 新手模式：默认只显示 4 个核心数字，展开"高级设置"后显示全部参数
- [ ] 未保存修改：编辑 → 浮动栏出现 → 点【撤销】恢复 → 点【运行并保存】落库
- [ ] 拦截引导：资金不足弹窗的 ① ② ③ 行动按钮点击后直接执行对应调整

---

## 14. 风险与边界情况

| 风险 | 应对 |
|---|---|
| K 线接口限流/失败 | 三级缓存兜底；失败提示 + 用缓存数据继续 |
| 前复权数据随除权变化导致历史点位漂移 | 缓存带 fetchedAt；下次增量合并时同步刷新 |
| 派生订单确定性被破坏（K 线修正） | 缓存键含末根 close，自动失效 |
| 长历史（>5 年）超出数据源范围 | 分页拉取；超出部分提示用户 |
| PWA 离线 | K 线持久化缓存，离线可回放已有数据 |
| 用户恶意调高模拟资金 | 允许（标注"模拟"），但基线永远锁定真实峰值 |

---

## 15. Phase 2 扩展方向（本次不做）

1. **区间复盘**：选择历史时间段，重建区间起点持仓状态（需"任意日期状态重建"算法）
2. **跨标的策略模板库**："保存为我的策略"升级为可套用到任意股票的模板
3. **分红送股再投资模拟**：前复权之外的现金分红再投资路径
4. **分钟级短线推演**：需分钟 K 线数据源 + tick 级抖动模型
5. **推演结果导出**：对比报告导出图片/CSV

---

## 16. 附录 —— 实现现状与设计增量（2026-08-21）

> 本附录记录规格书**未覆盖或与初版不同**的已落盘实现，使文件不落后于代码。
> 完整文件清单 / 行数 / 整体运行逻辑 / 开发上手见 `docs/sandbox-replay-implementation.md`。

### 16.1 加入功能（规格书未写）

1. **DCA 时序现金注入**：`SandboxBranch.injectionType`（`none`/`monthly`/`custom`）+ `cashInjections[]`；
   引擎在撮合前`盘前结算`当日入金。Store 提供 `addCashInjection` / `setMonthlyDCA` / `clearCashInjections`。
2. **多口径收益**：`SandboxResult` 新增 `totalInjectedCash`、`principalReturnRate`（基准本金收益）、
   `capitalWeightedReturnRate`（资金加权，按日平均占用）、`timeWeightedReturnRate`（时间加权 TWR）、
   `peakRequiredCash`（瞬时最大资金占用峰值，含 DCA 减负语义）。
3. **多套追加策略**：策略注册表从「4 经典」逐步扩展（新增 `max-opportunity` 均线/ATR 趋势追涨、
   `pure-dca` 纯被动定期定额零择时基准线、`hybrid-regime` 环境自适应混合、`model-recommend` 多因子智能推荐）。
   > 注：早期设计中的 `gap-fill`（补全建议）已移除（无明确定义来源、不专业，见 implementation 文档）。

### 16.2 实现与规格书的差异点

- 类型 `SandboxBranch` 新增 `baselinePositionId`（基线关联真实持仓）、DCA 相关、`presetStrategyId` 含 9 个策略 id。
- 基线**不做滑点**（`jitterFactor=0` 锚定真实成交价）；预设才抖动。
- 生成器在 `simulatedCash` 口径上**以 `generatedAtCash` 作为数量基准**，预算（`simulatedCash`）变化只改预算不改仓位，重配需 `rescalePreset`。
- K 线起点默认为「首笔真实操作日 − 90 自然日」，三级缓存 + 除权漂移检测（`DRIFT_THRESHOLD=0.005`）。
- `db-schema.puml` 尚未包含 3 张沙盘表（待补充）。

### 16.3 已实现测试清单（比 §11.3 增加）
> 新增：`sandboxDb.test.ts`（CRUD）、`sandboxStore.test.ts`（派生纯函数）、`sandboxPositionDiscrepancy.test.ts`（基线重演差异排查）、`sandboxE2E.test.ts`（Step5 端到端）、`sandboxPlayback.ui.test.tsx`（UI 层）、`helpers/sandboxFixture.ts`（夹具）。

### 16.4 已知边界（待产品决策）
- 合并基线 + 生成策略时，策略仓位按「独立预算」计划，与基线共用同一模拟资金 → 可能 `INSUFFICIENT_CASH`（详见 implementation 文档 §2.3）。
