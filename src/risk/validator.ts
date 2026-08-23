/**
 * @file validator.ts
 * @description 全局风控校验引擎（纯函数，可单测）：聚合多条校验规则，逐条执行并返回报告。
 *              规则分为 error（阻止操作）与 warning（允许通过但告警）两级。
 *              所有规则为纯函数，不依赖外部状态。
 * @layer Risk
 * @storage_impact 纯函数，不读写任何存储。
 * @author 开发团队
 */

import type {
  RiskCheckResult,
  RiskSeverity,
  RiskValidationContext,
  RiskValidationReport,
} from './types';

// ============================================================
// 规则定义
// ============================================================

/** 一条校验规则 */
export interface RiskRule<T = unknown> {
  name: string;
  severity: 'error' | 'warning';
  validate: (data: T, ctx: RiskValidationContext) => RiskCheckResult | null;
}

// ============================================================
// 内置规则工厂
// ============================================================

/**
 * R1: 数量合理性 —— 数量必须为正整数、不超过市场常识上限、为 100 的整数倍（A 股规则）。
 */
export function amountSanityRule(
  amount: number,
  label: string = '数量',
): RiskRule {
  return {
    name: 'amount_sanity',
    severity: 'error',
    validate: () => {
      if (!Number.isFinite(amount) || amount <= 0) {
        return {
          ruleName: 'amount_sanity',
          severity: 'error',
          passed: false,
          message: `${label}(${amount}) 必须为正数`,
        };
      }
      if (amount > 1_000_000) {
        return {
          ruleName: 'amount_sanity',
          severity: 'warning',
          passed: false,
          message: `${label}(${amount}) 超过 100 万股，请确认`,
          suggestion: '确认数量无误后可继续',
        };
      }
      // A 股买入须为 100 股整数倍；卖出无此限制，此处仅做 info 提示
      if (amount % 100 !== 0) {
        return {
          ruleName: 'amount_sanity',
          severity: 'info',
          passed: true,
          message: `${label}(${amount}) 不是 100 的整数倍`,
        };
      }
      return null;
    },
  };
}

/**
 * R2: 价格偏离 —— 交易价格偏离市价超过 ±20% 时预警。
 */
export function priceDeviationRule(
  price: number,
  fullCode: string,
  label: string = '价格',
): RiskRule {
  return {
    name: 'price_deviation',
    severity: 'warning',
    validate: (_data, ctx) => {
      const marketPrice = ctx.getMarketPrice?.(fullCode);
      if (!marketPrice || marketPrice <= 0) return null; // 无市价时不校验
      const deviation = (price - marketPrice) / marketPrice;
      if (Math.abs(deviation) > 0.2) {
        return {
          ruleName: 'price_deviation',
          severity: 'warning',
          passed: false,
          message: `${label}(${price}) 偏离市价(${marketPrice}) ${(deviation * 100).toFixed(1)}%，请确认`,
          suggestion: deviation > 0 ? '建议调低买入价' : '建议调高卖出价',
        };
      }
      if (Math.abs(deviation) > 0.5) {
        return {
          ruleName: 'price_deviation',
          severity: 'error',
          passed: false,
          message: `${label}(${price}) 偏离市价(${marketPrice}) 超过 ±50%，操作已阻止`,
          suggestion: '请核实价格后重试',
        };
      }
      return null;
    },
  };
}

/**
 * R3: 导入数据完整性 —— 校验导入 JSON 的结构完整性。
 */
export function importDataIntegrityRule(data: {
  version?: number;
  feeConfig?: unknown;
  positions?: unknown[];
  tRounds?: unknown[];
}): RiskRule {
  return {
    name: 'import_data_integrity',
    severity: 'error',
    validate: () => {
      if (!data || typeof data !== 'object') {
        return {
          ruleName: 'import_data_integrity',
          severity: 'error',
          passed: false,
          message: '导入数据为空或格式无效',
        };
      }
      if (typeof data.version !== 'number') {
        return {
          ruleName: 'import_data_integrity',
          severity: 'error',
          passed: false,
          message: '导入数据缺少版本号 (version)',
        };
      }
      return null;
    },
  };
}

/**
 * R4: 持仓一致性 —— 批次履历重算结果 vs 快照字段偏差检查（阈值 0.02 元/股）。
 */
export function positionConsistencyRule(
  recalculatedCost: number,
  storedCost: number,
  recalculatedAmount: number,
  storedAmount: number,
): RiskRule {
  return {
    name: 'position_consistency',
    severity: 'warning',
    validate: () => {
      if (Math.abs(recalculatedCost - storedCost) > 0.02 && storedAmount > 0) {
        return {
          ruleName: 'position_consistency',
          severity: 'warning',
          passed: false,
          message: `持仓成本偏差 ${(recalculatedCost - storedCost).toFixed(4)} 元，批次履历(${recalculatedCost.toFixed(4)}) ≠ 快照(${storedCost.toFixed(4)})`,
          suggestion: '建议执行数据一致性修复',
        };
      }
      if (recalculatedAmount !== storedAmount) {
        return {
          ruleName: 'position_consistency',
          severity: 'warning',
          passed: false,
          message: `持仓数量偏差：批次履历 ${recalculatedAmount} 股 ≠ 快照 ${storedAmount} 股`,
          suggestion: '建议执行数据一致性修复',
        };
      }
      return null;
    },
  };
}

// ============================================================
// 校验引擎
// ============================================================

/**
 * 执行一组校验规则，返回聚合报告。
 *
 * @param rules 待执行的规则列表
 * @param data  规则校验数据
 * @param ctx   校验上下文
 * @returns     聚合校验报告
 */
export function validate<T>(
  rules: RiskRule<T>[],
  data: T,
  ctx: RiskValidationContext,
): RiskValidationReport {
  const checks: RiskCheckResult[] = [];

  for (const rule of rules) {
    try {
      const result = rule.validate(data, ctx);
      if (result) checks.push(result);
    } catch (err) {
      checks.push({
        ruleName: rule.name,
        severity: 'error',
        passed: false,
        message: `校验规则 "${rule.name}" 执行异常: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const blocked = checks.some((c) => !c.passed && c.severity === 'error');
  const ok = !blocked;

  // 构建摘要
  const parts: string[] = [];
  const errors = checks.filter((c) => !c.passed && c.severity === 'error');
  const warnings = checks.filter((c) => !c.passed && c.severity === 'warning');
  if (errors.length) parts.push(`${errors.length} 项错误`);
  if (warnings.length) parts.push(`${warnings.length} 项警告`);
  const summary = parts.length ? parts.join('，') : '全部通过';

  return { ok, blocked, checks, summary };
}