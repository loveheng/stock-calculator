/**
 * @file Statistics.tsx
 * @description 数据统计页：合并「实时流水池撮合结果（进行中）+ 已归档做T战报」为统一卡片流，
 *              支持按时间维度（近7天/30天/本月/全部）、正倒T状态、仓位状态多维筛选，
 *              并内嵌个股行情行情快照搜索与建仓履历（持仓批次明细）。
 * @layer UI
 * @storage_impact 只读消费：tStreams（流水池）、tRounds（做T战报）、positions/batches（建仓履历）；
 *                 不直接写入 IndexedDB。
 * @author 开发团队
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Search, X, ChevronDown, ChevronUp, BarChart3, Wallet, Loader2 } from 'lucide-react';
import { useStreamResults } from '../store';
import type { Position, PositionBatch } from '../store';
import { useLiveQuery } from 'dexie-react-hooks';
import { ledgerService } from '../services/ledgerService';
import type { RoundTxn } from '../store';
import type { StreamEntry } from '../utils/tStreamEngine';
import { searchStocks } from '../services/stockService';
import type { StockSearchItem } from '../types/stock';

type TimeFilter = 'all' | '7d' | '30d' | 'month';
type DirectionTab = 'all' | 'long_open' | 'long_closed' | 'short_open' | 'short_closed';
type PositionFilter = 'all' | 'open' | 'closed';

const directionTabs: Array<{ value: DirectionTab; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'long_open', label: '正T · 进行中' },
  { value: 'long_closed', label: '正T · 已完成' },
  { value: 'short_open', label: '倒T · 进行中' },
  { value: 'short_closed', label: '倒T · 已完成' },
];

const timeTabs: Array<{ value: TimeFilter; label: string }> = [
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: 'month', label: '本月' },
  { value: 'all', label: '全部' },
];

const positionTabs: Array<{ value: PositionFilter; label: string }> = [
  { value: 'all', label: '全部仓位' },
  { value: 'open', label: '进行中仓位' },
  { value: 'closed', label: '已结案仓位' },
];

// ---- 统一卡片数据类型（合并进行中 + 已归档） ----
interface TCardData {
  id: string;
  source: 'active' | 'archived';
  stockName: string;
  fullCode: string;
  roundNo: number;
  mode: 'long' | 'short';
  status: 'open' | 'closed';
  settleType?: 'clear' | 'transfer';
  netProfit: number;
  fees: number;
  avgPrice: number;
  buyAmount: number;
  sellAmount: number;
  tradeCount: number;
  win: boolean;
  openedAt: string;
  closedAt?: string;
  // 进行中专用
  netPendingAmount?: number;
  weightedBuyCost?: number;
  shortPendingAmount?: number;
  avgSellPrice?: number;
  // 明细列表（StreamEntry 或 RoundTxn）
  entries: (StreamEntry | RoundTxn)[];
}

/**
 * 数据统计页面组件。
 *
 * @description 将进行中做T（streamResults）与已归档战报（tRounds）统一映射为
 *              TCardData 卡片，按选中筛选条件过滤后展示：
 *              - 汇总指标卡（总收益/完成率/胜率/交易笔数）
 *              - 做T卡片流（支持展开查看明细/删除/还原）
 *              - 个股行情搜索（快照行情）
 *              - 建仓履历（持仓批次 + 做T降本对照）
 * @returns {JSX.Element} 数据统计页视图
 * @note 删除/还原归档战报属于写操作，通过 ledgerService 落库并联动 store 刷新
 */
export default function Statistics() {
  const streamResults = useStreamResults();
  const tRounds = useLiveQuery(async () => await ledgerService.getTRoundsWithTransactions(), [], []) as any[];
  const positions = useLiveQuery(async () => await ledgerService.getPositionsWithStockInfo(), [], []) as Position[];

  const [tab, setTab] = useState<'trades' | 'positions'>('trades');
  const [searchQuery, setSearchQuery] = useState('');
  const [matchedCodes, setMatchedCodes] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [directionTab, setDirectionTab] = useState<DirectionTab>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [positionFilter, setPositionFilter] = useState<PositionFilter>('all');
  const [visibleCount, setVisibleCount] = useState(10);

  // ---- 搜索 debounce 定时器引用 ----
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 搜索输入变化时，使用 300ms 防抖调用 searchStocks API ----
  useEffect(() => {
    const term = searchQuery.trim();

    // 清除之前未执行的定时器
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (term.length === 0) {
      setMatchedCodes([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);

    debounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchStocks(term);
        // 提取匹配到的唯一 fullCode 列表
        const codes = results.map((item) => item.fullCode).filter(Boolean);
        setMatchedCodes(codes);
      } catch {
        setMatchedCodes([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    // 清理函数
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [searchQuery]);

  // ---- 清除搜索 ----
  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setMatchedCodes([]);
    setSearchLoading(false);
  }, []);

  // ---- 合并进行中 + 已归档 Rounds ----
  const allCards = useMemo<TCardData[]>(() => {
    const cards: TCardData[] = [];

    // 1) 进行中 Round（从撮合引擎结果中取非 CLEARED 状态）
    for (const stream of streamResults) {
      if (stream.status === 'CLEARED') continue;
      const existingRounds = tRounds.filter((r) => r.fullCode === stream.fullCode);
      const roundNo = existingRounds.length + 1;

      // 倒T卖出均价
      let avgSellPrice = 0;
      if (stream.mode === 'short') {
        const sells = stream.entries.filter((e) => e.direction === 'sell');
        if (sells.length > 0) {
          const totalVal = sells.reduce((s, e) => s + e.price * e.amount, 0);
          const totalQty = sells.reduce((s, e) => s + e.amount, 0);
          avgSellPrice = totalQty > 0 ? totalVal / totalQty : 0;
        }
      }

      cards.push({
        id: `active-${stream.fullCode}`,
        source: 'active',
        stockName: stream.stockName,
        fullCode: stream.fullCode,
        roundNo,
        mode: stream.mode,
        status: 'open',
        netProfit: stream.transferProfit,
        fees: stream.totalFee,
        avgPrice: stream.avgPrice,
        buyAmount: stream.buyAmount,
        sellAmount: stream.sellAmount,
        tradeCount: stream.tradeCount,
        win: stream.transferProfit >= 0,
        openedAt: stream.openedAt ?? stream.entries[0]?.timestamp ?? new Date().toISOString(),
        netPendingAmount: stream.netPendingAmount,
        weightedBuyCost: stream.weightedBuyCost,
        shortPendingAmount: stream.shortPendingAmount,
        avgSellPrice,
        entries: stream.entries,
      });
    }

    // 2) 已归档 Round
    for (const round of tRounds) {
      cards.push({
        id: `archived-${round.id}`,
        source: 'archived',
        stockName: round.stockName,
        fullCode: round.fullCode,
        roundNo: round.roundNo,
        mode: round.mode,
        status: 'closed',
        settleType: round.settleType,
        netProfit: round.netProfit,
        fees: round.fees,
        avgPrice: round.avgPrice,
        buyAmount: round.buyAmount,
        sellAmount: round.sellAmount,
        tradeCount: round.tradeCount,
        win: round.win,
        openedAt: round.openedAt,
        closedAt: round.closedAt,
        entries: round.transactions,
      });
    }

    // 按开启时间倒序（浅拷贝后排序，避免原位修改）
    return [...cards].sort(
      (a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime()
    );
  }, [streamResults, tRounds]);

  // ---- 筛选（链式组合：搜索 → 方向/状态 → 时间范围，任一不匹配即排除） ----
  const filteredCards = useMemo(() => {
    const hasSearch = searchQuery.trim().length > 0;

    return allCards.filter((card) => {
      // 1. 搜索框过滤：使用 searchStocks API 返回的 matchedCodes 进行精准匹配
      if (hasSearch) {
        const isMatch = matchedCodes.includes(card.fullCode);
        if (!isMatch) return false;
      }

      // 2. 方向/状态过滤（正T/倒T × 进行中/已完成）
      if (directionTab !== 'all') {
        const dirOk =
          (directionTab === 'long_open' && card.mode === 'long' && card.status === 'open') ||
          (directionTab === 'long_closed' && card.mode === 'long' && card.status === 'closed') ||
          (directionTab === 'short_open' && card.mode === 'short' && card.status === 'open') ||
          (directionTab === 'short_closed' && card.mode === 'short' && card.status === 'closed');
        if (!dirOk) return false;
      }

      // 3. 时间范围过滤（近7天 / 近30天 / 本月 / 全部）
      if (timeFilter !== 'all') {
        const now = new Date();
        const d = new Date(card.openedAt);
        if (timeFilter === '7d' && now.getTime() - d.getTime() > 7 * 86400000) return false;
        if (timeFilter === '30d' && now.getTime() - d.getTime() > 30 * 86400000) return false;
        if (timeFilter === 'month' && (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth())) return false;
      }

      return true;
    });
  }, [allCards, searchQuery, matchedCodes, directionTab, timeFilter]);

  const visibleCards = filteredCards.slice(0, visibleCount);

  // ---- 模块 1：做 T 交易维度统计 (T-Trading Overall) ----
  const tStats = useMemo(() => {
    const closedCards = allCards.filter((c) => c.status === 'closed');
    const totalNetProfit = closedCards.reduce((sum, c) => sum + c.netProfit, 0);
    const totalClosedCount = closedCards.length;
    const winCount = closedCards.filter((c) => c.win).length;
    const loseCount = totalClosedCount - winCount;
    const winRate = totalClosedCount > 0 ? (winCount / totalClosedCount) * 100 : 0;
    const totalFees = allCards.reduce((sum, c) => sum + c.fees, 0);
    return { totalNetProfit, totalClosedCount, winCount, loseCount, winRate, totalFees };
  }, [allCards]);

  // ---- 模块 2：仓位维度统计 (Position Overall) ----
  const positionStats = useMemo(() => {
    const openPositions = positions.filter((p) => !p.isClosed);
    const closedPositions = positions.filter((p) => p.isClosed);
    const openCount = openPositions.length;
    const closedCount = closedPositions.length;
    const activeCapital = openPositions.reduce((sum, p) => sum + p.currentAmount * p.currentCost, 0);
    const closedCapital = closedPositions.reduce((sum, p) => sum + (p.totalInvested ?? 0), 0);
    const totalProfit = positions.reduce((sum, p) => sum + (p.realizedPnL ?? 0), 0);
    return { openCount, closedCount, activeCapital, closedCapital, totalProfit };
  }, [positions]);

  const toggleExpand = (id: string) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };

  // ---- 仓位筛选 ----
  const filteredPositions = useMemo(() => {
    return positions.filter((p) => {
      if (positionFilter === 'open') return !p.isClosed;
      if (positionFilter === 'closed') return p.isClosed;
      return true;
    });
  }, [positions, positionFilter]);

  // ---- 格式化工具 ----
  const fmtProfit = (val: number) =>
    `${val >= 0 ? '+' : ''}¥${val.toFixed(2)}`;

  const fmtRate = (num: number, denom: number) => {
    if (!denom || denom === 0) return '--';
    const pct = (num / denom) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  };

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('zh-CN');
    } catch {
      return '--';
    }
  };
  const fmtDateTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('zh-CN');
    } catch {
      return '--';
    }
  };

  // ---- 渲染卡片核心数据网格 ----
  const renderDataGrid = (card: TCardData) => {
    if (card.mode === 'long' && card.status === 'open') {
      // 正T · 进行中
      return (
        <>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">待对冲股数</div>
            <div className="mt-1.5 text-base font-semibold text-slate-100">
              {card.netPendingAmount != null ? card.netPendingAmount.toLocaleString() : '--'}
              <span className="text-xs font-normal text-slate-400"> 股</span>
            </div>
          </div>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">买入加权均价</div>
            <div className="mt-1.5 text-base font-semibold text-slate-100">
              {card.weightedBuyCost != null ? `¥${card.weightedBuyCost.toFixed(2)}` : '--'}
            </div>
          </div>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">当前浮动盈亏</div>
            <div className={`mt-1.5 text-base font-semibold ${card.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {fmtProfit(card.netProfit)}
            </div>
          </div>
        </>
      );
    }
    if (card.mode === 'long' && card.status === 'closed') {
      // 正T · 已完成
      const rate = fmtRate(card.netProfit, card.avgPrice * card.sellAmount);
      return (
        <>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">落袋纯收益</div>
            <div className={`mt-1.5 text-base font-semibold ${card.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {fmtProfit(card.netProfit)}
            </div>
          </div>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">做T收益率</div>
            <div className="mt-1.5 text-base font-semibold text-slate-100">{rate}</div>
          </div>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">交易笔数</div>
            <div className="mt-1.5 text-base font-semibold text-slate-100">
              {card.tradeCount} 笔
            </div>
          </div>
        </>
      );
    }
    if (card.mode === 'short' && card.status === 'open') {
      // 倒T · 进行中
      const pos = positions.find((p) => p.fullCode === card.fullCode && !p.isClosed);
      const baseLabel = pos && pos.currentAmount > 0 ? '正常占用' : '底仓出空';
      const baseStyle = pos && pos.currentAmount > 0
        ? 'bg-blue-500/10 text-blue-300'
        : 'bg-amber-500/10 text-amber-300';
      return (
        <>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">已卖出待买回</div>
            <div className="mt-1.5 text-base font-semibold text-slate-100">
              {card.shortPendingAmount != null ? card.shortPendingAmount.toLocaleString() : '--'}
              <span className="text-xs font-normal text-slate-400"> 股</span>
            </div>
          </div>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">卖出加权均价</div>
            <div className="mt-1.5 text-base font-semibold text-slate-100">
              {card.avgSellPrice != null && card.avgSellPrice > 0
                ? `¥${card.avgSellPrice.toFixed(2)}`
                : '--'}
            </div>
          </div>
          <div className="rounded-2xl bg-slate-950/80 p-3">
            <div className="text-[11px] text-slate-500">底仓状态</div>
            <div className="mt-1.5">
              <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${baseStyle}`}>
                {baseLabel}
              </span>
            </div>
          </div>
        </>
      );
    }
    // 倒T · 已完成
    const rate = fmtRate(card.netProfit, card.avgPrice * card.sellAmount);
    return (
      <>
        <div className="rounded-2xl bg-slate-950/80 p-3">
          <div className="text-[11px] text-slate-500">落袋纯收益</div>
          <div className={`mt-1.5 text-base font-semibold ${card.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {fmtProfit(card.netProfit)}
          </div>
        </div>
        <div className="rounded-2xl bg-slate-950/80 p-3">
          <div className="text-[11px] text-slate-500">做T收益率</div>
          <div className="mt-1.5 text-base font-semibold text-slate-100">{rate}</div>
        </div>
        <div className="rounded-2xl bg-slate-950/80 p-3">
          <div className="text-[11px] text-slate-500">交易笔数</div>
          <div className="mt-1.5 text-base font-semibold text-slate-100">
            {card.tradeCount} 笔
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="page-container space-y-5 pb-8">
      {/* 顶部 Tab 切换导航 */}
      <div className="flex rounded-2xl bg-slate-800/80 p-1">
        <button
          type="button"
          onClick={() => setTab('trades')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium transition ${
            tab === 'trades'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <BarChart3 className="h-4 w-4" />
          <span>做T账本统计</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('positions')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium transition ${
            tab === 'positions'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Wallet className="h-4 w-4" />
          <span>仓位数据统计</span>
        </button>
      </div>

      {/* =============================== */}
      {/* 做T账本统计 */}
      {/* =============================== */}
      {tab === 'trades' ? (
        <div className="space-y-4">
          {/* ===== 模块 1：做 T 交易维度统计 (T-Trading Overall) ===== */}
          <div className="rounded-[28px] border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600/20">
                <BarChart3 className="h-4 w-4 text-blue-400" />
              </div>
              <span className="text-sm font-semibold text-slate-200">做 T 交易维度统计</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {/* 做T净利润 */}
              <div className="rounded-2xl bg-slate-950/80 p-3">
                <div className="text-[11px] text-slate-500">做T净利润</div>
                <div className={`mt-1.5 text-lg font-bold ${tStats.totalNetProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {tStats.totalClosedCount > 0
                    ? `${tStats.totalNetProfit >= 0 ? '+' : ''}¥${tStats.totalNetProfit.toFixed(2)}`
                    : '--'}
                </div>
              </div>
              {/* 累计做T笔数（成功/失败） */}
              <div className="rounded-2xl bg-slate-950/80 p-3">
                <div className="text-[11px] text-slate-500">累计做T笔数</div>
                <div className="mt-1.5 text-lg font-bold text-slate-100">
                  {tStats.totalClosedCount > 0
                    ? `${tStats.totalClosedCount} 笔`
                    : '--'}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {tStats.totalClosedCount > 0
                    ? `${tStats.winCount} 胜 / ${tStats.loseCount} 负`
                    : ''}
                </div>
              </div>
              {/* 做T胜率 */}
              <div className="rounded-2xl bg-slate-950/80 p-3">
                <div className="text-[11px] text-slate-500">做T胜率</div>
                <div className={`mt-1.5 text-lg font-bold ${tStats.winRate >= 50 ? 'text-green-400' : 'text-amber-400'}`}>
                  {tStats.totalClosedCount > 0
                    ? `${tStats.winRate.toFixed(1)}%`
                    : '0.0%'}
                </div>
              </div>
              {/* 摩擦成本总额 */}
              <div className="rounded-2xl bg-slate-950/80 p-3">
                <div className="text-[11px] text-slate-500">摩擦成本总额</div>
                <div className="mt-1.5 text-lg font-bold text-slate-100">
                  ¥{tStats.totalFees.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* 搜索与筛选栏 */}
          <div className="space-y-3">
            {/* 搜索输入框（使用 searchStocks API + 300ms debounce） */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="search"
                inputMode="search"
                autoComplete="off"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="输入股票代码或名称搜索（如：茅台 / 600519）"
                className="w-full rounded-3xl border border-slate-800 bg-slate-950/90 py-3 pl-11 pr-11 text-sm text-slate-100 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                {/* 加载中指示器 */}
                {searchLoading && (
                  <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                )}
                {/* 清除按钮 */}
                {searchQuery && !searchLoading && (
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    className="text-slate-500 hover:text-slate-200"
                    aria-label="清除搜索"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* 搜索结果提示 */}
            {searchQuery.trim().length > 0 && !searchLoading && (
              <div className="text-xs text-slate-500 px-1">
                {matchedCodes.length > 0
                  ? `找到 ${matchedCodes.length} 只匹配股票`
                  : '未找到匹配的股票'}
              </div>
            )}

            {/* 方向/状态切换胶囊 Tab */}
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
              {directionTabs.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setDirectionTab(item.value)}
                  className={`flex-shrink-0 whitespace-nowrap rounded-full border px-4 py-2 text-sm transition ${
                    directionTab === item.value
                      ? 'border-blue-500 bg-blue-600 text-white'
                      : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* 时间快捷筛选 */}
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
              {timeTabs.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setTimeFilter(item.value)}
                  className={`flex-shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm transition ${
                    timeFilter === item.value
                      ? 'bg-slate-100 text-slate-950'
                      : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* 卡片列表 */}
          <div className="space-y-4">
            {visibleCards.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-8 text-center text-sm text-slate-500">
                当前筛选条件下暂无做T记录，您可以调整搜索或筛选条件查看历史卡片。
              </div>
            ) : (
              <>
                {visibleCards.map((card) => {
                  const isActive = card.status === 'open';
                  // 状态 badge
                  let statusLabel = isActive ? '进行中' : '已完成';
                  let statusStyle = isActive
                    ? 'bg-blue-500/10 text-blue-300'
                    : 'bg-slate-700 text-slate-300';
                  if (card.status === 'closed' && card.settleType === 'transfer') {
                    statusLabel = '划转';
                    statusStyle = 'bg-purple-500/10 text-purple-300';
                  }

                  return (
                    <div
                      key={card.id}
                      className="rounded-[28px] border border-slate-800 bg-slate-900 p-4 shadow-sm"
                    >
                      {/* 卡片头部 */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="truncate font-medium text-slate-100">
                              {card.stockName || '未命名'}
                            </span>
                            {card.fullCode && (
                              <span className="flex-shrink-0 rounded-full bg-slate-950 px-2 py-0.5 text-xs text-slate-400">
                                {card.fullCode}
                              </span>
                            )}
                            <span className="flex-shrink-0 rounded-full bg-slate-950 px-2 py-0.5 text-xs text-slate-400">
                              Round {card.roundNo}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex rounded-full px-3 py-0.5 text-xs font-medium ${
                                card.mode === 'long'
                                  ? 'bg-red-500/10 text-red-300'
                                  : 'bg-green-500/10 text-green-300'
                              }`}
                            >
                              {card.mode === 'long' ? '正T' : '倒T'}
                            </span>
                            <span
                              className={`inline-flex rounded-full px-3 py-0.5 text-xs font-medium ${statusStyle}`}
                            >
                              {statusLabel}
                            </span>
                          </div>
                        </div>
                        <div className="flex-shrink-0 text-right text-xs text-slate-500">
                          {fmtDate(card.openedAt)}
                        </div>
                      </div>

                      {/* 核心数据网格 */}
                      <div className="mt-4 grid grid-cols-3 gap-3">
                        {renderDataGrid(card)}
                      </div>

                      {/* 底部折叠区 */}
                      <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-3">
                        <button
                          type="button"
                          onClick={() => toggleExpand(card.id)}
                          className="flex w-full items-center justify-between gap-3 text-sm font-medium text-slate-300"
                        >
                          <span className="flex items-center gap-2">
                            <span>查看做T流水细节</span>
                            <span className="text-xs text-slate-500">
                              ({card.entries.length} 条)
                            </span>
                          </span>
                          {expandedIds.has(card.id) ? (
                            <ChevronUp className="h-4 w-4 flex-shrink-0" />
                          ) : (
                            <ChevronDown className="h-4 w-4 flex-shrink-0" />
                          )}
                        </button>
                        {expandedIds.has(card.id) && (
                          <div className="mt-3 space-y-3 border-t border-slate-800 pt-3">
                            {card.entries.map((entry, idx) => {
                              const dir = entry.direction;
                              const dirLabel = dir === 'buy' ? '买入' : dir === 'sell' ? '卖出' : '划转';
                              const dirColor = dir === 'buy' ? 'text-red-300' : dir === 'sell' ? 'text-green-300' : 'text-slate-300';
                              return (
                                <div
                                  key={entry.id ?? idx}
                                  className="rounded-2xl bg-slate-900 p-3 text-sm"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${dirColor} bg-slate-800`}>
                                      {dirLabel}
                                    </span>
                                    <span className="text-xs text-slate-500">
                                      {fmtDateTime(entry.timestamp)}
                                    </span>
                                  </div>
                                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                                    <div className="text-slate-400">
                                      成交价
                                      <span className="ml-1 text-slate-100">
                                        ¥{entry.price.toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="text-slate-400">
                                      股数
                                      <span className="ml-1 text-slate-100">
                                        {entry.amount.toLocaleString()}
                                      </span>
                                    </div>
                                    <div className="text-slate-400">
                                      规费
                                      <span className="ml-1 text-slate-100">
                                        ¥{entry.fee.toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="text-slate-400">
                                      对冲盈亏
                                      <span className={`ml-1 ${entry.realizedProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        {entry.realizedProfit >= 0 ? '+' : ''}¥{entry.realizedProfit.toFixed(2)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* 查看更多按钮 */}
                {filteredCards.length > visibleCount && (
                  <div className="flex justify-center pt-2">
                    <button
                      type="button"
                      onClick={() => setVisibleCount((prev) => prev + 10)}
                      className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-6 py-3 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white"
                    >
                      查看更多历史卡片
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        /* =============================== */
        /* 仓位数据统计 */
        /* =============================== */
        <div className="space-y-4">
          {/* ===== 模块 2：仓位维度统计 (Position Overall) ===== */}
          <div className="rounded-[28px] border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600/20">
                <Wallet className="h-4 w-4 text-emerald-400" />
              </div>
              <span className="text-sm font-semibold text-slate-200">仓位维度统计</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {/* 累计仓位（开启/完结数量） */}
              <div className="rounded-2xl bg-slate-950/80 p-3">
                <div className="text-[11px] text-slate-500">累计仓位</div>
                <div className="mt-1.5 text-lg font-bold text-slate-100">
                  {positionStats.openCount + positionStats.closedCount > 0
                    ? `总 ${positionStats.openCount + positionStats.closedCount} 个`
                    : '--'}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  开启 {positionStats.openCount} / 完结 {positionStats.closedCount}
                </div>
              </div>
              {/* 投入总额（开启 / 完结） */}
              <div className="rounded-2xl bg-slate-950/80 p-3">
                <div className="text-[11px] text-slate-500">投入总额（开启/完结）</div>
                <div className="mt-1.5 text-sm font-bold text-slate-100 leading-tight">
                  <div>¥{positionStats.activeCapital.toFixed(2)}</div>
                  <div className="text-xs font-normal text-slate-500">/ ¥{positionStats.closedCapital.toFixed(2)}</div>
                </div>
              </div>
              {/* 仓位累计利润 */}
              <div className="rounded-2xl bg-slate-950/80 p-3">
                <div className="text-[11px] text-slate-500">仓位累计利润</div>
                <div className={`mt-1.5 text-lg font-bold ${positionStats.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {positionStats.totalProfit >= 0 ? '+' : ''}¥{positionStats.totalProfit.toFixed(2)}
                </div>
              </div>
              {/* 开启仓位实时资金占用 */}
              <div className="rounded-2xl bg-slate-950/80 p-3">
                <div className="text-[11px] text-slate-500">开启资金占用</div>
                <div className="mt-1.5 text-lg font-bold text-blue-400">
                  ¥{positionStats.activeCapital.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* 顶部切换 Tab */}
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {positionTabs.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setPositionFilter(item.value)}
                className={`flex-shrink-0 whitespace-nowrap rounded-full border px-4 py-2 text-sm transition ${
                  positionFilter === item.value
                    ? 'border-blue-500 bg-blue-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* 仓位卡片列表 */}
          <div className="space-y-4">
            {filteredPositions.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-8 text-center text-sm text-slate-500">
                暂无仓位数据
              </div>
            ) : (
              <>
                {filteredPositions.slice(0, visibleCount).map((position) => {
                  const openBatch = position.batches.find(
                    (b: PositionBatch) => b.type === 'open' || b.type === 'add'
                  );
                  const originalCost = openBatch?.price ?? position.currentCost;
                  const currentValue =
                    position.currentAmount != null && position.currentCost != null
                      ? position.currentAmount * position.currentCost
                      : null;
                  const totalProfit = position.realizedPnL ?? null;

                  let statusLabel = '正常持仓';
                  let statusStyle = 'bg-blue-500/10 text-blue-300';
                  if (position.isClosed) {
                    statusLabel = '结案';
                    statusStyle = 'bg-slate-700 text-slate-300';
                  } else if (position.currentAmount === 0) {
                    statusLabel = '底仓出空';
                    statusStyle = 'bg-amber-500/10 text-amber-300';
                  }

                  return (
                    <div
                      key={position.id}
                      className="rounded-[28px] border border-slate-800 bg-slate-900 p-4 shadow-sm"
                    >
                      {/* 卡片头部 */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="truncate font-medium text-slate-100">
                              {position.stockName}
                            </span>
                            {position.fullCode && (
                              <span className="flex-shrink-0 rounded-full bg-slate-950 px-2 py-0.5 text-xs text-slate-400">
                                {position.fullCode}
                              </span>
                            )}
                            <span
                              className={`inline-flex flex-shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle}`}
                            >
                              {statusLabel}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* 核心数据网格 */}
                      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="rounded-2xl bg-slate-950/80 p-3">
                          <div className="text-[11px] text-slate-500">持仓股数</div>
                          <div className="mt-1 text-sm font-semibold text-slate-100">
                            {position.currentAmount?.toLocaleString() ?? '--'}
                            <span className="text-xs font-normal text-slate-400"> 股</span>
                          </div>
                        </div>
                        <div className="rounded-2xl bg-slate-950/80 p-3">
                          <div className="text-[11px] text-slate-500">原始成本→最新均价</div>
                          <div className="mt-1 text-sm font-semibold text-slate-100">
                            ¥{originalCost.toFixed(3)}
                            <span className="mx-1 text-xs text-slate-500">→</span>
                            <span
                              className={`${
                                position.currentCost < originalCost
                                  ? 'text-green-400'
                                  : position.currentCost > originalCost
                                    ? 'text-red-400'
                                    : 'text-slate-100'
                              }`}
                            >
                              ¥{position.currentCost.toFixed(3)}
                            </span>
                          </div>
                        </div>
                        <div className="rounded-2xl bg-slate-950/80 p-3">
                          <div className="text-[11px] text-slate-500">累计做T回馈</div>
                          <div
                            className={`mt-1 text-sm font-semibold ${
                              totalProfit != null
                                ? totalProfit >= 0
                                  ? 'text-green-400'
                                  : 'text-red-400'
                                : 'text-slate-100'
                            }`}
                          >
                            {totalProfit != null
                              ? `${totalProfit >= 0 ? '+' : ''}¥${totalProfit.toFixed(2)}`
                              : '--'}
                          </div>
                        </div>
                        <div className="rounded-2xl bg-slate-950/80 p-3">
                          <div className="text-[11px] text-slate-500">{position.isClosed ? '总结算收益' : '当前市值'}</div>
                          <div className="mt-1 text-sm font-semibold text-slate-100">
                            {currentValue != null ? `¥${currentValue.toFixed(2)}` : '--'}
                          </div>
                        </div>
                      </div>

                      {/* 展开明细 */}
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            const next = new Set(expandedIds);
                            if (next.has(position.id)) next.delete(position.id);
                            else next.add(position.id);
                            setExpandedIds(next);
                          }}
                          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
                        >
                          <span>{expandedIds.has(position.id) ? '收起明细' : '展开明细'}</span>
                          {expandedIds.has(position.id) ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>

                      {expandedIds.has(position.id) && (
                        <div className="mt-3 space-y-3 rounded-2xl bg-slate-950/50 p-3 text-sm">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="rounded-2xl bg-slate-900 p-3">
                              <div className="text-xs text-slate-500">原始投入成本</div>
                              <div className="mt-1 text-slate-100">
                                {position.totalInvested != null
                                  ? `¥${position.totalInvested.toFixed(2)}`
                                  : '--'}
                              </div>
                            </div>
                            <div className="rounded-2xl bg-slate-900 p-3">
                              <div className="text-xs text-slate-500">建仓批次</div>
                              <div className="mt-1 text-slate-100">
                                {position.batches.length} 笔
                              </div>
                            </div>
                          </div>
                          {position.batches.length > 0 && (
                            <div className="rounded-2xl bg-slate-900 p-3">
                              <div className="mb-2 text-xs text-slate-500">建仓历史</div>
                              <div className="space-y-2">
                                {position.batches
                                  .slice()
                                  .reverse()
                                  .slice(0, 5)
                                  .map((batch: PositionBatch) => (
                                    <div
                                      key={batch.id}
                                      className="flex items-center justify-between text-xs text-slate-400"
                                    >
                                      <span>
                                        {batch.type === 'open'
                                          ? '建仓'
                                          : batch.type === 'add'
                                            ? '加仓'
                                            : batch.type === 'reduce'
                                              ? '减仓'
                                              : '结清'}
                                        {' · '}
                                        ¥{batch.price.toFixed(2)} × {batch.amount} 股
                                      </span>
                                      <span className="text-slate-500">
                                        {fmtDate(batch.timestamp)}
                                      </span>
                                    </div>
                                  ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {filteredPositions.length > visibleCount && (
                  <div className="flex justify-center pt-2">
                    <button
                      type="button"
                      onClick={() => setVisibleCount((prev) => prev + 10)}
                      className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-6 py-3 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white"
                    >
                      查看更多历史卡片
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}