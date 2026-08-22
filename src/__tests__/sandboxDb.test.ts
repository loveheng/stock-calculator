/**
 * @file sandboxDb.test.ts
 * @description 沙盘推演数据层（Step 1 成果）回归测试：
 *              - 分支 CRUD（写入 / 加载 / 软删除 + 订单级联软删）
 *              - 订单批量写入幂等（先软删旧单再插入，无孤儿单）
 *              - K 线缓存读写（前复权 K 线 + 复权系数表往返）
 * @layer Test
 * @storage_impact 使用 fake-indexeddb 内存数据库，不触达真实存储。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bulkPutSandboxOrders,
  clearKlineCache,
  db,
  deleteSandboxBranch,
  deleteSandboxOrdersByBranchId,
  loadKlineCache,
  loadSandboxBranchesFromDB,
  loadSandboxOrdersByBranchId,
  putKlineCache,
  putSandboxBranch,
} from '../db';
import type { SandboxBranch, SandboxOrder } from '../types/sandbox';
import type { KlineItem } from '../types/sandbox';

/** 构造分支（user 类型全字段） */
function makeBranch(over: Partial<SandboxBranch> = {}): SandboxBranch {
  return {
    id: 'branch-1',
    fullCode: 'sh601318',
    stockName: '中国平安',
    branchType: 'user',
    branchName: '测试方案',
    status: 'draft',
    peakCapitalLock: 20000,
    simulatedCash: 20000,
    dataAsOfDate: '2026-08-19',
    lastRunAt: 0,
    generatedAtCash: 20000,
    lastBaselineSignature: '',
    jitterFactor: 0.25,
    jitterWindowSize: 5,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: 0,
    ...over,
  };
}

/** 构造订单 */
function makeOrder(over: Partial<SandboxOrder>): SandboxOrder {
  return {
    id: 'order-1',
    branchId: 'branch-1',
    seqIndex: 0,
    action: 'buy',
    timestamp: '2026-01-05T09:30:00+08:00',
    price: 10,
    quantity: 100,
    ...over,
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('沙盘分支 CRUD', () => {
  it('写入 → 加载 → 更新 → 软删除（订单级联软删）', async () => {
    await putSandboxBranch(makeBranch());

    let branches = await loadSandboxBranchesFromDB();
    expect(branches).toHaveLength(1);
    expect(branches[0].branchName).toBe('测试方案');
    expect(branches[0].peakCapitalLock).toBe(20000);

    // 更新（同 id 覆盖）
    await putSandboxBranch(makeBranch({ branchName: '改名的方案', updatedAt: 2 }));
    branches = await loadSandboxBranchesFromDB();
    expect(branches).toHaveLength(1);
    expect(branches[0].branchName).toBe('改名的方案');

    // 订单落库 + 级联软删
    await bulkPutSandboxOrders('branch-1', [makeOrder({})]);
    expect(await loadSandboxOrdersByBranchId('branch-1')).toHaveLength(1);

    await deleteSandboxBranch('branch-1');
    expect(await loadSandboxBranchesFromDB()).toHaveLength(0);
    expect(await loadSandboxOrdersByBranchId('branch-1')).toHaveLength(0);
  });

  it('按标的过滤加载', async () => {
    await putSandboxBranch(makeBranch({ id: 'b1', fullCode: 'sh601318' }));
    await putSandboxBranch(makeBranch({ id: 'b2', fullCode: 'sz000001' }));
    const list = await loadSandboxBranchesFromDB('sh601318');
    expect(list.map((b) => b.id)).toEqual(['b1']);
  });
});

describe('订单批量写入幂等', () => {
  it('重复保存不产生孤儿单：旧订单软删、同 id 覆盖、新单追加', async () => {
    // 第一次保存：o1, o2
    await bulkPutSandboxOrders('branch-1', [
      makeOrder({ id: 'o1', seqIndex: 0, price: 10, quantity: 100 }),
      makeOrder({ id: 'o2', seqIndex: 1, price: 11, quantity: 200 }),
    ]);
    // 第二次保存：o2 更新、o3 新增、o1 删除
    await bulkPutSandboxOrders('branch-1', [
      makeOrder({ id: 'o2', seqIndex: 1, price: 12, quantity: 300 }),
      makeOrder({ id: 'o3', seqIndex: 2, price: 13, quantity: 100 }),
    ]);

    const orders = await loadSandboxOrdersByBranchId('branch-1');
    expect(orders).toHaveLength(2);
    expect(orders.map((o) => o.id).sort()).toEqual(['o2', 'o3']);
    expect(orders.find((o) => o.id === 'o2')!.price).toBe(12);
    expect(orders.find((o) => o.id === 'o2')!.quantity).toBe(300);
    expect(orders[0].seqIndex).toBeLessThan(orders[1].seqIndex);
  });

  it('删除分支全部订单', async () => {
    await bulkPutSandboxOrders('branch-1', [makeOrder({ id: 'o1' }), makeOrder({ id: 'o2' })]);
    await deleteSandboxOrdersByBranchId('branch-1');
    expect(await loadSandboxOrdersByBranchId('branch-1')).toHaveLength(0);
  });
});

describe('K 线缓存读写', () => {
  it('前复权 K 线 + 复权系数表往返一致，清除后返回 null', async () => {
    const klines: KlineItem[] = [
      { date: '2026-01-05', open: 10, close: 10.2, high: 10.3, low: 9.9, volume: 1000 },
      { date: '2026-01-06', open: 10.2, close: 10.5, high: 10.6, low: 10.1, volume: 1200 },
    ];
    const factors = { '2026-01-05': 0.96, '2026-01-06': 0.96 };

    await putKlineCache('sh601318', klines, factors);
    const loaded = await loadKlineCache('sh601318');
    expect(loaded).not.toBeNull();
    expect(loaded!.klines).toEqual(klines);
    expect(loaded!.factors).toEqual(factors);

    // 无系数时兼容读取
    await putKlineCache('sz000001', [klines[0]]);
    const withoutFactors = await loadKlineCache('sz000001');
    expect(withoutFactors!.factors).toEqual({});

    await clearKlineCache('sh601318');
    expect(await loadKlineCache('sh601318')).toBeNull();
  });
});
