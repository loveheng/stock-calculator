import Dexie, { type Table } from 'dexie';

export interface StockEntity {
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

export interface PositionEntity {
  id: string;
  fullCode: string;
  currentCost: number;
  currentAmount: number;
  isClosed: boolean;
  createdAt: number;
  closedAt?: number;
  totalInvested: number;
  realizedPnL: number;
}

export interface PositionBatchEntity {
  id: string;
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

export interface TRoundEntity {
  id: string;
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

export interface TTransactionEntity {
  id: string;
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
}

export interface CashFlowEntity {
  id: string;
  type: 'deposit' | 'withdraw' | 'dividend' | 'interest';
  fullCode?: string;
  amount: number;
  note?: string;
  timestamp: number;
}

export interface TradeNoteEntity {
  id: string;
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
    this.version(1).stores({
      stocks: 'fullCode, code, stockName, pinYin, marketType, securityType',
      positions: 'id, fullCode, isClosed, createdAt',
      positionBatches: 'id, positionId, type, timestamp',
      tRounds: 'id, positionId, fullCode, mode, status, openedAt, closedAt',
      tTransactions: 'id, roundId, timestamp',
      accountCash: 'id',
      cashFlows: 'id, type, timestamp, fullCode',
      tradeNotes: 'id, roundId, positionId, timestamp',
      feeConfigs: 'id',
    });
  }
}

export const db = new TradingLedgerDB();
