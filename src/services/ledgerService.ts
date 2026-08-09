import { db } from '../db/index';
import type {
  AccountCashEntity,
  PositionBatchEntity,
  PositionEntity,
  StockEntity,
  TTransactionEntity,
  TRoundEntity,
} from '../db/schema';
import type { Position, PositionBatch } from '../store';

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
  const [positions, batches, stocks] = await Promise.all([
    db.positions.toArray(),
    db.positionBatches.toArray(),
    db.stocks.toArray(),
  ]);

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

export async function addPositionTransaction(
  data: AddPositionTransactionData,
): Promise<PositionEntity> {
  return db.transaction(
    'rw',
    [db.positions, db.positionBatches, db.stocks],
    async () => {
      const { stock, position, batch } = data;
      const normalizedBatch = normalizeBatch(batch);

      const existingStock = await db.stocks.get(stock.fullCode);
      if (!existingStock) {
        await db.stocks.put(stock);
      }

      const existingPosition = await db.positions.get(position.id);
      if (existingPosition) {
        await db.positions.put(position);
      } else {
        await db.positions.add(position);
      }

      await db.positionBatches.add({ ...normalizedBatch, positionId: position.id });
      return position;
    },
  );
}

export async function closePosition(positionId: string): Promise<void> {
  await db.positions.update(positionId, {
    isClosed: true,
    closedAt: Date.now(),
  });
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
    await db.positionBatches.delete(batchId);

    const remainingBatches = await db.positionBatches
      .where('positionId')
      .equals(positionId)
      .toArray();

    if (remainingBatches.length === 0) {
      await db.positions.delete(positionId);
      return;
    }

    const metrics = calcPositionMetrics(remainingBatches);
    await db.positions.update(positionId, {
      currentAmount: metrics.currentAmount,
      currentCost: metrics.currentCost,
      totalInvested: metrics.totalInvested,
      realizedPnL: metrics.realizedPnL,
      isClosed: metrics.currentAmount === 0,
      closedAt: metrics.currentAmount === 0 ? Date.now() : undefined,
    });
  });
}

export async function removePosition(positionId: string): Promise<void> {
  await db.transaction('rw', [db.positions, db.positionBatches], async () => {
    await db.positionBatches.where('positionId').equals(positionId).delete();
    await db.positions.delete(positionId);
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

      const transaction: TTransactionEntity = {
        id: generateId(),
        roundId,
        direction: 'sell',
        price: closePrice,
        amount: closeShares,
        fee,
        matchedAmount: closeShares,
        realizedProfit,
        timestamp: Date.now(),
      };

      await db.tTransactions.add(transaction);

      const nextRemaining = remainingShares - closeShares;
      const updatedRound: Partial<TRoundEntity> = {
        netProfit: (round.netProfit ?? 0) + realizedProfit,
        totalFees: (round.totalFees ?? 0) + fee,
        status: nextRemaining === 0 ? 'COMPLETED' : 'OPENED',
        sellAmount: (round.sellAmount ?? 0) + closeShares,
      };

      await db.tRounds.update(roundId, updatedRound);

      const accountCash = await db.accountCash.get(1);
      if (!accountCash) {
        throw new Error('Account cash row missing');
      }

      const updateCash: AccountCashEntity = {
        ...accountCash,
        availableCash: accountCash.availableCash + closePrice * closeShares - fee,
        frozenCash: Math.max(0, accountCash.frozenCash - closePrice * closeShares),
        lastUpdated: Date.now(),
      };
      await db.accountCash.put(updateCash);

      return transaction;
    },
  );
}
