/**
 * @file tStrategy.ts
 * @description 短线 T+0 套利（正T / 倒T）状态机、计算引擎与 UI ViewModel 类型定义。
 * @layer DAO（类型层）
 * @storage_impact 纯类型定义，无运行时逻辑，不读写任何存储。
 */

import type { FeeConfig, TradeFees } from '../utils/mathUtils';

// ──────────────────────────────────────────────
// 1. 基础实体
// ──────────────────────────────────────────────

/** 底仓对象 */
export interface BasePosition {
  /** 持仓成本（移动加权均价） */
  cost: number;
  /** 持有数量（股） */
  quantity: number;
}

/** 做 T 的方向模式 */
export type TMode = 'long' | 'short';

/** 交易方向 */
export type TradeDirection = 'buy' | 'sell';

/** 做 T 过程中的单笔流水记录 */
export interface TStreamRecord {
  id: string;
  timestamp: string;
  fullCode: string;
  stockName: string;
  direction: TradeDirection;
  price: number;
  amount: number;
  /** 该笔交易的摩擦成本（由系统费率动态计算） */
  fee: number;
  /** @deprecated 倒T卖出时从底仓扣减的数量（旧引擎兼容字段） */
  baseDeductedAmount?: number;
  /** 倒T买入时已归并到底仓的超额数量（用于幂等，仅在 buy 记录上有值） */
  baseMergedAmount?: number;
  /** 该卖出流对应的出借批次 ID（normalizeShortTDeductions 设置） */
  borrowBatchId?: string;
  /** 该买入流对应的归并批次 ID（applyShortExcessMerge 设置，多个流共享同一个 ID） */
  mergeBatchId?: string;
  note?: string;
  quoteId?: string;
  selectedStock?: any;
}

// ──────────────────────────────────────────────
// 2. 过程节点卡片 ViewModel（中间状态 UI）
// ──────────────────────────────────────────────

/** 做 T 过程中的每一步快照（用于 UI 步骤卡片渲染） */
export interface TStepNode {
  /** 步骤序号（从 1 开始） */
  index: number;
  /** 方向标签 */
  direction: TradeDirection;
  /** 成交单价 */
  price: number;
  /** 成交数量 */
  amount: number;
  /** 成交金额（price × amount） */
  turnover: number;

  /** 本步纯支出（买入时 = turnover + fee）或 null */
  netOutflow: number | null;
  /** 本步纯回收（卖出时 = turnover - fee）或 null */
  netInflow: number | null;
  /** 本步摩擦成本 */
  stepFrictionCost: number;

  /** 截至当前步骤的已实现累计盈亏 */
  cumulativeProfit: number;
  /** 截至当前步骤的摩擦总成本 */
  cumulativeFrictionCost: number;

  /** 当前持仓成本（移动加权均价） */
  currentCost: number;
  /** 当前持有数量 */
  currentQuantity: number;

  /** 本次流水原始记录 id */
  recordId: string;
  /** 交易时间戳 */
  timestamp: string;
  /** 备注（可选） */
  note?: string;
}

// ──────────────────────────────────────────────
// 3. 结算卡片 ViewModel（结束 / 归并 / 减持）
// ──────────────────────────────────────────────

/** 结算类型 */
export type SettlementType =
  | 'long_auto_close'      // 正T 自动结束（卖出平仓）
  | 'long_merge'           // 正T 归并底仓
  | 'short_auto_close'     // 倒T 自动结束（买回平仓）
  | 'short_partial_reduce' // 倒T 部分减持
  | 'short_transfer';      // 倒T 划转

/** 最终结算卡片 ViewModel */
export interface TSettlementCard {
  /** 结算类型 */
  settlementType: SettlementType;
  /** 显示标签，如 "[正T 自动结束]" */
  label: string;
  /** 标签颜色方案 */
  labelColor: 'green' | 'red' | 'blue' | 'purple' | 'orange';

  /** 做 T 模式 */
  mode: TMode;

  /** 总支出（含摩擦） */
  totalOutflow: number;
  /** 总回收（含摩擦） */
  totalInflow: number;
  /** 总摩擦成本 */
  totalFrictionCost: number;
  /** 已实现套利利润 */
  realizedArbitrageProfit: number;

  /** 更新后底仓成本 */
  updatedBaseCost: number;
  /** 最终持有数量（底仓） */
  finalQuantity: number;

  /** 归并/减持数量（仅归并或减持场景有值） */
  mergeQuantity: number | null;
  /** 归并/减持金额 */
  mergeAmount: number | null;

  /** 做 T 过程中涉及的所有步骤节点 */
  steps: TStepNode[];
}

// ──────────────────────────────────────────────
// 4. 异常分支交互（超卖 / 超买防御）
// ──────────────────────────────────────────────

/** 超限防御类型 */
export type OverflowDefenseType = 'over_sell' | 'over_buy';

/** 超卖防御分支选项 */
export interface OverflowDefenseOption {
  /** 选项标识 */
  key: string;
  /** 选项描述文案 */
  label: string;
  /** 触发动作 */
  action: 'auto_hedge' | 'hedge_then_start_reverse' | 'cancel';
}

/** 超限防御弹窗数据 */
export interface OverflowDefenseDialog {
  /** 是否显示弹窗 */
  visible: boolean;
  /** 超限类型 */
  type: OverflowDefenseType;
  /** 弹窗标题 */
  title: string;
  /** 说明文案 */
  description: string;
  /** 3 个分支选项 */
  options: OverflowDefenseOption[];
  /** 待提交的流水数据（暂存，待用户选择后处理） */
  pendingRecord: TStreamRecord | null;
}

// ──────────────────────────────────────────────
// 5. 状态机上下文
// ──────────────────────────────────────────────

/** 做 T 状态机当前状态 */
export interface TStateMachineState {
  /** 做 T 模式 */
  mode: TMode;
  /** 初始底仓快照 */
  basePosition: BasePosition;

  /** 累积买入数量 */
  totalBuyQuantity: number;
  /** 累积买入纯支出（不含摩擦）= Σ(price × amount) */
  totalBuyTurnover: number;
  /** 累积买入摩擦总成本 */
  totalBuyFriction: number;

  /** 累积卖出数量 */
  totalSellQuantity: number;
  /** 累积卖出纯回收（不含摩擦）= Σ(price × amount) */
  totalSellTurnover: number;
  /** 累积卖出摩擦总成本 */
  totalSellFriction: number;

  /** 已实现套利利润 */
  realizedProfit: number;

  /** 当前持仓成本（移动加权均价） */
  currentCost: number;
  /** 当前持有数量（做 T 过程中动态持有量） */
  currentQuantity: number;

  /** 所有步骤节点 */
  steps: TStepNode[];

  /** 是否已结束 */
  isClosed: boolean;
  /** 结束原因 */
  closeReason: SettlementType | null;
  /** 结算卡片（结束时生成） */
  settlementCard: TSettlementCard | null;

  /** 当前待处理的防御弹窗 */
  defenseDialog: OverflowDefenseDialog | null;
}

// ──────────────────────────────────────────────
// 6. 计算引擎输入 / 输出
// ──────────────────────────────────────────────

/** 引擎输入：单步推进参数 */
export interface TEngineStepInput {
  /** 当前状态机状态 */
  state: TStateMachineState;
  /** 新流水记录 */
  record: TStreamRecord;
  /** 系统费率配置 */
  feeConfig: FeeConfig;
  /** 底仓（用于倒 T 引用） */
  basePosition: BasePosition;
}

/** 引擎输出：单步推进结果 */
export interface TEngineStepOutput {
  /** 更新后的状态 */
  newState: TStateMachineState;
  /** 是否触发了防御弹窗 */
  triggeredDefense: boolean;
  /** 是否需要向底仓归并 / 减持 */
  needsMergeToBase: boolean;
  /** 归并/减持信息 */
  mergeInfo: {
    quantity: number;
    amount: number;
    newBaseCost: number;
    newBaseQuantity: number;
  } | null;
}