/**
 * @file riskController.ts
 * @description 全局风控门面：场景化的统一评估入口，内部自动串联校验规则 + 异步审计日志。
 *              所有 Store Action 和 View 调用只需一行代码，不再散落风控逻辑。
 * @layer Risk
 * @storage_impact 纯函数校验 + 异步审计（非阻塞），不直接读写 IndexedDB。
 * @author 开发团队
 */

import { recordAudit } from './auditLogger';
import { getMarketPrice } from './priceCache';
import type {
  RiskValidationContext,
  RiskValidationReport,
  TTradeEvalInput,
  BatchEvalInput,
  ClosePositionEvalInput,
  PlanEvalInput,
  BorrowInfo,
  RiskEvalResult,
  SellValidationResult,
} from './types';
import {
  validate,
  amountSanityRule,
  priceDeviationRule,
  tBorrowRule,
  positionLimitRule,
  closeBlockRule,
  dynamicPyramidRule,
  type RiskRule,
} from './validator';
import { evaluateDynamicPyramid, computePositionLifecycleSummary } from '../utils/mathUtils';
import type { DynamicPyramidResult, PositionLifecycleSummary } from './types';

/**
 * 全局风控控制门面。
 *
 * 用法：
 * ```ts
 * const { report, borrowInfo } = RiskController.evaluateTTrade({ sellAmount, pendingBuyAmount, availableForT, price, fullCode, direction: 'sell' });
 * if (report.blocked) { /* 拦截 *\/ }
 * ```
 */
export class RiskController {
  /**
   * 做T交易评估：串联数量合理性 + 价格偏离 + 两级阶梯借仓校验 + 自动审计。
   * 适用于 TCalculator 主表单 / 底部面板的卖出前置校验。
   */
  static evaluateTTrade(input: TTradeEvalInput): RiskEvalResult {
    const { sellAmount, pendingBuyAmount, availableForT, price, fullCode, direction } = input;
    const ctx: RiskValidationContext = { now: new Date().toISOString(), getMarketPrice };

    // 计算借仓元数据（仅卖出方向有意义）
    const neededBase = Math.max(0, sellAmount - pendingBuyAmount);
    const borrowInfo: BorrowInfo | undefined =
      direction === 'sell' && neededBase > 0 && neededBase <= availableForT ? { neededBase } : undefined;

    const rules: RiskRule[] = [
      amountSanityRule(sellAmount, direction === 'sell' ? '卖出数量' : '买入数量'),
      priceDeviationRule(price, fullCode, direction === 'sell' ? '卖出价格' : '买入价格'),
      tBorrowRule(sellAmount, pendingBuyAmount, availableForT),
    ];

    const report = validate(rules, input, ctx);

    // 异步审计：记录拦截或警告
    if (report.blocked) {
      const firstError = report.checks.find((c) => !c.passed && c.severity === 'error');
      recordAudit('add_stream_record', 'round', fullCode, 'rejected', {
        reason: firstError?.message ?? report.summary,
        tags: { fullCode, direction },
      });
    } else if (borrowInfo) {
      recordAudit('add_stream_record', 'round', fullCode, 'success', {
        tags: { fullCode, direction, borrowType: 'needs_base' },
        after: { neededBase: borrowInfo.neededBase },
      });
    }

    return { report, borrowInfo };
  }

  /**
   * 批次操作评估：串联数量合理性 + 减仓防负持仓校验 + 动态金字塔健康度（加仓） + 自动审计。
   * 适用于 Store addBatch / 中长期加减仓的前置校验。
   */
  static evaluateBatch(input: BatchEvalInput): { report: RiskValidationReport; pyramidHealth?: DynamicPyramidResult } {
    const { amount, type, currentAmount, price, existingBatches, batchId } = input;
    const ctx: RiskValidationContext = { now: new Date().toISOString(), getMarketPrice };

    const rules: RiskRule[] = [
      amountSanityRule(amount, type === 'reduce' ? '减仓数量' : '加减数量'),
    ];
    if (type === 'reduce' && currentAmount !== undefined) {
      rules.push(positionLimitRule(amount, currentAmount));
    }

    // 加仓方向：动态金字塔健康度评估（软风控）
    let pyramidHealth: DynamicPyramidResult | undefined;
    if (type === 'add' && price !== undefined && price > 0 && existingBatches && existingBatches.length > 0) {
      pyramidHealth = evaluateDynamicPyramid(existingBatches, { price, amount });
      rules.push(dynamicPyramidRule(pyramidHealth));
    }

    const report = validate(rules, input, ctx);

    // 审计 target：优先使用真实批次 id，未提供时回退到时间戳生成值
    const targetId = batchId ?? 'batch-' + Date.now();

    // 异步审计：金字塔健康度警告留痕
    if (pyramidHealth && pyramidHealth.level === 'RISKY') {
      recordAudit('add_batch', 'batch', targetId, 'success', {
        tags: { type, pyramidScore: String(pyramidHealth.score), pyramidLevel: pyramidHealth.level },
        after: { pyramidDeviation: pyramidHealth.centerDeviation },
      });
    } else if (report.blocked) {
      const firstError = report.checks.find((c) => !c.passed && c.severity === 'error');
      recordAudit('add_batch', 'batch', targetId, 'rejected', {
        reason: firstError?.message ?? report.summary,
        tags: { type },
      });
    }

    return { report, pyramidHealth };
  }

  /**
   * 结仓资格评估：校验未卖出持仓 + 进行中的做T轮次 + 自动审计。
   * 适用于 CostAveraging 的结仓按钮前置校验。
   */
  static evaluateClosePosition(input: ClosePositionEvalInput): {
    report: RiskValidationReport;
    lifecycleSummary?: PositionLifecycleSummary;
  } {
    const { remaining, hasOpenTRound, batches, positionId } = input;
    const ctx: RiskValidationContext = { now: new Date().toISOString() };

    const rules: RiskRule[] = [closeBlockRule(remaining, hasOpenTRound)];
    const report = validate(rules, input, ctx);

    // 生命周期履历元数据（仅信息性，结仓硬拦截仍取决于 report.blocked）
    let lifecycleSummary: PositionLifecycleSummary | undefined;
    if (batches && batches.length > 0) {
      lifecycleSummary = computePositionLifecycleSummary(batches);
    }

    // 异步审计
    if (report.blocked) {
      const firstError = report.checks.find((c) => !c.passed && c.severity === 'error');
      recordAudit('close_position', 'position', positionId ?? 'unknown', 'rejected', {
        reason: firstError?.message ?? report.summary,
      });
    }

    return { report, lifecycleSummary };
  }

  /**
   * 计划单评估：串联数量合理性 + 价格偏离校验 + 动态金字塔健康度（加仓） + 自动审计。
   * 适用于计划单录入/执行前的风控前置检查。
   */
  static evaluatePlan(input: PlanEvalInput): { report: RiskValidationReport; pyramidHealth?: DynamicPyramidResult } {
    const { price, fullCode, amount, direction, existingBatches } = input;
    const ctx: RiskValidationContext = { now: new Date().toISOString(), getMarketPrice };

    const rules: RiskRule[] = [
      amountSanityRule(amount, '计划数量'),
      priceDeviationRule(price, fullCode, '计划价格'),
    ];

    // 加仓方向：动态金字塔健康度评估（软风控）
    let pyramidHealth: DynamicPyramidResult | undefined;
    if (direction === 'buy' && existingBatches && existingBatches.length > 0) {
      pyramidHealth = evaluateDynamicPyramid(existingBatches, { price, amount });
      rules.push(dynamicPyramidRule(pyramidHealth));
    }

    const report = validate(rules, input, ctx);

    // 异步审计：金字塔健康度警告留痕
    if (pyramidHealth && pyramidHealth.level === 'RISKY') {
      recordAudit('set_planned_order', 'system', fullCode, 'success', {
        tags: { fullCode, pyramidScore: String(pyramidHealth.score), pyramidLevel: pyramidHealth.level },
        after: { pyramidDeviation: pyramidHealth.centerDeviation },
      });
    } else if (report.blocked) {
      const firstError = report.checks.find((c) => !c.passed && c.severity === 'error');
      recordAudit('set_planned_order', 'system', fullCode, 'rejected', {
        reason: firstError?.message ?? report.summary,
        tags: { fullCode },
      });
    }

    return { report, pyramidHealth };
  }

  /**
   * 兼容方法：将 RiskController 评估结果转换为旧版 `SellValidationResult` 结构，
   * 供 TCalculator 等 UI 组件在过渡期使用。
   *
   * @deprecated 新 UI 组件应直接消费 `RiskEvalResult.report`。
   */
  static toSellValidationResult(
    result: RiskEvalResult,
    pendingBuyAmount: number,
    availableForT: number,
  ): SellValidationResult {
    const totalAvailable = pendingBuyAmount + availableForT;
    const firstError = result.report.checks.find((c) => !c.passed && c.severity === 'error');
    return {
      valid: result.report.ok,
      maxSellable: totalAvailable,
      error: firstError?.message ?? (result.report.blocked ? result.report.summary : undefined),
      warning: result.borrowInfo
        ? `本次卖出将占用底仓 ${result.borrowInfo.neededBase} 股进行借仓对冲`
        : undefined,
      needsBasePosition: !!result.borrowInfo,
      neededBaseAmount: result.borrowInfo?.neededBase,
    };
  }
}