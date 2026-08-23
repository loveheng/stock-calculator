# 计划单（plannedOrders）开发文档

> 版本：v2（2026-08 — 重构：严格短线/中长期强隔离，新增分支试算引擎）
> 定位：面向**开发者**的实现说明，描述计划单的数据模型、Store 契约、执行链路与页面集成，供二次开发与排障使用。
> 关联：`src/store/types.ts`（领域类型）、`src/store/index.ts`（Store Actions）、`src/db/schema.ts`（DB 实体）、`src/db/index.ts`（DAO）、`src/components/PlanOrderCard.tsx`（UI）、`src/utils/shortTermTrial.ts`（短线试算引擎，v2 新增）、`src/views/TCalculator.tsx`（短线页）、`src/views/CostAveraging.tsx`（中长期页）、`src/views/Home.tsx`（首页快速执行）。

---

## 0. 角色与数据所有权

| 数据 / 能力 | 拥有者 | 写入口 |
|---|---|---|
| `plannedOrders`（内存态） | Zustand Store | `setPlannedOrder` / `markPlanExecuted` / `cancelPlan` / `removePlannedOrder` |
| `plannedOrders`（表） | IndexedDB（Dexie） | `putPlannedOrder` / `deletePlannedOrder`（软删除） |
| `PlanOrderCard` 渲染 | 共享 UI 层 | 只读 `order` + 回调（`onEdit` / `onExecute` / `onCancel` / `onNavigate`） |
| 短线执行落地（流水） | 做T侧引擎 | `addStreamRecord`（执行时由页面 / Home 调用） |
| 中长期执行落地（批次） | 中长期侧 | `addBatch`（执行时由页面 / Home 调用） |

核心约定（当前实现即如此）：

1. **计划单只是"交易意图备忘录"，不是成交事实源**：创建时只记录计划价格 / 数量 / 有效期，实际成交发生在**执行**动作，执行时改写实际值并调用真实交易入口（`addStreamRecord` / `addBatch`）。
2. **每个标的（fullCode）全局最多一个 active 计划单**：`setPlannedOrder` 会先移除同标的既有 active 计划再写入（覆盖语义）。
3. **执行逻辑按 context 分发**：`both` 上下文在首页（Home）会同时走短线流水与中长期批次两条链路。
4. **状态是自关联的、非自动过期**：`expired` 由前端在**读取**时按 `expiresAt` 派生判定；Store / DB 不主动写 `expired`。

---

## 1. 领域类型（store/types.ts）

```ts
export interface PlannedOrder {
  id: string;
  fullCode: string;                 // 股票完整代码，如 'sh600745'
  stockName: string;                // 股票名称
  context: 'long-term' | 'short-term' | 'both';  // 来源 / 分发上下文
  direction: 'buy' | 'sell';        // 方向
  plannedPrice: number;             // 计划价格
  plannedAmount: number;            // 计划数量
  note?: string;
  createdAt: string;                // ISO
  expiresAt: string;                // = createdAt + validityDays
  validityDays: number;             // 1 | 3 | 7 | 14 | 30
  status: 'active' | 'expired' | 'cancelled' | 'executed';
  actual?: {
    executedAt: string;             // ISO
    actualPrice: number;
    actualAmount: number;
    note?: string;
    isAchieved: boolean;            // buy: actualPrice<=planned；sell: actualPrice>=planned
    // 中长期执行结果
    newCost?: number;               // 新成本价
    newAmount?: number;             // 新持有数量
    newTotalInvested?: number;      // 新累计投入
    totalFee?: number;              // 规费
    // 短线执行结果
    avgPrice?: number;              // 加权均价
    netProfit?: number;             // 净收益
  };
}
```

Store 层的 Actions 契约（`AppStoreActions`）：

```ts
loadPlannedOrders: () => Promise<void>;
setPlannedOrder: (order: PlannedOrder) => void;              // 覆盖同标的 active
removePlannedOrder: (id: string) => void;
markPlanExecuted: (id: string, actual: PlannedOrder['actual']) => void;
cancelPlan: (id: string) => void;
```

---

## 2. 数据库（schema.ts / index.ts）

### 2.1 表

`plannedOrders` 是 v10 新增表，索引：

```ts
const STORES_V10 = {
  ...STORES_V9,
  plannedOrders: 'id, fullCode, status, expiresAt, [status+expiresAt]',
} as const;
```

实体 `PlannedOrderEntity`（`src/db/schema.ts`）把 `PlannedOrder.actual` 的嵌套对象**拍平**为顶层字段：

```ts
export interface PlannedOrderEntity extends BaseEntity {
  fullCode: string;
  stockName: string;
  context: 'long-term' | 'short-term' | 'both';
  direction: 'buy' | 'sell';
  plannedPrice: number;
  plannedAmount: number;
  note?: string;
  expiresAt: string;
  validityDays: number;
  status: 'active' | 'expired' | 'cancelled' | 'executed';
  // 拍平的实际执行字段
  actualPrice?: number;
  actualAmount?: number;
  actualExecutedAt?: string;
  actualNote?: string;
  isAchieved?: boolean;
  newCost?: number; newAmount?: number; newTotalInvested?: number; totalFee?: number;  // 中长期
  avgPrice?: number; netProfit?: number;                                              // 短线
}
```

### 2.2 DAO（src/db/index.ts）

| 函数 | 说明 |
|---|---|
| `loadPlannedOrdersFromDB()` | 读 `isDeleted === 0` 的全部行，映射为领域 `PlannedOrder`（嵌套 `actual` 重组） |
| `putPlannedOrder(order)` | 写入 / 更新（`toPlannedOrderEntity` 拍平，`cleanUndefined` 去空） |
| `deletePlannedOrder(id)` | **软删除**：`isDeleted: 1` |

### 2.3 同步 / 导入导出

- `exportData` / `exportJSON`：导出 `plannedOrders`。
- `safeImportAllData(...)`：`plannedOrders` 参与全量导入，`stalePlanIds` 做清除。
- `webdavSync.mergeData`：按 `id` 用 `mergeRecordById` 合并本地/远端计划单（`plannedOrdersAdded/Updated`）。

---

## 3. Store Actions 语义（src/store/index.ts）

### 3.1 setPlannedOrder — 创建 / 覆盖

```ts
setPlannedOrder: (order) => {
  set((s) => {
    // 同标的覆盖：移除该标的已有的 active 计划单
    const filtered = s.plannedOrders.filter((p) => !(p.fullCode === order.fullCode && p.status === 'active'));
    return { plannedOrders: [...filtered, order] };
  });
  safePersist(() => putPlannedOrder(order));
},
```

- 创建 / 编辑走同一入口：编辑 = 先删同标的 active（含自身）再写入新 plan。
- **注意**：`safePersist` 持久化的是 `order` 本身，前端内存里已覆盖同标的，但旧 plan 的持久化行**不会被删除**（因为 `deletePlannedOrder` 只按 `id`）。

### 3.2 markPlanExecuted — 执行落定

```ts
markPlanExecuted: (id, actual) => {
  set((s) => ({
    plannedOrders: s.plannedOrders.map((p) =>
      p.id === id ? { ...p, status: 'executed' as const, actual } : p
    ),
  }));
  const order = get().plannedOrders.find((p) => p.id === id);
  if (order) safePersist(() => putPlannedOrder(order));
},
```

- 只负责改**状态与回填 `actual`**，**不负责真实成交**；真实成交在页面 / Home 执行入口先完成。
- Store 更新后从 `get()` 取最新值落库。

### 3.3 cancelPlan

```ts
cancelPlan: (id) => set/… status: 'cancelled' … + putPlannedOrder
```

- 状态置 `cancelled`，不在过滤窗口内展示，但**不物理删除**。

### 3.4 removePlannedOrder（软删）

先内存过滤移除，再 `deletePlannedOrder(id)`（`isDeleted: 1`）。

---

## 4. 展示层：PlanOrderCard.tsx（共享组件）

`PlanOrderCard` 是计划单的统一渲染，被**三个表面**复用：Home、`TCalculator`、`CostAveraging`。

Props：

```ts
interface PlanOrderCardProps {
  order: PlannedOrder;
  quote?: StockQuoteSummary | null;      // 实时行情（可空）
  position?: Position | null;            // 当前底仓（可空）
  feeConfig?: FeeConfig | null;
  /** 短线项目池（进行中的短期项目，仅短线计划单用于短线试算匹配；v2 新增） */
  shortProjects?: ShortTrialProject[];
  onEdit?: (order) => void;              // 编辑
  onExecute?: (order, actualPrice, actualAmount, note) => void;
  onCancel?: (id) => void;
  onNavigate?: (order) => void;          // 首页「跳转」
}
```

### 4.1 派生逻辑（组件内部 useMemo）

| 字段 | 条件 | 说明 |
|---|---|---|
| `currentPrice` / `priceDiff` / `diffPercent` | 有 quote | 现价与计划价差额 |
| `execSimulation` | 中长期 + 有 position + 有 feeConfig | 执行弹窗内按**实际输入值**模拟 `calcBatchExecution` |
| `trialSimulation` | 中长期 + active + 有 position | 卡片展开区按**计划价**模拟 |
| `matchedProject` | `shortProjects` 存在 | `findLatestShortProject(order.fullCode, shortProjects)` 匹配最新进行中短线项目 |
| `trialResult` | isShortTerm + active | `computeShortTermTrial(...)` **分支试算引擎**，绝不读取底仓（v2 新增，替代旧 `shortTermFee`） |
| `isFavorable` | — | 买入现价≤计划价、卖出现价≥计划价记为"利好" |

### 4.2 展开区（移动端默认折叠，桌面端默认展开）

- 实时对比（现价 / 计划价 / 差额 / 方向提示）。
- 底层仓位对比（**仅中长期**：成本、累计投入、已实现盈亏；v2 起短线计划单**隐藏**此块，避免底仓数据穿透）。
- 试算预览：
  - 中长期：按**计划价**模拟 `calcBatchExecution`（成本摊薄 / 持有数量 / 投入 / 规费）。
  - 短线（v2 重构）：严格按 `shortTermTrial.ts` 的**4 分支**渲染，**禁用**底仓成本/股数/可卖来源读取：
    1. **`matched-buy`**：匹配到短期项目 + 买入 → 追加后新均价 / 总持仓 / 预估规费。
    2. **`matched-sell`**：匹配到短期项目 + 卖出 → 对冲差价 / 对冲数量 / 预估规费 / 净收益。
    3. **`new-project-buy`**：无短期项目 + 买入 → 新建短期项目 / 初始成本基准 / 预估规费。
    4. **`blocked-sell`**：无短期项目 + 卖出 → **阻断试算**，仅显示红色警示横幅（"需借用底仓，暂不进行收益试算"），**不渲染收益/规费表**。
- 已执行对比表（计划 vs 实际：价格/数量/总额/成本/持有/投入/规费）。
- 操作按钮：active → 「编辑 / 执行 / 取消 /（跳转）」；executed / expired / cancelled → 仅展示说明。

### 4.3 执行弹窗

- 默认预填 `plannedPrice` / `plannedAmount`，可改，输入实际成交价与数量。
- 中长期显示仓位变化预览（成本价 / 持有数量 / 累计投入 / 已实现盈亏 / 规费）。
- 短线显示"仅记录流水，不改变底层仓位"，倒T卖出校验底仓。
- 达成判定：`buy ? actual ≤ planned : actual ≥ planned` → ✅ / ⚠️。

### 4.4 短线试算引擎（shortTermTrial.ts，v2 新增）

文件位置：`src/utils/shortTermTrial.ts`

核心接口：

```ts
type ShortTrialProject = {
  fullCode: string; mode: 'long' | 'short'; status: string;
  pendingAmount: number;    // 剩余待处理持仓量
  avgCost: number;          // 加权均价 P_avg
  realizedPnL: number; openedAt?: string;
};

type ShortTrialResult =
  | { kind: 'matched-buy';    project; newAvgCost; newAmount; addedFee }
  | { kind: 'matched-sell';   project; avgCost; hedgeAmount; netIncome; fee; spreadPct }
  | { kind: 'new-project-buy'; initCost; initAmount; fee }
  | { kind: 'blocked-sell';   reason: 'no-short-project'; message: string };

function findLatestShortProject(fullCode, projects): ShortTrialProject | null;
function toShortTrialProject(sr: StockStreamResult): ShortTrialProject;
function computeShortTermTrial(direction, price, amount, fullCode, stockName, project, feeConfig?): ShortTrialResult;
```

**核心规则**：

1. 存在短期项目 + 买入 → 基于当前均价与持仓试算追加买入后的新加权成本（`matched-buy`）。
2. 存在短期项目 + 卖出 → 基于短期项目加权均价做对冲差价试算（`matched-sell`）。
3. 无短期项目 + 买入 → 允许试算，以计划价与量作为初始成本基准（`new-project-buy`）。
4. 无短期项目 + 卖出 → **阻断试算**，输出警告，**禁止**穿透到底仓计算收益（`blocked-sell`）。

**隔离保障**：该引擎纯函数，不接收 `position` 参数，不依赖任何中长期底仓数据。

---

## 5. 页面上下文：TCalculator.tsx（短线）

文件位置：`src/views/TCalculator.tsx`，主组件 `TCalculator`。

### 5.1 读取 Store

```ts
const plannedOrders = useAppStore((s) => s.plannedOrders);
const setPlannedOrder = useAppStore((s) => s.setPlannedOrder);
const markPlanExecuted = useAppStore((s) => s.markPlanExecuted);
const cancelPlan = useAppStore((s) => s.cancelPlan);
```

### 5.2 上下文过滤 `shortTermPlans`

展示窗口 = `[现在 - 3天, 现在]` 内的 active / expired / executed，过滤逻辑：

```ts
const shortTermPlans = useMemo(() => {
  const now = Date.now();
  const displayWindow = 3 * 24 * 60 * 60 * 1000;
  return plannedOrders.filter((p) => {
    if (p.status === 'cancelled') return false;
    if (p.context !== 'short-term') return false;   // 【强隔离】短线页仅展示严格 short-term
    if (p.status === 'expired' || p.status === 'executed') {
      const expiresAt = new Date(p.expiresAt).getTime();
      return (now - expiresAt) <= displayWindow;
    }
    return true;
  });
}, [plannedOrders]);
```

- `context !== 'short-term'` → 短线页只展示严格 `short-term`，`both` / `long-term` 一律不进入短线视图（强隔离）。
- `shortTermPlans` 全量送达 `PlanOrderCard`；卡片自作状态展示。

### 5.2.1 短线项目池 -> 试算项目池（v2 新增）

```ts
// 进行中的短线项目（CLEARED 已归档的不算）
const activeResults = useMemo(() => results.filter((r) => r.status !== 'CLEARED'), [results]);

// 转换为 ShortTrialProject，供 PlanOrderCard 的短线试算引擎匹配
const shortTrialProjects = useMemo(() => activeResults.map(toShortTrialProject), [activeResults]);
```

- `activeResults` 来自 `useStreamResults()`，是当前短线页的流水池撮合结果。
- `shortTrialProjects` 通过 `toShortTrialProject` 提取出试算所需字段（`pendingAmount` / `avgCost` 等），**绝不包含**中长期底仓。
- 传入 `PlanOrderCard` 的 `shortProjects` prop，由卡片内部的 `computeShortTermTrial` 按 4 分支计算。

### 5.3 创建 `handleCreatePlan` 与编辑

- 表单状态：`planStock` / `planDirection` / `planPrice` / `planAmount` / `planValidity`（默认 3）。
- 创建时 `context: 'short-term'`，`expiresAt = now + validityDays * 86400000`，`status: 'active'`。
- 编辑 = `setPlan*(order.plannedXXX)` + `setPlanFormOpen(true)` → 复用同一创建表单，点击确认走 `setPlannedOrder` 覆盖。

### 5.4 执行 `handlePlanExecute`（短线链路）

```ts
const handlePlanExecute = useCallback((order, actualPrice, actualAmount, note) => {
  const direction = order.direction;
  const txnFee = calcTradeFees(actualPrice, actualAmount, direction, feeConfig).total;
  const record: TStreamRecord = { /* id/timestamp/fullCode/stockName/direction/price/amount/fee/note */ };
  const result = addStreamRecord(record);          // 真实短线成交 + FIFO 撮合
  if (result?.rejected) { showToast(...); return; } // 倒T校验失败等
  const isAchieved = order.direction === 'buy'
    ? actualPrice <= order.plannedPrice
    : actualPrice >= order.plannedPrice;
  markPlanExecuted(order.id, { executedAt, actualPrice, actualAmount, note, isAchieved,
    avgPrice: result?.avgPrice, netProfit: result?.netProfit });
  showToast(`✅ 计划单已执行 · ${order.stockName}`);
}, [addStreamRecord, markPlanExecuted, feeConfig, showToast]);
```

要点：
- 短路执行**必须先** `addStreamRecord` 成功，再 `markPlanExecuted`。
- `addStreamRecord` 是同步的（`StreamAddResult?`），若被 Store 层校验拒绝（如倒卖无底仓）则不改变计划状态。
- **【强隔离】短路执行绝不调用 `addBatch`，绝不修改中长期底仓成本/持仓/累计投入**；只追加短线流水。
- **标的自动关联**：执行即走 `addStreamRecord` → 该 `fullCode` 若有进行中短线项目自动归入；若无，`findOrCreateOpenRound` 自动初始化该标的的短线 Round（短线自持持有），**不强制依赖中长期已建仓**（正T买→卖可在短线侧独立完成）。

### 5.5 行情订阅

`planQuoteCodes = shortTermPlans.map(p => p.fullCode)` → `useLiveQuotes(planQuoteCodes)` 返回 `planQuotes`，传入每个卡片 `quote={planQuotes[p.fullCode] ?? null}`。

---

## 6. 页面接线：CostAveraging.tsx（中长期）

文件位置：`src/views/CostAveraging.tsx`，子组件 `PositionLedger`。

### 6.1 读取 / 过滤

与短线基本一致，但 `context` 过滤改为：

```ts
if (p.context !== 'long-term' && p.context !== 'both') return false;   // longTermPlans
```

`planQuoteCodes` 同理订阅 Long-term 标的行情。

### 6.2 创建 `handleCreatePlan`

与短线一致，`context: 'long-term'`，`handleBatch` 走 `setPlannedOrder`。

### 6.3 执行 `handlePlanExecute`（中长期链路）

```ts
const handlePlanExecute = (order, actualPrice, actualAmount, note) => {
  const pos = positions.find((p) => p.fullCode === order.fullCode && !p.isClosed);
  if (!pos) { window.dispatchEvent(new CustomEvent('app-toast', { detail: '❌ 未找到对应持仓，请先建仓' })); return; }
  const type = order.direction === 'buy' ? 'add' : 'reduce';
  const calc = calcBatchExecution(pos, type, actualPrice, actualAmount, feeConfig);
  // 构造 batch（type/amount/costAfter/amountAfter/note/fee）
  addBatch(pos.id, batch, { currentCost, currentAmount, realizedPnL, totalInvested });
  const isAchieved = …;   // 与短线一致
  markPlanExecuted(order.id, { executedAt, actualPrice, actualAmount, note,
    newCost: calc.newCost, newAmount: calc.newAmount,
    newTotalInvested: calc.newTotalInvested, totalFee: calc.totalFee });
  window.dispatchEvent(new CustomEvent('app-toast', { detail: `✅ 计划单已执行 · ${order.stockName}` }));
};
```

要点：
- **必须先建仓**：无 position 直接 toast 阻断，不改计划状态。
- 执行 = `addBatch`（修改底仓成本 / 数量）+ `markPlanExecuted`（写回 `newCost` 等）。
- 展示用全局 `app-toast`，而短线页用本地 `showToast`。

**减仓（reduce）成本口径 = 保本摊薄法**（`calcBatchExecution` reduce 分支，已重构）：

```
soldAmount        = price × amount            // 卖出回笼资金
remainingInvested = prevTotalInvested − soldAmount + totalFee   // 剩余总投入（含规费）
remainingAmount   = prevAmount − amount     // 剩余持仓股数
newCost           = remainingInvested / remainingAmount   // 执行后摊薄成本（保本口径）
```

- 剩余持仓 `remainingAmount ≤ 0`（完全清仓）时：`newCost = 0`，并将差额 `(soldAmount − totalFee) − prevTotalInvested` 全部计入已实现盈亏（`newRealizedPnL`）。
- 该结果通过 `addBatch` 的 `currentCost / currentAmount / realizedPnL / totalInvested` **真实写入**底仓账本，且 `loadPositionsFromDB` 直接读存储的 `currentCost`（不重算），故计划单减仓后成本**会动态更新并持久保留**。
- **口径一致性警示**：真实账本存在多个独立写入口，其中**手动加减仓弹窗 `handleBatchConfirm`（CostAveraging.tsx）与 `recomputePositionSnapshot`（删除批次 / 做T对账 / 流水 reconcile）仍为平均成本法（成本基础法）**。因此计划单执行（保本法）与手动弹窗（平均成本法）对同一笔减仓，执行后成本可能不同；如需统一须同步改这两处 reduce 分支。

---

## 7. 首页 Home.tsx（快速执行）

### 7.1 待办列表

- `homePlans`：过滤 active/executed + 3 天窗口，不短 / long 都进。
- `activePlanCount`：active 且未过期的计数（角标）。
- `homeShortTrialProjects`（v2 新增）：`allActiveStreams.map(toShortTrialProject)`，传入 `PlanOrderCard` 的 `shortProjects` prop，使首页短线计划单也能正确匹配短线项目进行试算，避免穿透到底仓。

### 7.2 快速执行 `handleHomePlanExecute`

**按 `context` 双分支**，是"both 语义"的唯一旁路：

```ts
if (order.context === 'short-term' || order.context === 'both') {
  // 短线：addStreamRecord → streamResult
}
if (order.context === 'long-term' || order.context === 'both') {
  // 中长期：calcBatchExecution + addBatch → calcResult
}
markPlanExecuted(order.id, { …合并两种链路的结果… });
```

### 7.3 `handleHomePlanNavigate`

`context === 'short-term' || 'both'` → `/t-calculator`；否则 `/cost-averaging`。

---

## 8. 上下文三条链路的对照

| 维度 | TCalculator（短线） | CostAveraging（中长期） | Home（快速执行） |
|---|---|---|---|
| context 过滤 | `short-term`（严格） | `long-term \| both` | 全部（`homePlans`） |
| 真实成交入口 | `addStreamRecord`（流水） | `addBatch`（批次） | 按 context 双分支 |
| 是否改底仓 | 否（仅流水） | 是（成本 / 数量 / 投入） | 视 context |
| 达成判定 | `buy? ≤ : ≥` 计划价 | 同上 | 同上 |
| 执行取舍 | Store 校验可能拒绝 | 无持仓则中止 | Store 校验 / 无持仓 |
| Toast | 本地 `showToast` | 全局 `app-toast` | 全局 `app-toast` |
| 导航 |—（自身页面）|---|---（Navigate）|

---

## 9. 常见排障速查

| 现象 | 排查点 |
|---|---|
| 短线计划点击执行无反应 | 走 `addStreamRecord`，检查是否被 Store 拦截（倒卖无底仓 / 校验 rejected），rejected 时计划状态不改。 |
| 计划创建后同标的只有一个 | `setPlannedOrder` 覆盖同标的 active（预期行为）。 |
| 已执行计划几天后消失 | 3 天展示窗口内过滤，`expiresAt` 超过 3 天自动隐藏。 |
| 首页/页面状态不同步 | 各页面独立用 `useMemo` 从 `plannedOrders` 派生的展示视图，刷新 / 切换后一致性由 Store 保证。 |
| context 是 `both` 的在哪执行 | 首页执行**双分支都执行**；短线页只走短线，中长期页只走中长期。 |