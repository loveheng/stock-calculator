# 批量导入工作台文档

> **文件位置**: `src/views/BatchImport/` + `src/types/import.ts` + `src/utils/dedup.ts` + `src/utils/importMerger.ts` + `src/services/importAdapter.ts` + `src/services/ocrService.ts`  
> **关联模块**: `src/risk/riskController.ts`（风控预检）、`src/store/`（分流过账）、`src/utils/dedup.ts`（代码/名称归一化）  
> **路由**: `/batch-import`  
> **最后更新**: 2026-08-26 (v3 — 同标的聚合加权加仓 + 代码/名称归一化)

---

## 目录

1. [概述](#1-概述)
2. [架构与文件结构](#2-架构与文件结构)
3. [数据模型](#3-数据模型)
4. [防重核心层（dedup.ts）](#4-防重核心层dedupts)
5. [适配清洗层（importAdapter.ts）](#5-适配清洗层importadapterts)
6. [暂存工作台（BatchImport 视图）](#6-暂存工作台batchimport-视图)
7. [聚合与分流过账（merge + commitRow）](#7-聚合与分流过账merge--commitrow)
8. [集成点全览](#8-集成点全览)
9. [尚未实现 / 待办事项](#9-尚未实现--待办事项)

---

## 1. 概述

批量导入工作台提供了一个**独立路由**（`/batch-import`）的暂存工作台，用于手工录入、剪贴板粘贴、OCR/CSV（未来扩展）等来源的交易数据批量导入。流程遵循**两阶段暂存区（Staging & Validation）架构**：

```
录入/解析 → 暂存草稿 → 批量风控校验 → 聚合（同标的中长期合并）→ 一键分流过账落库
```

### 核心设计原则

- **两阶段暂存区**：数据先进入暂存表格（非持久化 React state），用户确认后再分流过账，避免脏数据直接写入 store
- **三道防重防线**：表内去重（Intra-Batch）→ 跨库比对（Cross-Store）→ UI 差异化标记（覆盖/跳过）
- **业务归类驱动分流**：每行数据指定归类目标（长期批次/短线做T/履约计划单），过账时同标的中长期流水中长期批次先聚合（加权加仓/卖出减仓），再调用对应 store action
- **同标的聚合**：批量导入时，同一标的的多笔中长期流水在过账前合并为一条指令，避免创建多个独立仓位
- **风控前置**：过账前可调用 `RiskController` 批量预检，拦截违规交易
- **全键盘友好**：Enter/Tab 换行输入，提高录入效率

### 适用场景

| 场景 | 来源 | 状态 |
|------|------|------|
| 手工逐笔录入交易 | 用户手动填表 | ✅ 已实现 |
| 从同花顺/东财复制交割单粘贴 | 剪贴板 TSV | ✅ 已实现 |
| OCR 图片识别（前端服务就绪，后端端点待部署） | OCR 接口 | 🟡 前端就绪，依赖后端 |
| CSV 文件批量导入 | 文件上传（本地降级解析） | 🟡 文本类文件支持 |

---

## 2. 架构与文件结构

```
src/
├── types/
│   └── import.ts                     # 批量导入数据类型契约
├── utils/
│   ├── dedup.ts                      # 交易特征指纹生成、查重、代码/名称归一化
│   └── importMerger.ts               # 同标的聚合（加权加仓/卖出减仓）
├── services/
│   ├── importAdapter.ts              # 格式归一化、智能关联 Position/Plan、防重批处理、OCR 载荷解析
│   └── ocrService.ts                 # OCR 图像解析服务（调用后端接口 + 本地文本降级）
├── views/
│   └── BatchImport/
│       ├── index.tsx                 # 路由主页面（状态管理 + 分组编排 + 全局粘贴监听 + 过账编排）
│       ├── StockImportCard.tsx       # 按标的分组的折叠卡片（Summary Bar + 行内编辑列表）
│       └── ImportToolbar.tsx         # 顶部工具栏（上传区 + 全局操作按钮 + OCR 缩略图预览）
└── App.tsx                           # 路由注册（/batch-import）+ 导航项
```

### 分层依赖

```
用户交互层 (View)
  ├── StockImportCard.tsx   — 按标的分组卡片（折叠/展开、Summary Bar、行内编辑器）
  ├── ImportToolbar.tsx     — 上传区（拖拽 + 点击 + 全局粘贴）、操作按钮、OCR 缩略图
  └── index.tsx             — 状态管理（rows / groups）、全局粘贴监听、过账编排
          │
          ▼
适配清洗层 (Adapter & Ingestion)
  ├── importAdapter.ts      — parseClipboardText / parseOcrPayload / enrichDraftRow / completeDedupCheck / inferPlanBind / groupRowsByStock
  ├── importMerger.ts       — mergeImportedTradesToPositions / MergedImportInstruction / BuySummary / SellSummary
  ├── ocrService.ts         — parseOcrFile / extractImageFromClipboard / revokeObjectUrl
  └── dedup.ts              — generateTxFingerprint / classifyDraft / normalizeCode / canonicalizeFullCode / normalizeStockName / isSameStock / PreparedHistory
          │
          ├──► riskController.ts    — 风控预检（evaluateTTrade / evaluateBatch）
          ├──► store actions        — 分流过账（addBatch / addStreamRecord / addPosition / markPlanExecuted）
          └──► store/utils.ts       — 计算工具（calcBatchExecution / recomputePositionSnapshot）
```

---

## 3. 数据模型

### 3.1 `ImportDraftRow`（暂存区行数据模型）

```typescript
// src/types/import.ts

export type ImportTargetCategory =
  | 'LONG_TERM_BATCH'    // 中长期底仓批次 → 分流至 addBatch
  | 'SHORT_TERM_T'       // 短线做T流水 → 分流至 addStreamRecord
  | 'BIND_PLANNED_ORDER' // 履约绑定已有计划单 → addBatch + markPlanExecuted
  | 'NEW_POSITION';      // 全新开仓 → 先 addPosition 再记账

export type ValidationStatus = 'PENDING' | 'PASSED' | 'WARNING' | 'ERROR';

export interface ImportDraftRow {
  id: string;                    // 前端临时 UUID（generateId）
  fingerprint: string;           // 确定性交易特征指纹

  // 基础交易数据
  timestamp: number;             // 成交时间戳（ms）
  fullCode: string;              // 完整证券代码（含市场前缀，如 sh600519）
  stockName?: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;

  // 归类与绑定
  targetCategory: ImportTargetCategory;
  targetPositionId?: string;     // 绑定的持仓 ID
  targetPlannedOrderId?: string; // 绑定的计划单 ID
  isNewPosition?: boolean;       // 无对应 Position 时是否作为全新开仓

  // 防重状态
  duplicateStatus: DuplicateStatus; // 'UNIQUE' | 'POTENTIAL' | 'EXACT_DUPLICATE'
  matchedRecordId?: string;      // 命中的历史记录 ID
  skipImport: boolean;           // 防重/校验拦截时跳过过账

  // 风控状态
  validationStatus: ValidationStatus;
  validationMessage?: string;

  source?: string;               // 来源（'manual' | 'clipboard' | 'ocr' | 'csv'）
}
```

### 3.2 防重状态机

```
┌──────────┐  表内/跨库比对   ┌──────────────────┐
│  UNIQUE  │ ──────────────► │  EXACT_DUPLICATE  │  → skipImport = true
└──────────┘                 └──────────────────┘
      │                              ▲
      │  同日同代码同方向             │
      │  但价格或数量有差异           │ 精确匹配（日期+代码+方向+价格+数量）
      ▼                              │
┌──────────┐                         │
│ POTENTIAL│ ────────────────────────┘
└──────────┘  用户确认强制导入 → skipImport = false
```

---

## 4. 防重核心层（dedup.ts）

### 4.1 指纹生成算法

```
Fingerprint = normalizeCode(fullCode) + "_" + direction + "_" + price.toFixed(3) + "_" + amount + "_" + dateKey(timestamp)
```

**关键细节**：
- `normalizeCode`：从任意格式提取 6 位数字代码（`600519`、`sh600519`、`SH:600519`、`600519.SH` 均归一为 `600519`）；回退时去市场前缀转大写
- `dateKey`：本地时区 `YYYYMMDD`（`new Date(ts).getFullYear() + pad(month) + pad(day)`）
- 时间戳精度对齐：手动录入可能只填日期，未来 OCR 可能精确到秒，指纹采用**年月日 + 价格(3位) + 数量 + 方向 + 代码**作为基准主特征

### 4.1a 归一化工具函数

代码/名称差异的归一化处理是导入防重与同标的聚合的基础：

```typescript
// 归一化代码：从任意格式提取 6 位数字
normalizeCode('sh600519')    // → '600519'
normalizeCode('SH:600519')  // → '600519'
normalizeCode('600519.SH')  // → '600519'
normalizeCode('600519')     // → '600519'

// 规范化为带市场前缀的完整代码（用于存储）
canonicalizeFullCode('600519')      // → 'sh600519'  （按首位推测市场：6/9/5→沪, 4/8→北, 其余→深）
canonicalizeFullCode('SH:600519')  // → 'sh600519'
canonicalizeFullCode('600519.SH')  // → 'sh600519'

// 归一化名称：大写 + 去风险/除权/新股前缀 + 去空格
normalizeStockName('*ST闻泰')   // → '闻泰'
normalizeStockName('XD贵州茅台') // → '贵州茅台'
normalizeStockName('N华大')     // → '华大'

// 判断是否同一标的：优先代码（权威），其次名称（辅助）
isSameStock({ fullCode: 'sh600519' }, { fullCode: '600519' })  // → true
isSameStock({ stockName: '*ST闻泰' }, { stockName: 'ST闻泰' })  // → true
```

**设计原则**：
- **代码是权威键**，`normalizeCode` 用于所有比对/分组
- **名称仅作展示辅助和兜底匹配**（当依赖手动输入、无代码时）
- 导入时若系统已存在该标的持仓，采用系统持仓上的权威代码/名称（`enrichDraftRow` 中的统一键原则）

### 4.2 核心函数

```typescript
// 生成指纹
function generateTxFingerprint(input: {
  fullCode, direction, price, amount, timestamp
}): string

// 比对判定
function classifyDraft(
  input: { fullCode, direction, price, amount, timestamp },
  history: PreparedHistory[],
): { status: DuplicateStatus; matchedId?: string }

// 历史库条目
interface PreparedHistory {
  id: string;
  dk: string;            // 本地 YYYYMMDD
  normalizedCode: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;
}

// 归一化工具
function normalizeCode(raw: string): string
function canonicalizeFullCode(raw: string): string
function normalizeStockName(raw: string): string
function isSameStock(a, b): boolean
```

### 4.3 判定逻辑

| 条件 | 判定 | UI 表现 |
|------|------|---------|
| 同日 + 同代码 + 同方向 + 价格数量一致 | `EXACT_DUPLICATE` | 🔴 标红，`skipImport=true`，禁止过账 |
| 同日 + 同代码 + 同方向，但价格或数量有差异 | `POTENTIAL` | 🟡 标黄，允许用户确认强制导入 |
| 其他 | `UNIQUE` | 🟢 正常展示 |

---

## 5. 适配清洗层（importAdapter.ts）

### 5.1 剪贴板解析（`parseClipboardText`）

支持从同花顺/东财复制的多行制表符/空格分隔文本。格式示例：

```
2026-08-23 10:31	600519	贵州茅台	买入	1680.00	100
600519	买	1680	100
```

解析规则：
1. 尝试匹配日期前缀（`YYYY-MM-DD` 或 `YYYY/MM/DD`），可选含时间部分
2. 取股票代码，可选股票名称（若下一个字段不是买卖方向也不是数字）
3. 取方向（`买/buy` → `buy`，其他 → `sell`）
4. 取价格（浮点数）、数量（整数）
5. 无效行自动跳过

### 5.2 智能推断（`enrichDraftRow`）

根据已有数据为 draft 行填充默认归类与关联目标：

| 条件 | 默认归类 |
|------|----------|
| 该标的已有持仓 | `SHORT_TERM_T`（短线做T） |
| 该标的无持仓 | `LONG_TERM_BATCH`（新开仓） |
| 该标的有活跃计划单 | 可选 `BIND_PLANNED_ORDER` |

同时自动填充 `targetPositionId`（匹配持仓）、`targetPlannedOrderId`（匹配计划单）、`isNewPosition`（无持仓时）。

**统一键原则**：导入时若系统已存在该标的持仓，以持仓上的 `fullCode`/`stockName` 为准（消除导入与行情接口/剪贴板之间的代码/名称差异）。`enrichDraftRow` 内部先对 `fullCode` 做 `canonicalizeFullCode` 规范化，再以 `normalizeCode` 匹配持仓，匹配到后采用持仓的权威代码和名称。

```typescript
// 示例：导入代码 '600519'（无市场前缀），系统已有持仓 'sh600519'
const fullCode = canonicalizeFullCode('600519');  // → 'sh600519'
const norm = normalizeCode(fullCode);              // → '600519'
const pos = positions.find(p => normalizeCode(p.fullCode) === norm);
// 确定用持仓的权威代码/名称
const canonicalFullCode = pos ? pos.fullCode : fullCode;  // → 'sh600519'
const canonicalName = pos?.stockName || row.stockName;    // 用持仓上的名称
```

### 5.2a 计划单智能预挂载（`inferPlanBind`）

当某标的的活跃计划单与流水方向一致，且价格/数量在容差范围内时，自动将行归类设为 `BIND_PLANNED_ORDER`：

```typescript
export function inferPlanBind(
  row: { fullCode: string; direction: 'buy' | 'sell'; price: number; amount: number },
  plannedOrders: PlannedOrder[],
  opts?: { priceTolerance?: number; qtyTolerance?: number }, // 默认 5% / 10%
): PlannedOrder | undefined
```

价格容差默认 5%，数量容差允许 ±1 股或 ±10%。UI 中归类选择器会展示 `📋 自动挂载: 买入 ¥1680×100 (待履约)` 提示。

### 5.2b OCR 载荷解析（`parseOcrPayload`）

将 OCR 后端接口返回的 JSON 载荷归一化为 `RawTxRecord[]`：

```typescript
export function parseOcrPayload(payload: unknown): RawTxRecord[]
```

兼容 `{ items: [...] }` 包装对象或裸数组。支持中英双语字段名（`fullCode` / `证券代码`、`direction` / `交易方向` / `买卖` 等），自动补市场前缀（`toFullCode`）、金额四舍五入到 3 位小数、数量取整。

### 5.2c 按标的分组（`groupRowsByStock`）

将扁平的 `ImportDraftRow[]` 按 `normalizeCode(fullCode)` 聚合为分组数组，供卡片流渲染：

```typescript
export function groupRowsByStock(rows: ImportDraftRow[]): { key: string; items: ImportDraftRow[] }[]
```

`key` 为归一化后的代码（如 `600519`），`__unassigned__` 用于无代码行。

### 5.2d 辅助查询函数

- `getAvailablePositions(positions, fullCode)`: 按标的过滤未结仓持仓
- `getActivePlannedOrders(plannedOrders, fullCode)`: 按标的过滤活跃计划单

### 5.3 批量防重（`completeDedupCheck`）

执行两道防线：

```typescript
export function completeDedupCheck(
  rows: ImportDraftRow[],
  history: PreparedHistory[],  // 从 store 构建的跨库历史指纹集
): ImportDraftRow[]
```

1. **第一道防线（Intra-Batch）**：表内已出现的指纹直接标记 `EXACT_DUPLICATE`
2. **第二道防线（Cross-Store）**：与历史库（positions.batches + longTermRecords）比对

### 5.4 历史库构建（`buildHistoryFromStore`）

从 store 数据拍平为 `PreparedHistory[]`：

```typescript
export function buildHistoryFromStore(
  positions: Position[],
  longTermRecords: LongTermRecord[],
): PreparedHistory[]
```

---

## 6. 暂存工作台（BatchImport 视图）

### 6.1 页面布局概览

页面由三部分构成：
1. **顶部上传区 + 工具栏**（`ImportToolbar`）：文件拖拽/点击上传、全局粘贴监听、展开/折叠/风险过滤/清空/过账按钮、OCR 缩略图预览
2. **主体分组卡片流**（`StockImportCard` × N）：按 `stockCode` 聚合的折叠卡片，每张卡片包含 Summary Bar 和行内编辑列表
3. **全局状态**：`index.tsx` 管理 `rows: ImportDraftRow[]`，通过 `useMemo` 按 `groupRowsByStock` 派生卡片列表

### 6.2 页面状态管理

页面使用 React `useState` 管理 `rows: ImportDraftRow[]`，数据仅驻留在内存中，**不会持久化到 IndexedDB**。页面关闭或刷新后暂存数据丢失——这是有意设计：用户填到一半可切换去查看当前持仓，通过独立路由 + 状态保持（未来可加 `sessionStorage` 兜底）避免误关弹窗丢失数据。

### 6.3 上传区域（`ImportToolbar`）

| 能力 | 实现方式 |
|------|----------|
| 点击选择文件 | `<input type="file">` 隐藏控件，accept `image/*,.csv,.tsv,.txt` |
| 拖拽文件 | `onDragOver` / `onDrop` 事件，视觉反馈（蓝色高亮边框） |
| 全局 Ctrl+V 粘贴 | `index.tsx` 中 `onPaste` 事件监听，区分图片（走 OCR）和文本（本地 TSV 解析） |
| 图片→OCR 解析 | 调用 `ocrService.parseOcrFile` → `POST /api/import/ocr-parse`（后端就绪时）或本地文本降级 |
| 文本/CSV/TSV | 调用 `parseClipboardText` 本地解析，无需后端 |
| OCR 缩略图预览 | 右上角小图缩略 + 点击放大 Modal |

### 6.4 工具栏按钮

| 按钮 | 函数 | 说明 |
|------|------|------|
| 粘贴文本 (Ctrl+V) | `handlePasteText` | 读取剪贴板文本 → `parseClipboardText` → `enrichDraftRow` → `completeDedupCheck` |
| 全部展开 / 折叠 | `onToggleExpand` | 切换所有卡片展开/折叠状态 |
| 仅看风险项 | `onToggleRiskFilter` | 过滤仅显示含 ERROR/WARNING 的卡片 |
| 清空暂存区 | `onClear` | 确认后清空所有暂存行 |
| 一键全部过账 | `onCommitAll` | 过滤有效行 → 逐行 `commitRow` → 清空已过账行 |
| 去重扫描 | `handleDedupAll` | 对全部暂存行重新执行 `completeDedupCheck`（自动在导入时触发） |
| 批量校验 | `handleValidateAll` | 逐行调用 `RiskController`，回填 `validationStatus`（自动在导入时触发） |

### 6.5 分组卡片流（`StockImportCard`）

每张卡片代表一个标的，通过 `useMemo` 将 `rows` 按 `groupRowsByStock` 聚合。

#### 折叠头部（Summary Bar）

| 元素 | 内容 |
|------|------|
| 展开/折叠箭头 | ChevronDown / ChevronRight |
| 股票名称 + 代码 | `group.name` + `group.key` |
| 统计 | `N 笔` + `¥总计` |
| 风险徽标 | 🟢 全部通过 / 🟡 存在警告 / 🔴 拦截阻断 |
| 计划挂载提示 | 若有行自动挂载计划单，显示蓝色 `📋 自动挂载: ...` |
| 快捷操作 | `[过账本组]` `[整组丢弃]` |

#### 展开体（Detail Editor）

1. **标的全局绑定选择器**：下拉选择该标的的已有 Position，或标记「🆕 全新开仓」。组内所有流水默认继承此持仓上下文。
2. **行内编辑列表**：每行渲染 `RowLine` 组件，包含：
   - 成交时间（`datetime-local` input）
   - 方向（买入/卖出）
   - 价格（step=0.001）
   - 数量（整数）
   - 防重状态（新/疑/重 三色）
   - 归类与目标选择器（Combo Select）
   - 风控状态图标
   - 删除按钮
3. **底部添加按钮**：`[+ 为该标的新增一笔流水]`

#### 归类选择器选项

| 选项 | 说明 | 过账路由 |
|------|------|----------|
| `📍 关联持仓 (中长期批次)` | 归入已有持仓的中长期底仓 | `addBatch` |
| `📍 关联持仓 (短线做T流水)` | 归入已有持仓的做T流水 | `addStreamRecord` |
| `📋 履约挂载计划单` | 绑定活跃计划单并触发履约 | `addBatch` + `markPlanExecuted` |
| `✨ 全新开仓` | 先创建新持仓再记账 | `addPosition` + `addBatch` |

### 6.6 键盘导航

- **Enter**：在末行任一控件触发时自动添加新行
- **Tab**：在单元格间正常聚焦切换

### 6.7 全局粘贴流程

```
用户 Ctrl+V
    │
    ├── 剪贴板有图片 → extractImageFromClipboard → parseOcrFile → OCR 解析
    │       └── 失败 → toast 提示
    │
    └── 剪贴板有文本 → parseClipboardText → 本地 TSV 解析
            │
            ▼
    enrichDraftRow (智能归类 + 指纹生成)
            │
            ▼
    completeDedupCheck (表内 + 跨库防重)
            │
            ▼
    handleValidateAll (风控预检)
            │
            ▼
    setRows 更新暂存区
```

---

## 7. 聚合与分流过账（merge + commitRow）

### 7.0 同标的聚合（`mergeImportedTradesToPositions`）

**核心改造**：为解决同一标的（如 `*ST闻泰`）多笔流水被拆分为多个独立仓位的 Bug，在过账前新增聚合步骤。

**生命周期插入点**：位于 `handleCommitRows` 中、正式调用 `addPosition` / `addBatch` 之前。

```
用户点击「确认过账」
       │
       ▼
  过滤 valid 行
       │
       ├── LONG_TERM_BATCH / NEW_POSITION
       │   └── mergeImportedTradesToPositions()  ← 在此聚合
       │           │
       │           ├── 按 normalizeCode(fullCode) 分组
       │           ├── 每组按时间排序
       │           ├── 汇总买入/卖出 → 决定仓位动作（create / add_to）
       │           ├── 保留每笔交易的原始价格/数量/时间戳╱用于后续逐批过账
       │           ├── 匹配已有持仓（未结仓）→ 决定 action
       │           │   ├── 已有持仓 → add_to_position
       │           │   └── 无持仓 → create_position
       │           └── 返回 MergedImportInstruction[]（每标的唯一一条指令）
       │
       └── 其他类别（SHORT_TERM_T / BIND_PLANNED_ORDER）
           └── 逐行 commitRow（不变）
```

**聚合结果类型**：

```typescript
interface MergedImportInstruction {
  fullCode: string;              // 完整证券代码（含市场前缀）
  stockName: string;             // 证券名称
  action: 'create_position' | 'add_to_position';
  existingPositionId?: string;   // 已有持仓 ID
  existingPosition?: Position;   // 已有持仓对象
  allRows: ImportDraftRow[];     // 按时间排序的原始行（审计与 UI 追溯）
  buySummary: BuySummary | null;  // 买入汇总（加权平均）
  sellSummary: SellSummary | null; // 卖出汇总
}

interface BuySummary {
  totalAmount: number;   // 总买入股数
  totalCost: number;     // 总买入金额
  weightedPrice: number; // 加权平均买入价 = totalCost / totalAmount
  count: number;         // 合并的买入笔数
}

interface SellSummary {
  totalAmount: number;   // 总卖出股数
  totalProceeds: number; // 总卖出金额
  count: number;         // 合并的卖出笔数
}
```

**每笔交易独立过账的执行逻辑**（`commitMergedLongTerm`）：

核心原则：**仓位归并，但批次独立。** 每笔交易作为独立 `PositionBatch` 记录，保留原始价格/数量/时间戳，`costAfter`/`amountAfter` 逐笔累积计算。

| 场景 | 处理 |
|------|------|
| `create_position` + 买入 | 首笔买入 → `open` 批次，后续买入 → `add` 批次，每笔独立 |
| `create_position` + 卖出 | 逐笔追加 `reduce` 批次做减仓，每笔独立 |
| `add_to_position` + 买入 | 逐笔 `addBatch`（`add` 类型），每笔独立 |
| `add_to_position` + 卖出 | 逐笔 `addBatch`（`reduce` 类型），每笔独立 |

### 7.1 过账路由

```
handleCommitRows(validRows)
    │
    ├── LONG_TERM_BATCH / NEW_POSITION
    │   └── mergeImportedTradesToPositions()
    │           │
    │           ├── create_position → commitMergedLongTerm
    │           │   └── 逐笔: calcTradeFees → 构造独立 batch → addPosition(含所有批次)
    │           │
    │           └── add_to_position → commitMergedLongTerm
    │               └── 逐笔: calcTradeFees → recomputePositionSnapshot → addBatch
    │
    ├── SHORT_TERM_T
    │   └── commitRow → calcTradeFees → addStreamRecord(自动建Round/撮合/归档)
    │
    └── BIND_PLANNED_ORDER
        └── commitRow → calcBatchExecution → addBatch + markPlanExecuted
```

**同标的聚合保证**：同一标的的 `LONG_TERM_BATCH` / `NEW_POSITION` 行在过账前已合并为唯一一条指令，因此 `addPosition` 对每个标的至多被调用一次。
**但批次独立不合并**：合并的是「仓位」而非「交易」。每笔交易保留原始价格、数量、时间戳作为独立 `PositionBatch`，首笔为 `open`，后续买入为 `add`，卖出为 `reduce`。`costAfter`/`amountAfter` 逐笔累积。

**两条路径互不交叉**：`commitMergedLongTerm` 和 `commitRow` 是对等的两个独立函数，不存在嵌套调用关系。`commitRow` 中**不包含** `LONG_TERM_BATCH` / `NEW_POSITION` 分支——该分支（旧版逐行建仓逻辑）已被删除，因为所有中长期行在到达 `commitRow` 之前已被 `mergeImportedTradesToPositions` 拦截聚合并转由 `commitMergedLongTerm` 处理。

```
handleCommitRows(validRows)
   │
   ├── LONG_TERM_BATCH / NEW_POSITION  ──► mergeImportedTradesToPositions()
   │                                           │
   │                                           └── commitMergedLongTerm（聚合执行）
   │
   └── SHORT_TERM_T / BIND_PLANNED_ORDER ──► commitRow（逐条执行）
```

这种分层保证了：
- **中长期**：先聚合再执行，标的不重复、加权价准确
- **短线做T / 计划单**：逐条独立，无聚合语义，不需归并
- **无死代码**：所有行的目标类别在两个分支中有且仅有一个归宿

### 7.1a Store 级不变量守卫

`addPosition` 在 store 层增加了**同标的开启仓位拦截**，作为全系统防御纵深：

```typescript
addPosition: (pos) => {
  // 检查是否存在同标的开启仓位（normalizeCode 比对 + 名称兜底）
  const dup = existingOpenPosition(get().positions, pos);
  if (dup) {
    recordAudit('add_position_blocked', ...);  // 审计留痕
    throw new Error('标的尚存在开启仓位，请直接在原账本上加仓');
  }
  set(...);  // 正常建仓
}
```

| 防护层级 | 拦截点 | 用户可见性 |
|----------|--------|----------|
| UI 层 | `CostAveraging.handleOpenPosition` | `dupAlert` 弹窗 |
| 聚合层 | `mergeImportedTradesToPositions` | 预览卡片已合并，过账时无感 |
| Store 层 | `addPosition`（全系统） | 抛错 → 调用方 toast/弹窗 |

### 7.2 状态流转

```
录入 → 暂存（PENDING） → 校验（PASSED/WARNING/ERROR）
                           │
                           ▼
                   确认过账（跳过 ERROR + skipImport）
                           │
                           ▼
                   聚合同标的中长期流水 ← 新增步骤
                           │
                           ▼
                   分流落库 → 清空已过账行
```

### 7.3 错误处理

- 过账失败的行保留在表格中，标红提示
- 成功过账的行自动从暂存清除
- 风控 ERROR 的行在过账前被拦截，提示用户先处理
- 聚合后的单条指令执行失败时，整组同标的流水均不会过账（原子性保证）

### 7.4 分组过账

支持三种粒度：
| 操作 | 触发位置 | 行为 |
|------|----------|------|
| 一键全部过账 | 工具栏按钮 | 遍历所有行，过滤 valid 行 → 聚合 + 逐行过账 |
| 过账本组 | 卡片头部按钮 | 仅过账单张卡片内的所有 valid 行（同标的中长期自动聚合） |
| 整组丢弃 | 卡片头部按钮 | 删除单张卡片内的所有行（不落库） |

---

## 8. 集成点全览

### 8.1 已集成的现有模块

| 模块 | 文件 | 用途 |
|------|------|------|
| Store 持仓管理 | `src/store/index.ts` | `addBatch`（中长期批次）、`addPosition`（新开仓，含同标的守卫）、`addStreamRecord`（短线做T）、`markPlanExecuted`（计划履约） |
| Store 计算工具 | `src/store/utils.ts` | `generateId`、`calcBatchExecution`、`recomputePositionSnapshot` |
| 同标的聚合 | `src/utils/importMerger.ts` | 导入前按 `normalizeCode` 合并同标的流水，加权加仓/卖出减仓 |
| 代码/名称归一化 | `src/utils/dedup.ts` | `normalizeCode`、`canonicalizeFullCode`、`normalizeStockName`、`isSameStock` |
| 风控门面 | `src/risk/riskController.ts` | `evaluateTTrade`（做T评估）、`evaluateBatch`（批次评估） |
| 费率计算 | `src/utils/mathUtils.ts` | `calcTradeFees`、`matchSecurityKind` |
| 股票搜索 | `src/components/ui/StockAutocomplete.tsx` | 代码/名称搜索联想 |
| 路由 | `src/App.tsx` | `/batch-import` 路由 + 导航项 |

### 8.2 未硬依赖的模块

| 模块 | 关系 | 说明 |
|------|------|------|
| 审计日志 | 已预留 | 暂未在批量导入中显式调用 `recordAudit`，过账行为由 store action 内部审计 |
| 金字塔健康度 | 已预留 | `RiskController.evaluateBatch` 内部会评估加仓健康度，校验结果通过 `validationMessage` 回显 |

---

## 9. 尚未实现 / 待办事项

### 9.1 持久化指纹（第三道防线）

**问题**：当前防重仅基于运行时内存 store 数据。用户关闭页面后重新打开，指纹集会重建，但无法跨会话检测「历史已导入且已落库」的重复交易。

**解决方案**：给 `PositionBatch` 和 `TStreamRecord` 添加 `importFingerprint?: string` 可选字段，过账时一并写入。后续启动时从 DB 查询所有已存指纹，构建完整的历史指纹集。

**涉及修改**：
1. `src/store/types.ts` — `PositionBatch` 增加 `importFingerprint?: string`
2. `src/types/tStrategy.ts` — `TStreamRecord` 增加 `importFingerprint?: string`
3. `src/db/schema.ts` — `PositionBatchEntity` / `TTransactionEntity` 增加对应字段（Dexie 存对象，新增可选字段**无需 schema 版本迁移**）
4. `src/services/importAdapter.ts` — `buildHistoryFromStore` 扩展从 DB 直接查询已存指纹
5. `src/views/BatchImport/index.tsx` — `commitRow` 中传递 `importFingerprint`

**建议优先级**：中（上线后第二周）

### 9.2 OCR 后端接口部署

**问题**：前端 OCR 服务（`src/services/ocrService.ts`）已就绪，但后端 `POST /api/import/ocr-parse` 端点尚未部署。

**当前状态**：
- `ocrService.ts` 已实现 `parseOcrFile`（图片→OCR 接口 / 文本→本地 TSV 降级）
- `importAdapter.ts` 已实现 `parseOcrPayload`（JSON 载荷归一化）
- UI 已支持文件拖拽/点击上传、全局 Ctrl+V 粘贴图片、OCR 缩略图预览

**待办**：
1. 部署 OCR 解析服务到 `POST /api/import/ocr-parse`
2. 接口返回格式需兼容 `parseOcrPayload` 的输入（`{ items: [...] }` 或裸数组）
3. 接口错误时前端已会降级为 toast 提示

**建议优先级**：中（OCR 服务就绪后）

### 9.3 CSV 文件导入

**问题**：当前文本类文件（CSV/TSV/TXT）已支持通过上传区拖拽/选择或 Ctrl+V 粘贴导入，但无专门的 CSV 解析器（仅支持制表符/空格分隔的 TSV 格式）。

**解决方案**：在 `importAdapter.ts` 中新增 `parseCSVText(text: string): RawTxRecord[]` 函数，使用逗号分隔解析，支持 RFC 4180 标准格式。

**建议优先级**：低（有需求时）

### 9.4 暂存数据持久化（会话保持）

**问题**：当前暂存数据仅存在于 React state 中，页面刷新或误关后丢失。

**解决方案**：在 `index.tsx` 中增加 `sessionStorage` 自动保存/恢复：

```typescript
// 暂存时
useEffect(() => {
  sessionStorage.setItem('batchImportDrafts', JSON.stringify(rows));
}, [rows]);

// 初始化时
useEffect(() => {
  const saved = sessionStorage.getItem('batchImportDrafts');
  if (saved) setRows(JSON.parse(saved));
}, []);
```

**注意**：仅用 `sessionStorage`（非 `localStorage`），避免跨标签页污染。弹窗/独立路由切换不会丢失数据。

**建议优先级**：中（用户体验优化）

### 9.4a OCR 图片上传状态保持

**问题**：当前 `ocrImageUrl` 为 React state 中的 blob URL，页面刷新后丢失。

**解决方案**：在 OCR 图片上传成功后，将图片 Base64 或 URL 存入 `sessionStorage`，页面初始化时恢复。注意 blob URL 需在页面关闭时 `revokeObjectUrl` 清理。

**建议优先级**：低（不会导致数据丢失）

### 9.5 批量编辑（全选/反选/批量修改归类）

**问题**：当前仅支持逐行编辑。当用户导入 20 条以上数据时，逐行修改归类/关联目标效率低。

**解决方案**：在工具栏增加「批量编辑」模式，支持：
- 多选行（checkbox）
- 批量修改归类、关联目标、方向
- 批量删除选中行

**建议优先级**：低（有反馈后）

### 9.6 风控校验结果详情展示

**问题**：当前校验结果仅通过徽标+title 展示摘要信息，用户无法看到详细的校验规则明细。

**解决方案**：在表格行上增加「展开详情」按钮，点击后弹出 `RiskValidationReport` 的完整校验结果列表（`checks[]` 数组），包含每条规则的 `ruleName`、`passed`、`message`、`suggestion`。

**建议优先级**：中（用户体验优化）

### 9.7 导入模板下载

**问题**：用户首次使用时不了解剪贴板/上传格式。

**解决方案**：在工具栏增加「下载模板」按钮，生成一个 TSV 格式的示例文件供用户参考。

**建议优先级**：低（有需求时）

### 9.7a 上传区空状态提示优化

**问题**：当前上传区仅显示文字提示，首次使用的用户可能不清楚支持哪些格式。

**解决方案**：在上传区增加示例格式预览，或显示「点击查看支持格式」的浮层。

**建议优先级**：低（有反馈后）

### 9.8 单位测试覆盖

**问题**：当前批量导入模块无单元测试。

**待办测试**：

| 测试文件 | 待测内容 |
|----------|----------|
| `src/__tests__/dedup.test.ts` | `generateTxFingerprint`、`classifyDraft`、`normalizeCode`、`dateKey` |
| `src/__tests__/importAdapter.test.ts` | `parseClipboardText`（多种格式边界）、`enrichDraftRow`、`completeDedupCheck`、`buildHistoryFromStore`、`parseOcrPayload`、`inferPlanBind`、`groupRowsByStock`、`toFullCode` |
| `src/__tests__/ocrService.test.ts` | `parseOcrFile`（图片/文本分支）、`extractImageFromClipboard` |

**建议优先级**：高（下个迭代）

### 9.9 中长期减仓到 0 自动结仓

**问题**：当前 `commitRow` 中减仓到 0 时不会自动调用 `closePosition`，与手填页 `CostAveraging.handleBatchConfirm` 行为不一致。

**解决方案**：在 `commitRow` 的 `LONG_TERM_BATCH` → `reduce` 分支中，检测 `newAmount <= 0` 时调用 `closePosition`。

**建议优先级**：低（行为对齐，不影响数据正确性）