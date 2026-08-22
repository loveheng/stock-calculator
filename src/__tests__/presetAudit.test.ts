/**
 * @file presetAudit.test.ts
 * @description 预设策略「静态审计」运行器：载入真实股票（闻泰科技 600745）前复权日 K 线，
 *              以 20 万初始现金逐策略跑出每笔买卖与触发原因，并核对资金不变量。
 *              输出即为主要断言目标（跑一次即可在终端看到完整 trace）。
 * @layer Test
 * @storage_impact 只读真实 K 线 JSON，无副作用。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditPresetOrders, renderAudit, type AuditResult } from '../utils/presetAudit';
import { generateStrategyOrders, type StrategyContext } from '../utils/strategyGenerators';
import { DEFAULT_FEE_CONFIG } from '../store/feePresets';
import type { KlineItem, PresetStrategyId, SandboxOrder } from '../types/sandbox';

const KLINE_PATH = new URL('../../data/audit-wt/wt-kline.json', import.meta.url);
const INITIAL_CASH = 200000;
// 闻泰科技 600745，2025-12-01 → 2026-08-20（前复权日线）

const klines = JSON.parse(readFileSync(fileURLToPath(KLINE_PATH), 'utf-8')) as KlineItem[];
const STRATEGIES: PresetStrategyId[] = ['pyramid', 'ma20-bounce', 'grid', 'stop-profit', 'max-opportunity', 'pure-dca', 'gap-fill', 'hybrid-regime'];

/** 把某一策略产出的订单复用为另一策略（gap-fill）的基线订单 */
function ordersOf(strategyId: PresetStrategyId): SandboxOrder[] {
  const ctx: StrategyContext = {
    klineData: klines,
    simulatedCash: INITIAL_CASH,
    peakCapitalLock: INITIAL_CASH,
    currentPrice: klines[klines.length - 1]?.close ?? 0,
    currentCost: 0,
    currentQuantity: 0,
    feeConfig: DEFAULT_FEE_CONFIG,
    securityKind: 'stock',
  };
  return generateStrategyOrders(strategyId, ctx, {});
}

describe('预设策略静态审计（真实行情 闻泰科技 600745 · 20 万）', () => {
  it('导出真实 K 线（175 根，2025-12-01 → 2026-08-20）', () => {
    expect(klines.length).toBe(175);
    expect(klines[0].date).toBe('2025-12-01');
    expect(klines[klines.length - 1].date).toBe('2026-08-20');
    expect(klines[0].close).toBeCloseTo(40.91, 2);
  });

  it('逐策略重放并核对资金不变量（打印完整 trace）', () => {
    const results: AuditResult[] = [];
    for (const id of STRATEGIES) {
      // gap-fill 需要基线订单：用 pyramid 产出作为「若当时有持仓/操作」的基线参考
      const baseline = id === 'gap-fill' ? ordersOf('pyramid') : undefined;
      const audit = auditPresetOrders(id, klines, INITIAL_CASH, baseline);
      results.push(audit);
      // eslint-disable-next-line no-console
      console.log('\n' + renderAudit(audit) + '\n' + '='.repeat(88));
    }
    const allOk = results.every((r) => r.invariantOk);
    expect(allOk).toBe(true);
  });
});