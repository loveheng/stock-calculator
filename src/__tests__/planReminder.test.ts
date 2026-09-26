/**
 * @file planReminder.test.ts
 * @description 计划单 → 后端价格提醒参数映射单测：覆盖 docs/monitor/api.md §6.1 单边语义
 *              （BUY + 容差 0 → PRICE_BELOW；BUY/SELL + 容差 >0 → PRICE_NEAR；SELL 仅容 PRICE_NEAR）
 *              与 defaultBand 由价格阈值带推导默认容差。
 */

import { describe, it, expect } from 'vitest';
import type { PlannedOrder } from '../types/domain';
import { deriveMonitorInput, defaultBand } from '../utils/planReminder';

/** 构造最小可用 PlannedOrder（仅取映射所需字段） */
function makeOrder(overrides: Partial<PlannedOrder>): PlannedOrder {
  return {
    id: 'o1',
    fullCode: 'sh600519',
    stockName: '贵州茅台',
    context: 'short-term',
    direction: 'buy',
    plannedPrice: 1450,
    plannedAmount: 100,
    validityDays: 3,
    createdAt: '2026-09-25T10:00:00+08:00',
    expiresAt: '2026-09-28T10:00:00+08:00',
    status: 'active',
    ...overrides,
  };
}

describe('deriveMonitorInput', () => {
  it('BUY + band 0 → PRICE_BELOW（跌破目标价即提醒）', () => {
    const input = deriveMonitorInput(makeOrder({ direction: 'buy' }), 0);
    expect(input).toEqual({
      fullCode: 'sh600519',
      direction: 'BUY',
      type: 'PRICE_BELOW',
      threshold: 1450,
    });
  });

  it('BUY + band > 0 → PRICE_NEAR（区间触发）', () => {
    const input = deriveMonitorInput(makeOrder({ direction: 'buy' }), 20);
    expect(input).toEqual({
      fullCode: 'sh600519',
      direction: 'BUY',
      type: 'PRICE_NEAR',
      threshold: 1450,
      band: 20,
    });
  });

  it('SELL 始终 → PRICE_NEAR（后端仅容 PRICE_NEAR）', () => {
    const input = deriveMonitorInput(makeOrder({ direction: 'sell' }), 0);
    expect(input.direction).toBe('SELL');
    expect(input.type).toBe('PRICE_NEAR');
    expect(input.threshold).toBe(1450);
    expect(input.band).toBe(0);
  });

  it('负数容差按 0 处理（BUY 退化为 PRICE_BELOW）', () => {
    const input = deriveMonitorInput(makeOrder({ direction: 'buy' }), -5);
    expect(input.type).toBe('PRICE_BELOW');
  });
});

describe('defaultBand', () => {
  it('BUY：上端点 − 目标价（跌入区间上沿即触发）', () => {
    const band = defaultBand(makeOrder({ direction: 'buy', thresholdRange: { low: 1400, high: 1470 } }));
    expect(band).toBe(20); // 1470 - 1450
  });

  it('SELL：目标价 − 下端点（涨入区间下沿即触发）', () => {
    const band = defaultBand(makeOrder({ direction: 'sell', thresholdRange: { low: 1430, high: 1470 } }));
    expect(band).toBe(20); // 1450 - 1430
  });

  it('无阈值带 → 0', () => {
    expect(defaultBand(makeOrder({}))).toBe(0);
  });

  it('阈值带端点无效（≤0）→ 0', () => {
    expect(defaultBand(makeOrder({ thresholdRange: { low: 0, high: 0 } }))).toBe(0);
  });
});
