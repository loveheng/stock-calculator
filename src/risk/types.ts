/**
 * @file types.ts
 * @description 全局风控模块类型定义：校验结果、审计日志条目、风控事件。
 * @layer Risk
 * @storage_impact 纯类型定义，无运行时代码。
 * @author 开发团队
 */

import type { DynamicPyramidResult } from '../utils/mathUtils';
import type { PositionLifecycleSummary } from '../utils/mathUtils';

export type { DynamicPyramidResult };
export type { PositionLifecycleSummary };

// ---- 校验层 ----

/** 校验严重级别 */
export type RiskSeverity = 'error' | 'warning' | 'info';

/** 单条校验结果 */
export interface RiskCheckResult {
  ruleName: string;
  severity: RiskSeverity;
  passed: boolean;
  message: string;
  /** 可执行的补救建议（UI 渲染为按钮文案） */
  suggestion?: string;
}

/** 校验结果聚合 */
export interface RiskValidationReport {
  /** 是否全部通过（passed === true） */
  ok: boolean;
  /** 是否有 error 级别的未通过项 */
  blocked: boolean;
  checks: RiskCheckResult[];
  /** 聚合后的用户可读信息 */
  summary: string;
}

/** 风控校验上下文（仅读，由 Store 注入） */
export interface RiskValidationContext {
  /** 当前时间戳（ISO 字符串） */
  now: string;
  /** 当前市价查询（由外部传入，避免耦合行情服务） */
  getMarketPrice?: (fullCode: string) => number | undefined;
}

// ---- 审计层 ----

/** 操作类型枚举 */
export type AuditActionType =
  | 'add_stream_record'
  | 'remove_stream_record'
  | 'clear_streams'
  | 'remove_round'
  | 'transfer_to_position'
  | 'settle_short_round'
  | 'add_position'
  | 'update_position'
  | 'close_position'
  | 'add_batch'
  | 'delete_batch'
  | 'remove_position'
  | 'import_data'
  | 'export_data'
  | 'set_planned_order'
  | 'planned_order_executed'
  | 'cancel_planned_order'
  | 'mark_plan_executed'
  | 'sandbox_select_stock'
  | 'sandbox_generate_preset'
  | 'sandbox_run_simulation'
  | 'sandbox_delete_branch'
  | 'sandbox_update_orders'
  | 'set_fee_config';

/** 审计日志条目 */
export interface AuditEntry {
  id: string;
  timestamp: number;
  action: AuditActionType;
  /** 操作目标类型（position / round / batch / sandbox / system） */
  targetType: string;
  targetId: string;
  /** 操作前的关键状态快照（仅关键字段） */
  before?: unknown;
  /** 操作后的关键状态快照 */
  after?: unknown;
  result: 'success' | 'rejected';
  /** 拒绝原因或异常信息 */
  reason?: string;
  /** 关联的标记（如 fullCode、roundId 等） */
  tags?: Record<string, string>;
}

// ---- 事件总线 ----

/** 风控事件类型 */
export type RiskEventType =
  | 'VALIDATION_BLOCKED'
  | 'VALIDATION_WARNING'
  | 'PERSIST_FAILURE'
  | 'OPERATION_REJECTED'
  | 'AUDIT_RECORDED';

/** 风控事件（供 UI 消费） */
export interface RiskEvent {
  type: RiskEventType;
  timestamp: number;
  message: string;
  detail?: string;
  recoverable: boolean;
}

// ---- 兼容层（旧 SellValidationResult 形态，供 TCalculator 适配过渡）----

/** @deprecated 迁移至 RiskController 后保留 UI 兼容 */
export interface SellValidationResult {
  valid: boolean;
  maxSellable: number;
  error?: string;
  /** 借仓对冲提示（仅在需要占用底仓时设置） */
  warning?: string;
  /** 是否需要占用底仓（sellAmount > pendingBuyAmount 时） */
  needsBasePosition?: boolean;
  /** 需要占用的底仓数量 */
  neededBaseAmount?: number;
}

/** 借仓对冲元数据 */
export interface BorrowInfo {
  /** 需要占用的底仓数量 */
  neededBase: number;
}

/** 做T交易评估输入 */
export interface TTradeEvalInput {
  sellAmount: number;
  pendingBuyAmount: number;
  availableForT: number;
  price: number;
  fullCode: string;
  direction: 'buy' | 'sell';
}

/** 批次操作评估输入 */
export interface BatchEvalInput {
  amount: number;
  type: string;
  currentAmount?: number;
  /** 新批次价格（用于金字塔健康度评估） */
  price?: number;
  /** 现有买入批次列表（用于动态金字塔健康度评估，仅加仓方向需要） */
  existingBatches?: { amount: number; price: number }[];
  /** 目标批次 id（可选）：用于审计日志 targetId，未传入时回退到时间戳生成 */
  batchId?: string;
}

/** 结仓评估输入 */
export interface ClosePositionEvalInput {
  remaining: number;
  hasOpenTRound: boolean;
  /** 该持仓的历史批次（可选）：用于结仓时补充生命周期履历元数据 */
  batches?: { type: string; amount: number; price: number; timestamp?: string }[];
  /** 目标持仓 id（可选）：用于审计日志 targetId，未传入时回退到 'unknown' */
  positionId?: string;
}

/** 计划单评估输入 */
export interface PlanEvalInput {
  price: number;
  fullCode: string;
  amount: number;
  direction?: 'buy' | 'sell';
  /** 现有买入批次列表（用于动态金字塔健康度评估，仅加仓方向需要） */
  existingBatches?: { amount: number; price: number }[];
}

/** 风控评估结果 */
export interface RiskEvalResult {
  report: RiskValidationReport;
  borrowInfo?: BorrowInfo;
  /** 动态金字塔健康度评估（仅加仓方向可能包含） */
  pyramidHealth?: DynamicPyramidResult;
}