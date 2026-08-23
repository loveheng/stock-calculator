# 全局风控模块文档

> **文件位置**: `src/risk/`  
> **关联模块**: `src/utils/mathUtils.ts`（动态金字塔 / 生命周期履历）  
> **测试文件**: `src/__tests__/riskRules.test.ts`  
> **最后更新**: 2026-08-23

---

## 目录

1. [概述](#1-概述)
2. [架构与文件结构](#2-架构与文件结构)
3. [校验规则目录（R1-R8）](#3-校验规则目录r1-r8)
4. [风控门面 RiskController](#4-风控门面-riskcontroller)
5. [审计日志 AuditLogger](#5-审计日志-auditlogger)
6. [行情价格缓存 PriceCache](#6-行情价格缓存-pricecache)
7. [动态金字塔/加仓健康度模型](#7-动态金字塔加仓健康度模型)
8. [结仓生命周期履历 LifecycleSummary](#8-结仓生命周期履历-lifecyclesummary)
9. [集成点全览](#9-集成点全览)
10. [测试覆盖](#10-测试覆盖)
11. [未实现 / 待办](#11-未实现--待办)

---

## 1. 概述

全局风控模块将散落在各处的风控、借仓校验和越界防护逻辑，统一抽取并收拢到 `src/risk/` 中，建立统一的风控控制中枢。

### 核心设计原则

- **纯函数同步校验**：所有校验规则（`RiskRule`）为纯函数，不依赖外部状态，不发起网络请求
- **非阻塞审计**：审计日志通过 `safePersist` 异步写入 IndexedDB，不阻塞主流程
- **场景化门面**：`RiskController` 提供按业务场景划分的评估入口，内部自动串联规则校验与异步审计
- **软硬分级**：校验结果分为 `error`（硬拦截，`passed=false`，`blocked=true`）和 `warning`（软风控，仅告警提示，`passed=true`，`blocked=false`）

### 需抽取的散落逻辑（已收拢）

| 来源 | 逻辑 | 收拢目标 |
|------|------|----------|
| `src/services/validation.ts`（已移除） | 短线做T阶梯借仓校验 | `tBorrowRule` (R5) |
| `src/utils/calculator.ts` | 减仓超持仓拦截 | `positionLimitRule` (R6) |
| `src/store/index.ts` 内联校验 | 参数合法性检查 | `amountSanityRule` (R1) + `RiskController` |
| `src/store/utils.ts` | 结仓资格校验 | `closeBlockRule` (R7) + `getCloseBlockReason` 代理 |
| 原内联公式 | 做T卖出上限（未扣减在途借仓漏洞） | `tBorrowRule` 两级阶梯逻辑 |

---

## 2. 架构与文件结构

```
src/risk/
├── index.ts          # 模块入口：统一导出所有类型、规则、审计、门面
├── types.ts          # 类型定义：校验结果、审计条目、风控事件、评估输入/输出
├── validator.ts      # 校验引擎 + 规则工厂（R1-R8）
├── riskController.ts # 风控门面：场景化评估入口
├── auditLogger.ts    # 审计日志写入/查询（异步非阻塞）
└── priceCache.ts     # 模块级内存行情价格缓存（非响应式）

src/utils/mathUtils.ts (相关部分)
├── evaluateDynamicPyramid()    # 动态金字塔健康度评估（R8 底层引擎）
├── computePositionLifecycleSummary()  # 结仓生命周期履历摘要
└── 辅助函数: calcPyramidBaseScore / scoreToLevel / buildPyramidSuggestion
```

### 分层依赖

```
视图层 (TCalculator / CostAveraging / PlanOrderCard)
    │
    ▼
RiskController 门面 (riskController.ts)
    │
    ├──► 规则引擎 (validator.ts) — 纯函数同步
    ├──► 审计日志 (auditLogger.ts) — 异步非阻塞
    └──► 价格缓存 (priceCache.ts) — 内存同步读取
    │
    ▼
数学引擎 (mathUtils.ts) — 纯函数
```

---

## 3. 校验规则目录（R1-R8）

| 编号 | 规则名 | 工厂函数 | 级别 | 描述 |
|------|--------|----------|------|------|
| R1 | 数量合理性 | `amountSanityRule(amount, label)` | `error` / `warning` / `info` | 正数校验、100万上限、A股100整数倍提示 |
| R2 | 价格偏离 | `priceDeviationRule(price, fullCode, label)` | `warning` / `error` | 偏离市价 ±20% → warning；±50% → error |
| R3 | 导入数据完整性 | `importDataIntegrityRule(data)` | `error` | 校验导入JSON结构和版本号 |
| R4 | 持仓一致性 | `positionConsistencyRule(recalcCost, storedCost, recalcAmount, storedAmount)` | `warning` | 批次履历 vs 快照字段偏差>0.02元/股预警 |
| R5 | 做T两级阶梯借仓 | `tBorrowRule(sellAmount, pendingBuyAmount, availableForT)` | `error` / `warning` | 先做T池、再底仓；不足则拦截 |
| R6 | 持仓上限（防负持仓） | `positionLimitRule(sellAmount, currentAmount)` | `error` | 减仓数量>当前持仓时拦截 |
| R7 | 结仓资格 | `closeBlockRule(remaining, hasOpenTRound)` | `error` | 有剩余持仓或进行中做T轮次时阻止结仓 |
| R8 | 动态金字塔健康度 | `dynamicPyramidRule(result)` | `warning`（软风控） | 加仓追高 > RISKY 时不硬拦截，仅告警提示 |

### 校验引擎

```ts
function validate<T>(rules: RiskRule<T>[], data: T, ctx: RiskValidationContext): RiskValidationReport
```

- 逐条执行规则，捕获异常不中断
- 聚合结果：`{ ok, blocked, checks[], summary }`
- `blocked` = 存在 `error` 级别且 `passed=false` 的规则

---

## 4. 风控门面 RiskController

### 4.1 evaluateTTrade — 做T交易评估

```ts
static evaluateTTrade(input: TTradeEvalInput): RiskEvalResult
```

**输入**: `TTradeEvalInput`（sellAmount, pendingBuyAmount, availableForT, price, fullCode, direction）

**串联规则**: R1（数量合理性）+ R2（价格偏离）+ R5（做T阶梯借仓）

**输出**: `{ report, borrowInfo? }`

**审计**:
- 被拦截 → `add_stream_record` / `rejected`（带 fullCode, direction）
- 需借仓 → `add_stream_record` / `success`（带 borrowType: 'needs_base'）

### 4.2 evaluateBatch — 批次操作评估

```ts
static evaluateBatch(input: BatchEvalInput): { report, pyramidHealth? }
```

**输入**: `BatchEvalInput`（amount, type, currentAmount?, price?, existingBatches?）

**串联规则**: R1（数量合理性）+ R6（减仓防负持仓）+ R8（加仓时动态金字塔）

**输出**: `{ report, pyramidHealth? }`

**审计**:
- 金字塔 RISKY → `add_batch` / `success`（带 pyramidScore, pyramidLevel）
- 被拦截 → `add_batch` / `rejected`（带 reason, type）

### 4.3 evaluateClosePosition — 结仓资格评估

```ts
static evaluateClosePosition(input: ClosePositionEvalInput): { report, lifecycleSummary? }
```

**输入**: `ClosePositionEvalInput`（remaining, hasOpenTRound, batches?）

**串联规则**: R7（结仓资格）+ 生命周期履历（信息性，不阻断）

**输出**: `{ report, lifecycleSummary? }`

**审计**:
- 被拦截 → `close_position` / `rejected`（带 reason）

### 4.4 evaluatePlan — 计划单评估

```ts
static evaluatePlan(input: PlanEvalInput): { report, pyramidHealth? }
```

**输入**: `PlanEvalInput`（price, fullCode, amount, direction?, existingBatches?）

**串联规则**: R1（计划数量合理性）+ R2（计划价格偏离）+ R8（加仓时动态金字塔）

**输出**: `{ report, pyramidHealth? }`

**审计**:
- 金字塔 RISKY → `set_planned_order` / `success`（带 pyramidScore, pyramidLevel）
- 被拦截 → `set_planned_order` / `rejected`（带 reason, fullCode）

### 4.5 toSellValidationResult — 兼容适配器

```ts
static toSellValidationResult(result: RiskEvalResult, pendingBuyAmount, availableForT): SellValidationResult
```

**定位**: `@deprecated` — 将 `RiskEvalResult` 转换为旧版 `SellValidationResult`，供 `TCalculator` 过渡期使用。新 UI 组件应直接消费 `report`。

---

## 5. 审计日志 AuditLogger

### API

```ts
recordAudit(action, targetType, targetId, result, options?)
queryAuditLogs(options?): Promise<AuditEntry[]>
```

### AuditActionType 完整枚举

| 操作类型 | 触发场景 | 触发位置 |
|----------|----------|----------|
| `add_stream_record` | 追加做T流水 / 做T被拦截 | `RiskController.evaluateTTrade`, Store `index.ts` |
| `remove_stream_record` | 删除做T流水 | Store `index.ts` |
| `clear_streams` | 清空全市场流水池 | Store `index.ts` |
| `remove_round` | 删除做T轮次 | — |
| `transfer_to_position` | 做T归仓 | — |
| `settle_short_round` | 结算做T轮次 | — |
| `add_position` | 新建建仓 | Store `index.ts` |
| `update_position` | 更新持仓 | — |
| `close_position` | 结仓（含生命周期履历 tags） | Store `index.ts` |
| `add_batch` | 追加批次（含金字塔健康度审计） | Store `index.ts` / `RiskController.evaluateBatch` |
| `delete_batch` | 删除批次 | Store `index.ts` |
| `remove_position` | 删除整个标的 | Store `index.ts` |
| `import_data` | 导入数据 | Store `index.ts` |
| `export_data` | 导出数据 | — |
| `set_planned_order` | 设置计划单（含金字塔健康度审计） | `RiskController.evaluatePlan` |
| `planned_order_executed` | **计划单执行履约审计** | `CostAveraging.tsx` |
| `cancel_planned_order` | 取消计划单 | — |
| `mark_plan_executed` | 标记计划单已执行 | — |
| `sandbox_select_stock` | 选股 | `sandboxStore.ts` |
| `sandbox_generate_preset` | 生成预设 | `sandboxStore.ts` |
| `sandbox_run_simulation` | 运行回测 | `sandboxStore.ts` |
| `sandbox_delete_branch` | 删除分支 | `sandboxStore.ts` |
| `sandbox_update_orders` | 更新订单 | `sandboxStore.ts` |
| `set_fee_config` | 设置费率 | Store `index.ts` |

### 审计日志设计要点

- 只追加、不修改、不删除（`AuditEntry` 不可变）
- `id` 使用 `ulid` 生成，支持时间排序
- 写入使用 `safePersist`（指数退避重试，最多3次）
- `before`/`after` 记录操作前后的关键状态快照
- `tags` 记录关联标记（如 `fullCode`, `pyramidScore`, `slippagePct` 等）

---

## 6. 行情价格缓存 PriceCache

```ts
setMarketPrice(fullCode, price)          // 单只设置
setMarketPrices(quotes)                  // 批量设置（配合 useLiveQuotes）
getMarketPrice(fullCode): number | undefined  // 同步读取
clearMarketPrices()                      // 清空缓存
```

### 设计要点

- 纯内存 `Map<string, number>`，不持久化、不依赖 React 响应式
- 由视图层（`TCalculator` / `Home`）在 `useLiveQuotes` 刷新后调用 `setMarketPrices` 填充
- 风控引擎（R2 价格偏离规则）在 Store Action 中同步读取
- 缓存无数据时 R2 跳过校验（空转，不产生告警）

---

## 7. 动态金字塔/加仓健康度模型

### 7.1 定位

**软风控（Warning 级别）**，只做风险提示与审计留痕，**不作硬拦截**（`passed` 保持 `true`）。

### 7.2 核心函数

```ts
function evaluateDynamicPyramid(
  existingBatches: { amount: number; price: number }[],
  newBatch: { amount: number; price: number },
): DynamicPyramidResult
```

### 7.3 评分算法

1. **计算现有加权均价（WAC）**：`Σ(price×amount) / Σamount`
2. **计算偏离幅度**：`(newPrice - WAC) / WAC`
3. **原始评分映射**（`calcPyramidBaseScore`）：

| 偏离幅度 | 原始分 | 描述 |
|----------|--------|------|
| `< -0.15`（深跌） | 60 | 可能价值也可能接飞刀 |
| `< -0.05`（良性回调） | 85 | 低吸布局 |
| `< 0`（轻微回调） | 95 | 机会 |
| `< 0.03`（轻微溢价） | 75 | 轻度溢价可接受 |
| `< 0.08`（明显溢价） | 45 | 追高需谨慎 |
| `< 0.15`（显著溢价） | 25 | 风险较大 |
| `>= 0.15`（追高） | 10 | 严重追高 |

4. **数量比例调整**：偏离 > 0 且数量比例 > 30% 扣 15 分，> 50% 再扣 25 分
5. **评分边界钳制**：`[0, 100]`
6. **等级判定**（`scoreToLevel`）：

| 评分 | 等级 |
|------|------|
| `>= 75` | `HEALTHY` |
| `>= 40` | `NEUTRAL` |
| `< 40` | `RISKY` |

### 7.4 规则适配

`dynamicPyramidRule(result)` 仅在 `level === 'RISKY'` 时产生校验项（`severity: 'warning'`, `passed: true`），HEALTHY 和 NEUTRAL 不产生告警。

### 7.5 集成点

| 场景 | 集成位置 | 触发方式 |
|------|----------|----------|
| 计划单创建时试算 | `CostAveraging.tsx` `handleCreatePlan` | 直接调用 `evaluateDynamicPyramid`，结果存入 `order.planPyramidHealth` |
| 计划单卡片实时展示 | `PlanOrderCard.tsx` | `useMemo` 调用 `evaluateDynamicPyramid`，渲染健康度徽标 |
| 批次加仓风控 | `RiskController.evaluateBatch` | 加仓时自动串联 `dynamicPyramidRule` |
| 计划单风控评估 | `RiskController.evaluatePlan` | 买入方向自动串联 `dynamicPyramidRule` |

---

## 8. 结仓生命周期履历 LifecycleSummary

### 8.1 定位

**信息性元数据（Info）**，在结仓时输出持仓全生命周期的加仓履历摘要，不参与拦截判断。

### 8.2 核心函数

```ts
function computePositionLifecycleSummary(
  batches: LifecycleBatch[],
): PositionLifecycleSummary
```

### 8.3 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalAddRounds` | `number` | 历次加仓轮数（type==='add' 的批次数量） |
| `finalPyramidScore` | `number` | 最终加仓健康分（0-100），以最后一笔买入为新仓评估 |
| `finalPyramidLevel` | `PyramidLevel` | 最终加仓健康度等级 |
| `strategyType` | `string` | 策略分类：`低吸金字塔` / `均衡加仓` / `追高风险` |
| `expansionRatio` | `number` | 最终仓位相比首仓的膨胀倍数 |

### 8.4 算法

1. 过滤买入批次（open/add, amount>0, price>0），按时间排序
2. 如果无买入批次 → 安全基线（100/HEALTHY/首仓建仓/1）
3. 如果仅一次建仓 → 100/HEALTHY/首仓建仓，计算膨胀倍数
4. 如果多次加仓 → 以最后一笔买入为新仓，之前全部为底仓，调用 `evaluateDynamicPyramid` 评估最终健康度

### 8.5 集成点

| 场景 | 集成位置 | 说明 |
|------|----------|------|
| 结仓资格评估 | `RiskController.evaluateClosePosition` | 传入 `batches` 时，返回 `lifecycleSummary` |
| 结仓审计落库 | Store `closePosition` | 写入 `close_position` 审计的 `tags` 和 `after.lifecycleSummary` |
| 清仓弹窗展示 | `ClearPositionModal`（CostAveraging.tsx） | 渲染一行生命周期摘要文案 |

---

## 9. 集成点全览

### 9.1 数据流

```
用户操作
    │
    ▼
视图层 (TCalculator / CostAveraging / PlanOrderCard)
    │
    ├── 直接调用 RiskController.evaluateTTrade / evaluatePlan
    ├── 直接调用 evaluateDynamicPyramid（实时试算）
    └── 调用 Store Action
            │
            ▼
        Store (index.ts / sandboxStore.ts)
            │
            ├── addBatch → RiskController.evaluateBatch
            ├── closePosition → RiskController.evaluateClosePosition（代理）+ recordAudit
            ├── addStreamRecord → RiskController.evaluateTTrade（内联）
            ├── 导入/导出 → validate + importDataIntegrityRule
            └── 所有变更 → recordAudit 审计
            │
            ▼
        IndexedDB (safePersist)
```

### 9.2 引用关系

| 文件 | 引用 | 用途 |
|------|------|------|
| `src/risk/index.ts` | — | 模块入口，`barrel export` |
| `src/store/index.ts` | `risk/validator`, `risk/priceCache`, `risk/types`, `risk/auditLogger`, `risk/riskController` | 导入校验、风控门面、审计 |
| `src/store/utils.ts` | `risk` | `getCloseBlockReason` 代理调用 `evaluateClosePosition` |
| `src/store/sandboxStore.ts` | `risk/auditLogger` | 沙箱操作审计 |
| `src/views/TCalculator.tsx` | `risk/priceCache`, `risk` | 行情缓存填充、做T风控兼容适配 |
| `src/views/CostAveraging.tsx` | `risk/auditLogger`, `utils/mathUtils` | 计划单执行审计、金字塔试算 |
| `src/views/Home.tsx` | `risk/priceCache` | 行情缓存填充 |
| `src/components/PlanOrderCard.tsx` | `utils/mathUtils` | 金字塔健康度实时试算与展示 |
| `src/db/index.ts` | `risk/types` | 审计日志表类型定义 |

---

## 10. 测试覆盖

**测试文件**: `src/__tests__/riskRules.test.ts`（29 个测试用例）

### 覆盖范围

| 测试分组 | 用例数 | 覆盖内容 |
|----------|--------|----------|
| `tBorrowRule` | 4 | 纯做T通过、需借仓+底仓充足、底仓不足拦截、卖出数量<=0 |
| `positionLimitRule` | 2 | 不超过持仓、超过持仓 |
| `closeBlockRule` | 3 | 有剩余持仓、有做T轮次、空仓+无轮次可结 |
| `RiskController.evaluateTTrade` | 3 | 卖出超限拦截、需借仓有底仓、买入方向不触发借仓 |
| `RiskController.evaluateBatch` | 3 | 减仓超限拦截、减仓通过、加仓不触发持仓校验 |
| `RiskController.evaluateClosePosition` | 2 | 清仓可结、有剩余数量阻塞 |
| `evaluateDynamicPyramid` | 5 | 单批次建仓(100分)、良性低价加仓(HEALTHY)、高位重仓追高(RISKY)、evaluateBatch传参、evaluatePlan传参 |
| `computePositionLifecycleSummary` | 7 | 无批次、仅建仓、温和加仓(HEALTHY)、深跌加仓(NEUTRAL)、追高加仓(RISKY)、evaluateClosePosition传batches、不传batches |

### 未覆盖的测试

- 审计日志写入/查询的异步验证（`recordAudit` 使用 `safePersist` 异步）
- 价格缓存集成测试（`priceCache` 与 `priceDeviationRule` 联动）
- `getCloseBlockReason` 代理集成测试（已在 `getCloseBlockReason.test.ts` 中有10个用例，但未覆盖 `batches` 传入时的 `lifecycleSummary`）

---

## 11. 未实现 / 待办

### 11.1 功能缺口

| 优先级 | 模块 | 未实现内容 | 说明 |
|--------|------|-----------|------|
| P1 | 审计查询 | 审计日志 UI 页面 | `queryAuditLogs` 函数已实现，但缺乏前端页面展示审计记录。当前仅往 IndexedDB 写，无入口查看。 |
| P1 | 风控事件总线 | 风控事件 UI 消费 | `RiskEventType` 和 `RiskEvent` 接口已定义，但未接入事件总线，UI 无法实时响应风控事件（如弹窗提示）。 |
| P2 | 规则 | **现金不足拦截** | 原 `calcBatchExecution` 中有现金不足的硬拦截，当前未纳入风险规则体系。需新增 R9（`cashLimitRule`）。 |
| P2 | 规则 | **做T卖出上限公式统一** | 原 Store 内联公式中做T卖出上限为 `pendingBuyAmount + availableForT`，但 `availableForT` 未扣减在途借仓。当前 `tBorrowRule` 已通过两级阶梯逻辑处理。✅ **已确认**：Store 侧旧内联公式已完全移除，`addStreamRecord` 和 `TCalculator` 均已改走 `RiskController.evaluateTTrade`（含 R1/R2/R5），全量测试通过。 |
| P2 | 门面 | `evaluateTTrade` 审计优化 | 当前 `evaluateTTrade` 的审计日志固定使用 `add_stream_record` 作为 action 类型，但该场景实际上属于做T交易前置校验，应考虑使用独立的 action 类型（如 `ttrade_evaluate`）以区分实际流水写入。 |
| P3 | 规则 | **导入数据完整性**（R3） | 规则已实现，但 Store 的 `import_data` 流程中是否已串联调用 `importDataIntegrityRule` 需确认。当前 `importDataIntegrityRule` 未在 `RiskController` 门面中暴露，仅在 Store 中单独使用。 |
| P3 | 规则 | **持仓一致性**（R4） | 规则已实现但未在任何 Store Action 中串联调用。当前仅作为独立规则工厂存在，需在 `addBatch` / `deletePositionBatch` 等操作后自动触发。 |
| P3 | 兼容 | **TCalculator 完全迁移** | `TCalculator` 仍使用 `toSellValidationResult` 兼容适配器读取风控结果。需将 UI 组件完全迁移至直接消费 `RiskEvalResult.report` 后移除该适配器。 |

### 11.2 技术债务

| 类型 | 内容 | 建议 | 状态 |
|------|------|------|------|
| 类型 | `SafeSold` 等弃用类型 | 检查 `src/store/types.ts` 中是否存在已不再使用的旧类型，需清理 | 未确认 |
| 审计 | 结仓审计 `targetId` 硬编码 | `RiskController.evaluateClosePosition` 中审计日志的 `targetId` 为 `'unknown'` 字符串，应改为传入真实 position id | ✅ 已修复：`ClosePositionEvalInput` 新增 `positionId`，`getCloseBlockReason` 传入 `pos.id` |
| 审计 | 批次审计 `targetId` 生成 | `evaluateBatch` 中审计日志的 `targetId` 使用 `'batch-' + Date.now()`，不够精确，应考虑传入真实 batch id | ✅ 已修复：`BatchEvalInput` 新增 `batchId`，Store `addBatch` 传入 `batch.id` |
| 测试 | 动态金字塔评分公式 | `calcPyramidBaseScore` 对深跌（< -0.15）的评分仅为 60 分（NEUTRAL），可能导致"越跌越买的网格策略"被低估。当前为设计决策，但需持续观察用户反馈。 | 设计决策 |
| 测试 | 生命周期履历测试 | 缺少 `getCloseBlockReason` 传入 `batches` 时的 `lifecycleSummary` 行为测试 | 未实现 |

### 11.3 未来扩展方向

1. **R9 现金不足拦截**：从 `calculator.ts` 的 `calcBatchExecution` 中提取现金校验逻辑，封装为 `cashLimitRule`
2. **风控事件 UI 通知**：接入 `RiskEvent` 接口，实现全局风控事件通知组件（Toast / Modal）
3. **审计日志查看器**：基于 `queryAuditLogs` 实现的审计日志管理页面，支持按操作类型、时间范围筛选
4. **风控规则热重载**：支持从外部配置（如 JSON / API）动态加载规则参数（阈值、级别等）
5. **批量风控评估**：`evaluateBatch` 支持同时评估多个批次操作（如导入多笔时）
6. **金字塔评分参数可配置**：`calcPyramidBaseScore` 的阈值区间支持用户自定义