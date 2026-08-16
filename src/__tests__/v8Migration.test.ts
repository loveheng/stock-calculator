/**
 * @file v8Migration.test.ts
 * @description v8 数据模型持久化回归测试：
 *              1) v8 库结构：tTransactions 取代 tStreams（真实数据层无 tStreams 表，历史数据不保留）；
 *              2) loadTRoundsFromDB 为 OPENED Round 附带 transactions（流水池恢复源）；
 *              3) putTransaction / putRoundWithTransactions / deleteTransaction 增量写路径。
 * @layer Test
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  db,
  loadTRoundsFromDB,
  putTransaction,
  putRoundWithTransactions,
  deleteTransaction,
  fetchTransactionsByRoundId,
} from '../db';
import type { TRoundArchive, RoundTxn } from '../store';

describe('v8 数据模型持久化（tRounds + tTransactions）', () => {
  it('v8 库结构：tTransactions 存在且 tStreams 已被删除', async () => {
    await db.delete();
    await db.open();

    // tStreams 不在 v8 schema 中；Dexie db.tables 会残留历史版本注册的表，
    // 因此用原生 objectStoreNames 断言真实数据层
    const storeNames = Array.from(db.backendDB().objectStoreNames) as string[];
    expect(storeNames).toContain('tTransactions');
    expect(storeNames).not.toContain('tStreams');

    await db.close();
    await db.delete();
  });

  it('增量写路径：putTransaction / putRoundWithTransactions / deleteTransaction / loadTRoundsFromDB', async () => {
    await db.delete();
    await db.open();

    const roundId = 'r-test';
    const round: TRoundArchive = {
      id: roundId,
      fullCode: 'sh600000',
      stockName: '浦发银行',
      mode: 'long',
      status: 'OPENED',
      roundCode: '#20260813-1000',
      settleType: 'clear',
      netProfit: 0,
      openedAt: '2026-08-13T02:00:00.000Z',
      transactions: [],
    };
    await putRoundWithTransactions(round);

    // 逐笔增量写入流水
    const t1: RoundTxn = { id: 'tx1', timestamp: '2026-08-13T02:00:00.000Z', fullCode: 'sh600000', stockName: '浦发银行', direction: 'buy', price: 16, amount: 100, fee: 0.5 };
    const t2: RoundTxn = { id: 'tx2', timestamp: '2026-08-13T03:00:00.000Z', fullCode: 'sh600000', stockName: '浦发银行', direction: 'sell', price: 17, amount: 100, fee: 0.5 };
    await putTransaction(roundId, t1);
    await putTransaction(roundId, t2);

    const fetched = await fetchTransactionsByRoundId(roundId);
    expect(fetched.map((t) => t.id).sort()).toEqual(['tx1', 'tx2']);
    expect(fetched[0].fullCode).toBe('sh600000');

    // loadTRoundsFromDB：OPENED Round 附带 transactions（流水池恢复源）
    const rows = await loadTRoundsFromDB();
    const openRow = rows.find((r) => r.id === roundId);
    expect(openRow?.status).toBe('OPENED');
    expect(openRow?.transactions?.map((t) => t.id).sort()).toEqual(['tx1', 'tx2']);

    // 物理删除单笔流水
    await deleteTransaction('tx1');
    const after = await fetchTransactionsByRoundId(roundId);
    expect(after.map((t) => t.id)).toEqual(['tx2']);

    // 整轮替换写（round 概览 + 全量明细）
    const updatedRound: TRoundArchive = {
      ...round,
      status: 'COMPLETED',
      closedAt: '2026-08-13T04:00:00.000Z',
      netProfit: 50,
      transactions: [t1, t2],
    };
    await putRoundWithTransactions(updatedRound);
    const roundRow = await db.tRounds.get(roundId);
    expect(roundRow?.status).toBe('COMPLETED');
    expect(roundRow?.netProfit).toBe(50);
    expect((await fetchTransactionsByRoundId(roundId)).map((t) => t.id).sort()).toEqual(['tx1', 'tx2']);

    await db.close();
    await db.delete();
  });
});
