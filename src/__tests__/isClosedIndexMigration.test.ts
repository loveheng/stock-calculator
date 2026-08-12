/**
 * @file isClosedIndexMigration.test.ts
 * @description 回归测试：PositionEntity.isClosed 由 boolean 迁移为 0|1 数字后，
 *              isClosed 与 [isClosed+isDeleted] 索引才真正生效（IndexedDB 的索引 key
 *              不支持 boolean 类型，boolean 字段不会被索引收录，导致按索引查询查不出数据）。
 *              本测试用 fake-indexeddb 模拟 v6 存量数据（boolean isClosed），
 *              再打开真实 DB（v7）触发 upgrade 迁移，验证索引查询与新写入路径。
 * @layer Test
 */
import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { describe, expect, it } from 'vitest';
import { db, fetchClosedPositionsPage, loadPositionsFromDB, putPosition } from '../db';
import type { Position } from '../store';

/** 模拟 v6 时期的旧库（isClosed 为 boolean，仅声明 positions 表即可） */
class LegacyV6DB extends Dexie {
  positions!: Table<any, string>;
  constructor() {
    super('TradingLedgerDB_v3');
    this.version(6).stores({
      positions: 'id, fullCode, isClosed, [isClosed+isDeleted], createdAt, updatedAt, isDeleted',
    });
  }
}

function legacyPosition(id: string, fullCode: string, isClosed: boolean) {
  return {
    id,
    fullCode,
    isClosed,
    isDeleted: 0,
    createdAt: 1,
    updatedAt: 1,
    currentCost: 10,
    currentAmount: isClosed ? 0 : 100,
  };
}

describe('positions 表 isClosed 索引迁移', () => {
  it('v6 boolean 存量数据迁移到 v7 后，isClosed 索引查询生效', async () => {
    // 0) 清理：确保从空库开始
    await db.delete();

    // 1) 构造 v6 旧库并写入 boolean isClosed 数据（复现历史 bug 的存储形态）
    const legacy = new LegacyV6DB();
    await legacy.open();
    await legacy.positions.bulkPut([
      legacyPosition('open-1', 'sh600000', false),
      legacyPosition('closed-1', 'sz000001', true),
    ]);

    // 2) 复现 bug：v6 下按 [isClosed+isDeleted] 索引查不出任何数据
    const buggyOpen = await legacy.positions.where('[isClosed+isDeleted]').equals([0, 0]).toArray();
    expect(buggyOpen).toHaveLength(0);
    const buggyClosed = await legacy.positions.where('[isClosed+isDeleted]').equals([1, 0]).toArray();
    expect(buggyClosed).toHaveLength(0);
    await legacy.close();

    // 3) 打开真实 DB（v7）→ 触发 upgrade：boolean isClosed 迁移为 0|1 数字
    await db.open();
    const all = await db.positions.toArray();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.isClosed).sort()).toEqual([0, 1]);
    expect(typeof all[0].isClosed).toBe('number');

    // 4) 迁移后：复合索引 [isClosed+isDeleted] 查询恢复正常
    const open = await db.positions.where('[isClosed+isDeleted]').equals([0, 0]).toArray();
    expect(open.map((p) => p.id)).toEqual(['open-1']);
    const closed = await db.positions.where('[isClosed+isDeleted]').equals([1, 0]).toArray();
    expect(closed.map((p) => p.id)).toEqual(['closed-1']);

    // 5) 单字段索引 isClosed 查询也生效
    const singleOpen = await db.positions.where('isClosed').equals(0).toArray();
    expect(singleOpen.map((p) => p.id)).toEqual(['open-1']);

    // 6) DAO 读路径：实体数字 isClosed 转回 Store 层 boolean
    const rows = await loadPositionsFromDB();
    const openRow = rows.find((r) => r.id === 'open-1');
    expect(openRow?.isClosed).toBe(false);

    // 7) 新写入路径：boolean → 实体落库为 0|1 数字，且索引立即可查
    await db.close();
    await db.delete();
    await db.open();
    const newPosition: Position = {
      id: 'new-open',
      stockName: '浦发银行',
      fullCode: 'sh600000',
      currentCost: 10,
      currentAmount: 100,
      batches: [],
      isClosed: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      realizedPnL: 0,
      totalInvested: 1000,
    };
    await putPosition(newPosition);
    const raw = await db.positions.get('new-open');
    expect(raw?.isClosed).toBe(0);
    const newOpen = await db.positions.where('[isClosed+isDeleted]').equals([0, 0]).toArray();
    expect(newOpen.map((p) => p.id)).toContain('new-open');

    // 8) 已平仓分页查询接口（equals([1,0])）同样正常
    await putPosition({
      ...newPosition,
      id: 'new-closed',
      currentAmount: 0,
      isClosed: true,
      closedAt: '2026-01-02T00:00:00.000Z',
    });
    const page = await fetchClosedPositionsPage(1, 10);
    expect(page.items.map((p) => p.id)).toEqual(['new-closed']);
    expect(page.items[0].isClosed).toBe(true);

    await db.close();
    await db.delete();
  });
});
