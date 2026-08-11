# 股票计算器 PWA — 项目阅读指南

> **版本**：v5（增量持久化）  
> **技术栈**：React 19 + Zustand + Dexie (IndexedDB) + TypeScript + Vite + PWA  
> **最后更新**：2026-08-11

---

## 一、项目概览

一个面向个人投资者的 **股票成本摊薄 / 做T盈亏计算器 PWA**，核心功能包括：

| 模块 | 功能 |
|---|---|
| 估值计算器 | 涨跌幅、手续费联动计算 |
| 成本摊薄 | 持仓加权平均法成本追踪（买入/卖出/分红） |
| 做T计算器 | 正T/倒T 双向记录，FIFO 撮合引擎自动配对结算 |
| Round 归档库 | 每轮做T战报自动归档（交易明细 + 净收益 + 持股天数） |
| 历史统计 | 多维度盈亏汇总、胜率、日历热力图 |
| 费率配置 | 佣金/印花税/过户费等费率自定义 |

---

## 二、目录结构

```
src/
├── main.tsx                  # 应用入口：initStore() → ReactDOM.render()
├── App.tsx                   # 路由/布局根组件
│
├── db/                       # █ 数据持久化层 (DAO)
│   ├── schema.ts             #   Dexie 表结构定义 (10 张表)
│   ├── index.ts              #   增量 CRUD 操作 + 安全导入 (23 个导出函数)
│   └── storeInit.ts          #   启动装载 + isInitialLoadDone() 防护
│
├── store/                    # █ 全局状态层 (Zustand)
│   └── index.ts              #   所有 Action + 增量持久化绑定 (~1700 行)
│
├── utils/                    # █ 纯计算引擎
│   ├── mathUtils.ts          #   交易费用计算、四舍五入
│   └── tStreamEngine.ts      #   FIFO 撮合引擎：流水池 → 配对结算
│
├── services/                 # █ 外部数据服务
│   ├── stockService.ts       #   股票搜索 API
│   └── ledgerService.ts      #   账本服务
│
├── types/                    # █ 类型定义
│   ├── stock.ts              #   StockMeta / StockSearchItem
│   └── tStrategy.ts          #   TRecord / RoundTxn 等
│
├── views/                    # █ 页面视图
│   ├── Home.tsx              #   首页仪表盘
│   ├── TCalculator.tsx       #   做T计算器（主界面）
│   ├── CostAveraging.tsx     #   成本摊薄管理
│   ├── Statistics.tsx        #   历史统计 & 热力图
│   ├── ChangeRate.tsx        #   涨跌幅计算器
│   └── FeeConfig.tsx         #   费率配置
│
├── components/ui/            # █ 通用 UI 组件
│   ├── StockAutocomplete.tsx #   股票代码/名称自动补全
│   ├── ConfirmModal.tsx      #   确认弹窗
│   └── InstallPrompt.tsx     #   PWA 安装提示
│
├── __tests__/                # █ 单元测试
│   └── rollbackTransferPosition.test.ts
│
└── styles.css                #   全局样式 (Tailwind CSS)
```

---

## 三、架构分层与数据流

### 3.1 分层架构

```
┌─────────────────────────────────────────┐
│  Views (React Components)               │  ← UI 交互层
├─────────────────────────────────────────┤
│  Store (Zustand useAppStore)            │  ← 内存状态 + Action 逻辑
│  ├─ setFeeConfig / resetFeeConfig       │
│  ├─ addStreamRecord / removeStreamRecord│
│  ├─ addRound / removeRound / transferToPosition
│  ├─ addPosition / updatePosition / ...  │
│  ├─ addLongTermRecord / ...             │
│  └─ importData / exportData             │
├─────────────────────────────────────────┤
│  DB Layer (Dexie IndexedDB)             │  ← 持久化存储
│  put* / delete* / bulkPut* / bulkDelete*│
│  safeImportAllData (全量安全导入)        │
└─────────────────────────────────────────┘
```

### 3.2 数据流 (v5 增量持久化)

```
启动时:
  main.tsx → initStore() → ensureDefaultData() → loadAllFromDB()
          → useAppStore.setState(...) → initialLoadDone = true

运行时 (以 addStreamRecord 为例):
  用户点击"添加流水"
    → views/TCalculator.tsx 收集表单数据
    → useAppStore.getState().addStreamRecord(record)
    → Store Action 内部:
        1. 做T底仓校验 (倒T首笔卖出)
        2. FIFO 撮合引擎重新结算 (processAllStreams)
        3. 自动检查 Round 归档 (archiveRoundIfCleared)
        4. set({ tStreams, tRounds, positions })  ← 内存状态更新
        5. safePersist(() => {                     ← 增量 DB 写入
             putTStream(record)        // 新增流水
             bulkDeleteTStreams(...)   // 删除已结清流水
             putTRound(...)            // 新归档战报
           })

导入时:
  importData(data) → set(...) → safePersist(() => safeImportAllData(...))
                                  → 逐表 bulkPut + 清理不存在记录
```

### 3.3 安全防护机制

```typescript
// db/storeInit.ts
export function isInitialLoadDone(): boolean { return initialLoadDone; }

// store/index.ts
async function safePersist(fn: () => Promise<void>) {
  if (!isInitialLoadDone()) return;  // 启动装载中，禁止写库
  try { await fn(); }
  catch (err) { console.error('[StorePersistence] Failed:', err); }
}
```

- **initialLoadDone 守卫**：在 `initStore()` 完成前，任何 Action 的 DB 写入都会被跳过
- **try/catch 安全网**：DB 写入失败只记录日志，不阻断 UI 操作
- **零 clear() 原则**：整个代码库无任何 `table.clear()` 调用，所有删除按 id/fullCode 精确定位

---

## 四、核心模块详解

### 4.1 `db/schema.ts` — 数据库表结构

| 表名 | 主键 | 说明 |
|---|---|---|
| `feeConfigs` | id (1) | 费率配置，单行 upsert |
| `stocks` | fullCode | 已操作股票元信息 |
| `positions` | id | 持仓账本（底仓） |
| `positionBatches` | id | 持仓批次（open/add/sell/merge） |
| `tRounds` | id | 做T战报归档 |
| `tTransactions` | id | 战报成交明细快照 |
| `tStreams` | id | 做T流水池（原始买卖记录） |
| `longTermRecords` | id | 中长期操作记录 |
| `tRecords` | id | 旧版做T记录（兼容历史数据） |
| `settings` | id | 通用设置键值表 |

---

### 4.2 `db/index.ts` — 持久化操作 API

**23 个导出函数，分为 3 类：**

| 类别 | 函数 |
|---|---|
| **启动** | `ensureDefaultData()`, `loadAllFromDB()` |
| **增量写入** | `putFeeConfig`, `putStock`, `putPosition`, `putPositionBatch`, `putTRound`, `putTransaction`, `putTStream`, `putLongTermRecord` |
| **精确删除** | `deleteStock`, `deletePositionWithBatches`, `deletePositionBatch`, `deleteTRoundWithTransactions`, `deleteTStream`, `bulkDeleteTStreams`, `deleteLongTermRecord`, `deleteLongTermRecordsBySourceReportId` |
| **安全导入** | `safeImportAllData()` — 逐表 bulkPut + 清理不存在记录，绝不调用 clear() |

---

### 4.3 `store/index.ts` — Zustand Action 与 DB 绑定

**AppStore 接口定义了 30+ Action，每个 Action 均绑定增量 DB 写入：**

| Action | Store 更新 | DB 写入 |
|---|---|---|
| `setFeeConfig(partial)` | merge 费率 | `putFeeConfig` |
| `resetFeeConfig(config)` | 覆盖费率 | `putFeeConfig` |
| `addStreamRecord(record)` | 追加流水 + FIFO 撮合 + 自动归档 | `putTStream` + `bulkDeleteTStreams` + `putTRound` |
| `removeStreamRecord(id)` | 删除流水 + 重算撮合 | `deleteTStream` + `bulkDeleteTStreams` |
| `updateStreamRecord(id, up)` | 更新流水 + 重算撮合 | `putTStream` |
| `clearStreams()` | 清空流水 | `bulkDeleteTStreams` |
| `addRound(round)` | 追加战报 | `putTRound` |
| `removeRound(id)` | 删除战报 + 剥离底仓 + 级联中长期 | `deleteTRoundWithTransactions` + `deleteLongTermRecordsBySourceReportId` + `putPosition` |
| `transferToPosition(...)` | 划转到底仓 + 归档战报 | `bulkDeleteTStreams` + `putTRound` + `putLongTermRecord` + `putPosition` |
| `settleShortRound(fullCode)` | 倒T结算 | `bulkDeleteTStreams` + `putTRound` |
| `addPosition(pos)` | 新建持仓 | `putPosition` + `putPositionBatch` |
| `updatePosition(id, up)` | 更新持仓 | `putPosition` |
| `closePosition(id)` | 标记平仓 | `putPosition` |
| `addBatch(pid, batch)` | 追加批次 | `putPosition` + `putPositionBatch` |
| `deletePositionBatch(pid, bid)` | 删除批次 | `deletePositionBatch` + `putPosition` |
| `removePosition(id)` | 删除持仓 | `deletePositionWithBatches` |
| `addLongTermRecord(r)` | 追加记录 | `putLongTermRecord` |
| `removeLongTermRecord(id)` | 删除记录 | `deleteLongTermRecord` |
| `importData(data)` | 全量导入 | `safeImportAllData` |

---

### 4.4 `utils/tStreamEngine.ts` — FIFO 撮合引擎

纯函数，无副作用，不写 DB。核心流程：

```
流水池 (tStreams)
  → 按时间排序
  → FIFO 买入队列 / 卖出队列
  → 配对结算：卖出价 vs P_avg
  → 输出 StockStreamResult {
       netPendingAmount    // 待对冲剩余
       transferProfit      // 已实现净收益
       avgPrice            // 加权均价
       entries             // 带匹配量的明细
     }
```

---

## 五、阅读路径建议

### 新手入门（了解项目骨架）

1. **`GUIDE.md`** (本文件) — 项目全景
2. **`src/main.tsx`** — 启动流程（仅 42 行）
3. **`src/db/schema.ts`** — 数据库表结构
4. **`src/store/index.ts`** 前半部分 — TypeScript 接口定义 (行 1-260)
5. **`src/App.tsx`** — 页面路由

### 理解数据流（核心机制）

6. **`src/db/storeInit.ts`** — 启动装载 + 安全守卫
7. **`src/db/index.ts`** — 持久化 API（重点看增量函数注释）
8. **`src/store/index.ts`** 后半部分 — Action 实现 (行 800+)
9. **`src/utils/tStreamEngine.ts`** — FIFO 撮合引擎

### 深入视图（页面功能）

10. **`src/views/TCalculator.tsx`** — 做T计算器（最复杂页面）
11. **`src/views/CostAveraging.tsx`** — 成本摊薄
12. **`src/views/Statistics.tsx`** — 数据统计
13. **`src/views/FeeConfig.tsx`** — 费率配置

---

## 六、关键设计决策

| 决策 | 原因 |
|---|---|
| **Zustand 而非 Redux** | 极简 API，无 boilerplate，支持 selector 细粒度订阅 |
| **Dexie (IndexedDB) 而非 localStorage** | 支持大容量结构化数据、事务、索引查询 |
| **增量写库 (v5)** | 取代全量 clear+batch 模式，消除数据丢失风险 |
| **safePersist 防护** | 确保启动装载阶段不触发草率写库，写库异常不中断 UI |
| **PWA (Vite PWA plugin)** | 离线可用、安装到桌面、service worker 缓存策略 |
| **Decimal.js 而非原生浮点** | 金融精度要求；JavaScript 0.1+0.2≠0.3 不可接受 |
| **FIFO 撮合而非 LIFO** | 符合国内券商结算惯例 |

---

## 七、开发命令

```bash
npm install          # 安装依赖
npm run dev          # 开发服务器 (http://localhost:5173)
npm run build        # 生产构建 (dist/)
npm run preview      # 预览生产构建
npx tsc --noEmit     # TypeScript 类型检查
npx vitest run       # 运行单元测试
```

---

## 八、版本演进

| 版本 | 变更 |
|---|---|
| v1 | 基础涨跌幅计算 + 成本摊薄 |
| v2 | 做T 记录（正T/倒T 成对买入卖出） |
| v3 | 引入流水池 tStreams + FIFO 撮合引擎 |
| v4 | Round 战报归档 + 绝对现金流划转 + 中长期操作记录 |
| **v5** | **增量持久化重构：移除 table.clear()，改为 put/delete 按实体精确写入** |
