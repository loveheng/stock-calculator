/**
 * @file metricsEngine.ts
 * @description 沙盘推演指标引擎（纯函数）：在引擎输出（快照/结果）之上计算
 *              风险与基准类指标：
 *              - 最大回撤（市值曲线含浮盈回吐）
 *              - 持仓波动率（日收益标准差）
 *              - Buy & Hold 基准（首笔金额首笔价买入 → 持有到评估日清算，同一量纲）
 *              - 四维对比表（收益表现 / 风险控制 / 持仓基准 / 交易成本，每维标注最优方案）
 * @layer Logic
 * @storage_impact 纯函数，不读写任何存储。
 * @author 开发团队
 */

import type { ComparisonRow, KlineItem, SandboxOrder, SandboxResult, SandboxSnapshot } from '../types/sandbox';

/** 四舍五入到分 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 计算最大回撤（%）：遍历市值曲线相对历史峰值的最大跌幅，取绝对值（正数表示跌幅）。
 *
 * @param {SandboxSnapshot[]} snapshots - 时间线快照（含 totalAsset）
 * @returns {number} 最大回撤百分比（0 表示无回撤）
 */
export function computeMaxDrawdown(snapshots: SandboxSnapshot[]): number {
  if (snapshots.length === 0) return 0;
  let peak = -Infinity;
  let maxDd = 0;
  for (const s of snapshots) {
    if (s.totalAsset > peak) peak = s.totalAsset;
    if (peak > 0) {
      const dd = (s.totalAsset - peak) / peak;
      if (dd < maxDd) maxDd = dd;
    }
  }
  return round2(Math.abs(maxDd) * 100);
}

/**
 * 计算持仓波动率（日收益标准差，%）：基于总资产曲线的对数/简单日收益。
 *
 * @param {SandboxSnapshot[]} snapshots - 时间线快照
 * @returns {number} 日收益标准差（百分比）
 */
export function computeVolatility(snapshots: SandboxSnapshot[]): number {
  if (snapshots.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].totalAsset;
    if (prev > 0) returns.push(snapshots[i].totalAsset / prev - 1);
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / returns.length;
  return round2(Math.sqrt(variance) * 100);
}

/**
 * 计算 Buy & Hold 基准：取第一笔买入的成交额，以该笔价格一次性买入（100 股取整），
 * 剩余零钱留现金，持有到评估日按收盘价清算。
 *
 * @param {SandboxOrder[]} orders - 订单时间线
 * @param {KlineItem[]} kline - 前复权日 K 线
 * @param {string} asOfDate - 评估日（YYYY-MM-DD）
 * @returns {{ finalProfit: number; returnRate: number; maxDrawdown: number }} B&H 三指标
 */
export function computeBuyAndHold(
  orders: SandboxOrder[],
  kline: KlineItem[],
  asOfDate: string,
): { finalProfit: number; returnRate: number; maxDrawdown: number } {
  const firstBuy = [...orders].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).find((o) => o.action === 'buy');
  if (!firstBuy || kline.length === 0) {
    return { finalProfit: 0, returnRate: 0, maxDrawdown: 0 };
  }

  const price = firstBuy.price;
  const invested = price * firstBuy.quantity; // 首笔金额（不含规费，简化口径）
  const shares = Math.floor(invested / price / 100) * 100;
  if (shares <= 0) return { finalProfit: 0, returnRate: 0, maxDrawdown: 0 };
  const leftover = invested - shares * price;

  // 持有期起点 = 首笔买入所在 K 线
  const startIdx = kline.findIndex((k) => k.date >= firstBuy.timestamp.slice(0, 10));
  const fromIdx = startIdx >= 0 ? startIdx : 0;
  const asOfIdx = kline.findIndex((k) => k.date > asOfDate);
  const endIdx = asOfIdx >= 0 ? asOfIdx - 1 : kline.length - 1;

  let peak = -Infinity;
  let maxDd = 0;
  let finalAsset = invested;
  for (let i = fromIdx; i <= endIdx; i++) {
    finalAsset = shares * kline[i].close + leftover;
    if (finalAsset > peak) peak = finalAsset;
    if (peak > 0 && finalAsset < peak) {
      const dd = (finalAsset - peak) / peak;
      if (dd < maxDd) maxDd = dd;
    }
  }

  const finalProfit = round2(finalAsset - invested);
  return {
    finalProfit,
    returnRate: round2((finalProfit / invested) * 100),
    maxDrawdown: round2(Math.abs(maxDd) * 100),
  };
}

/**
 * 在引擎结果上补齐派生指标（volatility + buyAndHold）。
 *
 * @param {SandboxResult} result - 引擎结果（volatility 与 buyAndHold 为占位 0）
 * @param {SandboxOrder[]} orders - 订单时间线
 * @param {KlineItem[]} kline - K 线
 * @returns {SandboxResult} 补齐后的结果（原地修改并返回）
 */
export function enrichResult(result: SandboxResult, orders: SandboxOrder[], kline: KlineItem[]): SandboxResult {
  result.volatility = computeVolatility(result.snapshots);
  result.buyAndHold = computeBuyAndHold(orders, kline, result.asOfDate);
  return result;
}

/** 对比分支输入（分支 id → 名称 + 结果） */
export interface ComparisonBranchInput {
  id: string;
  name: string;
  result: SandboxResult;
}

/** 对比行构造配置 */
interface RowDef {
  key: string;
  metric: string;
  direction: 'higher' | 'lower';
  extract: (r: SandboxResult) => number;
}

/** 四维对比表的行定义（收益 / 风险 / 基准 / 成本） */
const ROW_DEFS: RowDef[] = [
  { key: 'finalProfit', metric: '最终收益额', direction: 'higher', extract: (r) => r.finalProfit },
  { key: 'returnRate', metric: '累计收益率', direction: 'higher', extract: (r) => r.returnRate },
  { key: 'maxDrawdown', metric: '最大回撤', direction: 'lower', extract: (r) => r.maxDrawdown },
  { key: 'volatility', metric: '持仓波动率', direction: 'lower', extract: (r) => r.volatility },
  { key: 'excessReturn', metric: '跑赢死拿不动（超额收益）', direction: 'higher', extract: (r) => round2(r.returnRate - r.buyAndHold.returnRate) },
  { key: 'totalFees', metric: '累计手续费损耗', direction: 'lower', extract: (r) => r.totalFees },
  { key: 'capitalOccupationDays', metric: '资金占用周期', direction: 'lower', extract: (r) => r.capitalOccupationDays },
];

/**
 * 构建四维对比表。
 *
 * @param {ComparisonBranchInput[]} branches - 参与对比的分支（≥2 个）
 * @returns {ComparisonRow[]} 对比行数组，每行标注该维最优分支
 */
export function buildComparisonRows(branches: ComparisonBranchInput[]): ComparisonRow[] {
  if (branches.length === 0) return [];

  return ROW_DEFS.map((def) => {
    const values: Record<string, number> = {};
    let bestId: string | null = null;
    let bestValue = 0;

    for (const branch of branches) {
      const v = def.extract(branch.result);
      values[branch.id] = v;
      if (bestId === null) {
        bestId = branch.id;
        bestValue = v;
      } else if (def.direction === 'higher' ? v > bestValue : v < bestValue) {
        bestId = branch.id;
        bestValue = v;
      }
    }

    return {
      metric: def.metric,
      key: def.key,
      values,
      bestBranchId: bestId,
      direction: def.direction,
    };
  });
}
