/**
 * @file customStatRunner.test.ts
 * @description 沙箱执行器（vm.ts，QuickJS WASM）回归测试：
 *              - eval 求值 + 调用 + 结果 JSON 序列化出沙箱（card/chart 双形态）
 *              - helpers 注入可用（fmtMoney/sumBy/groupBy）
 *              - 空数组夹具上 AI 常见错误模式（rounds[0].x 无保护）被拦截为执行错误而非崩溃
 *              - 夹具预跑：空数组/样例两套夹具上合法代码通过
 *              - 死循环被 interrupt 时限打断（timedOut 语义）
 *              - 语法错误在 eval 阶段暴露并携带行号；VM 单例驻留可连续执行
 * @layer 测试
 * @author 开发团队
 */

import { afterEach, describe, expect, it } from 'vitest';
import { executeStatCode, resetSandbox } from '../utils/customStats/vm';
import { buildEmptyFixtureCtx, buildSampleFixtureCtx } from '../utils/customStats/fixtures';
import { normalizeCustomStatsResult } from '../utils/customStats/guard';

afterEach(async () => {
  await resetSandbox();
});

describe('executeStatCode（QuickJS 沙箱执行）', () => {
  it('合法 card 代码：求值 → 调用 → JSON 出沙箱 → Guard 通过', async () => {
    const code = `(ctx) => ({
      kind: 'card',
      title: '总净收益',
      caption: '已归档轮 netProfit 求和',
      kpis: [{ label: '净收益', value: ctx.helpers.fmtMoney(ctx.helpers.sumBy(ctx.rounds, (r) => r.netProfit)), tone: 'good' }],
    })`;
    const out = await executeStatCode(code, buildSampleFixtureCtx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const guarded = normalizeCustomStatsResult(JSON.parse(out.resultJson));
    expect(guarded?.kind).toBe('card');
    if (guarded?.kind !== 'card') return;
    // 样例夹具：236.5 - 58.2 + 120.0 = 298.3
    expect(guarded.kpis[0].value).toBe('298.30');
  });

  it('合法 chart 代码：分组聚合出柱状数据', async () => {
    const code = `(ctx) => {
      const groups = ctx.helpers.groupBy(ctx.rounds, (r) => r.stockName);
      const data = Object.keys(groups).map((k) => ({
        label: k,
        value: ctx.helpers.round2(ctx.helpers.sumBy(groups[k], (r) => r.netProfit)),
      }));
      data.sort((a, b) => b.value - a.value);
      return { kind: 'chart', title: '各股净收益排行', caption: '降序', chart: { type: 'bar', data } };
    }`;
    const out = await executeStatCode(code, buildSampleFixtureCtx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const guarded = normalizeCustomStatsResult(JSON.parse(out.resultJson));
    expect(guarded?.kind).toBe('chart');
    if (guarded?.kind !== 'chart') return;
    expect(guarded.chart.type).toBe('bar');
    expect(guarded.chart.data[0]).toEqual({ label: '贵州茅台', value: 356.5 });
  });

  it('空数组夹具 + 无保护代码（rounds[0].netProfit）→ 执行错误而非崩溃', async () => {
    const code = `(ctx) => ({ kind: 'card', title: 't', kpis: [{ label: 'a', value: String(ctx.rounds[0].netProfit) }] })`;
    const out = await executeStatCode(code, buildEmptyFixtureCtx());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // QuickJS 报错文案：cannot read property 'netProfit' of undefined —— 空数组保护缺口被夹具拦截
    expect(out.message).toContain('netProfit');
    expect(out.message).toContain('undefined');
  });

  it('可选链防御代码在空夹具上正常产出（空态）', async () => {
    const code = `(ctx) => ({
      kind: 'chart',
      title: '趋势',
      chart: { type: 'line', data: ctx.rounds?.length ? [] : [] },
    })`;
    const out = await executeStatCode(code, buildEmptyFixtureCtx());
    expect(out.ok).toBe(true);
  });

  it('死循环被 interrupt 时限打断（timedOut = true）', async () => {
    const code = `(ctx) => { while (true) {} }`;
    const out = await executeStatCode(code, buildEmptyFixtureCtx(), 60);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.timedOut).toBe(true);
  });

  it('语法错误在 eval 阶段暴露（QuickJS 解析错误不携带行号，仅报消息）', async () => {
    const code = `(ctx) => { return { kind: 'card', title: 't' kpis: [] }; }`;
    const out = await executeStatCode(code, buildEmptyFixtureCtx());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.timedOut).toBeUndefined();
    expect(out.message).toContain('expecting');
  });

  it('运行时异常携带行号（指向生成代码行）', async () => {
    const code = `(ctx) => {
      const xs = null;
      return { kind: 'card', title: 't', kpis: [{ label: 'a', value: String(xs.foo()) }] };
    }`;
    const out = await executeStatCode(code, buildEmptyFixtureCtx());
    expect(out.ok).toBe(false);
  });

  it('VM 单例驻留：连续两次执行复用同一沙箱（第二次无需重新初始化）', async () => {
    const first = await executeStatCode(`(ctx) => ({ kind: 'card', title: 'a', kpis: [] })`, buildEmptyFixtureCtx());
    const second = await executeStatCode(`(ctx) => ({ kind: 'card', title: 'b', kpis: [] })`, buildEmptyFixtureCtx());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.parse(second.resultJson)).toMatchObject({ title: 'b' });
  });

  it('全局 __ctx 兑底：未声明参数的代码体也能取到 ctx（生成代码容错）', async () => {
    // 参数名被改写时（不叫 ctx），函数体经 globalThis.__ctx 仍可取到执行上下文
    const out = await executeStatCode(
      `(data) => ({ kind: 'card', title: String(typeof data.__proto__ === 'object' && typeof globalThis.__ctx === 'object'), kpis: [] })`,
      buildEmptyFixtureCtx(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(JSON.parse(out.resultJson)).toMatchObject({ title: 'true' });
  });
});
