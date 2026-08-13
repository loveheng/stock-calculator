import { describe, it, expect } from 'vitest';
import { processStockStream, StockStreamRecord } from '../utils/tStreamEngine';

function makeRecord(p: Partial<StockStreamRecord> & { id: string }): StockStreamRecord {
  return {
    id: p.id,
    fullCode: '600000',
    stockName: '浦发银行',
    direction: 'buy',
    price: 0,
    amount: 0,
    fee: 0,
    timestamp: '2026-08-13T00:00:00.000Z',
    ...p,
  } as StockStreamRecord;
}

const FEE_CONFIG = { commissionRate: 0.00025, minCommission: 0.5, stampTaxRate: 0.0005, transferFeeRate: 0.00001 };

describe('tmp visual verification', () => {
  it('prints repro entries', () => {
    const result = processStockStream(
      [
        makeRecord({ id: 'b1', direction: 'buy', price: 16.0, amount: 200, fee: 0.83, timestamp: '2026-08-13T01:00:00.000Z' }),
        makeRecord({ id: 's1', direction: 'sell', price: 17.0, amount: 100, fee: 1.37, timestamp: '2026-08-13T02:00:00.000Z' }),
        makeRecord({ id: 'b2', direction: 'buy', price: 16.0, amount: 100, fee: 0.52, timestamp: '2026-08-13T03:00:00.000Z' }),
      ],
      FEE_CONFIG as never,
      24.11,
    );
    for (const e of result.entries) {
      console.log(`[${e.id}] ${e.direction} ${e.amount}股 @${e.price} fee=${e.fee} → 撮合 ${e.matchedAmount} 股 收益 ${e.realizedProfit >= 0 ? '+' : ''}${e.realizedProfit.toFixed(2)} remaining=${e.remaining}`);
    }
    console.log(`realizedFee=${result.realizedFee} transferProfit=${result.transferProfit} netPendingAmount=${result.netPendingAmount} sellCostTotal=${result.sellCostTotal} status=${result.status}`);
    expect(true).toBe(true);
  });
});
