/**
 * @file types.ts
 * @description 全局风控模块类型定义：校验结果、审计日志条目、风控事件。
 * @layer Risk
 * @storage_impact 纯类型定义，无运行时代码。
 * @author 开发团队
 */

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