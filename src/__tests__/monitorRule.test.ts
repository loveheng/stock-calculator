/**
 * @file monitorRule.test.ts
 * @description 价格预告单触发规则纯函数测试：钉死单边触发边界口径（BUY 取上沿 / SELL 取下沿）、
 *              非法组合（SELL + 跌破）拒算、建单即触发与容差过窄两类风险判定。
 * @layer Test
 * @storage_impact 无存储读写。
 * @author 开发团队
 */

import { describe, it, expect } from 'vitest';
import {
  NARROW_BAND_RATIO,
  bandPctOfThreshold,
  computeTriggerBoundary,
  distanceToTrigger,
  isBandTooNarrow,
  isPriceInTriggerSide,
} from '../utils/monitorRule';

describe('computeTriggerBoundary 单边触发边界', () => {
  it('BUY + 区间：边界 = 目标价 + 容差（提前量在上沿）', () => {
    const b = computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_NEAR', threshold: 1450, band: 20 });
    expect(b).toEqual({ operator: '<=', bound: 1470, text: '价格 ≤ 1470.00 时提醒' });
  });

  it('SELL + 区间：边界 = 目标价 − 容差（提前量在下沿）', () => {
    const b = computeTriggerBoundary({ direction: 'SELL', type: 'PRICE_NEAR', threshold: 1450, band: 20 });
    expect(b).toEqual({ operator: '>=', bound: 1430, text: '价格 ≥ 1430.00 时提醒' });
  });

  it('BUY + 跌破：边界 = 目标价，无容差', () => {
    const b = computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_BELOW', threshold: 10.5, band: 5 });
    expect(b?.bound).toBe(10.5);
    expect(b?.operator).toBe('<=');
  });

  it('SELL + 跌破：非法组合返回 null（后端 400，前端禁用提交）', () => {
    expect(computeTriggerBoundary({ direction: 'SELL', type: 'PRICE_BELOW', threshold: 10 })).toBeNull();
  });

  it('目标价非正数 / 非数字：返回 null', () => {
    expect(computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_NEAR', threshold: 0, band: 1 })).toBeNull();
    expect(computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_NEAR', threshold: Number.NaN })).toBeNull();
  });

  it('低价股容差大于目标价：SELL 下沿兜底为 0，不出现负边界', () => {
    const b = computeTriggerBoundary({ direction: 'SELL', type: 'PRICE_NEAR', threshold: 5, band: 20 });
    expect(b?.bound).toBe(0);
  });

  it('容差缺省 / 负值按 0 处理（不产生 NaN 边界）', () => {
    const b = computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_NEAR', threshold: 100, band: null });
    expect(b?.bound).toBe(100);
    const b2 = computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_NEAR', threshold: 100, band: -8 });
    expect(b2?.bound).toBe(100);
  });
});

describe('isPriceInTriggerSide 建单即触发判定', () => {
  const buy = computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_NEAR', threshold: 1450, band: 20 })!;
  const sell = computeTriggerBoundary({ direction: 'SELL', type: 'PRICE_NEAR', threshold: 1450, band: 20 })!;

  it('BUY：价格低于上沿即已落在触发侧（含跌穿下沿）', () => {
    expect(isPriceInTriggerSide(1421.6, buy)).toBe(true);
    expect(isPriceInTriggerSide(1400, buy)).toBe(true);
    expect(isPriceInTriggerSide(1500, buy)).toBe(false);
  });

  it('SELL：价格高于下沿即已落在触发侧（含升穿上限）', () => {
    expect(isPriceInTriggerSide(1460, sell)).toBe(true);
    expect(isPriceInTriggerSide(1490, sell)).toBe(true);
    expect(isPriceInTriggerSide(1380, sell)).toBe(false);
  });

  it('非有限价格一律 false（不误判为已触发）', () => {
    expect(isPriceInTriggerSide(Number.NaN, buy)).toBe(false);
  });
});

describe('distanceToTrigger 距触发距离', () => {
  it('BUY：正号表示还需下跌（相对边界百分比）', () => {
    const buy = computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_NEAR', threshold: 1450, band: 20 })!;
    const d = distanceToTrigger(1500, buy)!;
    expect(d.diff).toBeCloseTo(30, 6);
    expect(d.pct).toBeCloseTo((30 / 1470) * 100, 6);
  });

  it('SELL：正号表示还需上涨', () => {
    const sell = computeTriggerBoundary({ direction: 'SELL', type: 'PRICE_NEAR', threshold: 1450, band: 20 })!;
    const d = distanceToTrigger(1400, sell)!;
    expect(d.diff).toBeCloseTo(30, 6);
    expect(d.pct).toBeGreaterThan(0);
  });

  it('已越过边界 → 负号', () => {
    const buy = computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_BELOW', threshold: 100 })!;
    expect(distanceToTrigger(90, buy)!.diff).toBeLessThan(0);
  });

  it('边界为 0 或非有限价格 → null（避免除零）', () => {
    const zero = computeTriggerBoundary({ direction: 'SELL', type: 'PRICE_NEAR', threshold: 5, band: 20 })!;
    expect(distanceToTrigger(3, zero)).toBeNull();
    const buy = computeTriggerBoundary({ direction: 'BUY', type: 'PRICE_BELOW', threshold: 100 })!;
    expect(distanceToTrigger(Number.NaN, buy)).toBeNull();
  });
});

describe('容差占比与过窄判定', () => {
  it('bandPctOfThreshold：区间型取容差/目标价，跌破型为 0', () => {
    expect(bandPctOfThreshold({ direction: 'BUY', type: 'PRICE_NEAR', threshold: 1450, band: 20 })).toBeCloseTo(
      (20 / 1450) * 100,
      6,
    );
    expect(bandPctOfThreshold({ direction: 'BUY', type: 'PRICE_BELOW', threshold: 1450 })).toBe(0);
  });

  it('容差小于参考价 0.3% → 判定过窄；等于阈值不算窄', () => {
    expect(isBandTooNarrow(0.01, 10)).toBe(true);
    expect(isBandTooNarrow(10 * NARROW_BAND_RATIO, 10)).toBe(false);
  });

  it('容差 0（精确跌破型）不算窄，避免误告警', () => {
    expect(isBandTooNarrow(0, 10)).toBe(false);
    expect(isBandTooNarrow(null, 10)).toBe(false);
  });

  it('参考价缺失/非正 → false（不阻断）', () => {
    expect(isBandTooNarrow(0.01, 0)).toBe(false);
    expect(isBandTooNarrow(0.01, Number.NaN)).toBe(false);
  });
});
