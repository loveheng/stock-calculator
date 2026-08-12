# 股票计算器 PWA — 项目阅读指南

> **版本**：v7（按需加载重构）  
> **技术栈**：React 19 + React Router 7 + Zustand + Dexie (IndexedDB) + TypeScript + Vite + PWA + Vitest  
> **最后更新**：2026-08-12

---

## 一、项目概览

一个面向个人投资者的 **股票做T账本与成本计算器 PWA**，全部数据保存在浏览器本地（IndexedDB），无需后端服务，离线可用（PWA）。共 6 个功能页面：

| 页面 | 路由 | 核心功能 |
|---|---|---|
| 首页仪表盘 | `/` | 做T总览、近 N 日收益趋势、持仓分布、账户现金流、做T异动预警 |
| 涨跌幅计算器 | `/change-rate` | 涨跌幅⇄目标价双向换算、涨跌停阶梯推算、手续费联动 |
| 短线交易（做T计算器） | `/t-calculator` | 正T/倒T 双向记录，FIFO 撮合引擎自动配对结算，Round 战报自动归档 |
| 中长期交易（成本摊薄） | `/cost-averaging` | 多批次建仓账本（建仓/加仓/减仓/结案）+ 目标成本反推补仓 |
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
    │   └── utils.ts       #   纯函数：generateId / 归并回滚 / useStreamResults / 自动归档
    │
    ├── hooks/             # █ 共享 React Hooks
    │   ├── useDataLoader.ts    #   按需加载钩子（useLoadCoreData / useLoadPositions / ...）
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
    ├── views/             # █ 页面视图（6 个页面）
    │   ├── Home.tsx
    │   ├── ChangeRate.tsx
    │   ├── TCalculator.tsx    # 短线交易（最复杂页面）
    │   ├── CostAveraging.tsx
    │   ├── Statistics.tsx
    │   └── FeeConfig.tsx
    │
    ├── components/ui/     # █ 通用 UI 组件
    │   ├── StockAutocomplete.tsx  # 股票代码/名称自动补全
    │   ├── ConfirmModal.tsx       # 确认弹窗
    │   └── InstallPrompt.tsx      # PWA 安装提示
    │
    └── __tests__/         # █ 单元测试 (Vitest，共 46 用例)
        ├── mathUtils.test.ts                 # 35 用例
        └── rollbackTransferPosition.test.ts  # 11 用例
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
    └─ utils.ts   纯函数（撮合结果派生 Hook、Round 自动归档、归并回滚）
DB Layer (Dexie IndexedDB)                  ← 持久化存储
    └─ schema.ts（11 表） / index.ts（40+ 函数） / storeInit.ts
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
  useLoadCoreData() → loadTStreams() + loadPositions() + loadTRounds()   # 并行
                    → setCoreDataLoaded(true)                            # 核心数据就绪
  各页面再按需加载: useLoadPositions / useLoadTStreams / useLoadTRounds / useLoadStocks

运行时（以 addStreamRecord 为例）:
  用户点击"添加流水"
    → views/TCalculator.tsx 收集表单数据
    → useAppStore.getState().addStreamRecord(record)
    → Store Action 内部（统一管道）:
        1. 做T底仓校验（validateStreamTrade / 倒T首笔卖出）
        2. normalizeShortTDeductions（归一化倒T底仓扣减）
        3. buildBasePositionCosts → processAllStreams（FIFO 撮合）
        4. archiveRoundIfCleared（自动 Round 归档）
        5. set({ tStreams, tRounds, positions })   ← 内存状态更新
        6. safePersist(() => { ... })              ← 增量 DB 写入
             putTStream(record)        # 新增/更新流水
             putTRound(...)            # 新归档战报
             putPosition(...)          # 被修改的持仓（diff 检测）

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

### 4.1 `db/schema.ts` — 数据库表结构（11 张表，库名 TradingLedgerDB_v3）

| 表名 | 主键 | 说明 |
|---|---|---|
| `stocks` | fullCode | 股票元信息（含 `kind`：stock/etf/bond 费率分类） |
| `positions` | id | 持仓账本（底仓成本 + 数量 + 平仓状态） |
| `positionBatches` | id | 持仓批次（open/add/reduce） |
| `tRounds` | id | 做T战报（status: OPENED/COMPLETED） |
| `tTransactions` | id | 战报成交明细快照 |
| `tStreams` | id | 做T流水池（进行中 Round 的单边买卖记录） |
| `accountCash` | id=1 | 现金账户（单行；初始化已做，UI 待开发） |
| `cashFlows` | id | 现金流水（预留，尚无读写代码） |
| `tradeNotes` | id | 交易笔记（预留，尚无读写代码） |
| `feeConfigs` | id=1 | 费率配置（单行） |
| `longTermRecords` | id | 中长期操作记录（buy/sell/merge，与战报级联删除） |

> 所有实体继承 `BaseEntity`（id / createdAt / updatedAt / `isDeleted` 软删除标记）。
> 表结构用版本链常量 `STORES_V2 → STORES_V6` 增量叠加，新增表/索引时在链尾追加即可，无需全量复制。

### 4.2 `db/index.ts` — 持久化操作 API（40+ 导出函数）

| 类别 | 函数 |
|---|---|
| **启动/装载** | `ensureDefaultData`, `loadFeeConfigFromDB`, `loadPositionsFromDB`, `loadTStreamsFromDB`, `loadTRoundsFromDB`, `loadStocksFromDB` |
| **增量写入** | `putFeeConfig`, `putStock`, `bulkPutStocks`, `putPosition`, `putPositionWithBatches`, `putPositionBatch`, `addBatchToPosition`, `replacePositionBatches`, `putTRound`, `putTransaction`, `replaceRoundTransactions`, `putTStream`, `putLongTermRecord` |
| **精确删除** | `deleteStock`, `deletePositionWithBatches`, `deletePositionBatch`, `deleteTRoundWithTransactions`, `deleteTStream`, `bulkDeleteTStreams`, `deleteLongTermRecord`, `deleteLongTermRecordsBySourceReportId`, `deleteRoundWithCascade` |
| **级联结算** | `completeRoundWithMerge`（划转底仓）, `completeRoundClear`（清仓结算） |
| **查询/分页** | `fetchBatchesByPositionId`, `fetchClosedPositionsPage`, `fetchAllClosedPositions`, `fetchOpenRoundsWithTransactions`（进行中 Round，含明细）, `fetchCompletedRoundsPage`（已完成 Round，仅摘要，不含明细）, `fetchAllCompletedRounds`（导出用，含明细）, `fetchTransactionsByRoundId`（明细按需查询）, `fetchAllLongTermRecords` |
| **安全导入** | `safeImportAllData` — 逐表批量 upsert + 清理残留记录，绝不调用 clear() |

> 写库前统一经 `cleanUndefined()` 剔除 undefined 字段（IndexedDB 结构化克隆不允许 undefined）。
> `Row` 类型（PositionRow/TRoundRow/...）与 Store 类型同源（type 别名），改一处全局生效。
>
> **Round 成交明细按需加载**：列表加载器（`fetchCompletedRoundsPage` → `useArchivedRounds`）只返回轮次摘要
> （含 `tradeCount` 等汇总字段，不含 `transactions`）；UI 展开「查看成交明细」时才通过
> `fetchTransactionsByRoundId` 按需查询 `tTransactions` 表。写入路径（`putTRound` / `completeRoundClear` /
> `completeRoundWithMerge` / `safeImportAllData`）负责把明细持久化到 `tTransactions`，保证按需加载有据可查；
> `fetchAllCompletedRounds`（导出用）仍返回完整明细。

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
  coreDataLoaded: boolean;         // 核心数据（流水/持仓/战报）是否已加载
  feeConfig: FeeConfig;            // 费率配置（含 ETF 分层费率）
  tRecords: TRecord[];             // @deprecated 旧版做T记录（仅统计页兼容展示）
  tStreams: TStreamRecord[];       // 做T流水池
  tRounds: TRoundArchive[];        // 进行中的 Round 战报
  positions: Position[];           // 持仓账本
  stocks: StockMeta[];             // 股票元信息
  longTermRecords: LongTermRecord[]; // 中长期操作记录
  persistError: string | null;     // 最近一次持久化错误
}
```

**关键 Action 与 DB 绑定（摘录）：**

| Action | Store 更新 | DB 写入 |
|---|---|---|
| `loadTStreams / loadPositions / loadTRounds / loadStocks` | 全量装载对应数据 | 只读查询 |
| `setFeeConfig(partial)` | merge 费率 | `putFeeConfig` |
| `addStreamRecord(record)` | 追加流水 + FIFO 撮合 + 自动归档 | `putTStream` + `putTRound` + `putPosition`(diff) |
| `removeStreamRecord(id)` | 删流水 + 重算撮合 + 自动归档 | `deleteTStream` + `putTRound` + `putPosition`(diff) |
| `updateStreamRecord(id, up)` | 更新流水 + 归一化 + 重算 + 归档 | `putTStream` + `putTRound` + `putPosition`(diff) |
| `clearStreams()` | 清空流水 + 持仓还原 | `bulkDeleteTStreams` + `putPosition`(diff) |
| `removeRound(id)` | 删战报 + 剥离底仓 + 级联中长期 | `deleteRoundWithCascade` |
| `transferToPosition(...)` | 划转底仓 + 归档 + 记中长期 | `completeRoundWithMerge` |
| `settleShortRound(fullCode)` | 倒T结算归档 | `completeRoundClear` |
| `addPosition(pos)` | 新建持仓 | `putPositionWithBatches` |
| `importData(data)` | 全量导入 | `safeImportAllData` |
| `exportJSON / exportCSV` | — | 只读导出 |

### 4.4 `utils/tStreamEngine.ts` — FIFO 撮合引擎（纯函数，不写 DB）

核心流程：

```
流水池 (tStreams)
  → 按时间排序（compareByTimestamp）
  → FIFO 买入/卖出队列
  → 配对结算：卖出价 vs 加权均价 P_avg（倒T首笔卖出引用底仓成本 P_base）
  → 输出 StockStreamResult {
       status: 'CLEARED' | 'PENDING' | 'PARTIAL' | 'SHORT_PENDING'
       netPendingAmount / transferProfit / avgPrice / entries（带匹配量的明细）
     }
```

配套派生 Hook `useStreamResults()`（`store/utils.ts`）—— 页面直接订阅即可获得全市场撮合结果，任何流水/费率/持仓变化自动级联重算。

> 另外该引擎还保留一套**单步状态机**（`createInitialState` / `stepTEngine` / `mergeLongToBase` 等），用于 TCalculator 页面的逐步交互展示，`processAllStreams` 是其批量入口。

### 4.5 `hooks/useDataLoader.ts` — 按需加载钩子（v7 核心机制）

| Hook | 加载内容 | 使用场景 |
|---|---|---|
| `useLoadCoreData()` | tStreams + positions + tRounds | AppLayout 挂载时调用一次 |
| `useLoadPositions()` | positions | CostAveraging 等 |
| `useLoadTStreams()` | tStreams | TCalculator 等 |
| `useLoadTRounds()` | tRounds | TCalculator 等 |
| `useLoadStocks()` | stocks | 需要股票自动补全的页面 |

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
