/**
 * @file schema.ts
 * @description 定义 TradingLedgerDB_v3 的全部 IndexedDB 实体类型（Entity）与 Dexie 数据库表结构，是整个应用数据持久化的类型基石。
 * @layer DAO
 * @storage_impact 声明 stocks / positions / positionBatches / tRounds / tTransactions / accountCash / cashFlows / tradeNotes / feeConfigs 共 9 张表的实体结构，并导出 Dexie 实例 db。
 * @author 开发团队
 */

import Dexie, { type Table } from 'dexie';

/**
 * 所有持久化实体的公共基础字段。
 *
 * @description 提供全局统一的主键与审计时间戳；`isDeleted` 采用软删除标记（0=正常，1=已删除），物理删除前均以此字段过滤。
 */
export interface BaseEntity {
  /** 全局唯一主键，字符串 UUID */
  id: string;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 最近更新时间戳（毫秒），写入/更新记录时必须同步维护 */
  updatedAt: number;
  /** 软删除标记：0 = 正常，1 = 已软删除。查询时应过滤 `(isDeleted ?? 0) === 0` */
  isDeleted?: number; // 0 = normal, 1 = soft-deleted
}

/** 股票基础信息实体（stocks 表）。`fullCode` 为唯一业务主键，关联持仓与做T记录。 */
export interface StockEntity extends BaseEntity {
  /** 完整证券代码（含市场前缀），如 sh601318 / sz000001 */
  fullCode: string;
  /** 纯数字证券代码 */
  code: string;
  /** 股票名称 */
  stockName: string;
  /** 拼音缩写，用于快速搜索 */
  pinYin: string;
  /** 市场类型，如 SH / SZ */
  marketType: string;
  /** 证券类型 */
  securityType: string;
  /** 行情快照 ID */
  quoteId?: string;
  /** 简称 */
  shortName?: string;
  /** 统一代码 */
  unifiedCode?: string;
}

/** 持仓实体（positions 表）。记录某一股票的底仓成本、数量与平仓状态。 */
export interface PositionEntity extends BaseEntity {
  /** 关联股票完整代码 */
  fullCode: string;
  /** 当前加权成本（元） */
  currentCost: number;
  /** 当前持有数量（股） */
  currentAmount: number;
  /** 是否已平仓 */
  isClosed: boolean;
  /** 平仓时间戳（毫秒），未平仓时缺省 */
  closedAt?: number;
  /** 累计投入金额（元） */
  totalInvested: number;
  /** 已实现盈亏（元） */
  realizedPnL: number;
}

/** 持仓批次实体（positionBatches 表）。记录每次开仓/加仓/减仓操作对成本与数量的影响。 */
export interface PositionBatchEntity extends BaseEntity {
  /** 所属持仓的主键 id */
  positionId: string;
  /** 批次类型：开仓 / 加仓 / 减仓 */
  type: 'open' | 'add' | 'reduce';
  /** 成交单价（元） */
  price: number;
  /** 成交数量（股） */
  amount: number;
  /** 该笔交易手续费（元） */
  fee: number;
  /** 本次操作后的加权成本（元） */
  costAfter: number;
  /** 本次操作后的持仓数量（股） */
  amountAfter: number;
  /** 成交时间戳（毫秒） */
  timestamp: number;
  /** 备注 */
  note?: string;
}

/** 做T轮次实体（tRounds 表）。一个 Round 代表一次完整/进行中的做T项目，采用绝对现金流法核算净收益。 */
export interface TRoundEntity extends BaseEntity {
  /** 关联持仓 id（可选，做T可与底仓解耦） */
  positionId?: string;
  /** 股票完整代码 */
  fullCode: string;
  /** 做T方向：long=正T（先买后卖），short=倒T（先卖后买） */
  mode: 'long' | 'short';
  /** 轮次状态：OPENED=进行中，COMPLETED=已结清归档 */
  status: 'OPENED' | 'COMPLETED';
  /** 该股票的第几轮做T（从 1 递增） */
  roundNo: number;
  /** 结算方式：clear=清仓式结清，partial=部分/划转底仓 */
  settleType: 'clear' | 'partial';
  /** 本轮净收益（元） */
  netProfit: number;
  /** 本轮累计手续费（元） */
  totalFees: number;
  /** 开启时间戳（毫秒） */
  openedAt: number;
  /** 关闭时间戳（毫秒），未结清时缺省 */
  closedAt?: number;
  /** 股票名称快照 */
  stockName?: string;
  /** 累计买入金额（元） */
  buyAmount?: number;
  /** 累计卖出金额（元） */
  sellAmount?: number;
  /** 划转底仓数量（股，仅划转结算时存在） */
  transferAmount?: number;
  /** 加权平均价（元） */
  avgPrice?: number;
  /** 成交笔数 */
  tradeCount?: number;
  /** 持股天数 */
  holdingDays?: number;
  /** 是否盈利 */
  win?: boolean;
  /** 最近一次活动时间戳（毫秒） */
  lastUpdated?: number;
}

/** 做T成交流水实体（tTransactions 表）。记录 Round 内每笔买卖及撮合对冲结果。 */
export interface TTransactionEntity extends BaseEntity {
  /** 所属做T轮次 id */
  roundId: string;
  /** 成交方向：买入 / 卖出（划转在写入时统一转为 buy） */
  direction: 'buy' | 'sell';
  /** 成交单价（元） */
  price: number;
  /** 成交数量（股） */
  amount: number;
  /** 手续费（元） */
  fee: number;
  /** 被撮合对冲的数量（股） */
  matchedAmount: number;
  /** 本笔已实现盈亏（元，卖出方向才产生） */
  realizedProfit: number;
  /** 成交时间戳（毫秒） */
  timestamp: number;
  /** 备注 */
  note?: string;
}

/** 现金账户实体（accountCash 表）。单行记录（id 固定为 1）。 */
export interface AccountCashEntity {
  /** 主键，固定为 1（单例） */
  id: number;
  /** 可用现金（元） */
  availableCash: number;
  /** 冻结现金（元） */
  frozenCash: number;
  /** 累计入金总额（元） */
  totalDeposit: number;
  /** 最后更新时间戳（毫秒） */
  lastUpdated: number;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
  /** 软删除标记 */
  isDeleted?: number;
}

/** 现金流水实体（cashFlows 表）。记录入金/出金/分红/利息等资金变动。 */
export interface CashFlowEntity extends BaseEntity {
  /** 流水类型：入金 / 出金 / 分红 / 利息 */
  type: 'deposit' | 'withdraw' | 'dividend' | 'interest';
  /** 关联股票完整代码（分红时填写） */
  fullCode?: string;
  /** 金额（元，出金为负） */
  amount: number;
  /** 备注 */
  note?: string;
  /** 发生时间戳（毫秒） */
  timestamp: number;
}

/** 交易笔记实体（tradeNotes 表）。用于记录做T/持仓的复盘心得。 */
export interface TradeNoteEntity extends BaseEntity {
  /** 关联做T轮次 id（可选） */
  roundId?: string;
  /** 关联持仓 id（可选） */
  positionId?: string;
  /** 逗号分隔的标签 */
  tags: string;
  /** 交易原因 */
  reason: string;
  /** 复盘总结 */
  review: string;
  /** 评分（如 1-5） */
  rating: number;
  /** 笔记时间戳（毫秒） */
  timestamp: number;
}

/** 费率配置实体（feeConfigs 表）。单行记录（id 固定为 1）。 */
export interface FeeConfigEntity {
  /** 主键，固定为 1（单例） */
  id: number;
  /** 佣金费率（如 0.00025） */
  commissionRate: number;
  /** 最低佣金（元，如 0.5） */
  minCommission: number;
  /** 是否免五（免最低 5 元佣金限制） */
  isFreeFive: boolean;
  /** 过户费率 */
  transferRate: number;
  /** 印花税率（卖出收取） */
  stampRate: number;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
  /** 软删除标记 */
  isDeleted?: number;
}

/**
 * 交易账本 IndexedDB 数据库（Dexie 封装，库名 TradingLedgerDB_v3）。
 *
 * @description 集中管理全部 9 张规范化表，并声明各表的索引字段以支持高效查询。
 * @note 索引字符串格式为 Dexie schema：主键在前（`++` 自增 / 普通字段），逗号分隔的字段均会被建立索引。
 */
export class TradingLedgerDB extends Dexie {
  /** 股票基础信息表 */
  stocks!: Table<StockEntity, string>;
  /** 持仓表 */
  positions!: Table<PositionEntity, string>;
  /** 持仓批次明细表 */
  positionBatches!: Table<PositionBatchEntity, string>;
  /** 做T轮次表 */
  tRounds!: Table<TRoundEntity, string>;
  /** 做T成交流水表 */
  tTransactions!: Table<TTransactionEntity, string>;
  /** 现金账户表（单行） */
  accountCash!: Table<AccountCashEntity, number>;
  /** 现金流水表 */
  cashFlows!: Table<CashFlowEntity, string>;
  /** 交易笔记表 */
  tradeNotes!: Table<TradeNoteEntity, string>;
  /** 费率配置表（单行） */
  feeConfigs!: Table<FeeConfigEntity, number>;

  /**
   * 初始化数据库结构（版本 2 的 stores 定义）。
   *
   * @description 声明各表的主键与索引；后续结构变更须升级 version 并添加 stores/upgrade 迁移逻辑。
   */
  constructor() {
    super('TradingLedgerDB_v3');
    this.version(2).stores({
      stocks: 'fullCode, code, stockName, pinYin, marketType, securityType, updatedAt, isDeleted',
      positions: 'id, fullCode, isClosed, createdAt, updatedAt, isDeleted',
      positionBatches: 'id, positionId, type, timestamp, updatedAt, isDeleted',
      tRounds: 'id, positionId, fullCode, mode, status, openedAt, closedAt, updatedAt, isDeleted',
      tTransactions: 'id, roundId, timestamp, updatedAt, isDeleted',
      accountCash: 'id, updatedAt',
      cashFlows: 'id, type, timestamp, fullCode, updatedAt, isDeleted',
      tradeNotes: 'id, roundId, positionId, timestamp, updatedAt, isDeleted',
      feeConfigs: 'id, updatedAt',
    });
  }
}

/** 全局唯一的数据库实例，供 Service 与 Store 层读写使用 */
export const db = new TradingLedgerDB();
