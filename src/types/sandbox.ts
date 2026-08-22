/**
 * @file sandbox.ts
 * @description 沙盘推演（事后复盘 / What-if）功能类型定义：
 *              三类分支（基线/预设/用户方案）、沙盘订单、K 线条目、
 *              推演结果与时间线快照、四维对比指标行。
 *              本次重构新增：DCA 时序现金注入（cashInjections / injectionType）、
 *              累计投入本金（totalInjectedCash）与资金/时间加权收益口径。
 * @layer DAO（类型层）
 * @storage_impact 纯类型定义，无运行时代码；SandboxBranch / SandboxOrder
 *                 与 db/schema.ts 中 SandboxBranchEntity / SandboxOrderEntity 对应，
 *                 KlineItem 与 klineCache 表的缓存载荷对应。
 * @author 开发团队
 */

/** 分支类型：基线 / 预设 / 用户方案 */
export type SandboxBranchType = 'baseline' | 'preset' | 'user';

/**
 * 注入资金频率：
 * - none    无追加（纯初始资金推演）
 * - monthly 按月定时定投（setMonthlyDCA 依据日历月 + 交易日展开为具体日期）
 * - custom  用户手动逐笔追加（addCashInjection）
 */
export type InjectionType = 'none' | 'monthly' | 'custom';

/** 单笔现金注入事件（DCA 记账） */
export interface CashInjection {
  /** 入金生效日（YYYY-MM-DD，盘前结算，早于订单撮合） */
  date: string;
  /** 入金金额（元） */
  amount: number;
}

/** 预设策略标识（注册于 utils/strategyGenerators.ts） */
export type PresetStrategyId =
  | 'ma20-bounce'
  | 'pyramid'
  | 'grid'
  | 'stop-profit'
  | 'gap-fill'
  | 'max-opportunity'
  | 'hybrid-regime'
  /** 多因子智能推荐：因子提取 + 评分 + 动态资金分配（model-recommend） */
  | 'model-recommend'
  /** 纯被动定期定额定投：零择优基准线（不主动卖出，持有至评估日清算） */
  | 'pure-dca';

/**
 * 沙盘分支（一张表统一三种类型）。
 *
 * @description 基线（baseline）为真实历史流水派生的只读视图；预设（preset）
 *              由策略生成器确定性派生（订单不落库）；用户方案（user）订单
 *              全部落库可自由编辑。三者共用同一结构，仅落库约定不同（见 §2.3）。
 */
export interface SandboxBranch {
  id: string;
  /** 关联标的（含市场前缀，如 sh601318） */
  fullCode: string;
  stockName: string;
  branchType: SandboxBranchType;
  branchName: string;
  status: 'draft' | 'completed';

  // ---- 基线专属：关联的真实持仓（branchType === 'baseline'） ----
  /** 基线关联的持仓 id（Position.id），用于实时派生批次时间线 */
  baselinePositionId?: string;

  // ---- 资金 ----
  /** 历史资金占用峰值（全量批次口径，含做T调整），作为沙盘总预算硬上限 */
  peakCapitalLock: number;
  /** 模拟资金（默认=峰值，可调，UI 标注"模拟"） */
  simulatedCash: number;

  // ---- 增量现金注入（DCA：分批追加工资入金） ----
  /** 注入频率类型：none / monthly（日历月定投）/ custom（自定义逐笔） */
  injectionType?: InjectionType;
  /** 逐笔注入事件（已按日历月/自定义展开为具体交易日，盘前结算） */
  cashInjections?: CashInjection[];
  /** 累计投入本金 = 初始 simulatedCash + Σ cashInjections.amount（推演时重算） */
  totalInjectedCash?: number;

  // ---- 时效戳（策略过期的三大来源，全部可追溯） ----
  /** 生成/推演时最后一根 K 线日期（YYYY-MM-DD） */
  dataAsOfDate: string;
  /** 最后推演时间戳（epoch ms） */
  lastRunAt: number;
  /** 上次生成时资金 → ⚡ 检测 */
  generatedAtCash: number;
  /** 基线指纹（批次数量|末笔时间|当前股数）→ 🔄 检测 */
  lastBaselineSignature: string;

  // ---- 预设专属（branchType === 'preset'） ----
  /** 预设策略标识：见 PresetStrategyId */
  presetStrategyId?: PresetStrategyId;
  presetParams?: Record<string, number>;

  // ---- 用户方案专属（branchType === 'user'） ----
  /** 溯源：来自哪个预设 */
  parentPresetId?: string;
  /** 已"保存为我的策略"（解除关联） */
  decoupledFromPreset?: boolean;

  // ---- 抖动配置 ----
  /** 默认 0.25（基准波动率 × 系数 = 抖动范围） */
  jitterFactor: number;
  /** 默认 5（取目标日期前后各 N 根 K 线统计） */
  jitterWindowSize: number;

  /** 推演结果（SandboxResult 序列化） */
  resultJson?: string;
  createdAt: number;
  updatedAt: number;
  /** 软删除（与现有表约定一致） */
  isDeleted: 0 | 1;
}

/** 沙盘订单（仅 user 分支落库；preset 订单为派生数据） */
export interface SandboxOrder {
  id: string;
  branchId: string;
  /** 时间线序号 */
  seqIndex: number;
  action: 'buy' | 'sell';
  /** ISO 时间戳（可编辑） */
  timestamp: string;
  /** 期望价（抖动前） */
  price: number;
  /** 数量（股） */
  quantity: number;
  /** 规费（推演时计算） */
  fee?: number;
  /** 做T调整标注（倒T出借/归并） */
  kind?: 'borrow' | 'merge';
  /** 溯源做T轮次 */
  sourceRoundId?: string;
  note?: string;
  /** 来自基线（还原用） */
  isBaseline?: boolean;
}

/** K 线条目（日线，前复权） */
export interface KlineItem {
  /** YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 推演结果。
 *
 * @description 收益分三段呈现：已实现（realizedProfit）、浮动（unrealizedProfit，
 *              评估日按现价 Mark-to-Market）与累计总收益（finalProfit = 两者之和）。
 *              在 DCA 注入本金（totalInjectedCash）口径下，额外提供资金加权
 *              （capitalWeightedRote）与时间加权（timeWeightedRote）收益率，
 *              消除分批加仓对简单收益率的失真。
 */
export interface SandboxResult {
  /** 评估日 */
  asOfDate: string;
  /** 最终收益 = 已实现 + 未实现 */
  finalProfit: number;
  /** 已实现盈亏 */
  realizedProfit: number;
  /** 未实现盈亏（剩余持仓 ×（评估日收盘−均价）） */
  unrealizedProfit: number;
  /** 累计收益率 = finalProfit / simulatedCash */
  returnRate: number;

  // ---- 本次重构新增 ----
  /** 方案执行所需瞬时最大资金峰值（元）：任意时点资金占用的峰值，含 DCA 减负语义 */
  peakRequiredCash: number;
  /** 累计投入本金 = 初始模拟资金 + Σ现金注入 */
  totalInjectedCash: number;
  /** 基准本金收益率（%） = finalProfit / totalInjectedCash */
  principalReturnRate: number;
  /** 资金加权收益率（%） = finalProfit / 平均占用本金（按日平均现金+持仓成本） */
  capitalWeightedReturnRate: number;
  /** 时间加权收益率（%）：修正入金/出金后按日链式复合（几何 True，TWR） */
  timeWeightedReturnRate: number;

  /** 最大回撤（%） */
  maxDrawdown: number;
  /** 持仓波动率（日收益标准差） */
  volatility: number;
  /** 累计规费 */
  totalFees: number;
  /** 累计印花税 */
  totalStampTax: number;
  /** 交易笔数 */
  tradeCount: number;
  /** 资金占用周期 */
  capitalOccupationDays: number;
  /** 评估日剩余持股数 */
  finalPosition: number;
  /** 评估日剩余现金 */
  finalCash: number;
  buyAndHold: {
    finalProfit: number;
    returnRate: number;
    maxDrawdown: number;
  };
  /** 市值曲线快照 */
  snapshots: SandboxSnapshot[];
}

/** 时间线快照（每个操作节点 + 每根 K 线） */
export interface SandboxSnapshot {
  timestamp: string;
  /** 当前持股 */
  position: number;
  /** 当前持仓成本（移动加权） */
  cost: number;
  /** 当日收盘价 */
  marketPrice: number;
  /** 剩余现金 */
  cash: number;
  /** 总资产 = cash + position × marketPrice */
  totalAsset: number;
  /** 浮动盈亏 */
  unrealizedPnL: number;
  /** 相对峰值回撤（%） */
  drawdown: number;
}

/** 四维对比指标（对比表一行） */
export interface ComparisonRow {
  /** 指标名 */
  metric: string;
  /** 指标键 */
  key: string;
  /** branchId → 值 */
  values: Record<string, number>;
  /** 该维度最优方案 */
  bestBranchId: string | null;
  /** 最优方向 */
  direction: 'higher' | 'lower';
}