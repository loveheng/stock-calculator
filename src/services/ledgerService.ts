import { db, type StockRow } from '../db/index';
import type {
  AccountCashEntity,
  PositionBatchEntity,
  PositionEntity,
  StockEntity,
  TTransactionEntity,
  TRoundEntity,
} from '../db/schema';
import type { Position, PositionBatch } from '../store';
import type { TRoundArchive, RoundTxn } from '../store';
import type { FeeConfig } from '../utils/mathUtils';

export async function getFeeConfig(): Promise<FeeConfig | null> {
  const row = await db.feeConfigs.get(1 as any);
  if (!row || (row.isDeleted ?? 0) === 1) return null;
  const cfg: FeeConfig = {
    commissionRate: row.commissionRate,
    isFreeFive: row.isFreeFive,
    minCommission: row.minCommission,
    transferRate: row.transferRate,
    stampRate: row.stampRate,
  };
  return cfg;
}

// ---------- Mutation API wrapping store behaviors ----------
import { useAppStore } from '../store';
import type { TStreamRecord } from '../utils/tStreamEngine';

export async function createPosition(pos: any): Promise<void> {
  // keep existing store behavior for complex side-effects
  const addPosition = useAppStore.getState().addPosition;
  addPosition(pos);
}

export async function addBatchToPosition(positionId: string, batch: any): Promise<void> {
  const addBatch = useAppStore.getState().addBatch;
  addBatch(positionId, batch);
}

export async function updatePositionById(positionId: string, updates: Partial<any>): Promise<void> {
  const updatePosition = useAppStore.getState().updatePosition;
  updatePosition(positionId, updates);
}

export async function deleteBatchForPosition(positionId: string, batchId: string): Promise<void> {
  const deletePositionBatch = useAppStore.getState().deletePositionBatch;
  deletePositionBatch(positionId, batchId);
}

export async function removePositionById(positionId: string): Promise<void> {
  const removePosition = useAppStore.getState().removePosition;
  removePosition(positionId);
}

export async function applyStreamRecord(rec: TStreamRecord) {
  const addStreamRecord = useAppStore.getState().addStreamRecord;
  return addStreamRecord(rec);
}

export async function transferToPositionService(fullCode: string, transferAmount?: number, transferPrice?: number) {
  const transferToPosition = useAppStore.getState().transferToPosition;
  return transferToPosition(fullCode, transferAmount, transferPrice);
}

export async function settleShortRoundService(fullCode: string) {
  const settleShortRound = useAppStore.getState().settleShortRound;
  return settleShortRound(fullCode);
}

export interface PositionWithStockInfo extends Position {
  stock?: StockEntity;
  stockNameDisplay: string;
}

export interface AddPositionTransactionData {
  stock: StockEntity;
  position: PositionEntity;
  batch: Omit<PositionBatchEntity, 'positionId'>;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function makeId(): string {
  try {
    // prefer standard UUID when available
    // @ts-ignore
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (e) {
    // ignore
  }
  return generateId();
}

function ensureTimestamps<T extends { id?: string; createdAt?: number; updatedAt?: number; isDeleted?: number }>(obj: T, isNew = false): T {
  const now = Date.now();
  if (!obj.id) obj.id = makeId();
  if (isNew) {
    obj.createdAt = obj.createdAt ?? now;
  }
  obj.updatedAt = now;
  obj.isDeleted = obj.isDeleted ?? 0;
  return obj;
}

/** Strip undefined values from an object to prevent IndexedDB serialization errors */
function cleanUndefined<T extends Record<string, any>>(obj: T): T {
  const result: any = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

function normalizeBatch(batch: Omit<PositionBatchEntity, 'positionId'>): Omit<PositionBatchEntity, 'positionId'> {
  return {
    ...batch,
    amount: batch.type === 'reduce' ? -Math.abs(batch.amount) : batch.amount,
  };
}

function mapPositionBatchEntityToStore(batch: PositionBatchEntity): PositionBatch {
  return {
    ...batch,
    timestamp: new Date(batch.timestamp).toISOString(),
  };
}

function mapPositionEntityToStore(
  position: PositionEntity,
  stockName: string,
): Omit<Position, 'batches'> {
  return {
    ...position,
    stockName,
    createdAt: new Date(position.createdAt).toISOString(),
    closedAt: position.closedAt ? new Date(position.closedAt).toISOString() : undefined,
  };
}

function calcPositionMetrics(batches: PositionBatchEntity[]) {
  const sorted = [...batches].sort((a, b) => a.timestamp - b.timestamp);
  let remainingAmount = 0;
  let invested = 0;
  let realizedPnL = 0;

  for (const batch of sorted) {
    const qty = Math.abs(batch.amount);
    const fee = batch.fee ?? 0;
    if (batch.type === 'open' || batch.type === 'add') {
      const cost = batch.price * qty + fee;
      invested += cost;
      remainingAmount += qty;
    } else {
      if (remainingAmount > 0) {
        const costBasisPerShare = invested / remainingAmount;
        const costBasis = costBasisPerShare * qty;
        const proceeds = batch.price * qty - fee;
        realizedPnL += proceeds - costBasis;
        invested -= costBasis;
      }
      remainingAmount = Math.max(0, remainingAmount - qty);
      if (remainingAmount === 0) {
        invested = 0;
      }
    }
  }

  return {
    currentAmount: remainingAmount,
    currentCost: remainingAmount > 0 ? invested / remainingAmount : 0,
    totalInvested: invested,
    realizedPnL,
  };
}

export async function getPositionsWithStockInfo(): Promise<PositionWithStockInfo[]> {
  const [positionsRaw, batchesRaw, stocksRaw] = await Promise.all([
    db.positions.toArray(),
    db.positionBatches.toArray(),
    db.stocks.toArray(),
  ]);

  const positions = positionsRaw.filter((p) => (p.isDeleted ?? 0) === 0);
  const batches = batchesRaw.filter((b) => (b.isDeleted ?? 0) === 0);
  const stocks = stocksRaw.filter((s) => (s.isDeleted ?? 0) === 0);

  return positions.map((position) => {
    const stock = stocks.find((item) => item.fullCode === position.fullCode);
    const positionBatches = batches
      .filter((batch) => batch.positionId === position.id)
      .sort((a, b) => a.timestamp - b.timestamp);

    return {
      ...mapPositionEntityToStore(position, stock?.stockName ?? position.fullCode),
      stockName: stock?.stockName ?? position.fullCode,
      stock,
      stockNameDisplay: stock?.stockName ?? position.fullCode,
      batches: positionBatches.map(mapPositionBatchEntityToStore),
    };
  });
}

export async function getTRoundsWithTransactions(): Promise<TRoundArchive[]> {
  const [roundsRaw, txnsRaw, stocksRaw] = await Promise.all([
    db.tRounds.toArray(),
    db.tTransactions.toArray(),
    db.stocks.toArray(),
  ]);

  const rounds = roundsRaw.filter((r) => (r.isDeleted ?? 0) === 0);
  const txns = txnsRaw.filter((t) => (t.isDeleted ?? 0) === 0);
  const stocks = stocksRaw.filter((s) => (s.isDeleted ?? 0) === 0);

  const stockMap = new Map(stocks.map((s) => [s.fullCode, s]));

  return rounds.map((r) => {
    const related = txns.filter((t) => t.roundId === r.id).sort((a, b) => a.timestamp - b.timestamp);
    const transactions: RoundTxn[] = related.map((t) => ({
      id: t.id,
      timestamp: new Date(t.timestamp).toISOString(),
      direction: t.direction,
      price: t.price,
      amount: t.amount,
      fee: t.fee,
      matchedAmount: t.matchedAmount,
      realizedProfit: t.realizedProfit,
      note: t.note,
    }));

    const archive: TRoundArchive = {
      id: r.id,
      fullCode: r.fullCode,
      stockName: stockMap.get(r.fullCode)?.stockName ?? r.fullCode,
      roundNo: r.roundNo,
      mode: r.mode,
      settleType: r.settleType === 'partial' ? 'transfer' : 'clear',
      transactions,
      netProfit: r.netProfit,
      fees: r.totalFees,
      sellAmount: r.sellAmount ?? 0,
      transferAmount: r.transferAmount,
      avgPrice: r.avgPrice ?? 0,
      buyAmount: r.buyAmount ?? 0,
      tradeCount: r.tradeCount ?? 0,
      holdingDays: r.holdingDays ?? 0,
      win: !!r.win,
      openedAt: new Date(r.openedAt).toISOString(),
      closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : '',
    };

    return archive;
  });
}

export async function addPositionTransaction(
  data: AddPositionTransactionData,
): Promise<PositionEntity> {
  return db.transaction(
    'rw',
    [db.positions, db.positionBatches, db.stocks],
    async () => {
      const { stock, position, batch } = data;
      const normalizedBatch = normalizeBatch(batch);

      // prepare stock
      const existingStock = await db.stocks.get(stock.fullCode as any);
      if (!existingStock) {
        const toPut = ensureTimestamps({ ...stock } as any, true);
        await db.stocks.put(toPut as any);
      } else {
        await db.stocks.put(ensureTimestamps({ ...existingStock } as any, false) as any);
      }

      // prepare position
      const existingPosition = await db.positions.get(position.id);
      if (existingPosition) {
        await db.positions.put(ensureTimestamps({ ...existingPosition } as any, false) as any);
      } else {
        const posToAdd = ensureTimestamps({ ...position } as any, true);
        await db.positions.add(posToAdd as any);
      }

      // add batch
      const batchToAdd = ensureTimestamps({ ...normalizedBatch, positionId: position.id } as any, true) as PositionBatchEntity;
      if (!batchToAdd.id) batchToAdd.id = makeId();
      await db.positionBatches.add(batchToAdd);
      return await db.positions.get(position.id) as PositionEntity;
    },
  );
}

export async function closePosition(positionId: string): Promise<void> {
  await db.positions.update(positionId, cleanUndefined({
    isClosed: true,
    closedAt: Date.now(),
    updatedAt: Date.now(),
  } as any));
}

export async function deletePositionBatch(
  positionId: string,
  batchId: string,
): Promise<void> {
  await db.transaction('rw', [db.positions, db.positionBatches], async () => {
    const existingBatch = await db.positionBatches.get(batchId);
    if (!existingBatch || existingBatch.positionId !== positionId) {
      throw new Error('Position batch not found');
    }
    // soft delete the batch
    await db.positionBatches.update(batchId, cleanUndefined({ isDeleted: 1, updatedAt: Date.now() } as any));

    const remainingBatches = await db.positionBatches
      .where('positionId')
      .equals(positionId)
      .toArray();

    if (remainingBatches.length === 0) {
      // soft delete position as well
      await db.positions.update(positionId, cleanUndefined({ isDeleted: 1, updatedAt: Date.now() } as any));
      return;
    }

    const metrics = calcPositionMetrics(remainingBatches);
    await db.positions.update(positionId, cleanUndefined({
      currentAmount: metrics.currentAmount,
      currentCost: metrics.currentCost,
      totalInvested: metrics.totalInvested,
      realizedPnL: metrics.realizedPnL,
      isClosed: metrics.currentAmount === 0,
      closedAt: metrics.currentAmount === 0 ? Date.now() : undefined,
      updatedAt: Date.now(),
    } as any));
  });
}

export async function removePosition(positionId: string): Promise<void> {
  await db.transaction('rw', [db.positions, db.positionBatches], async () => {
    // soft-delete all batches and the position
    const now = Date.now();
    const batches = await db.positionBatches.where('positionId').equals(positionId).toArray();
    for (const b of batches) {
      await db.positionBatches.update(b.id, cleanUndefined({ isDeleted: 1, updatedAt: now } as any));
    }
    await db.positions.update(positionId, cleanUndefined({ isDeleted: 1, updatedAt: now } as any));
  });
}

export async function appendTSlice(
  roundId: string,
  closePrice: number,
  closeShares: number,
  fee: number,
): Promise<TTransactionEntity> {
  return db.transaction(
    'rw',
    [db.tRounds, db.tTransactions, db.accountCash],
    async () => {
      const round = await db.tRounds.get(roundId);
      if (!round) {
        throw new Error(`Round not found: ${roundId}`);
      }

      const buyAmount = round.buyAmount ?? 0;
      const sellAmount = round.sellAmount ?? 0;
      const remainingShares = Math.max(0, buyAmount - sellAmount);
      if (closeShares <= 0) {
        throw new Error('closeShares must be greater than 0');
      }
      if (closeShares > remainingShares) {
        throw new Error('closeShares cannot exceed remaining shares');
      }

      const profitPerShare = round.mode === 'short'
        ? (round.avgPrice ?? 0) - closePrice
        : closePrice - (round.avgPrice ?? 0);
      const realizedProfit = profitPerShare * closeShares - fee;

      const transaction: any = {
        id: makeId(),
        roundId,
        direction: 'sell',
        price: closePrice,
        amount: closeShares,
        fee,
        matchedAmount: closeShares,
        realizedProfit,
        timestamp: Date.now(),
      };

      ensureTimestamps(transaction, true);
      await db.tTransactions.add(cleanUndefined(transaction) as TTransactionEntity);

      const nextRemaining = remainingShares - closeShares;
      await db.tRounds.update(roundId, cleanUndefined({
        netProfit: (round.netProfit ?? 0) + realizedProfit,
        totalFees: (round.totalFees ?? 0) + fee,
        status: nextRemaining === 0 ? 'COMPLETED' : 'OPENED',
        sellAmount: (round.sellAmount ?? 0) + closeShares,
        updatedAt: Date.now(),
      } as any));

      const accountCash = await db.accountCash.get(1);
      if (!accountCash) {
        throw new Error('Account cash row missing');
      }

      const updateCash = cleanUndefined({
        ...accountCash,
        availableCash: accountCash.availableCash + closePrice * closeShares - fee,
        frozenCash: Math.max(0, accountCash.frozenCash - closePrice * closeShares),
        lastUpdated: Date.now(),
        updatedAt: Date.now(),
      } as any);
      await db.accountCash.put(updateCash as any);

      return transaction;
    },
  );
}

// ============================================================
// Unified LedgerService facade
// All DB access is concentrated here; UI components must route
// every read/write through this object instead of importing `db`.
// ============================================================
export const ledgerService = {
  getFeeConfig,
  getPositionsWithStockInfo,
  getTRoundsWithTransactions,
  createPosition,
  addBatchToPosition,
  updatePositionById,
  deleteBatchForPosition,
  removePositionById,
  applyStreamRecord,
  transferToPositionService,
  settleShortRoundService,
  addPositionTransaction,
  closePosition,
  deletePositionBatch,
  removePosition,
  appendTSlice,
};
