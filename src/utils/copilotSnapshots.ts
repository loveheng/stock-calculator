/**
 * @file copilotSnapshots.ts
 * @description Copilot 页面快照纯引擎：试点页（statistics/home）白名单 builder 一次产出、
 *              两路分发（D28）——标量概览（落库 contextOverview）+ ephemeral 明细
 *              （contextSummary.data，经 applySizeGuard ≤12KB 护栏）。
 *              铁律：显式入参 store 切片（R2 纯函数，不依赖 store 状态机），
 *              与视图同源纯引擎重算（tStreamEngine 撮合管线），禁读组件闭包/DOM。
 * @layer Utility
 * @storage_impact 纯计算，不读写任何存储。
 * @author 开发团队
 */

import type {
  CopilotContextData,
  PlannedOrder,
  Position,
  TRoundArchive,
} from '../types/domain';
import {
  activeStreamsFromRounds,
  buildBasePositionCosts,
  processAllStreams,
} from './tStreamEngine';
import type { FeeConfig } from './mathUtils';

/** builder 显式入参（AppStore 结构子集，由调用方传 useAppStore.getState()） */
export interface CopilotSnapshotSource {
  tRounds: TRoundArchive[];
  positions: Position[];
  plannedOrders: PlannedOrder[];
  feeConfig: FeeConfig;
}

/** 体积护栏默认上限：ephemeral 明细 JSON 序列化字节数（D5④/D28） */
export const COPILOT_MAX_BYTES = 12_000;

/** 当前时刻（epoch 秒） */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** JSON 字符串的 UTF-8 字节数（护栏口径，无需逐字节精确到业务字段） */
function byteLength(json: string): number {
  return new TextEncoder().encode(json).length;
}

/** 数组是否可用（length > 0 的数组字段） */
function isNonEmptyArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0;
}

/**
 * 体积护栏（D5④/D28）：ephemeral 明细序列化超限时的确定性裁剪。
 * ① 逐数组裁尾：每次将最长数组砍半，直到达标或数组全空；
 * ② 数组全空仍超限 → 丢弃对象类字段，仅保留标量（string/number/boolean）。
 * 纯函数：不修改入参，返回裁剪副本 + truncated 标记（contextSummary 组装输入）。
 */
export function applySizeGuard(
  snapshot: CopilotContextData,
  maxBytes: number = COPILOT_MAX_BYTES,
): {
  data: Record<string, unknown>;
  _units: Record<string, string>;
  capturedAt: number;
  truncated: boolean;
} {
  const data: Record<string, unknown> = { ...snapshot.detail };
  const units = { ...snapshot.units };
  const capturedAt = snapshot.timeAnchor.asOf;
  const size = () => byteLength(JSON.stringify({ data, _units: units }));
  let truncated = false;

  if (size() <= maxBytes) return { data, _units: units, capturedAt, truncated };
  truncated = true;

  // ① 逐数组裁尾（对数砍半，迭代次数 O(log n)）
  for (;;) {
    const keys = Object.keys(data).filter((k) => isNonEmptyArray(data[k]));
    if (keys.length === 0 || size() <= maxBytes) break;
    let longest = keys[0];
    for (const k of keys) {
      if ((data[k] as unknown[]).length > (data[longest] as unknown[]).length) longest = k;
    }
    const arr = data[longest] as unknown[];
    const keep = Math.floor(arr.length / 2);
    data[longest] = keep > 0 ? arr.slice(0, keep) : [];
  }

  // ② 数组全空仍超限 → 丢弃对象/数组字段，仅保留标量
  if (size() > maxBytes) {
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (v !== null && typeof v === 'object') delete data[k];
      if (size() <= maxBytes) break;
    }
  }
  return { data, _units: units, capturedAt, truncated };
}

// ──────────────────────────────────────────────
// 试点页 builder（P0：statistics + home）
// ──────────────────────────────────────────────

/**
 * 数据统计页快照（P0 试点）：与 Statistics 视图同源——
 * 已归档轮直接取 tRounds（COMPLETED）标量；进行中轮经 tStreamEngine
 * 撮合管线重算（buildBasePositionCosts → activeStreamsFromRounds → processAllStreams）。
 */
export function buildStatisticsContext(src: CopilotSnapshotSource): CopilotContextData {
  const completed = src.tRounds.filter((r) => (r.status ?? 'OPENED') === 'COMPLETED');
  const closedCount = completed.length;
  const winCount = completed.filter((r) => r.win).length;
  const totalNetProfit = completed.reduce((sum, r) => sum + r.netProfit, 0);
  const totalFees = completed.reduce((sum, r) => sum + (r.fees ?? r.totalFees ?? 0), 0);
  const winRate = closedCount > 0 ? winCount / closedCount : 0;
  const avgNetPerRound = closedCount > 0 ? totalNetProfit / closedCount : 0;
  const activeRoundCount = src.tRounds.length - closedCount;

  // 进行中轮次撮合结果（与 useStreamResults 同一纯函数管线，store + 引擎重算）
  const baseCosts = buildBasePositionCosts(src.positions);
  const activeStreams = activeStreamsFromRounds(src.tRounds);
  const streams = processAllStreams(activeStreams, src.feeConfig, baseCosts);
  const pending = streams.filter((s) => s.status !== 'CLEARED');
  const pendingRealizedPnl = pending.reduce((sum, s) => sum + s.realizedPnL, 0);

  return {
    overview: {
      roundCount: closedCount + activeRoundCount,
      completedRoundCount: closedCount,
      activeRoundCount,
      winRate: Number(winRate.toFixed(4)),
      totalNetProfit: Number(totalNetProfit.toFixed(2)),
      avgNetPerRound: Number(avgNetPerRound.toFixed(2)),
      pendingRealizedPnl: Number(pendingRealizedPnl.toFixed(2)),
      totalFees: Number(totalFees.toFixed(2)),
    },
    timeAnchor: { asOf: nowSec(), range: 'all' },
    units: {
      totalNetProfit: '元(CNY)',
      avgNetPerRound: '元(CNY)',
      pendingRealizedPnl: '元(CNY)',
      totalFees: '元(CNY)',
      winRate: '0-1小数比例(0.62=62%)',
      roundCount: '轮',
      price: '元/股',
    },
    detail: {
      recentCompletedRounds: completed
        .slice()
        .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
        .slice(0, 10)
        .map((r) => ({
          stockName: r.stockName,
          mode: r.mode,
          netProfit: Number(r.netProfit.toFixed(2)),
          win: r.win ?? false,
          closedAt: r.closedAt ?? '',
        })),
      activePositions: pending.slice(0, 10).map((s) => ({
        stockName: s.stockName,
        status: s.status,
        netPendingAmount: s.netPendingAmount,
        weightedBuyCost: s.weightedBuyCost,
        realizedPnL: Number(s.realizedPnL.toFixed(2)),
      })),
    },
  };
}

/**
 * 首页仪表盘快照（P0 试点）：持仓/计划单标量概览 + 明细。
 * 市值为成本口径（数量×成本价），非实时行情口径——units 中显式声明防 AI 误读。
 */
export function buildHomeContext(src: CopilotSnapshotSource): CopilotContextData {
  const open = src.positions.filter((p) => !p.isClosed);
  const closed = src.positions.filter((p) => p.isClosed);
  const totalMarketValue = open.reduce((sum, p) => sum + p.currentAmount * p.currentCost, 0);
  const totalRealizedPnL = src.positions.reduce((sum, p) => sum + (p.realizedPnL ?? 0), 0);
  const activePlans = src.plannedOrders.filter((p) => p.status === 'active');

  return {
    overview: {
      positionCount: src.positions.length,
      openPositionCount: open.length,
      closedPositionCount: closed.length,
      totalMarketValue: Number(totalMarketValue.toFixed(2)),
      totalRealizedPnL: Number(totalRealizedPnL.toFixed(2)),
      activePlanCount: activePlans.length,
    },
    timeAnchor: { asOf: nowSec(), range: 'now' },
    units: {
      totalMarketValue: '元(CNY,成本口径=数量×成本价,非实时行情)',
      totalRealizedPnL: '元(CNY)',
      currentCost: '元/股(含规费加权)',
      plannedPrice: '元/股',
    },
    detail: {
      openPositions: open.slice(0, 10).map((p) => ({
        stockName: p.stockName,
        fullCode: p.fullCode,
        currentCost: p.currentCost,
        currentAmount: p.currentAmount,
        marketValue: Number((p.currentAmount * p.currentCost).toFixed(2)),
        realizedPnL: Number((p.realizedPnL ?? 0).toFixed(2)),
      })),
      activePlans: activePlans.slice(0, 10).map((o) => ({
        stockName: o.stockName,
        direction: o.direction,
        plannedPrice: o.plannedPrice,
        plannedAmount: o.plannedAmount,
        expiresAt: o.expiresAt,
      })),
    },
  };
}
