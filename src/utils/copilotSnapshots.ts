/**
 * @file copilotSnapshots.ts
 * @description Copilot 页面快照纯引擎：试点页（statistics/home）与 V2 推广域卡片
 *              （t_calculator 短线项目 / cost_averaging 实盘账本，按标的 scope）
 *              白名单 builder 一次产出、两路分发（D28）——标量概览（落库 contextOverview）
 *              + ephemeral 明细（contextSummary.data，经 applySizeGuard ≤12KB 护栏）。
 *              铁律：显式入参 store 切片（R2 纯函数，不依赖 store 状态机），
 *              与视图同源纯引擎重算（tStreamEngine 撮合管线 / calculator 批次重建），
 *              禁读组件闭包/DOM。
 * @layer Utility
 * @storage_impact 纯计算，不读写任何存储。
 * @author 开发团队
 */

import type {
  CopilotContextData,
  HomeTimeRange,
  PlannedOrder,
  Position,
  PositionBatchEntity,
  TRoundArchive,
} from '../types/domain';
import {
  activeStreamsFromRounds,
  buildBasePositionCosts,
  calcHedgeBreakeven,
  processAllStreams,
} from './tStreamEngine';
import { recalculatePosition } from './calculator';
import type { FeeConfig } from './mathUtils';

/** builder 显式入参（AppStore 结构子集，由调用方传 useAppStore.getState()） */
export interface CopilotSnapshotSource {
  tRounds: TRoundArchive[];
  positions: Position[];
  plannedOrders: PlannedOrder[];
  feeConfig: FeeConfig;
  /** 首页时间 Tab（可选，区块级 builder 读取；缺省 '7d' 与视图初始 Tab 对齐） */
  homeTimeRange?: HomeTimeRange;
  /**
   * 行情价桥（可选，计划单区块用）：现价不在 store 态（useLiveQuotes 组件态，R2 禁读闭包），
   * 由视图层注入 risk/priceCache 的 getMarketPrice（视图 useEffect 已将轮询结果同步入缓存）。
   * 依赖注入保持本模块零 risk 导入；缺省/无行情时计划单快照降级省略偏离度字段。
   */
  getMarketPrice?: (fullCode: string) => number | undefined;
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
  // 有效计划单口径与视图完全对齐（Home.tsx 1g）：status='active' 且未过期。
  // status 字段可能滞后（过期但未标 expired），必须以时间实时判断
  const now = Date.now();
  const activePlans = src.plannedOrders.filter(
    (p) => p.status === 'active' && new Date(p.expiresAt).getTime() > now,
  );

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

/**
 * 首页 · 短线统计区块快照（V2 Click-to-Focus 试点，blockId=home:short_term）：
 * 与 Home.tsx 模块 1 逐条同口径 —— 流水池经 tStreamEngine 撮合管线重算
 * （buildBasePositionCosts → activeStreamsFromRounds → processAllStreams，
 * 与 useStreamResults 同一管线），时间 Tab 筛选口径对齐视图 1a/1d/1e/1f；
 * 完成轮次统计与倒T预警沿用视图口径（胜率 1b 全量、预警 1h 全量 active，不随 Tab 收窄）。
 * 筛选状态 homeTimeRange 来自 store（R2：getState() 同源读取，禁读组件闭包）。
 */
export function buildHomeShortTermContext(src: CopilotSnapshotSource): CopilotContextData {
  const timeRange: HomeTimeRange = src.homeTimeRange ?? '7d';
  const timeBoundary =
    timeRange === 'all'
      ? 0
      : Date.now() - (timeRange === '1d' ? 1 : timeRange === '7d' ? 7 : 30) * 86_400_000;

  // 与 useStreamResults 同一纯函数管线（store + 引擎重算，禁读视图 useMemo）
  const baseCosts = buildBasePositionCosts(src.positions);
  const streams = processAllStreams(activeStreamsFromRounds(src.tRounds), src.feeConfig, baseCosts);
  const allActive = streams.filter((s) => s.status !== 'CLEARED');

  // 视图 1a 口径：进行中以最后一条流水时间为准；'all' 全保留
  const filteredActive = allActive.filter((s) => {
    if (timeRange === 'all') return true;
    const lastEntry = s.entries[s.entries.length - 1];
    if (!lastEntry) return false;
    return new Date(lastEntry.timestamp).getTime() >= timeBoundary;
  });

  // 已完成战报（视图 1d/1e 按 closedAt 过滤；1b 统计与胜率用全量，不随 Tab 收窄）
  const completed = src.tRounds.filter((r) => (r.status ?? 'OPENED') === 'COMPLETED');
  const filteredCompleted =
    timeRange === 'all'
      ? completed
      : completed.filter((r) => (r.closedAt ? new Date(r.closedAt).getTime() : 0) >= timeBoundary);

  // 视图 1d：做T盈亏（正T/倒T拆分，进行中 transferProfit + 已完成 netProfit）
  let totalProfit = 0;
  let longProfit = 0;
  let shortProfit = 0;
  for (const s of filteredActive) {
    totalProfit += s.transferProfit;
    if (s.mode === 'long') longProfit += s.transferProfit;
    else shortProfit += s.transferProfit;
  }
  for (const r of filteredCompleted) {
    totalProfit += r.netProfit;
    if (r.mode === 'long') longProfit += r.netProfit;
    else shortProfit += r.netProfit;
  }

  // 视图 1b：完成轮次与胜率（全量口径，不随 Tab 收窄）
  const winCount = completed.filter((r) => r.win).length;
  const winRate = completed.length > 0 ? winCount / completed.length : 0;

  // 视图 1a：区间短线总金额（实际资金占用，排除流水重复计算）
  const pendingCapital = filteredActive.reduce(
    (sum, s) => sum + (s.mode === 'long' ? s.pendingTotalCost : s.shortPendingAmount * s.avgPrice),
    0,
  );

  // 视图 1c：区间摩擦成本（仅进行中流水）
  let totalFee = 0;
  let buyFee = 0;
  let sellFee = 0;
  for (const s of filteredActive) {
    totalFee += s.totalFee;
    for (const e of s.entries) {
      if (e.direction === 'buy') buyFee += e.fee;
      else sellFee += e.fee;
    }
  }

  // 视图 1e/1f：区间最大盈利/亏损单笔（合并进行中 + 已完成）
  const roundCandidates = [
    ...filteredActive.map((s) => ({ stockName: s.stockName, fullCode: s.fullCode, profit: s.transferProfit })),
    ...filteredCompleted.map((r) => ({ stockName: r.stockName, fullCode: r.fullCode, profit: r.netProfit })),
  ];
  const topProfit =
    roundCandidates.length > 0
      ? roundCandidates.reduce((best, c) => (c.profit > best.profit ? c : best))
      : null;
  const lossCandidates = roundCandidates.filter((c) => c.profit < 0);
  const topLoss =
    lossCandidates.length > 0
      ? lossCandidates.reduce((worst, c) => (c.profit < worst.profit ? c : worst))
      : null;

  // 视图 1h：倒T待回补风险预警（全量 active 口径，不随 Tab 收窄）
  const rebuyAlerts = allActive
    .filter((s) => s.mode === 'short' && s.shortPendingAmount > 0)
    .slice(0, 10)
    .map((s) => {
      const pos = src.positions.find((p) => p.fullCode === s.fullCode && !p.isClosed);
      const isBaseExhausted = !pos || pos.currentAmount === 0;
      return {
        stockName: s.stockName,
        fullCode: s.fullCode,
        pendingAmount: s.shortPendingAmount,
        isBaseExhausted,
        message: isBaseExhausted
          ? `倒T底仓出空，待低吸买回 ${s.shortPendingAmount} 股`
          : `倒T待回补 ${s.shortPendingAmount} 股`,
      };
    });

  // 区间内分标的盈亏归集（Top 10，供 AI 定位盈亏贡献来源）
  const profitByCode: Record<string, { stockName: string; totalProfit: number }> = {};
  const acc = (code: string, name: string, profit: number) => {
    if (!profitByCode[code]) profitByCode[code] = { stockName: name, totalProfit: 0 };
    profitByCode[code].totalProfit += profit;
  };
  for (const s of filteredActive) acc(s.fullCode, s.stockName, s.transferProfit);
  for (const r of filteredCompleted) acc(r.fullCode, r.stockName, r.netProfit);
  const perSymbolProfit = Object.entries(profitByCode)
    .map(([fullCode, v]) => ({ fullCode, stockName: v.stockName, totalProfit: Number(v.totalProfit.toFixed(2)) }))
    .sort((a, b) => b.totalProfit - a.totalProfit)
    .slice(0, 10);

  return {
    overview: {
      timeRange,
      totalProfit: Number(totalProfit.toFixed(2)),
      longProfit: Number(longProfit.toFixed(2)),
      shortProfit: Number(shortProfit.toFixed(2)),
      activeCount: filteredActive.length,
      completedRounds: completed.length,
      winRounds: winCount,
      winRate: Number(winRate.toFixed(4)),
      pendingCapital: Number(pendingCapital.toFixed(2)),
      totalFees: Number(totalFee.toFixed(2)),
      rebuyAlerts: rebuyAlerts.length,
    },
    timeAnchor: { asOf: nowSec(), range: timeRange },
    units: {
      totalProfit: '元(CNY)',
      longProfit: '元(CNY,正T)',
      shortProfit: '元(CNY,倒T)',
      pendingCapital: '元(CNY,实际资金占用)',
      totalFees: '元(CNY)',
      winRate: '0-1小数比例(0.62=62%)',
      timeRange: '1d|7d|30d|all(与视图时间Tab一致)',
      pendingAmount: '股',
    },
    detail: {
      timeRange,
      feeBreakdown: { buyFee: Number(buyFee.toFixed(2)), sellFee: Number(sellFee.toFixed(2)) },
      topProfit: topProfit ? { ...topProfit, profit: Number(topProfit.profit.toFixed(2)) } : null,
      topLoss: topLoss ? { ...topLoss, profit: Number(topLoss.profit.toFixed(2)) } : null,
      rebuyAlerts,
      perSymbolProfit,
    },
  };
}

/**
 * 首页 · 仓位统计区块快照（V2 Click-to-Focus 推广，blockId=home:position）：
 * 与 Home.tsx 模块 2 逐条同口径 ——
 * 2a 市值 = Σ(数量×成本价) 成本口径；2c 最多金额仓位；2d 最大持有时间仓位
 * （视图 getHoldingDays：max(1, ceil(自然日))，argmax 用原始天数比较）；
 * 2e/2f 短线收益合并口径 = 全量流水池（processAllStreams 全输出，含 CLEARED）
 * + 已完成战报按 fullCode 归集（对齐视图 combinedProfitByCode），仅统计开启仓位标的；
 * 单一标的集中度 = 最大仓位市值 / 总市值（0-1 小数，空仓时 0）。
 */
export function buildHomePositionContext(src: CopilotSnapshotSource): CopilotContextData {
  // 视图模块 2 开启仓位口径
  const open = src.positions.filter((p) => !p.isClosed);
  const completed = src.tRounds.filter((r) => (r.status ?? 'OPENED') === 'COMPLETED');

  // 与 useStreamResults 同一纯函数管线（全量输出含 CLEARED，对齐视图 2e/2f 合并口径）
  const streams = processAllStreams(
    activeStreamsFromRounds(src.tRounds),
    src.feeConfig,
    buildBasePositionCosts(src.positions),
  );

  // 2d 持有天数（视图 getHoldingDays 同式：不足 1 天按 1 天）
  const nowMs = Date.now();
  const rawDays = (createdAt: string) => (nowMs - new Date(createdAt).getTime()) / 86_400_000;
  const holdingDays = (createdAt: string) => Math.max(1, Math.ceil(rawDays(createdAt)));

  // 2a. 仓位实际总金额（成本口径 = Σ 数量×成本价，视图标注「实时市值」但公式为成本口径）
  const totalValue = open.reduce((sum, p) => sum + (p.currentAmount * p.currentCost || 0), 0);

  // 2c. 最多金额仓位
  const maxCapital =
    open.length > 0
      ? open.reduce((max, p) =>
          p.currentAmount * p.currentCost > max.currentAmount * max.currentCost ? p : max,
        )
      : null;

  // 2d. 最大持有时间仓位（argmax 用原始天数，与视图 reduce 比较式一致）
  const maxHolding =
    open.length > 0
      ? open.reduce((max, p) => (rawDays(p.createdAt) > rawDays(max.createdAt) ? p : max))
      : null;

  // combinedProfitByCode 口径：全量流水池 + 已完成战报按 fullCode 归集
  const profitByCode: Record<string, { stockName: string; totalProfit: number }> = {};
  const acc = (code: string, name: string, profit: number) => {
    if (!profitByCode[code]) profitByCode[code] = { stockName: name, totalProfit: 0 };
    profitByCode[code].totalProfit += profit;
  };
  for (const s of streams) acc(s.fullCode, s.stockName, s.transferProfit);
  for (const r of completed) acc(r.fullCode, r.stockName, r.netProfit);

  // 2e/2f 仅统计开启仓位标的（视图 openCodes 过滤）
  const openCodes = new Set(open.map((p) => p.fullCode));

  // 2e. 短线降本最多仓位（开启仓位中正收益最大者）
  let best: { stockName: string; fullCode: string; totalProfit: number } | null = null;
  for (const [code, info] of Object.entries(profitByCode)) {
    if (!openCodes.has(code) || info.totalProfit <= 0) continue;
    if (!best || info.totalProfit > best.totalProfit) {
      best = {
        stockName: info.stockName,
        fullCode: code,
        totalProfit: Number(info.totalProfit.toFixed(2)),
      };
    }
  }

  // 2f. 当前仓位总盈利（浮动盈亏）= 开启仓位标的的短线收益合计
  const totalFloatingPnL = Object.entries(profitByCode)
    .filter(([code]) => openCodes.has(code))
    .reduce((sum, [, info]) => sum + info.totalProfit, 0);

  // 单一标的集中度 = 最大仓位市值 / 总市值（空仓时 0）
  const maxCapitalValue = maxCapital ? maxCapital.currentAmount * maxCapital.currentCost : 0;
  const concentration = totalValue > 0 ? maxCapitalValue / totalValue : 0;

  return {
    overview: {
      positionCount: open.length,
      totalMarketValue: Number(totalValue.toFixed(2)),
      totalFloatingPnL: Number(totalFloatingPnL.toFixed(2)),
      concentration: Number(concentration.toFixed(4)),
      maxHoldingDays: maxHolding ? holdingDays(maxHolding.createdAt) : 0,
    },
    timeAnchor: { asOf: nowSec(), range: 'now' },
    units: {
      totalMarketValue: '元(CNY,成本口径=Σ数量×成本价,非实时行情)',
      totalFloatingPnL: '元(CNY,短线口径=流水池transferProfit+已完成netProfit)',
      concentration: '0-1小数比例(0.35=35%,最大仓位市值/总市值)',
      holdingDays: '天(自然日,不足1天按1天)',
      currentCost: '元/股(含规费加权)',
    },
    detail: {
      maxCapitalPosition: maxCapital
        ? {
            stockName: maxCapital.stockName,
            fullCode: maxCapital.fullCode,
            marketValue: Number(maxCapitalValue.toFixed(2)),
          }
        : null,
      maxHoldingPosition: maxHolding
        ? {
            stockName: maxHolding.stockName,
            fullCode: maxHolding.fullCode,
            holdingDays: holdingDays(maxHolding.createdAt),
          }
        : null,
      bestCostReduction: best,
      openPositions: open.slice(0, 10).map((p) => ({
        stockName: p.stockName,
        fullCode: p.fullCode,
        currentCost: p.currentCost,
        currentAmount: p.currentAmount,
        marketValue: Number((p.currentAmount * p.currentCost).toFixed(2)),
        holdingDays: holdingDays(p.createdAt),
        shortTermProfit: Number((profitByCode[p.fullCode]?.totalProfit ?? 0).toFixed(2)),
      })),
    },
  };
}

/**
 * 首页 · 计划单待办区块快照（V2 Click-to-Focus 推广，blockId=home:plan_orders）：
 * 与 Home.tsx「计划单待办」section 逐条同口径 ——
 * 列表 = homePlans 过滤（cancelled 剔除；expired/executed 仅过期后 3 天展示窗口内；
 * active 全保留，status 滞后由时间实时判断兜底）；activePlanCount = 视图 1g 口径；
 * 偏离度 = (现价−计划价)/计划价×100（PlanOrderCard 同式），现价经注入的 getMarketPrice
 * 桥读取模块级行情缓存（视图 useEffect 已将 useLiveQuotes 轮询结果同步入 risk/priceCache）；
 * 无行情时优雅降级 —— 单行省略现价/偏离度字段、概览省略 maxAbsDeviationPercent，严禁塞 0。
 */
export function buildHomePlanContext(src: CopilotSnapshotSource): CopilotContextData {
  const nowMs = Date.now();

  // 视图 homePlans 展示列表口径（过期/已执行仅过期后 3 天窗口内仍展示，供复盘）
  const displayWindowMs = 3 * 86_400_000;
  const plans = src.plannedOrders.filter((p) => {
    if (p.status === 'cancelled') return false;
    if (p.status === 'expired' || p.status === 'executed') {
      return nowMs - new Date(p.expiresAt).getTime() <= displayWindowMs;
    }
    return true;
  });

  // 视图 1g「N 个待执行」口径：status=active 且未过期（时间实时判断，不信任 status 滞后）
  const activePlans = plans.filter(
    (p) => p.status === 'active' && new Date(p.expiresAt).getTime() > nowMs,
  );

  // 行情价读取：注入桥缺省/价格非法时返回 null（降级语义，区别于「偏离为 0」）
  const priceOf = (fullCode: string): number | null => {
    const price = src.getMarketPrice?.(fullCode);
    return price !== undefined && price > 0 ? price : null;
  };
  const deviationOf = (o: PlannedOrder): number | null => {
    const price = priceOf(o.fullCode);
    if (price === null || o.plannedPrice <= 0) return null;
    return ((price - o.plannedPrice) / o.plannedPrice) * 100;
  };

  // 明细行（与视图一致最多展示 10 条，保持 store 顺序）；无行情行整体省略行情字段
  const planRows = plans.slice(0, 10).map((o) => {
    const price = priceOf(o.fullCode);
    const deviation = deviationOf(o);
    const quoteFields =
      price !== null && deviation !== null
        ? { currentPrice: price, deviationPercent: Number(deviation.toFixed(2)) }
        : null;
    return {
      stockName: o.stockName,
      fullCode: o.fullCode,
      context: o.context,
      direction: o.direction,
      plannedPrice: o.plannedPrice,
      plannedAmount: o.plannedAmount,
      status: o.status,
      expiresAt: o.expiresAt,
      ...(quoteFields ?? {}),
    };
  });

  // 活跃单偏离聚合（视图紧凑偏离徽标仅 active 展示，概览口径随之）
  const activeDeviations = activePlans
    .map(deviationOf)
    .filter((d): d is number => d !== null);
  const overview: Record<string, string | number | boolean> = {
    planCount: plans.length,
    activePlanCount: activePlans.length,
    activeBuyCount: activePlans.filter((p) => p.direction === 'buy').length,
    activeSellCount: activePlans.filter((p) => p.direction === 'sell').length,
    quotedCount: activeDeviations.length,
  };
  // 无行情覆盖时省略（严禁 0 伪装「无偏离」）
  if (activeDeviations.length > 0) {
    overview.maxAbsDeviationPercent = Number(
      Math.max(...activeDeviations.map(Math.abs)).toFixed(2),
    );
  }

  return {
    overview,
    timeAnchor: { asOf: nowSec(), range: 'now' },
    units: {
      plannedPrice: '元/股(委托计划价)',
      currentPrice: '元/股(最近一次行情轮询快照,可能延迟)',
      deviationPercent: '%(现价相对计划价,正=现价高于计划价)',
      maxAbsDeviationPercent: '%(活跃单|现价-计划价|/计划价最大值)',
      expiresAt: 'ISO时间字符串',
      plannedAmount: '股',
    },
    detail: {
      plans: planRows,
      plansOmitted: Math.max(0, plans.length - 10),
    },
  };
}

// ──────────────────────────────────────────────
// 域卡片 builder（V2 推广：按标的 scope，t_calculator / cost_averaging）
// ──────────────────────────────────────────────

/**
 * 进行中短线项目快照（V2 推广）：TCalculator「当前项目卡片」按标的聚焦。
 *
 * @description fullCode 是 scope 身份参数（注册时固化的标的标识，非易变 UI 态）；
 *              数据全部来自 getState() 切片 + tStreamEngine 撮合管线重算
 *              （buildBasePositionCosts → activeStreamsFromRounds → processAllStreams，
 *              与 useStreamResults 同管线，AI 数字 = 用户数字）。行情现价经 getMarketPrice
 *              注入桥读取（父视图 useEffect 已同步 priceCache）；无行情时降级省略
 *              现价/偏离字段，严禁塞 0。项目已结清（无活跃流水）时降级输出该标的归档战报统计。
 */
export function buildTProjectContext(fullCode: string, src: CopilotSnapshotSource): CopilotContextData {
  const stockRounds = src.tRounds.filter((r) => r.fullCode === fullCode);
  const completed = stockRounds
    .filter((r) => (r.status ?? 'OPENED') === 'COMPLETED')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  const doneRounds = completed.length;
  const wins = completed.filter((r) => r.win).length;
  const doneNetProfit = completed.reduce((sum, r) => sum + r.netProfit, 0);

  const completedDetail = completed.slice(0, 5).map((r) => ({
    mode: r.mode,
    netProfit: Number(r.netProfit.toFixed(2)),
    win: r.win ?? false,
    settleType: r.settleType,
    closedAt: r.closedAt ?? '',
  }));

  // 撮合管线重算（与 roundsSlice/视图同源），取目标标的结果
  const baseCosts = buildBasePositionCosts(src.positions);
  const streams = activeStreamsFromRounds(src.tRounds).filter((s) => s.fullCode === fullCode);
  const result =
    processAllStreams(streams, src.feeConfig, baseCosts).find((r) => r.fullCode === fullCode) ?? null;

  const breakeven = result ? calcHedgeBreakeven(result, src.feeConfig) : null;
  const price = src.getMarketPrice?.(fullCode);
  const hasPrice = typeof price === 'number' && price > 0;
  const breakevenGapPercent =
    breakeven && hasPrice && breakeven.price > 0
      ? Number((((price! - breakeven.price) / breakeven.price) * 100).toFixed(2))
      : undefined;

  if (!result) {
    return {
      overview: {
        exists: false,
        doneRounds,
        wins,
        doneNetProfit: Number(doneNetProfit.toFixed(2)),
      },
      timeAnchor: { asOf: nowSec(), range: 'all' },
      units: {
        doneNetProfit: '元(CNY)',
        doneRounds: '轮',
        wins: '轮',
      },
      detail: {
        stockName: stockRounds[0]?.stockName ?? fullCode,
        completedRounds: completedDetail,
      },
    };
  }

  return {
    overview: {
      exists: true,
      mode: result.mode,
      status: result.status,
      trades: result.tradeCount,
      buys: result.buyAmount,
      sells: result.sellAmount,
      pend: result.netPendingAmount,
      shortPend: result.shortPendingAmount,
      rpnl: Number(result.realizedPnL.toFixed(2)),
      tprofit: Number(result.transferProfit.toFixed(2)),
      fee: Number(result.totalFee.toFixed(2)),
      days: result.holdingDays,
      doneRounds,
      wins,
      ...(breakeven ? { be: Number(breakeven.price.toFixed(3)) } : {}),
      ...(hasPrice ? { px: Number(price!.toFixed(3)) } : {}),
      ...(breakevenGapPercent !== undefined ? { beGapPct: breakevenGapPercent } : {}),
    },
    timeAnchor: { asOf: nowSec(), range: 'all' },
    units: {
      rpnl: '元(CNY)',
      tprofit: '元(CNY)',
      fee: '元(CNY)',
      doneNetProfit: '元(CNY)',
      be: '元/股(对冲保本价)',
      px: '元/股',
      beGapPct: '%((现价-保本价)/保本价×100)',
      trades: '笔',
      buys: '股',
      sells: '股',
      pend: '股(待平/待回补净额)',
      shortPend: '股(倒T未回补)',
      days: '天',
      doneRounds: '轮',
      wins: '轮',
    },
    detail: {
      stockName: result.stockName,
      openedAt: result.openedAt ?? result.entries[0]?.timestamp ?? '',
      avgPrice: Number(result.avgPrice.toFixed(3)),
      weightedBuyCost: Number(result.weightedBuyCost.toFixed(3)),
      pendingTotalCost: Number(result.pendingTotalCost.toFixed(2)),
      inheritedBaseAmount: result.inheritedBaseAmount ?? 0,
      // 保本对冲价与方向：gte=正T 应卖出到位；lte=倒T 应回补至此价内（与卡片徽章同口径）
      breakeven: breakeven
        ? { price: Number(breakeven.price.toFixed(3)), direction: breakeven.symbol }
        : null,
      currentPrice: hasPrice ? Number(price!.toFixed(3)) : null,
      recentEntries: result.entries.slice(-10).reverse().map((e) => ({
        direction: e.direction,
        price: Number(e.price.toFixed(3)),
        amount: e.amount,
        realizedProfit: Number(e.realizedProfit.toFixed(2)),
        timestamp: e.timestamp,
      })),
      completedRounds: completedDetail,
    },
  };
}

/**
 * 实盘账本持仓快照（V2 推广）：CostAveraging「进行中持仓卡片」按标的聚焦。
 *
 * @description fullCode 为 scope 身份参数。与 PositionLedger 视图同口径：批次履历经
 *              recalculatePosition 重建权威快照（动态保本价 / 做T落袋利润 / 净投入现金，
 *              出借只减数量不记盈亏、归并正常加回），浮动盈亏/回本涨幅公式与视图逐条一致；
 *              现价经 getMarketPrice 桥读取，无行情或空仓时降级省略浮盈字段，严禁塞 0。
 *              未平仓优先（视图卡片仅渲染进行中持仓），仅剩已结仓时降级 open:false。
 */
export function buildLedgerPositionContext(fullCode: string, src: CopilotSnapshotSource): CopilotContextData {
  const pos =
    src.positions.find((p) => p.fullCode === fullCode && !p.isClosed) ??
    src.positions.find((p) => p.fullCode === fullCode);
  const tReports = src.tRounds.filter(
    (r) => r.fullCode === fullCode && (r.status ?? 'OPENED') === 'COMPLETED',
  );
  const reportCount = tReports.length;
  const reportWins = tReports.filter((r) => r.win).length;
  const reportNetProfit = tReports.reduce((sum, r) => sum + r.netProfit, 0);

  if (!pos) {
    return {
      overview: {
        exists: false,
        reportCount,
        reportWins,
        reportNetProfit: Number(reportNetProfit.toFixed(2)),
      },
      timeAnchor: { asOf: nowSec(), range: 'all' },
      units: {
        reportNetProfit: '元(CNY)',
        reportCount: '轮',
        reportWins: '轮',
      },
      detail: { fullCode },
    };
  }

  // 批次履历 → 实体转换与视图 toEntityBatch 一致（timestamp: ISO → epoch 毫秒）
  const snap = recalculatePosition(
    pos.batches.map(
      (b) =>
        ({ ...b, positionId: pos.id, timestamp: new Date(b.timestamp).getTime() }) as PositionBatchEntity,
    ),
  );

  const price = src.getMarketPrice?.(fullCode);
  const hasPrice = typeof price === 'number' && price > 0 && snap.currentAmount > 0;
  const floatPnL = hasPrice ? (price! - snap.currentCost) * snap.currentAmount : undefined;
  const floatPnLPercent =
    hasPrice && snap.currentCost > 0 ? ((price! - snap.currentCost) / snap.currentCost) * 100 : undefined;
  const requiredRisePercent =
    hasPrice && snap.currentCost > 0 ? ((snap.currentCost - price!) / price!) * 100 : undefined;
  const totalBorrow = pos.batches
    .filter((b) => b.kind === 'borrow')
    .reduce((sum, b) => sum + Math.abs(b.amount), 0);
  const holdingDays = pos.openAt
    ? Math.max(0, Math.floor((Date.now() - new Date(pos.openAt).getTime()) / 86_400_000))
    : undefined;

  return {
    overview: {
      exists: true,
      open: !pos.isClosed,
      amount: snap.currentAmount,
      cost: Number(snap.currentCost.toFixed(3)),
      invested: Number(snap.totalInvested.toFixed(2)),
      rpnl: Number(snap.realizedPnL.toFixed(2)),
      tprofit: Number(snap.accumulatedTPnL.toFixed(2)),
      batches: pos.batches.length,
      borrow: totalBorrow,
      reportCount,
      reportWins,
      ...(holdingDays !== undefined ? { days: holdingDays } : {}),
      ...(hasPrice ? { px: Number(price!.toFixed(3)) } : {}),
      ...(floatPnL !== undefined ? { float: Number(floatPnL.toFixed(2)) } : {}),
      ...(floatPnLPercent !== undefined ? { floatPct: Number(floatPnLPercent.toFixed(2)) } : {}),
    },
    timeAnchor: { asOf: nowSec(), range: 'all' },
    units: {
      cost: '元/股(动态保本价=净投入现金/持有数量)',
      px: '元/股(最近一次行情轮询快照,可能延迟)',
      invested: '元(CNY)',
      rpnl: '元(CNY)',
      tprofit: '元(CNY)',
      reportNetProfit: '元(CNY)',
      float: '元(CNY)',
      floatPct: '%((现价-保本价)/保本价×100)',
      requiredRisePercent: '%((保本价-现价)/现价×100,正=尚未回本)',
      amount: '股',
      borrow: '股(做T在途借出)',
      days: '天',
      batches: '笔',
      reportCount: '轮',
      reportWins: '轮',
    },
    detail: {
      stockName: pos.stockName,
      initialCost: Number(snap.initialCost.toFixed(3)),
      totalBorrow,
      currentPrice: hasPrice ? Number(price!.toFixed(3)) : null,
      requiredRisePercent:
        requiredRisePercent !== undefined ? Number(requiredRisePercent.toFixed(2)) : null,
      recentBatches: pos.batches.slice(-10).reverse().map((b) => ({
        type: b.type,
        price: Number(b.price.toFixed(3)),
        amount: Math.abs(b.amount),
        fee: Number((b.fee ?? 0).toFixed(2)),
        kind: b.kind ?? null,
        timestamp: b.timestamp,
      })),
      tReports: {
        count: reportCount,
        wins: reportWins,
        netProfit: Number(reportNetProfit.toFixed(2)),
        recent: tReports.slice(0, 5).map((r) => ({
          mode: r.mode,
          netProfit: Number(r.netProfit.toFixed(2)),
          win: r.win ?? false,
          closedAt: r.closedAt ?? '',
        })),
      },
    },
  };
}
