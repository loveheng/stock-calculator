import Dexie, { type Table } from 'dexie';

export interface BaseEntity {
  id: string;
  createdAt: number;
  updatedAt: number;
  isDeleted?: number; // 0 = normal, 1 = soft-deleted
}

export interface StockEntity extends BaseEntity {
  fullCode: string;
  code: string;
  stockName: string;
  pinYin: string;
  marketType: string;
  securityType: string;
  quoteId?: string;
  shortName?: string;
  unifiedCode?: string;
}

export interface PositionEntity extends BaseEntity {
  fullCode: string;
  currentCost: number;
  currentAmount: number;
  isClosed: boolean;
  closedAt?: number;
  totalInvested: number;
  realizedPnL: number;
}

export interface PositionBatchEntity extends BaseEntity {
  positionId: string;
  type: 'open' | 'add' | 'reduce';
  price: number;
  amount: number;
  fee: number;
  costAfter: number;
  amountAfter: number;
  timestamp: number;
  note?: string;
}

export interface TRoundEntity extends BaseEntity {
  positionId?: string;
  fullCode: string;
  mode: 'long' | 'short';
  status: 'OPENED' | 'COMPLETED';
  roundNo: number;
  settleType: 'clear' | 'partial';
  netProfit: number;
  totalFees: number;
  openedAt: number;
  closedAt?: number;
  stockName?: string;
  buyAmount?: number;
  sellAmount?: number;
  transferAmount?: number;
  avgPrice?: number;
  tradeCount?: number;
  holdingDays?: number;
  win?: boolean;
  lastUpdated?: number;
}

export interface TTransactionEntity extends BaseEntity {
  roundId: string;
  direction: 'buy' | 'sell';
  price: number;
  amount: number;
  fee: number;
  matchedAmount: number;
  realizedProfit: number;
  timestamp: number;
  note?: string;
}

export interface AccountCashEntity {
  id: number;
  availableCash: number;
  frozenCash: number;
  totalDeposit: number;
  lastUpdated: number;
  createdAt: number;
  updatedAt: number;
  isDeleted?: number;
}

export interface CashFlowEntity extends BaseEntity {
  type: 'deposit' | 'withdraw' | 'dividend' | 'interest';
  fullCode?: string;
  amount: number;
  note?: string;
  timestamp: number;
}

export interface TradeNoteEntity extends BaseEntity {
  roundId?: string;
  positionId?: string;
  tags: string;
  reason: string;
  review: string;
  rating: number;
  timestamp: number;
}

export interface FeeConfigEntity {
  id: number;
  commissionRate: number;
  minCommission: number;
  isFreeFive: boolean;
  transferRate: number;
  stampRate: number;
  createdAt: number;
  updatedAt: number;
  isDeleted?: number;
}

export class TradingLedgerDB extends Dexie {
  stocks!: Table<StockEntity, string>;
  positions!: Table<PositionEntity, string>;
  positionBatches!: Table<PositionBatchEntity, string>;
  tRounds!: Table<TRoundEntity, string>;
  tTransactions!: Table<TTransactionEntity, string>;
  accountCash!: Table<AccountCashEntity, number>;
  cashFlows!: Table<CashFlowEntity, string>;
  tradeNotes!: Table<TradeNoteEntity, string>;
  feeConfigs!: Table<FeeConfigEntity, number>;

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

export const db = new TradingLedgerDB();
