/**
 * @file customStatFixtures.test.ts
 * @description 沙箱夹具回归测试（spec FR2 / implementation §4.3）：
 *              空数组夹具全集合为空（消灭 rounds[0].x 类崩溃的执行环境）；
 *              样例夹具每集合 2~3 行真实形状数据（结果形状验证 + Guard 热身）；
 *              定义样例构造器产出不可变定义契约形状。
 * @layer 测试
 * @author 开发团队
 */

import { describe, expect, it } from 'vitest';
import {
  buildEmptyFixtureCtx,
  buildFixtureContexts,
  buildSampleDefinition,
  buildSampleFixtureCtx,
  FIXTURE_NOW,
} from '../utils/customStats/fixtures';
import { CUSTOM_STAT_SCHEMA_VERSION } from '../types/domain';

describe('沙箱夹具', () => {
  it('空数组夹具：五集合全空，锚点与费率就位', () => {
    const ctx = buildEmptyFixtureCtx();
    expect(ctx.rounds).toEqual([]);
    expect(ctx.openRounds).toEqual([]);
    expect(ctx.txns).toEqual([]);
    expect(ctx.positions).toEqual([]);
    expect(ctx.activeStreams).toEqual([]);
    expect(ctx.schemaVersion).toBe(CUSTOM_STAT_SCHEMA_VERSION);
    expect(ctx.now).toBe(FIXTURE_NOW);
    expect(ctx.feeConfig.commissionRate).toBeGreaterThan(0);
    // 序列化安全：JSON 往返无损（Worker 线格式前提）
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(ctx);
  });

  it('样例夹具：每集合 2~3 行真实形状（含盈利与亏损轮）', () => {
    const ctx = buildSampleFixtureCtx();
    expect(ctx.rounds.length).toBe(3);
    expect(ctx.openRounds.length).toBe(1);
    expect(ctx.txns.length).toBe(4);
    expect(ctx.positions.length).toBe(2);
    expect(ctx.activeStreams.length).toBe(1);
    // 轮次覆盖盈亏两态（统计口径验证的基本盘）
    expect(ctx.rounds.some((r) => r.win === true)).toBe(true);
    expect(ctx.rounds.some((r) => r.win === false)).toBe(true);
    // txns 升序（时间基准）
    const ts = ctx.txns.map((t) => Date.parse(t.timestamp));
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
  });

  it('buildFixtureContexts：先空后样例的两轮预跑顺序', () => {
    const [empty, sample] = buildFixtureContexts();
    expect(empty.rounds.length).toBe(0);
    expect(sample.rounds.length).toBeGreaterThan(0);
  });

  it('样例定义：契约形状完整（id/prompt/code/schemaVersion/kind/时间戳）', () => {
    const def = buildSampleDefinition();
    expect(def.schemaVersion).toBe(CUSTOM_STAT_SCHEMA_VERSION);
    expect(def.kind === 'card' || def.kind === 'chart').toBe(true);
    expect(def.prompt?.length).toBeGreaterThan(0);
    expect(def.code.startsWith('(ctx)')).toBe(true);
    expect(new Date(def.createdAt).toISOString()).toBe(def.createdAt);
  });
});
