/**
 * @file shortTermTrial.ts
 * @description 短线试算引擎：严格按「短线/中长期强隔离」规则计算计划单的试算预览。
 *              不依赖任何中长期底仓数据，所有计算基于短期项目流水池的自身状态。
 * @layer Utils
 */

import { calcTradeFees, matchSecurityKind, roundTo } from './mathUtils';
import type { FeeConfig } from './mathUtils';
import type { SecurityKind } from './mathUtils';

/**
 * 用于短线试算匹配的一个短期项目（从 StockStreamResult 提取的字段子集）。
 */
export interface ShortTrialProject {
  fullCode: string;
  mode: 'long' | 'short';
  status: string;
  /** 剩余待处理持仓量（正T=未平仓买入量，倒T=未回补卖出量） */
  pendingAmount: number;
  /** 加权均价 P_avg（正T=加权买入成本，倒T=移动加权成本） */
  avgCost: number;
  realizedPnL: number;
  openedAt?: string;
}

/**
 * 分支：匹配到短期项目 + 计划方向为买入 → 试算追加买入后的新加权成本
 */
export interface ShortTrialBuyMatched {
  kind: 'matched-buy';
  project: ShortTrialProject;
  /** 追加后的新加权均价 */
  newAvgCost: number;
  /** 追加后的总持仓量 */
  newAmount: number;
  /** 本次买入预估规费 */
  addedFee: number;
}

/**
 * 分支：匹配到短期项目 + 计划方向为卖出 → 试算对冲差价与净收益
 */
export interface ShortTrialSellMatched {
  kind: 'matched-sell';
  project: ShortTrialProject;
  /** 短期项目的加权均价 P_avg */
  avgCost: number;
  /** 本次对冲数量（取计划卖出量与项目待平仓量的较小值） */
  hedgeAmount: number;
  /** 净收益：(计划价 - P_avg) × 对冲量 - 预估规费 */
  netIncome: number;
  /** 卖出预估规费 */
  fee: number;
  /** 差价百分比 relative to P_avg */
  spreadPct: number;
}

/**
 * 分支：无短期项目 + 计划方向为买入 → 以计划价&量作为初始成本基准
 */
export interface ShortTrialNewProjectBuy {
  kind: 'new-project-buy';
  /** 初始成本基准（即计划价） */
  initCost: number;
  /** 初始持仓量 */
  initAmount: number;
  /** 买入预估规费 */
  fee: number;
}

/**
 * 分支：无短期项目 + 计划方向为卖出 → 阻断试算，仅输出警告
 */
export interface ShortTrialBlockedSell {
  kind: 'blocked-sell';
  reason: 'no-short-project';
  message: string;
}

export type ShortTrialResult =
  | ShortTrialBuyMatched
  | ShortTrialSellMatched
  | ShortTrialNewProjectBuy
  | ShortTrialBlockedSell;

/**
 * 从活跃短期项目池中按 fullCode 匹配最新项目（按 openedAt 倒序，取最新）。
 * 仅匹配 status !== 'CLEARED' 的进行中项目。
 */
export function findLatestShortProject(
  fullCode: string,
  projects: ShortTrialProject[],
): ShortTrialProject | null {
  const matched = projects.filter(
    (p) => p.fullCode === fullCode && p.status !== 'CLEARED',
  );
  if (matched.length === 0) return null;
  matched.sort((a, b) => {
    const ta = a.openedAt ? new Date(a.openedAt).getTime() : 0;
    const tb = b.openedAt ? new Date(b.openedAt).getTime() : 0;
    return tb - ta;
  });
  return matched[0];
}

/**
 * 将 StockStreamResult 转换为 ShortTrialProject（提取试算所需字段）。
 */
export function toShortTrialProject(
  sr: { fullCode: string; mode: string; status: string; netPendingAmount: number; weightedBuyCost: number; avgPrice: number; realizedPnL: number; openedAt?: string },
): ShortTrialProject {
  return {
    fullCode: sr.fullCode,
    mode: sr.mode as 'long' | 'short',
    status: sr.status,
    pendingAmount: Math.max(0, sr.netPendingAmount),
    // 试算统一使用加权买入均价（正T）或移动加权成本（倒T）
    avgCost: sr.weightedBuyCost > 0 ? sr.weightedBuyCost : sr.avgPrice,
    realizedPnL: sr.realizedPnL,
    openedAt: sr.openedAt,
  };
}

/**
 * 短线试算引擎：严格按分支逻辑计算，绝不读取中长期底仓。
 *
 * 分支规则：
 * 1. 存在短期项目 + 计划买入 → 基于当前均价与持仓试算追加买入后的新加权成本。
 * 2. 存在短期项目 + 计划卖出 → 基于短期项目的加权均价做对冲差价试算。
 * 3. 无短期项目 + 计划买入 → 允许试算，标记「新建短期项目」，以计划价与量作为初始成本基准。
 * 4. 无短期项目 + 计划卖出 → 阻断试算，输出警告提示借用底仓，不计算收益/规费。
 *
 * @param direction 计划方向
 * @param planPrice 计划价
 * @param planAmount 计划数量
 * @param fullCode 股票完整代码（用于费率计算）
 * @param stockName 股票名称（用于费率计算）
 * @param project 匹配到的短期项目（null 表示无匹配）
 * @param feeConfig 费率配置（可缺省，缺省时不计算规费）
 * @returns 试算结果
 */
export function computeShortTermTrial(
  direction: 'buy' | 'sell',
  planPrice: number,
  planAmount: number,
  fullCode: string,
  stockName: string,
  project: ShortTrialProject | null,
  feeConfig?: FeeConfig | null,
): ShortTrialResult {
  const code = fullCode.replace(/^(sh|sz|bj)/, '');
  const kind: SecurityKind = matchSecurityKind(stockName || fullCode, code);

  if (project) {
    // ── 分支 1/2：存在短期项目 ──
    if (direction === 'buy') {
      // 1. 基于当前均价与持仓，试算追加买入后的新加权成本
      const currentAvg = project.avgCost;
      const currentQty = Math.max(0, project.pendingAmount);
      const fee = feeConfig
        ? calcTradeFees(planPrice, planAmount, 'buy', feeConfig, kind).total
        : 0;
      const newTotalCost = currentAvg * currentQty + planPrice * planAmount + fee;
      const newAmount = currentQty + planAmount;
      const newAvgCost = newAmount > 0 ? newTotalCost / newAmount : planPrice;
      return {
        kind: 'matched-buy',
        project,
        newAvgCost: roundTo(newAvgCost, 3),
        newAmount,
        addedFee: roundTo(fee, 2),
      };
    } else {
      // 2. 基于短期项目的加权均价做对冲差价试算
      const avgCost = project.avgCost; // P_avg
      const available = Math.max(0, project.pendingAmount);
      const hedgeAmount = Math.min(planAmount, available);
      const fee = feeConfig
        ? calcTradeFees(planPrice, hedgeAmount, 'sell', feeConfig, kind).total
        : 0;
      // 净收益 = (计划卖出价 - 加权均价) × 对冲数量 - 规费
      const netIncome = (planPrice - avgCost) * hedgeAmount - fee;
      const spreadPct = avgCost > 0 ? ((planPrice - avgCost) / avgCost) * 100 : 0;
      return {
        kind: 'matched-sell',
        project,
        avgCost,
        hedgeAmount,
        netIncome: roundTo(netIncome, 2),
        fee: roundTo(fee, 2),
        spreadPct: roundTo(spreadPct, 2),
      };
    }
  } else {
    // ── 分支 3/4：无短期项目 ──
    if (direction === 'buy') {
      // 3. 标记新建短期项目，以计划价与量作为初始成本基准
      const fee = feeConfig
        ? calcTradeFees(planPrice, planAmount, 'buy', feeConfig, kind).total
        : 0;
      return {
        kind: 'new-project-buy',
        initCost: planPrice,
        initAmount: planAmount,
        fee: roundTo(fee, 2),
      };
    } else {
      // 4. 阻断试算，输出警告
      return {
        kind: 'blocked-sell',
        reason: 'no-short-project',
        message:
          '⚠️ 当前无进行中的短期项目，此卖出需借用底仓（倒T首笔），暂不进行做T收益试算',
      };
    }
  }
}