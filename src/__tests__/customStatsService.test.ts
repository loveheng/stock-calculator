/**
 * @file customStatsService.test.ts
 * @description 自定义统计 Service 回归测试：
 *              - buildFullContext 全量 ctx 组装形状（rounds/openRounds 拆分、txns 升序 + roundId 收紧、
 *                activeStreams 序列化安全子集、feeConfig 结构子集）
 *              - buildPromptContext 样例行 ≤3/集合 + 字典分组齐全
 *              - CRUD：保存/钉选（含 pinnedAt 键删除）/收藏/替换（钉选迁移 + 旧行软删）/软删/运行态写回
 *              - 不可变接口面：服务无 updateCode
 * @layer 测试
 * @storage_impact 使用 fake-indexeddb 内存数据库，不触达真实存储。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index';
import {
  buildFullContext,
  buildPromptContext,
  customStatsService,
  deleteCustomStatById,
  listCustomStatDefs,
  recordCustomStatRun,
  replaceCustomStatDef,
  saveCustomStatDef,
  setCustomStatFavorite,
  setCustomStatPinned,
} from '../services/customStatsService';
import type { FeeConfig } from '../utils/mathUtils';
import { buildSampleDefinition } from '../utils/customStats/fixtures';

const FEE: FeeConfig = {
  commissionRate: 0.00025,
  isFreeFive: false,
  minCommission: 5,
  transferRate: 0.00001,
  stampRate: 0.0005,
};

function baseEntity(id: string) {
  return { id, createdAt: 1750000000000, updatedAt: 1750000000000, isDeleted: 0 as const };
}

async function seed() {
  // 持仓：一开一平
  await db.positions.bulkPut([
    { ...baseEntity('pos-1'), fullCode: 'sh600519', currentCost: 1990, currentAmount: 100, isClosed: 0, totalInvested: 199000, realizedPnL: 356.5 },
    { ...baseEntity('pos-2'), fullCode: 'sz000001', currentCost: 10.2, currentAmount: 0, isClosed: 1, totalInvested: 10200, realizedPnL: -58.2, closedAt: 1754000000000 },
  ]);
  // 轮次：一完成一进行中
  await db.tRounds.bulkPut([
    { ...baseEntity('r-1'), fullCode: 'sh600519', mode: 'long' as const, status: 'COMPLETED' as const, roundCode: '#20260801-0935', settleType: 'clear' as const, netProfit: 236.5, totalFees: 12.3, openedAt: 1754000000000, closedAt: 1754050000000, win: true, tradeCount: 2, holdingDays: 1 },
    { ...baseEntity('r-2'), fullCode: 'sh601318', mode: 'long' as const, status: 'OPENED' as const, roundCode: '#20260906-0935', settleType: 'clear' as const, netProfit: 0, totalFees: 0, openedAt: 1757000000000 },
  ]);
  // 流水：挂在 OPENED 轮上 + 一条 COMPLETED 轮历史流水（乱序写入验证升序；
  // 日期相距多天，避开 'YYYY-MM-DD HH:mm' 按本地时区解析与 ISO 按 UTC 解析的偏移影响）
  await db.tTransactions.bulkPut([
    { ...baseEntity('t-2'), roundId: 'r-2', fullCode: 'sh601318', stockName: '中国平安', direction: 'sell' as const, price: 45.3, amount: 100, fee: 5.1, timestamp: '2026-09-10 10:00', matchedAmount: 0, realizedProfit: 0 },
    { ...baseEntity('t-3'), roundId: 'r-2', fullCode: 'sh601318', stockName: '中国平安', direction: 'buy' as const, price: 45.0, amount: 100, fee: 5.0, timestamp: '2026-09-06T09:35:00.000Z', matchedAmount: 100, realizedProfit: 0 },
    { ...baseEntity('t-1'), roundId: 'r-1', fullCode: 'sh600519', stockName: '贵州茅台', direction: 'sell' as const, price: 2000, amount: 10, fee: 4.1, timestamp: '2026-08-01T14:55:00.000Z', matchedAmount: 10, realizedProfit: 236.5 },
  ]);
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('buildFullContext（全量执行上下文）', () => {
  it('rounds/openRounds 拆分、txns 升序且带 roundId、positions 含已平仓', async () => {
    await seed();
    const ctx = await buildFullContext(FEE);
    expect(ctx.schemaVersion).toBe(1);
    expect(typeof ctx.now).toBe('string');
    expect(ctx.rounds.map((r) => r.id)).toEqual(['r-1']);
    expect(ctx.openRounds.map((r) => r.id)).toEqual(['r-2']);
    expect(ctx.positions.length).toBe(2);
    // 升序：t-3(09:35) < t-2(10:00) < t-1(8/1 属更早日期)
    expect(ctx.txns.map((t) => t.id)).toEqual(['t-1', 't-3', 't-2']);
    expect(ctx.txns.every((t) => typeof t.roundId === 'string' && t.fullCode && t.stockName)).toBe(true);
  });

  it('activeStreams 与统计页同口径且为序列化安全子集', async () => {
    await seed();
    const ctx = await buildFullContext(FEE);
    expect(ctx.activeStreams.length).toBe(1);
    const s = ctx.activeStreams[0];
    expect(s.fullCode).toBe('sh601318');
    // 子集形状：仅 6 个标量字段，无 entries 等非标量数组
    expect(Object.keys(s).sort()).toEqual(
      ['fullCode', 'netPendingAmount', 'realizedPnL', 'status', 'stockName', 'weightedBuyCost'],
    );
  });

  it('feeConfig 收紧为核心 5 字段子集', async () => {
    await seed();
    const ctx = await buildFullContext(FEE);
    expect(Object.keys(ctx.feeConfig).sort()).toEqual(
      ['commissionRate', 'isFreeFive', 'minCommission', 'stampRate', 'transferRate'],
    );
    expect(ctx.feeConfig.commissionRate).toBe(0.00025);
  });
});

describe('buildPromptContext（LLM 样例上下文）', () => {
  it('样例行 ≤3/集合，字典五组齐全', async () => {
    await seed();
    const p = await buildPromptContext(FEE);
    expect(p.sampleRows.rounds.length).toBeLessThanOrEqual(3);
    expect(p.sampleRows.txns.length).toBeLessThanOrEqual(3);
    expect(p.sampleRows.positions.length).toBeLessThanOrEqual(3);
    for (const group of ['rounds', 'txns', 'positions', 'activeStreams', 'context']) {
      expect(p.fieldDictionary[group]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('customStatsService CRUD（不可变接口面）', () => {
  it('无 updateCode：修改只能走重新生成', () => {
    expect((customStatsService as unknown as Record<string, unknown>).updateCode).toBeUndefined();
  });

  it('保存 → 钉选/取消（pinnedAt 键物理删除）→ 收藏 → 运行态写回', async () => {
    await saveCustomStatDef(buildSampleDefinition());
    let defs = await listCustomStatDefs();
    expect(defs.length).toBe(1);

    await setCustomStatPinned('fx-def-1', true);
    defs = await listCustomStatDefs();
    expect(defs[0].pinned).toBe(true);
    expect(typeof defs[0].pinnedAt).toBe('string');

    await setCustomStatPinned('fx-def-1', false);
    defs = await listCustomStatDefs();
    expect(defs[0].pinned).toBe(false);
    expect(defs[0].pinnedAt).toBeUndefined();

    await setCustomStatFavorite('fx-def-1', true);
    defs = await listCustomStatDefs();
    expect(defs[0].favorite).toBe(true);

    const result = { kind: 'card' as const, title: 't', kpis: [{ label: 'a', value: '1' }] };
    await recordCustomStatRun('fx-def-1', result, 1);
    defs = await listCustomStatDefs();
    expect(defs[0].lastResult).toEqual(result);
    expect(typeof defs[0].lastRunAt).toBe('string');
    expect(defs[0].runCount).toBe(1);
  });

  it('replaceCustomStatDef：钉选迁移 + 旧行软删（同事务）', async () => {
    await saveCustomStatDef(buildSampleDefinition({ pinned: true, pinnedAt: '2026-09-01T00:00:00.000Z' }));
    const next = buildSampleDefinition({ id: 'fx-def-2', kind: 'chart' });
    await replaceCustomStatDef('fx-def-1', next);
    const defs = await listCustomStatDefs();
    expect(defs.map((d) => d.id)).toEqual(['fx-def-2']);
    // 钉选状态按定义迁移（kind 变更即落图表区，pinned/pinnedAt 不丢）
    expect(defs[0].pinned).toBe(true);
    expect(defs[0].pinnedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('软删后列表不可见', async () => {
    await saveCustomStatDef(buildSampleDefinition());
    await deleteCustomStatById('fx-def-1');
    expect(await listCustomStatDefs()).toEqual([]);
  });
});
