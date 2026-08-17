# 股票计算器 PWA — 项目阅读指南

> **版本**：v7（按需加载重构）  
> **技术栈**：React 19 + React Router 7 + Zustand + Dexie (IndexedDB) + TypeScript + Vite + PWA + Vitest  
> **最后更新**：2026-08-13

---

## 一、项目概览

一个面向个人投资者的 **股票做T账本与成本计算器 PWA**，全部数据保存在浏览器本地（IndexedDB），无需后端服务，离线可用（PWA）。共 6 个功能页面：

| 页面 | 路由 | 核心功能 |
|---|---|---|
| 首页仪表盘 | `/` | 做T总览、近 N 日收益趋势、持仓分布、账户现金流、做T异动预警 |
| 涨跌幅计算器 | `/change-rate` | 涨跌幅⇄目标价双向换算、涨跌停阶梯推算、手续费联动 |
| 短线交易（做T计算器） | `/t-calculator` | 正T/倒T 双向记录，FIFO 撮合引擎自动配对结算，Round 战报自动归档 |
| 中长期交易（成本摊薄） | `/cost-averaging` | 多批次建仓账本（建仓/加仓/减仓/结仓）+ 目标成本反推补仓 |
| 数据统计 | `/statistics` | 进行中流水 + 归档战报统一卡片流、多维筛选、个股行情快照、建仓履历 |
| 费率配置 | `/fee-config` | 佣金/印花税/过户费按品种（股票/ETF/债券）分层配置，JSON/CSV 导入导出 |

---

## 二、目录结构

```
stock-calculator/
├── index.html             # HTML 入口（挂载 #root）
├── package.json           # 依赖与 npm scripts
├── vite.config.ts         # Vite 构建 + PWA 插件 + 开发代理（腾讯 Smartbox 行情搜索）
├── tsconfig.json          # TypeScript 配置（strict 严格模式）
├── tailwind.config.js     # Tailwind 主题扩展
├── vercel.json            # Vercel 部署路由与 SW 缓存头
├── scripts/postbuild.js   # 构建后处理（移除 crossorigin，适配 PWA 离线）
├── public/                # PWA 静态资源（sw.js / manifest.json）
└── src/
    ├── main.tsx           # 应用入口：initStore() → ReactDOM.render()
    ├── App.tsx            # 布局壳层（侧边栏/顶栏/移动端抽屉）+ 6 条路由
    ├── styles.css         # 全局样式（Tailwind）
    │
    ├── db/                # █ 数据持久化层 (DAO)
    │   ├── schema.ts      #   Dexie 表结构：11 张表，版本链 v2→v6
    │   ├── index.ts       #   40+ 个读写函数 + safeImportAllData 安全导入
    │   └── storeInit.ts   #   冷启动：仅加载费率配置 + initialLoadDone 守卫
    │
    ├── store/             # █ 全局状态层 (Zustand)
    │   ├── index.ts       #   Store 本体：31 个 Action + safePersist 增量写库
    │   ├── types.ts       #   全部类型定义（AppStore 接口 ≈ 后端 API 文档）
    │   └── utils.ts       #   纯函数：generateId / recomputePositionSnapshot / useStreamResults / 自动归档
    │
    ├── hooks/             # █ 共享 React Hooks
    │   ├── useDataLoader.ts    #   核心数据加载钩子（useLoadCoreData）
    │   └── useArchivedRounds.ts # 懒加载已完成 Round 战报
    │
    ├── services/          # █ 外部数据服务
    │   ├── stockService.ts #   腾讯 Smartbox 行情搜索（GBK + \uXXXX 解析）
    │   └── ledgerService.ts #  账本只读门面（查询封装，写入统一走 Store）
    │
    ├── types/             # █ 类型定义
    │   ├── stock.ts       #   StockMeta / StockSearchItem（含 kind 费率分类）
    │   └── tStrategy.ts   #   做T状态机 / 结算卡片 / 引擎输入输出
    │
    ├── utils/             # █ 纯计算引擎
    │   ├── mathUtils.ts   #   费率计算（Decimal.js）、涨跌幅、成本摊薄（20 个导出函数）
    │   └── tStreamEngine.ts #  FIFO 撮合引擎 + 做T状态机（20 个导出函数）
    │
    ├── views/             # █ 页面视图（7 个页面）
    │   ├── Home.tsx
    │   ├── ChangeRate.tsx
    │   ├── TCalculator.tsx    # 短线交易（最复杂页面）
    │   ├── CostAveraging.tsx
    │   ├── Statistics.tsx
    │   ├── FeeConfig.tsx
    │   └── WebDAVConfig.tsx   # 云端同步
    │
    ├── components/ui/     # █ 通用 UI 组件
    │   ├── StockAutocomplete.tsx  # 股票代码/名称自动补全
    │   ├── ConfirmModal.tsx       # 确认弹窗
    │   └── InstallPrompt.tsx      # PWA 安装提示
    │
    └── __tests__/         # █ 单元测试 (Vitest，共 14 文件 / 164 用例)
        ├── mathUtils.test.ts                 # 31 用例
        └── ...（recalculatePosition / tStreamEngine / roundLifecycle 等）
```

---
## 三、架构分层与数据流

### 3.1 分层架构

```
Views (React Components)                    ← UI 交互层
    │  通过 Zustand Selector 订阅状态 / 调用 Action
Hooks (React Custom Hooks)                  ← 共享逻辑层（按需加载、数据获取）
    └─ useLoadCoreData / useArchivedRounds
Store (Zustand useAppStore)                 ← 内存状态 + Action 逻辑
    ├─ index.ts   31 个 Action + safePersist 增量写库
    ├─ types.ts   AppStore 接口（状态 + 全部 Action 签名）
    └─ utils.ts   纯函数（撮合结果派生 Hook、Round 自动归档、履历重建）
DB Layer (Dexie IndexedDB)                  ← 持久化存储
    └─ schema.ts（12 表） / index.ts（40+ 函数） / storeInit.ts
```

### 3.2 数据流（v7：按需加载 + 增量持久化）

```
冷启动:
  main.tsx → initStore()
           → ensureDefaultData()        # 确保费率/现金账户单行存在
           → loadFeeConfigFromDB()      # 只读 1 行费率配置（冷启动不加载其他数据）
           → useAppStore.setState(feeConfig)
           → initialLoadDone = true     # 守卫放行，此后 Action 才允许写库
           → ReactDOM.render(<App />)

首帧渲染后（AppLayout 挂载时）:
  useLoadCoreData() → loadTRounds() + loadPositions()   # 并行（tRounds 的 OPENED 轮次内含流水池）
                    → setCoreDataLoaded(true)                            # 核心数据就绪
  各页面不再各自按需加载：核心数据由 useLoadCoreData 统一加载，股票搜索在
  StockAutocomplete 挂载时按需 loadStocks()

运行时（以 addStreamRecord 为例）:
  用户点击"添加流水"
    → views/TCalculator.tsx 收集表单数据
    → useAppStore.getState().addStreamRecord(record)
    → Store Action 内部（统一管道）:
        1. 做T底仓校验（validateStreamTrade / 倒T首笔卖出）
        2. 找/建 OPENED Round（单标的单 OPENED Round 规则），流水作为 transaction 追加
        3. activeStreamsFromRounds（OPENED Round 流水池）→ reconcilePositionsWithStreams
           → normalizeShortTDeductions → processAllStreams（FIFO 撮合）→ applyShortExcessMerge
        4. finalizeRoundIfCleared（撮合 CLEARED → 复用同一 Round 标记 COMPLETED，不新建）
        5. set({ tRounds, positions })   ← 内存状态更新
        6. safePersist(() => { ... })    ← 增量 DB 写入
             putTransaction(roundId, txn)  # 流水逐笔落库（tTransactions）
             putTRound(round)              # Round 概览（OPENED/COMPLETED）
             putPosition(...)              # 被修改的持仓（diff 检测）

导入/导出:
  exportJSON / importJSON → importData → safePersist(safeImportAllData)
```

### 3.3 安全防护机制（改代码前务必理解）

```typescript
// db/storeInit.ts —— 启动装载是否完成
export function isInitialLoadDone(): boolean { return initialLoadDone; }

// store/index.ts —— 统一写库入口
async function safePersist(fn: () => Promise<void>) {
  if (!isInitialLoadDone()) return;   // ① 启动装载中，禁止写库
  // ② 指数退避重试：最多重试 3 次（1s→2s→4s）
  // ③ 全部失败 → 加入 pendingQueue 失败队列，下次写库成功时自动重放
}
```

- **initialLoadDone 守卫**：冷启动未完成前跳过任何 DB 写入，防止半装载状态污染数据库
- **指数退避重试**：写库失败自动重试，容忍偶发 IndexedDB 事务冲突
- **失败队列重放**：重试仍失败的操作不丢弃，入队后自动补偿，保证不丢数据
- **零 clear() 原则**：整个代码库无 `table.clear()` 调用，所有删除按 id/fullCode 精确操作

---

## 四、核心模块详解

### 4.1 `db/schema.ts` — 数据库表结构（10 张表，库名 TradingLedgerDB_v3）

| 表名 | 主键 | 说明 |
|---|---|---|
| `stocks` | fullCode | 股票元信息（含 `kind`：stock/etf/bond 费率分类） |
| `positions` | id | 持仓账本（底仓成本 + 数量 + 平仓状态） |
| `positionBatches` | id | 持仓批次（open/add/reduce） |
| `tRounds` | id | 做T轮次概览（status: OPENED 进行中 / COMPLETED 已归档） |
| `tTransactions` | id | **做T流水唯一持久化表**（OPENED Round 的流水池 + COMPLETED Round 的成交明细，字段与引擎 TStreamRecord 对齐） |
| `accountCash` | id=1 | 现金账户（单行；初始化已做，UI 待开发） |
| `cashFlows` | id | 现金流水（预留，尚无读写代码） |
| `tradeNotes` | id | 交易笔记（预留，尚无读写代码） |
| `feeConfigs` | id=1 | 费率配置（单行） |
| `longTermRecords` | id | 中长期操作记录（buy/sell/merge，与战报级联删除） |

> 所有实体继承 `BaseEntity`（id / createdAt / updatedAt / `isDeleted` 软删除标记）。
> 表结构用版本链常量 `STORES_V2 → STORES_V8` 增量叠加，新增表/索引时在链尾追加即可，无需全量复制。
> **v8 变更**：`tStreams` 表移除（stores 中显式 `tStreams: null` 触发 Dexie 删除）。
> 历史 tStreams 数据不迁移（历史数据不保留），表随 upgrade 直接 drop；做T流水唯一持久化为 tTransactions。

### 4.2 `db/index.ts` — 持久化操作 API（40+ 导出函数）

| 类别 | 函数 |
|---|---|
| **启动/装载** | `ensureDefaultData`, `loadFeeConfigFromDB`, `loadPositionsFromDB`, `loadTRoundsFromDB`（OPENED 含流水）, `loadStocksFromDB` |
| **增量写入** | `putFeeConfig`, `putStock`, `bulkPutStocks`, `putPosition`, `putPositionWithBatches`, `putPositionBatch`, `addBatchToPosition`, `replacePositionBatches`, `putTRound`（概览）, `putTransaction`（单笔流水）, `putRoundWithTransactions`（整轮替换）, `replaceRoundTransactions`, `putLongTermRecord` |
| **精确删除** | `deleteStock`, `deletePositionWithBatches`, `deletePositionBatch`, `deleteTRoundWithTransactions`, `deleteTransaction`, `bulkDeleteTransactions`, `deleteLongTermRecord`, `deleteLongTermRecordsBySourceReportId`, `deleteRoundWithCascade` |
| **级联结算** | `completeRoundWithMerge`（划转底仓）, `completeRoundClear`（清仓结算） |
| **查询/分页** | `fetchBatchesByPositionId`, `fetchAllClosedPositions`, `fetchOpenRoundsWithTransactions`（进行中 Round，含明细）, `fetchCompletedRoundsPage`（已完成 Round，仅摘要，不含明细）, `fetchAllCompletedRounds`（导出用，含明细）, `fetchTransactionsByRoundId`（明细按需查询）, `fetchAllLongTermRecords` |
| **安全导入** | `safeImportAllData` — 逐表批量 upsert + 清理残留记录，绝不调用 clear() |

> 写库前统一经 `cleanUndefined()` 剔除 undefined 字段（IndexedDB 结构化克隆不允许 undefined）。
> `Row` 类型（PositionRow/TRoundRow/...）与 Store 类型同源（type 别名），改一处全局生效。
>
> **流水持久化（v8）**：每笔做T流水在录入时即 `putTransaction(roundId, txn)` 逐笔落库
> （per-entry，非归档时批量快照）；Round 概览由 `putTRound` 单独维护。CLEARED/手动结算时
> 只翻转 Round status 为 COMPLETED，流水原地保留为归档成交明细，不再复制/删除。
> **Round 成交明细按需加载**：列表加载器（`fetchCompletedRoundsPage` → `useArchivedRounds`）只返回轮次摘要
> （含 `tradeCount` 等汇总字段，不含 `transactions`）；UI 展开「查看成交明细」时才通过
> `fetchTransactionsByRoundId` 按需查询 `tTransactions` 表。

### 4.3 `store/` — Zustand 全局状态（三文件分工）

```
store/
├── types.ts    AppStore / AppStoreActions 接口 —— 相当于"后端 API 文档"，改数据结构先看这里
├── index.ts    Store 实现：31 个 Action + safePersist 增量持久化（含重试与失败队列）
└── utils.ts    纯函数与派生 Hook（不写 DB）
```

**AppStore 状态字段（types.ts）：**

```typescript
interface AppStore {
  coreDataLoaded: boolean;         // 核心数据（轮次/持仓/战报）是否已加载
  feeConfig: FeeConfig;            // 费率配置（含 ETF 分层费率）
  tRounds: TRoundArchive[];        // 做T轮次库：OPENED（transactions 即流水池）+ COMPLETED（已归档）
  positions: Position[];           // 持仓账本
  stocks: StockMeta[];             // 股票元信息
  longTermRecords: LongTermRecord[]; // 中长期操作记录
  persistError: string | null;     // 最近一次持久化错误
}
```

> **v8 变更**：`tStreams` 状态移除。流水不再独立存在，全部归属于 Round 的
> `transactions`（OPENED Round 的流水经 `activeStreamsFromRounds` 派生为引擎输入）。

**关键 Action 与 DB 绑定（摘录）：**

| Action | Store 更新 | DB 写入 |
|---|---|---|
| `loadPositions / loadTRounds / loadStocks` | 全量装载对应数据（OPENED Round 含流水） | 只读查询 |
| `setFeeConfig(partial)` | merge 费率 | `putFeeConfig` |
| `addStreamRecord(record)` | 找/建 OPENED Round + 追加流水 + FIFO 撮合 + 结清归档 | `putTransaction` + `putTRound` + `putPosition`(diff) |
| `removeStreamRecord(id)` | 删流水 + 重算撮合（空 Round 整轮删除） | `deleteTransaction` + `putTRound`/`deleteTRoundWithTransactions` + `putPosition`(diff) |
| `updateStreamRecord(id, up)` | 更新流水 + 归一化 + 重算 + 归档 | `putTransaction` + `putTRound` + `putPosition`(diff) |
| `clearStreams()` | 清空 OPENED Round（保留 COMPLETED 归档）+ 持仓还原 | `deleteTRoundWithTransactions` + `putPosition`(diff) |
| `removeRound(id)` | 删战报 + reconcile 对账剥离调整批次 + rollbackRound + 级联中长期 | `rollbackRound` + `persistPositionDiffs` |
| `transferToPosition(...)` | 划转底仓 + 复用 Round 结清 + 记中长期 | `completeRoundWithMerge` |
| `settleShortRound(fullCode)` | 倒T结算（复用 Round 结清） | `completeRoundClear` |
| `addPosition(pos)` | 新建持仓 | `putPositionWithBatches` |
| `importData(data)` | 全量导入（tRounds/positions/stocks/longTermRecords） | `safeImportAllData` |
| `exportJSON / exportCSV` | — | 只读导出 |

### 4.4 `utils/tStreamEngine.ts` — FIFO 撮合引擎（纯函数，不写 DB）

核心流程：

```
活跃流水池（OPENED Round 的 transactions）
  → 按时间排序（compareByTimestamp）
  → FIFO 买入/卖出队列
  → 配对结算：卖出价 vs 加权均价 P_avg（倒T首笔卖出引用底仓成本 P_base）
  → 输出 StockStreamResult {
       status: 'CLEARED' | 'PENDING' | 'PARTIAL' | 'SHORT_PENDING'
       netPendingAmount / transferProfit / avgPrice / entries（带匹配量的明细）
     }
```

配套派生 Hook `useStreamResults()`（`store/utils.ts`）—— 页面直接订阅即可获得全市场撮合结果，
流水来自 `activeStreamsFromRounds(tRounds)`（仅 OPENED Round），任何轮次/费率/持仓变化自动级联重算。

> 另外该引擎还保留一套**单步状态机**（`createInitialState` / `stepTEngine` / `mergeLongToBase` 等），用于 TCalculator 页面的逐步交互展示，`processAllStreams` 是其批量入口。

### 4.5 短线交易（做T）详细说明

短线交易（做T，T+0 套利）是本项目的核心功能，页面路由 `/t-calculator`，对应 `src/views/TCalculator.tsx`。其设计目标是：在保持底仓不变的前提下，通过 **先买后卖（正T）** 或 **先卖后买（倒T）** 的日内/短期操作，摊低成本或赚取差价利润。

#### 4.5.1 两种做T模式

**正T（T 模式 = `long`，先买后卖）**

适用场景：持仓底仓不动，日内低点买入、高点卖出相同数量，赚取差价。

```
买入 N 股（建T）→ 卖出 N 股（平仓）
利润 = 卖出回收 - 买入支出 - 摩擦成本（按比例分摊）
```

- 首笔流水为 **买入** 自动进入正T
- 买入仅计算支出并增加 `currentQuantity`，**不改变底仓成本**
- 卖出时按比例匹配累积买入量（`matchRatio = sellQty / totalBuyQuantity`），计算已实现利润
- 卖出数量 ≤ 累积买入量时为正常平仓；等量卖出自动结算（`long_auto_close`）
- 未平仓的买入持仓可通过「归并」按纯成交金额并入底仓（`long_merge`）

**倒T（T 模式 = `short`，先卖后买）**

适用场景：判断短期高点，先卖出底仓一部分，回落后再买回，赚取差价或降低成本。

```
卖出 N 股（借仓，引用底仓 P_base）→ 买入 N 股（回补）
```

- 首笔流水为 **卖出** 自动进入倒T
- 首笔卖出引用底仓成本 `P_base` 作为对冲成本基准（`buildBasePositionCosts` 构建 fullCode → P_base 映射）
- 卖出后底仓数量减少、单价不变（移动平均法）
- 回补买入时移动加权更新整体持仓成本：
  ```
  新持有成本 = (剩余底仓总成本 + 本次买入纯支出) / (剩余底仓数量 + 买入数量)
  ```
- 等量回补自动结算（`short_auto_close`）；部分回补后可「部分减持」（`short_partial_reduce`）或「划转」（`short_transfer`）到新底仓

#### 4.5.2 Round 流水池与 FIFO 撮合

所有做T操作都记录为 Round 内的单边流水（buy/sell，`RoundTxn`），不做配对存储，撮合由纯函数引擎实时计算：

```
OPENED Round.transactions（流水池，v8 取代独立 tStreams）
  → activeStreamsFromRounds 派生 TStreamRecord[]
  → 按 fullCode 分组
  → compareByTimestamp 时间升序排序
  → processStockStream 逐条推进状态机（stepTEngine）
  → 输出 StockStreamResult（含 entries 配对明细）
```

- **FIFO 规则**：先买入的先卖出（正T），先卖出的先买回（倒T），符合国内券商结算惯例
- **级联重算**：页面通过 `useStreamResults()` Hook 订阅，任何流水/费率/持仓变化自动重算全市场撮合结果
- **单标的单 OPENED Round**：同一 fullCode 同时至多一个进行中 Round；CLEARED 后 Round 标记 COMPLETED（流水退出活跃池），再次录入自动开启新一轮（跨轮隔离）
- **倒T成本继承**：倒T首笔卖出把底仓 `(P_base × N_sell)` 并入 P_avg 加权池，全部卖出统一按融合 P_avg 结算（`firstSellCostBasis` / `inheritedBaseAmount` 字段）
- **双指标口径**：`realizedPnL`（已实现净收益）与 `transferProfit`（Round 绝对现金流净收益 = 卖出回收 − 加权成本 − 规费）同时展示

#### 4.5.3 状态机与 5 种结算类型

`stepTEngine`（`src/utils/tStreamEngine.ts`）以**单步推进**方式驱动状态机，每一步生成 `TStepNode` 步骤节点卡片，结束时生成 `TSettlementCard` 结算卡片：

| 结算类型 | 触发场景 | 标签颜色 |
|---|---|---|
| `long_auto_close` | 正T 买入后等量卖出，自动平仓 | 🟢 绿 |
| `long_merge` | 正T 买入后未卖出，手动归并底仓 | 🔵 蓝 |
| `short_auto_close` | 倒T 卖出后等量买回，自动平仓 | 🔴 红 |
| `short_partial_reduce` | 倒T 卖出后部分买回，剩余部分减持 | 🟣 紫 |
| `short_transfer` | 倒T 卖出后部分买回，剩余划转新底仓 | 🟠 橙 |

#### 4.5.4 超限防御机制（超卖 / 超买）

当出现 **正T卖超**（卖出量 > 累积买入量）或 **倒T买超**（买入量 > 借仓卖出量）时，引擎触发防御弹窗 `OverflowDefenseDialog`，提供 3 个分支：

| 选项 | 动作 | 说明 |
|---|---|---|
| 选项 A | `auto_hedge` | 自动对冲已有数量并结清（超出的部分忽略） |
| 选项 B | `hedge_then_start_reverse` | 结清当前 T，超出部分自动反向开启（卖超 → 倒T；买超 → 正T） |
| 选项 C | `cancel` | 返回修改，取消防御弹窗 |

对应函数：`resolveOverSellAutoHedge` / `resolveOverSellHedgeThenReverse` / `resolveOverBuyAutoHedge` / `resolveOverBuyHedgeThenReverse` / `cancelDefenseDialog`。UI 层由 `DefenseOverflowModal` 组件渲染。

#### 4.5.5 Round 战报自动归档（v8：复用 Round 结清）

流水池完全配对（`status === 'CLEARED'`）且发生过卖出时，`finalizeRoundIfCleared`（`src/store/utils.ts`）将**已有的 OPENED Round 标记为 COMPLETED** 并回填概览字段：

- Round 在**首笔流水录入时即创建**（OPENED），流水逐笔落库 tTransactions；
- 结清时复用同一 Round 翻转 status（不新建、不复制流水），消除原 tStreams 模型的「重复归档」缺陷；
- 划转/归并场景（`transferToPosition` / `settleShortRound`）同样复用 OPENED Round 结清，走 `completeRoundWithMerge` / `completeRoundClear` 级联结算；
- 删除带归并的战报经 `positionAdjustmentPort.rollbackRound` 按登记簿精确剥离批次、回退加权成本（`src/services/positionAdjustmentPort.ts`）；
- 已完成战报按需懒加载（`useArchivedRounds`），展开「查看成交明细」时才按需查询 `fetchTransactionsByRoundId`。

##### 当前项目过滤（COMPLETED 自动出列）

页面通过 `activeResults = results.filter(r => r.status !== 'CLEARED')` 派生「当前做T项目」列表：

- Round 结清后（COMPLETED），其流水退出活跃池，撮合结果中不再出现该标的 —— **自动从「当前做T项目」卡片流淡出**；
- 头部汇总卡片仍按 `results` 统计累计已实现净收益，与下方归档库的今日累计口径衔接；
- 「清空流水池」按钮仅在进行中项目（`activeResults.length > 0`）时显示，避免误清空已归档数据。

##### 今日战报归档库（仅展示当天）

归档库标题为「🏆 今日战报归档库」，通过 `todayArchivedRounds` 按**本地时区当天**（00:00–24:00）过滤 `closedAt`（兜底 `openedAt`）后渲染：

- 胜率（赢/总 + 百分比）与累计净现金均按当日完成战报统计，聚焦当日做T战绩
- 卡片列表按 `closedAt` 倒序展示当日战报；无当日战报时显示空态引导文案
- 加载逻辑仍基于 `useArchivedRounds`（全量摘要懒加载），当天过滤在页面层完成，不改动 DB 查询

#### 4.5.6 UI 组成（TCalculator.tsx）

| 组件 | 职责 |
|---|---|
| 交易表单 | 选股（StockAutocomplete）、方向（正T买入/倒T卖出）、价格/数量/时间/备注、费用预览、[全部卖出] 快捷键、实时行情展示 |
| `CurrentProjectCard` | 进行中做T项目卡片：加权均价 P_avg、已卖对冲数量、剩余待处理持仓、已实现净收益、Round 绝对现金流净收益、实时行情徽章、流水明细（仅最新一条可撤销删除）、[+追加记录] 快速录入、[划转底仓]、[结算倒T] |
| `TStateMachinePanel` | 状态机可视化：步骤节点卡片（本步支出/回收、单步摩擦、累计利润、当前持仓成本与数量）、结算卡片、超限防御弹窗交互 |
| `ArchiveRoundCard` | 今日战报：净收益、卖出量、均价、成交明细穿透（按需加载）、删除战报（含归并回滚确认弹窗） |
| `StreamStatusBadge` | 状态徽章：PENDING / PARTIAL / CLEARED / SHORT_PENDING |

#### 4.5.7 关键 Store Action 与引擎函数

| 函数 | 位置 | 作用 |
|---|---|---|
| `addStreamRecord(record)` | store/index.ts | 追加流水 + 归一化 + 撮合 + 自动归档 + 增量写库 |
| `removeStreamRecord(id)` | store/index.ts | 删流水 + 重算撮合 + 自动归档 |
| `updateStreamRecord(id, up)` | store/index.ts | 更新流水 + 归一化 + 重算 + 归档 |
| `clearStreams()` | store/index.ts | 清空流水 + 持仓还原 |
| `transferToPosition(fullCode)` | store/index.ts | 正T归并/倒T划转底仓（completeRoundWithMerge） |
| `settleShortRound(fullCode)` | store/index.ts | 倒T清仓结算（completeRoundClear） |
| `removeRound(id)` | store/index.ts | 删战报 + reconcile 对账剥离调整批次 + rollbackRound + 级联中长期（persistPositionDiffs） |
| `validateStreamTrade` | tStreamEngine.ts | 卖出/买入数量校验（可卖数量上限、倒T首笔底仓校验） |
| `processAllStreams` | tStreamEngine.ts | 批量撮合入口（按 fullCode 分组，FIFO 配对结算） |
| `stepTEngine` | tStreamEngine.ts | 状态机单步推进（交互展示用） |
| `useStreamResults` | store/utils.ts | 派生全市场撮合结果 Hook（级联重算核心） |

### 4.6 `hooks/useDataLoader.ts` — 核心数据加载钩子（v7 关键机制）

| Hook | 加载内容 | 使用场景 |
|---|---|---|
| `useLoadCoreData()` | tRounds（OPENED 含流水池）+ positions | AppLayout 挂载时调用一次 |

> v8：`useLoadTStreams` 已移除 —— 流水随 OPENED Round 的 transactions 一并加载。
> 关键实现：`useCallback(useAppStore.getState().loadXxx, [])` 稳定函数引用，避免 useEffect 竞态重复触发；`useRef` 保证每个钩子只加载一次。

---
## 五、阅读路径建议

### 第一阶段：项目骨架（半天）
1. **`GUIDE.md`**（本文件）— 项目全景
2. **`src/main.tsx`** — 启动流程（仅 38 行）
3. **`src/db/schema.ts`** — 11 张表结构
4. **`src/store/types.ts`** — AppStore 接口（相当于"后端 Controller 的 API 文档"）
5. **`src/App.tsx`** — 6 条路由与布局

### 第二阶段：数据流（核心机制）
6. **`src/db/storeInit.ts`** — 冷启动装载 + initialLoadDone 守卫
7. **`src/store/index.ts`** 前半部分 — safePersist 持久化机制（行 85-170）
8. **`src/hooks/useDataLoader.ts`** — 按需加载钩子（v7 新机制）
9. **`src/store/utils.ts`** — 撮合结果派生 Hook + 自动归档
10. **`src/utils/tStreamEngine.ts`** — FIFO 撮合引擎

### 第三阶段：页面功能（按需深入）
11. **`src/views/TCalculator.tsx`** — 短线交易（最复杂页面）
12. **`src/views/CostAveraging.tsx`** — 中长期交易
13. **`src/views/Statistics.tsx`** — 数据统计
14. **`src/views/FeeConfig.tsx`** — 费率配置

---

## 六、关键设计决策

| 决策 | 原因 |
|---|---|
| **Zustand 而非 Redux** | 极简 API，无 boilerplate，selector 细粒度订阅 |
| **Dexie (IndexedDB) 而非 localStorage** | 大容量、事务、索引查询、版本迁移 |
| **增量写库（v5）** | 取代全量 clear+batch 模式，消除数据丢失风险 |
| **safePersist 防护** | 启动装载阶段禁止写库；失败重试 + 失败队列，写库异常不中断 UI |
| **按需加载（v7）** | 冷启动只读 1 行费率，其余数据进页面再加载，降低首屏等待与内存占用 |
| **PWA（vite-plugin-pwa）** | 离线可用、安装到桌面、Workbox 运行时缓存 |
| **Decimal.js 而非原生浮点** | 金融精度要求；JavaScript 0.1+0.2≠0.3 不可接受 |
| **FIFO 撮合而非 LIFO** | 符合国内券商结算惯例 |
| **证券类型分层费率（stock/etf/bond）** | ETF 免印花税/免五、债券免税，按品种精确计费 |

---

## 七、开发命令

```bash
npm install          # 安装依赖
npm run dev          # 开发服务器 (http://localhost:5173)，HMR 热更新
npm run build        # 生产构建 → dist/（vite build + scripts/postbuild.js）
npm run preview      # 预览生产构建
npm test             # 运行单元测试（vitest run，46 用例）
npm run test:watch   # 监听模式，文件变化自动重跑
npx tsc --noEmit     # TypeScript 类型检查（tsconfig 排除了 src/__tests__）
```

---

## 八、版本演进

| 版本 | 变更 |
|---|---|
| v1 | 基础涨跌幅计算 + 成本摊薄 |
| v2 | 做T 记录（正T/倒T 成对买入卖出） |
| v3 | 引入流水池 tStreams + FIFO 撮合引擎 |
| v4 | Round 战报归档 + 绝对现金流划转 + 中长期操作记录；移除 startStorePersistence，持久化改由 Store Action 增量完成 |
| **v5** | **增量持久化重构：移除 table.clear()，改为 put/delete 按实体精确写入** |
| v5.1 | 代码质量提升：共享 Hook（useArchivedRounds）、类型修复、导入门面、longTermRecords 按需加载、Vitest 测试框架 |
| v5.2 | 数据完整性修复：流操作统一管道（归一化→撮合→归档→内存→持久化），持仓变更 diff 检测 + 写库 |
| v6 | Store 层拆分：types.ts（类型）+ utils.ts（纯函数）+ index.ts（Action 实现） |
| v6.1 | deletePositionBatch 修复；safePersist 指数退避重试 + 失败队列；persistError 模块化，移除 DOM 事件耦合 |
| **v7** | **按需加载重构：冷启动仅加载费率配置，核心数据由 useDataLoader 钩子按需加载；新增证券类型（stock/etf/bond）与 ETF 分层费率** |
| v7.1 | 短线交易页聚焦当日：当前做T项目过滤 CLEARED 自动归档项（activeResults）；归档库改为「今日战报归档库」（仅显示当天完成的战报）；移除原注释状态的「中长期操作历史」UI 面板 |
| **v8** | **做T数据模型重构：移除 tStreams 表与旧版 tRecords 兼容层 —— 流水唯一持久化为 tTransactions（Round 内，字段与引擎对齐），Round 概览存 tRounds；单标的单 OPENED Round 规则，结清复用同一 Round 标记 COMPLETED（消除重复归档）；tTransactions 增加 fullCode/direction 索引；v8 upgrade 直接删除 tStreams 表（历史数据不保留，不做迁移）** |
