/**
 * @file riskRules.test.ts
 * @description 单元测试：验证统一风控模块新增规则（tBorrowRule / positionLimitRule /
 *              closeBlockRule）与 RiskController 门面的行为。
 * @layer Test
 * @storage_ impact 纯函数测试，不读写任何存储。
 */

import { describe, test, expect } from 'vitest';
import {
  tBorrowRule,
  positionLimitRule,
  closeBlockRule,
  dynamicPyramidRule,
  validate,
} from '../risk/validator';
import { evaluateDynamicPyramid, computePositionLifecycleSummary, type DynamicPyramidResult } from '../utils/mathUtils';
import { RiskController } from '../risk/riskController';
import type { RiskValidationContext } from '../risk/types';

/** 构造最小风控上下文 */
function makeCtx(): RiskValidationContext {
  return { now: new Date().toISOString() };
}

describe('tBorrowRule', () => {
  test('纯做T：不超过做T池可用量 → 通过', () => {
    const rule = tBorrowRule(500, 500, 0);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(false);
    expect(report.ok).toBe(true);
  });

  test('需借仓但底仓充足 → warning 通过', () => {
    const rule = tBorrowRule(800, 300, 500);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(false);
    const warn = report.checks.find((c) => c.severity === 'warning');
    expect(warn).toBeTruthy();
    expect(warn?.message).toContain('500');
  });

  test('不缺底仓 → 拦截', () => {
    const rule = tBorrowRule(900, 300, 500);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(true);
    const err = report.checks.find((c) => c.severity === 'error');
    expect(err?.message).toContain('合计');
  });

  test('卖出数量 <= 0 → 拦截', () => {
    const rule = tBorrowRule(0, 100, 100);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(true);
  });
});

describe('positionLimitRule', () => {
  test('减仓数量不超过持仓 → 通过', () => {
    const rule = positionLimitRule(100, 200);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(false);
  });

  test('减仓数量超过持仓 → 拦截', () => {
    const rule = positionLimitRule(300, 200);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(true);
  });
});

describe('closeBlockRule', () => {
  test('仍有未卖出持仓 → 拦截', () => {
    const rule = closeBlockRule(100, false);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(true);
    expect(report.checks[0].message).toContain('100');
  });

  test('存在进行中的做T轮次 → 拦截', () => {
    const rule = closeBlockRule(0, true);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(true);
    expect(report.checks[0].message).toContain('做T');
  });

  test('清仓到0且无做T轮次 → 通过', () => {
    const rule = closeBlockRule(0, false);
    const report = validate([rule], {}, makeCtx());
    expect(report.blocked).toBe(false);
  });
});

describe('RiskController.evaluateTTrade', () => {
  test('卖出超限被拦截且输出 borrowInfo 为 undefined', () => {
    const { report, borrowInfo } = RiskController.evaluateTTrade({
      sellAmount: 900,
      pendingBuyAmount: 300,
      availableForT: 500,
      price: 10,
      fullCode: 'sh600000',
      direction: 'sell',
    });
    expect(report.blocked).toBe(true);
    expect(borrowInfo).toBeUndefined();
  });

  test('需借仓且有底仓 → 不拦截 + borrowInfo.neededBase', () => {
    const { report, borrowInfo } = RiskController.evaluateTTrade({
      sellAmount: 800,
      pendingBuyAmount: 300,
      availableForT: 500,
      price: 10,
      fullCode: 'sh600000',
      direction: 'sell',
    });
    expect(report.blocked).toBe(false);
    expect(borrowInfo).toBeTruthy();
    expect(borrowInfo?.neededBase).toBe(500);
  });

  test('买入方向走数量/价格校验，不触发借仓', () => {
    const { report, borrowInfo } = RiskController.evaluateTTrade({
      sellAmount: 100,
      pendingBuyAmount: 0,
      availableForT: 100,
      price: 10,
      fullCode: 'sh600000',
      direction: 'buy',
    });
    expect(borrowInfo).toBeUndefined();
    // buy 方向仅做数量/价格合理性校验，不触发借仓逻辑
    expect(report.blocked).toBe(false);
  });
});

describe('RiskController.evaluateBatch', () => {
  test('减仓超过持仓被拦截', () => {
    const { report } = RiskController.evaluateBatch({
      amount: 500,
      type: 'reduce',
      currentAmount: 200,
    });
    expect(report.blocked).toBe(true);
  });

  test('减仓未超持仓 → 通过', () => {
    const { report } = RiskController.evaluateBatch({
      amount: 100,
      type: 'reduce',
      currentAmount: 200,
    });
    expect(report.blocked).toBe(false);
  });

  test('加仓不触发持仓上限校验', () => {
    const { report } = RiskController.evaluateBatch({
      amount: 500,
      type: 'add',
      currentAmount: 200,
    });
    expect(report.blocked).toBe(false);
  });
});

describe('RiskController.evaluateClosePosition', () => {
  test('清仓可结 → 不阻塞', () => {
    const { report } = RiskController.evaluateClosePosition({ remaining: 0, hasOpenTRound: false });
    expect(report.blocked).toBe(false);
  });

  test('有剩余数量 → 阻塞', () => {
    const { report } = RiskController.evaluateClosePosition({ remaining: 100, hasOpenTRound: false });
    expect(report.blocked).toBe(true);
  });
});

describe('evaluateDynamicPyramid（动态金字塔健康度）', () => {
  test('单批次建仓：无现有批次 → 100 分 HEALTHY', () => {
    const r = evaluateDynamicPyramid([], { price: 10, amount: 100 });
    expect(r.score).toBe(100);
    expect(r.level).toBe('HEALTHY');
  });

  test('良性低价加仓：现有高价批次 + 低位买入 → HEALTHY 且不产生警告', () => {
    // 现有买入 10 元 100 股，新加仓 9 元 50 股（重心下移，健康）
    const r = evaluateDynamicPyramid([{ price: 10, amount: 100 }], { price: 9, amount: 50 });
    expect(r.level).toBe('HEALTHY');
    expect(r.centerDeviation).toBeLessThan(0);
    // 软风控：不产生校验项（无警告）
    const rule = dynamicPyramidRule(r);
    const report = validate([rule], {}, makeCtx());
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(0);
  });

  test('高位重仓追高：偏离均价远且数量大 → RISKY，软风控仅告警不拦截', () => {
    // 现有买入 10 元 100 股，追高 13 元加仓 200 股（数量比例 > 0.5）
    const r = evaluateDynamicPyramid([{ price: 10, amount: 100 }], { price: 13, amount: 200 });
    expect(r.level).toBe('RISKY');
    expect(r.centerDeviation).toBeGreaterThan(0);
    const rule = dynamicPyramidRule(r);
    const report = validate([rule], {}, makeCtx());
    // passed 保持 true，不硬拦截
    expect(report.blocked).toBe(false);
    expect(report.ok).toBe(true);
    const warn = report.checks.find((c) => c.ruleName === 'dynamic_pyramid');
    expect(warn).toBeTruthy();
    expect(warn?.severity).toBe('warning');
    expect(warn?.passed).toBe(true);
    expect(warn?.message).toContain('高于');
  });

  test('evaluateBatch 向加仓传入 price/existingBatches → 返回 pyramidHealth', () => {
    const { report, pyramidHealth } = RiskController.evaluateBatch({
      amount: 200,
      type: 'add',
      currentAmount: 100,
      price: 13,
      existingBatches: [{ price: 10, amount: 100 }],
    });
    expect(pyramidHealth).toBeDefined();
    expect(pyramidHealth?.level).toBe('RISKY');
    // 软风控不拦截
    expect(report.blocked).toBe(false);
    expect(report.ok).toBe(true);
  });

  test('evaluatePlan 加仓方向接入金字塔风险 → 返回 pyramidHealth 且不硬拦', () => {
    const { report, pyramidHealth } = RiskController.evaluatePlan({
      price: 13,
      fullCode: 'sh600000',
      amount: 200,
      direction: 'buy',
      existingBatches: [{ price: 10, amount: 100 }],
    });
    expect(pyramidHealth).toBeDefined();
    expect(pyramidHealth?.level).toBe('RISKY');
    expect(report.blocked).toBe(false);
    const warn = report.checks.find((c) => c.ruleName === 'dynamic_pyramid');
    expect(warn?.severity).toBe('warning');
  });
});

describe('computePositionLifecycleSummary（结仓生命周期履历）', () => {
  test('无批次 → 安全基线', () => {
    const ls = computePositionLifecycleSummary([]);
    expect(ls.totalAddRounds).toBe(0);
    expect(ls.finalPyramidScore).toBe(100);
    expect(ls.finalPyramidLevel).toBe('HEALTHY');
    expect(ls.expansionRatio).toBe(1);
  });

  test('仅建仓无加仓 → 100 分 HEALTHY', () => {
    const ls = computePositionLifecycleSummary([
      { type: 'open', amount: 100, price: 10, timestamp: '2024-01-01T00:00:00Z' },
    ]);
    expect(ls.totalAddRounds).toBe(0);
    expect(ls.finalPyramidScore).toBe(100);
    expect(ls.finalPyramidLevel).toBe('HEALTHY');
    expect(ls.strategyType).toBe('首仓建仓');
    expect(ls.expansionRatio).toBe(1);
  });

  test('加仓节奏温和接近均价 → HEALTHY 低吸金字塔', () => {
    const ls = computePositionLifecycleSummary([
      { type: 'open', amount: 100, price: 10, timestamp: '2024-01-01T00:00:00Z' },
      { type: 'add', amount: 30, price: 10.05, timestamp: '2024-02-01T00:00:00Z' },
    ]);
    expect(ls.totalAddRounds).toBe(1);
    expect(ls.finalPyramidScore).toBeGreaterThanOrEqual(75);
    expect(ls.finalPyramidLevel).toBe('HEALTHY');
    expect(ls.strategyType).toBe('低吸金字塔');
    // 首仓 100 + 加仓 30 = 130 → 环比首仓 1.3 倍
    expect(ls.expansionRatio).toBeCloseTo(1.3, 1);
  });

  test('多次低位加仓但间隔深 → NEUTRAL 均衡加仓', () => {
    const ls = computePositionLifecycleSummary([
      { type: 'open', amount: 100, price: 15, timestamp: '2024-01-01T00:00:00Z' },
      { type: 'add', amount: 50, price: 12, timestamp: '2024-02-01T00:00:00Z' },
      { type: 'add', amount: 30, price: 10, timestamp: '2024-03-01T00:00:00Z' },
    ]);
    expect(ls.totalAddRounds).toBe(2);
    // 最后一笔 10 元相对底仓均价 14 元深跌 → 触发深度折价惩罚（60 分）
    expect(ls.finalPyramidScore).toBe(60);
    expect(ls.finalPyramidLevel).toBe('NEUTRAL');
    expect(ls.strategyType).toBe('均衡加仓');
    expect(ls.expansionRatio).toBeCloseTo(1.8, 1);
  });

  test('追高加仓 → RISKY 追高风险', () => {
    const ls = computePositionLifecycleSummary([
      { type: 'open', amount: 100, price: 10, timestamp: '2024-01-01T00:00:00Z' },
      { type: 'add', amount: 200, price: 13, timestamp: '2024-03-01T00:00:00Z' },
    ]);
    expect(ls.totalAddRounds).toBe(1);
    expect(ls.finalPyramidScore).toBeLessThan(40);
    expect(ls.finalPyramidLevel).toBe('RISKY');
    expect(ls.strategyType).toBe('追高风险');
    expect(ls.expansionRatio).toBe(3);
  });

  test('evaluateClosePosition 传入 batches 返回 lifecycleSummary', () => {
    const { report, lifecycleSummary } = RiskController.evaluateClosePosition({
      remaining: 0,
      hasOpenTRound: false,
      batches: [
        { type: 'open', amount: 100, price: 10, timestamp: '2024-01-01T00:00:00Z' },
        { type: 'add', amount: 200, price: 13, timestamp: '2024-03-01T00:00:00Z' },
      ],
    });
    expect(report.blocked).toBe(false);
    expect(lifecycleSummary).toBeDefined();
    expect(lifecycleSummary?.totalAddRounds).toBe(1);
    expect(lifecycleSummary?.finalPyramidLevel).toBe('RISKY');
  });

  test('evaluateClosePosition 无 batches 不返回 lifecycleSummary', () => {
    const { report, lifecycleSummary } = RiskController.evaluateClosePosition({
      remaining: 0,
      hasOpenTRound: false,
    });
    expect(report.blocked).toBe(false);
    expect(lifecycleSummary).toBeUndefined();
  });
});