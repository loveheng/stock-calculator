/**
 * @file Home.tsx
 * @description 首页仪表盘：聚合展示短线总览（实时已实现收益/待对冲持仓/底仓状态）、
 *              近 N 日收益趋势、持仓分布、账户现金流（现金/总资产）与短线异动预警。
 *              数据来源：useStreamResults（流水池撮合引擎）+ Store positions（持仓账本）
 *              + tRounds（已完成战报归档）。
 *              v8+ 适配：合并统计 OPENED 流水池（active streams）与 COMPLETED 战报（archived rounds）
 *              的净收益数据，短线降本最多仓位与当前仓位总盈利体现全量短线收益。
 * @layer UI
 * @storage_impact 只读消费：positions（底仓持仓）、tRounds（短线轮次，含 OPENED + COMPLETED）；
 *                 不直接写入任何 IndexedDB 表，跳转类操作委托各功能页完成。
 * @author 开发团队
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  TrendingUp,
  BarChart3,
  PieChart,
  Settings,
  DollarSign,
  Activity,
  TrendingDown,
  Wallet,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';
import { useStreamResults, useAppStore } from '../store';
import { roundTo } from '../utils/mathUtils';
import type { StockStreamResult } from '../utils/tStreamEngine';

// ---- 时间维度 ----
type TimeRange = '1d' | '7d' | '30d' | 'all';

const timeRangeOptions: Array<{ value: TimeRange; label: string }> = [
  { value: '1d', label: '1天' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: 'all', label: '全部' },
];

// ---- 预警条目 ----
interface AlertItem {
  id: string;
  stockName: string;
  fullCode: string;
  message: string;
  amount: number;
}

/**
 * 首页仪表盘组件。
 *
 * @description 组合 Store positions 与流水池：
 *               - 计算总持仓市值、现金余额与总资产
 *               - 汇总短线实时收益（transferProfit 口径）
 *               - 按 1d/7d/30d/all 时间维度过滤收益趋势
 *               - 生成短线异动预警条目（如倒数第二持仓归零、大额收益等）
 * @returns {JSX.Element} 首页仪表盘视图
 * @note 本组件仅读不写；所有写操作（开T/归档/调整底仓）跳转到对应页面完成
 */
export default function Home() {
  const navigate = useNavigate();
  const streamResults = useStreamResults();
  const positions = useAppStore((s) => s.positions);
  const tRounds = useAppStore((s) => s.tRounds);

  // ---- 时间筛选状态 ----
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');

  // ---- 计算时间范围边界 ----
  const timeBoundary = useMemo(() => {
    if (timeRange === 'all') return 0;
    const now = Date.now();
    const days = timeRange === '1d' ? 1 : timeRange === '7d' ? 7 : 30;
    return now - days * 86400000;
  }, [timeRange]);

  // ---- 筛选：时间区间内处于"开启/进行中"状态的短线项目（以最后一次操作时间为准） ----
  const filteredActiveStreams = useMemo(() => {
    return streamResults.filter((s) => {
      if (s.status === 'CLEARED') return false;
      if (timeRange === 'all') return true;
      // 以该标的最新一条流水的操作时间为准
      const lastEntry = s.entries[s.entries.length - 1];
      if (!lastEntry) return false;
      const lastTime = new Date(lastEntry.timestamp).getTime();
      return lastTime >= timeBoundary;
    });
  }, [streamResults, timeRange, timeBoundary]);

  // ---- 所有开启/进行中的短线项目（无时间筛选，用于总数统计） ----
  const allActiveStreams = useMemo(
    () => streamResults.filter((s) => s.status !== 'CLEARED'),
    [streamResults],
  );

  // ---- 已完成战报归档（COMPLETED rounds） ----
  const completedRounds = useMemo(
    () => tRounds.filter((r) => r.status === 'COMPLETED'),
    [tRounds],
  );

  // ---- 按时间筛选已完成战报 ----
  const filteredCompletedRounds = useMemo(() => {
    if (timeRange === 'all') return completedRounds;
    return completedRounds.filter((r) => {
      const closeTime = r.closedAt ? new Date(r.closedAt).getTime() : 0;
      return closeTime >= timeBoundary;
    });
  }, [completedRounds, timeRange, timeBoundary]);

  // ---- 全量短线收益归集（按 fullCode 合并 active streams + completed rounds） ----
  const combinedProfitByCode = useMemo(() => {
    const profitMap: Record<string, { stockName: string; totalProfit: number }> = {};
    // 来自进行中流水池的 transferProfit
    for (const s of streamResults) {
      if (!profitMap[s.fullCode]) {
        profitMap[s.fullCode] = { stockName: s.stockName, totalProfit: 0 };
      }
      profitMap[s.fullCode].totalProfit += s.transferProfit;
    }
    // 来自已完成战报的 netProfit（已落袋收益）
    for (const r of completedRounds) {
      if (!profitMap[r.fullCode]) {
        profitMap[r.fullCode] = { stockName: r.stockName, totalProfit: 0 };
      }
      profitMap[r.fullCode].totalProfit += r.netProfit;
    }
    return profitMap;
  }, [streamResults, completedRounds]);

  // ==============================
  // 模块 1：短线统计
  // ==============================

  // 1a. 区间短线总金额（实际资金占用总额，排除流水重复计算）
  const tTotalCapital = useMemo(() => {
    return filteredActiveStreams.reduce((sum, s) => {
      if (s.mode === 'long') {
        // 正T：pendingTotalCost 即为已买入未卖出的资金占用
        return sum + s.pendingTotalCost;
      }
      // 倒T：shortPendingAmount × avgPrice 估算待买回资金占用
      return sum + s.shortPendingAmount * s.avgPrice;
    }, 0);
  }, [filteredActiveStreams]);

  // 1b. 正在开启短线总数及分布（含已完成战报统计）
  const tActiveCount = allActiveStreams.length;
  const tLongCount = allActiveStreams.filter((s) => s.mode === 'long').length;
  const tShortCount = allActiveStreams.filter((s) => s.mode === 'short').length;
  const tFilteredCount = filteredActiveStreams.length;
  const tCompletedCount = completedRounds.length;
  const tCompletedWinCount = completedRounds.filter((r) => r.win).length;
  const tCompletedWinRate = tCompletedCount > 0
    ? roundTo((tCompletedWinCount / tCompletedCount) * 100, 1)
    : 0;

  // 1c. 区间摩擦成本明细（买入规费 / 卖出规费）
  const tFeeDetails = useMemo(() => {
    let totalFee = 0;
    let buyFee = 0;
    let sellFee = 0;
    for (const s of filteredActiveStreams) {
      totalFee += s.totalFee;
      for (const e of s.entries) {
        if (e.direction === 'buy') buyFee += e.fee;
        else sellFee += e.fee;
      }
    }
    return { totalFee, buyFee, sellFee };
  }, [filteredActiveStreams]);

  // 1d. 当前短线盈亏明细（正T盈亏 / 倒T盈亏，合并进行中 + 已完成）
  const tProfitDetails = useMemo(() => {
    let totalProfit = 0;
    let longProfit = 0;
    let shortProfit = 0;
    // 进行中流水池
    for (const s of filteredActiveStreams) {
      totalProfit += s.transferProfit;
      if (s.mode === 'long') longProfit += s.transferProfit;
      else shortProfit += s.transferProfit;
    }
    // 已完成战报
    for (const r of filteredCompletedRounds) {
      totalProfit += r.netProfit;
      if (r.mode === 'long') longProfit += r.netProfit;
      else shortProfit += r.netProfit;
    }
    return { totalProfit, longProfit, shortProfit };
  }, [filteredActiveStreams, filteredCompletedRounds]);

  // 1e. 区间最大盈利短线（落袋/浮盈金额最大的单笔短线标的，合并进行中 + 已完成）
  const topProfitRound = useMemo(() => {
    // 构建统一列表：active streams 用 transferProfit，completed rounds 用 netProfit
    const candidates: Array<{ stockName: string; fullCode: string; profit: number }> = [];
    for (const s of filteredActiveStreams) {
      candidates.push({ stockName: s.stockName, fullCode: s.fullCode, profit: s.transferProfit });
    }
    for (const r of filteredCompletedRounds) {
      candidates.push({ stockName: r.stockName, fullCode: r.fullCode, profit: r.netProfit });
    }
    if (candidates.length === 0) return null;
    return candidates.reduce((best, c) => (c.profit > best.profit ? c : best));
  }, [filteredActiveStreams, filteredCompletedRounds]);

  // 1f. 区间最大亏损短线（亏损金额最大的单笔短线标的，合并进行中 + 已完成）
  const topLossRound = useMemo(() => {
    const candidates: Array<{ stockName: string; fullCode: string; profit: number }> = [];
    for (const s of filteredActiveStreams) {
      if (s.transferProfit < 0) candidates.push({ stockName: s.stockName, fullCode: s.fullCode, profit: s.transferProfit });
    }
    for (const r of filteredCompletedRounds) {
      if (r.netProfit < 0) candidates.push({ stockName: r.stockName, fullCode: r.fullCode, profit: r.netProfit });
    }
    if (candidates.length === 0) return null;
    return candidates.reduce((worst, c) => (c.profit < worst.profit ? c : worst));
  }, [filteredActiveStreams, filteredCompletedRounds]);

  // 1g. 待办轮动提醒：倒T底仓出空或待平仓项目
  const alertItems = useMemo<AlertItem[]>(() => {
    const items: AlertItem[] = [];
    for (const s of allActiveStreams) {
      if (s.mode !== 'short') continue;
      if (s.shortPendingAmount <= 0) continue;
      const pos = positions.find(
        (p) => p.fullCode === s.fullCode && !p.isClosed,
      );
      const isBaseExhausted = !pos || pos.currentAmount === 0;
      items.push({
        id: s.fullCode,
        stockName: s.stockName,
        fullCode: s.fullCode,
        message: isBaseExhausted
          ? `倒T底仓出空，待低吸买回 ${s.shortPendingAmount} 股`
          : `倒T待回补 ${s.shortPendingAmount} 股`,
        amount: s.shortPendingAmount,
      });
    }
    return items;
  }, [allActiveStreams, positions]);

  // ==============================
  // 模块 2：开启仓位统计
  // ==============================

  const openPositions = useMemo(
    () => positions.filter((p) => !p.isClosed),
    [positions],
  );

  // 2a. 仓位实际总金额（实时持仓总市值/实际资金占用）
  const positionTotalValue = useMemo(
    () =>
      openPositions.reduce(
        (sum, p) => sum + (p.currentAmount * p.currentCost || 0),
        0,
      ),
    [openPositions],
  );

  // 2b. 开启仓位数量
  const positionCount = openPositions.length;

  // 2c. 最多金额仓位
  const maxCapitalPosition = useMemo(() => {
    if (openPositions.length === 0) return null;
    return openPositions.reduce((max, p) => {
      const val = p.currentAmount * p.currentCost;
      const maxVal = max.currentAmount * max.currentCost;
      return val > maxVal ? p : max;
    });
  }, [openPositions]);

  // 2d. 最大持有时间仓位
  const maxHoldingPosition = useMemo(() => {
    if (openPositions.length === 0) return null;
    const now = Date.now();
    return openPositions.reduce((max, p) => {
      const maxDays =
        (now - new Date(max.createdAt).getTime()) / 86400000;
      const curDays =
        (now - new Date(p.createdAt).getTime()) / 86400000;
      return curDays > maxDays ? p : max;
    });
  }, [openPositions]);

  // 2e. 短线降本最多仓位（开启仓位中短线累计落袋收益最高的标的，合并流水池 + 已完成战报）
  const bestCostReduction = useMemo(() => {
    // 使用 combinedProfitByCode（已合并 active streams + completed rounds）
    const openCodes = new Set(openPositions.map((p) => p.fullCode));
    let best: { stockName: string; totalProfit: number } | null = null;
    for (const [code, info] of Object.entries(combinedProfitByCode)) {
      if (!openCodes.has(code)) continue;
      if (info.totalProfit <= 0) continue; // 只统计正降本
      if (!best || info.totalProfit > best.totalProfit) {
        best = info;
      }
    }
    return best;
  }, [combinedProfitByCode, openPositions]);

  // 2f. 当前仓位总盈利（浮动盈亏）= 所有开启仓位对应的短线收益之和（合并流水池 + 已完成战报）
  const positionTotalProfit = useMemo(() => {
    const openCodes = new Set(openPositions.map((p) => p.fullCode));
    let total = 0;
    // 来自进行中流水池
    for (const s of streamResults) {
      if (openCodes.has(s.fullCode)) {
        total += s.transferProfit;
      }
    }
    // 来自已完成战报
    for (const r of completedRounds) {
      if (openCodes.has(r.fullCode)) {
        total += r.netProfit;
      }
    }
    return total;
  }, [streamResults, completedRounds, openPositions]);

  // ---- 快捷入口卡片 ----
  const quickCards = [
    {
      label: '短线计算器',
      icon: RefreshCw,
      path: '/t-calculator',
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
    },
    {
      label: '涨跌幅计算',
      icon: TrendingUp,
      path: '/change-rate',
      color: 'text-slate-400',
      bg: 'bg-slate-500/10',
    },
    {
      label: '成本摊薄',
      icon: BarChart3,
      path: '/cost-averaging',
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
    },
    {
      label: '数据统计',
      icon: PieChart,
      path: '/statistics',
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
    },
    {
      label: '费率配置',
      icon: Settings,
      path: '/fee-config',
      color: 'text-slate-400',
      bg: 'bg-slate-500/10',
    },
  ];

  // ---- 格式化 ----
  const fmtMoney = (val: number) =>
    `${val >= 0 ? '+' : ''}¥${Math.abs(val).toFixed(2)}`;
  const fmtMoneyAbs = (val: number) => `¥${val.toFixed(2)}`;

  // ---- 预警轮动状态 ----
  const [alertIndex, setAlertIndex] = useState(0);
  const alertTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 清理定时器的辅助函数
  const clearAlertTimer = useCallback(() => {
    if (alertTimerRef.current !== null) {
      clearInterval(alertTimerRef.current);
      alertTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearAlertTimer();
    if (alertItems.length === 0) {
      setAlertIndex(0);
      return;
    }
    alertTimerRef.current = setInterval(() => {
      setAlertIndex((prev) => (prev + 1) % alertItems.length);
    }, 4000);
    return clearAlertTimer;
  }, [alertItems.length, clearAlertTimer]);

  const currentAlert =
    alertItems.length > 0 ? alertItems[alertIndex % alertItems.length] : null;

  // ---- 计算持仓天数 ----
  const getHoldingDays = (createdAt: string) => {
    const diff = Date.now() - new Date(createdAt).getTime();
    return Math.max(1, Math.ceil(diff / 86400000));
  };

  return (
    <div className="page-container space-y-5 pb-[calc(env(safe-area-inset-bottom)+16px)]">
      {/* ============================ */}
      {/* 模块 1：短线统计 (T-Trading Metrics) */}
      {/* ============================ */}
      <div className="card !p-0 overflow-hidden border-slate-700/80 bg-gradient-to-br from-slate-900 to-slate-950">
        {/* 卡片标题 */}
        <div className="flex items-center justify-between px-5 pt-5 pb-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600/20">
              <Activity className="h-4 w-4 text-blue-400" />
            </div>
            <span className="text-sm font-semibold text-slate-200">
              短线统计
            </span>
          </div>
        </div>

        {/* 时间维度切换器 */}
        <div className="px-5 mt-4">
          <div className="flex gap-1.5 rounded-xl bg-slate-800/60 p-1">
            {timeRangeOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTimeRange(opt.value)}
                className={`flex-1 rounded-lg py-2 text-xs font-medium transition-all duration-200 ${
                  timeRange === opt.value
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 核心数据网格：6 cells, 2-col mobile / 4-col sm, last 2 span-2 */}
        <div className="grid grid-cols-2 gap-3 px-5 pt-4 pb-5 sm:grid-cols-4">
          {/* 区间短线总金额 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              区间短线总金额
            </div>
            <div className="mt-1.5 text-base font-bold text-white sm:text-lg">
              {fmtMoneyAbs(tTotalCapital)}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-600">
              {tFilteredCount} 笔 · 实际资金占用
            </div>
          </div>

          {/* 正在开启短线总数 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              正在开启短线总数
            </div>
            <div className="mt-1.5 text-base font-bold text-white sm:text-lg">
              {tActiveCount} 笔
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">
              正T: {tLongCount} | 倒T: {tShortCount}
            </div>
          </div>

          {/* 已完成战报统计 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              已完成短线
            </div>
            <div className="mt-1.5 text-base font-bold text-slate-400 sm:text-lg">
              {tCompletedCount} 笔
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">
              胜率 {tCompletedWinRate}% ({tCompletedWinCount}胜/{tCompletedCount - tCompletedWinCount}负)
            </div>
          </div>

          {/* 区间摩擦成本明细 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              区间摩擦成本
            </div>
            <div className="mt-1.5 text-base font-bold text-red-400 sm:text-lg">
              {fmtMoneyAbs(tFeeDetails.totalFee)}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">
              买¥{tFeeDetails.buyFee.toFixed(2)} / 卖¥{tFeeDetails.sellFee.toFixed(2)}
            </div>
          </div>

          {/* 当前短线盈亏明细 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              当前短线盈亏
            </div>
            <div
              className={`mt-1.5 text-base font-bold sm:text-lg ${
                tProfitDetails.totalProfit >= 0
                  ? 'text-red-400'
                  : 'text-green-400'
              }`}
            >
              {tProfitDetails.totalProfit >= 0 ? '+' : ''}
              ¥{tProfitDetails.totalProfit.toFixed(2)}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">
              正T{' '}
              <span
                className={
                  tProfitDetails.longProfit >= 0
                    ? 'text-red-400'
                    : 'text-green-400'
                }
              >
                {tProfitDetails.longProfit >= 0 ? '+' : ''}
                ¥{tProfitDetails.longProfit.toFixed(2)}
              </span>{' '}
              / 倒T{' '}
              <span
                className={
                  tProfitDetails.shortProfit >= 0
                    ? 'text-red-400'
                    : 'text-green-400'
                }
              >
                {tProfitDetails.shortProfit >= 0 ? '+' : ''}
                ¥{tProfitDetails.shortProfit.toFixed(2)}
              </span>
            </div>
          </div>

          {/* 区间最大盈利短线 */}
          <div className="rounded-2xl bg-slate-950/80 p-3 col-span-1 sm:col-span-2">
            <div className="text-[11px] text-slate-500">
              区间最大盈利短线
            </div>
            <div className="mt-1.5 text-sm font-bold text-white leading-tight">
              {topProfitRound && topProfitRound.profit > 0 ? (
                <>
                  <span className="truncate block">
                    {topProfitRound.stockName}
                  </span>
                  <span className="text-base text-red-400">
                    +¥{topProfitRound.profit.toFixed(2)}
                  </span>
                </>
              ) : (
                <span className="text-slate-500">--</span>
              )}
            </div>
          </div>

          {/* 区间最大亏损短线 */}
          <div className="rounded-2xl bg-slate-950/80 p-3 col-span-1 sm:col-span-2">
            <div className="text-[11px] text-slate-500">
              区间最大亏损短线
            </div>
            <div className="mt-1.5 text-sm font-bold text-white leading-tight">
              {topLossRound ? (
                <>
                  <span className="truncate block">
                    {topLossRound.stockName}
                  </span>
                  <span className="text-base text-green-400">
                    ¥{topLossRound.profit.toFixed(2)}
                  </span>
                </>
              ) : (
                <span className="text-slate-500">-</span>
              )}
            </div>
          </div>
        </div>

        {/* 待办轮动提醒 */}
        {currentAlert && (
          <div className="mx-5 mb-5 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-amber-300">
                    待办提醒
                  </span>
                  {alertItems.length > 1 && (
                    <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
                      {alertIndex + 1}/{alertItems.length}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm font-medium text-amber-200 leading-snug">
                  [{currentAlert.stockName}{' '}
                  <span className="text-amber-400/70">
                    {currentAlert.fullCode}
                  </span>
                  ] {currentAlert.message}
                </p>
              </div>
              {alertItems.length > 1 && (
                <div className="flex gap-0.5 mt-1.5">
                  {alertItems.map((_, i) => (
                    <span
                      key={i}
                      className={`block h-1 w-4 rounded-full transition-colors ${
                        i === alertIndex
                          ? 'bg-amber-400'
                          : 'bg-amber-500/20'
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 无预警时显示占位 */}
        {alertItems.length === 0 && (
          <div className="mx-5 mb-5 rounded-2xl border border-slate-700/50 bg-slate-950/40 px-4 py-3">
            <p className="text-xs text-slate-500 text-center">
              暂无待办提醒，所有短线项目状态正常
            </p>
          </div>
        )}
      </div>

      {/* ============================ */}
      {/* 模块 2：开启仓位统计 (Active Position Metrics) */}
      {/* ============================ */}
      <div className="card !p-0 overflow-hidden border-slate-700/80 bg-gradient-to-br from-slate-900 to-slate-950">
        {/* 卡片标题 */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-600/20">
            <Wallet className="h-4 w-4 text-slate-400" />
          </div>
          <span className="text-sm font-semibold text-slate-200">
            仓位统计
          </span>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
            全量统计
          </span>
        </div>

        {/* 核心数据网格：6 cells, 2-col mobile / 4-col sm, last 2 span-2 */}
        <div className="grid grid-cols-2 gap-3 px-5 pt-4 pb-5 sm:grid-cols-4">
          {/* 仓位实际总金额 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              仓位实际总金额
            </div>
            <div className="mt-1.5 text-base font-bold text-white sm:text-lg">
              {fmtMoneyAbs(positionTotalValue)}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-600">
              实时市值
            </div>
          </div>

          {/* 开启仓位数量 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              开启仓位数量
            </div>
            <div className="mt-1.5 text-base font-bold text-white sm:text-lg">
              {positionCount} 个标的
            </div>
            <div className="mt-0.5 text-[10px] text-slate-600">
              覆盖股票数
            </div>
          </div>

          {/* 最多金额仓位 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              最多金额仓位
            </div>
            <div className="mt-1.5 text-sm font-bold text-white leading-tight">
              {maxCapitalPosition ? (
                <>
                  <span className="truncate block">
                    {maxCapitalPosition.stockName}
                  </span>
                  <span className="text-base text-blue-400">
                    {fmtMoneyAbs(
                      maxCapitalPosition.currentAmount *
                        maxCapitalPosition.currentCost,
                    )}
                  </span>
                </>
              ) : (
                <span className="text-slate-500">--</span>
              )}
            </div>
          </div>

          {/* 最大持有时间仓位 */}
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">
              最大持有时间仓位
            </div>
            <div className="mt-1.5 text-sm font-bold text-white leading-tight">
              {maxHoldingPosition ? (
                <>
                  <span className="truncate block">
                    {maxHoldingPosition.stockName}
                  </span>
                  <span className="text-base text-amber-400">
                    已持有{' '}
                    {getHoldingDays(maxHoldingPosition.createdAt)}{' '}
                    天
                  </span>
                </>
              ) : (
                <span className="text-slate-500">--</span>
              )}
            </div>
          </div>

          {/* 短线降本最多仓位 */}
          <div className="rounded-2xl bg-slate-950/80 p-3 col-span-1 sm:col-span-2">
            <div className="text-[11px] text-slate-500">
              短线降本最多仓位
            </div>
            <div className="mt-1.5 text-sm font-bold text-white leading-tight">
              {bestCostReduction ? (
                <>
                  <span className="truncate block">
                    {bestCostReduction.stockName}
                  </span>
                  <span className="text-base text-red-400">
                    累计降本 +¥{bestCostReduction.totalProfit.toFixed(2)}
                  </span>
                </>
              ) : (
                <span className="text-slate-500">--</span>
              )}
            </div>
          </div>

          {/* 当前仓位总盈利（占满宽度） */}
          <div className="rounded-2xl bg-slate-950/80 p-3 col-span-1 sm:col-span-2">
            <div className="text-[11px] text-slate-500">
              当前仓位总盈利（浮动盈亏）
            </div>
            <div
              className={`mt-1.5 text-base font-bold sm:text-lg ${
                positionTotalProfit >= 0
                  ? 'text-red-400'
                  : 'text-green-400'
              }`}
            >
              {positionTotalProfit >= 0 ? '+' : ''}
              ¥{positionTotalProfit.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* 持仓标的列表（移动端紧凑，点击直达短线/底仓详情） */}
      {openPositions.length > 0 && (
        <div>
          <h3 className="text-base font-semibold text-slate-300 mb-3">
            持仓标的
          </h3>
          <div className="space-y-2">
            {openPositions.map((pos) => (
              <button
                key={pos.id}
                onClick={() => navigate(`/t-calculator?fullCode=${pos.fullCode}`)}
                className="tap-target w-full flex items-center justify-between gap-3 p-3 bg-slate-900 rounded-xl border border-slate-700 hover:border-slate-600 transition-colors text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-200 truncate">{pos.stockName}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{pos.fullCode}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-base font-bold text-slate-100 tabular-nums">
                    {pos.currentCost > 0 ? `¥${pos.currentCost.toFixed(3)}` : '--'}
                  </div>
                  <div className="text-[11px] text-slate-500 tabular-nums">
                    {pos.currentAmount} 股
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 快捷入口 */}
      <div>
        <h3 className="text-base font-semibold text-slate-300 mb-3">
          快捷入口
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {quickCards.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.path}
                onClick={() => navigate(card.path)}
                className="card tap-target flex items-center gap-3 p-4 hover:bg-slate-750 transition-colors cursor-pointer border-slate-700 hover:border-slate-600 mb-0"
              >
                <div className={`p-2.5 rounded-lg ${card.bg}`}>
                  <Icon className={`w-5 h-5 ${card.color}`} />
                </div>
                <span className="text-sm font-medium text-slate-300">
                  {card.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 提示信息 */}
      <div className="card">
        <h3 className="text-base font-semibold text-slate-300 mb-2">
          使用说明
        </h3>
        <ul className="space-y-2 text-sm text-slate-400">
          <li>
            • 短线计算器：支持正T（先买后卖）和倒T（先卖后买）两种模式
          </li>
          <li>
            • 涨跌幅计算：支持连续涨跌停阶梯推算
          </li>
          <li>
            • 成本摊薄：多批次建仓账本 + 目标成本推算工具
          </li>
          <li>
            • 数据统计：短线账本统计与建仓履历展示
          </li>
          <li>
            • 费率配置：自定义佣金率、免五开关、过户费/印花税率
          </li>
        </ul>
      </div>
    </div>
  );
}