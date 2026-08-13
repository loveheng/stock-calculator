/**
 * @file validation.ts
 * @description 交易流水表单校验：两级阶梯式卖出持仓校验。
 *              级别 1 → 做 T 池待处理数量（pendingBuyAmount）
 *              级别 2 → 中长期底仓数量（basePositionAmount）
 * @layer Utility
 */

import { type StockStreamResult } from './tStreamEngine';
import type { Position } from '../store/types';

export interface SellValidationResult {
  valid: boolean;
  maxSellable: number;
  error?: string;
  /** 借仓对冲提示（仅在需要占用底仓时设置） */
  warning?: string;
  /** 是否需要占用底仓（sellAmount > pendingBuyAmount 时） */
  needsBasePosition?: boolean;
  /** 需要占用的底仓数量 */
  neededBaseAmount?: number;
}

/**
 * 两级阶梯式卖出校验：
 *
 * 1. **第一级：做T池持仓** — 检查 `pendingBuyAmount`（已买入未对冲的待处理数量）
 *    - 若 `sellAmount <= pendingBuyAmount` → 纯做T内平仓，校验通过
 *
 * 2. **第二级：中长期底仓** — 若做T池不够，检查 `basePositionAmount`
 *    - 若 `neededBase <= basePositionAmount` → 需借仓对冲，校验通过 + 提示
 *    - 若 `neededBase > basePositionAmount` → 总数不足，校验失败
 *
 * @param sellAmount       用户输入的卖出数量
 * @param pendingBuyAmount 做T池中已买入未对冲的待处理数量（netPendingAmount）
 * @param basePositionAmount 中长期底仓可用数量
 * @returns 校验结果
 */
export function validateSellOrder(
  sellAmount: number,
  pendingBuyAmount: number,
  basePositionAmount: number,
): SellValidationResult {
  if (sellAmount <= 0) {
    return {
      valid: false,
      maxSellable: 0,
      error: '请输入有效的卖出数量',
    };
  }

  const totalAvailable = pendingBuyAmount + basePositionAmount;

  // 第一级校验：纯做T内平仓（无需占用底仓）
  if (sellAmount <= pendingBuyAmount) {
    return {
      valid: true,
      maxSellable: totalAvailable,
    };
  }

  // 第二级校验：需要借仓对冲
  const neededBase = sellAmount - pendingBuyAmount;

  if (neededBase <= basePositionAmount) {
    return {
      valid: true,
      maxSellable: totalAvailable,
      warning: `本次卖出将占用底仓 ${neededBase} 股进行借仓对冲`,
      needsBasePosition: true,
      neededBaseAmount: neededBase,
    };
  }

  // 总数不足，校验失败
  return {
    valid: false,
    maxSellable: totalAvailable,
    error: `❌ 卖出失败：做T池可用 ${pendingBuyAmount} 股，中长期底仓可用 ${basePositionAmount} 股，合计 ${totalAvailable} 股，不满足卖出需求 ${sellAmount} 股`,
    needsBasePosition: true,
    neededBaseAmount: neededBase,
  };
}

/**
 * 从 StockStreamResult 和 Position 中提取参数，调用二级校验。
 *
 * @param streamResult 做T引擎结果（含 netPendingAmount）
 * @param basePosition 该股票的中长期底仓（可能为 undefined）
 * @param sellAmount 用户输入的卖出数量
 */
export function validateSellWithStreamResult(
  streamResult: StockStreamResult | null,
  basePosition: Position | undefined,
  sellAmount: number,
): SellValidationResult {
  // 倒T（short）模式下 netPendingAmount = buyAmount - sellAmount 可能为负值，
  // 此时 pendingBuyAmount 应视作 0（没有已买入未对冲的持仓），
  // 否则 totalAvailable = pendingBuyAmount + basePositionAmount 会低估可卖数量。
  const pendingBuyAmount = Math.max(0, streamResult?.netPendingAmount ?? 0);
  const basePositionAmount = basePosition?.currentAmount ?? 0;
  return validateSellOrder(sellAmount, pendingBuyAmount, basePositionAmount);
}