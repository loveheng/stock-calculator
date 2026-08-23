/**
 * @file PlanOrderCard.tsx
 * @description 计划单卡片组件：展示计划单详情、实时价格对比、底层仓位对比、执行前后模拟。
 *              支持在短线交易页（TCalculator）、中长期交易页（CostAveraging）和首页（Home）中复用。
 *              移动端默认折叠，仅显示关键信息（价格/数量/剩余天数），点击展开全部内容。
 * @layer UI
 * @storage_impact 不直接读写 IndexedDB，通过回调与父组件通信。
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Edit3, CheckCircle, XCircle, Clock, TrendingUp, TrendingDown, AlertTriangle, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import type { PlannedOrder, Position } from '../store/types';
import { evaluateDynamicPyramid, type DynamicPyramidResult, type FeeConfig } from '../utils/mathUtils';
import type { StockQuoteSummary } from '../types/stock';
import { calcBatchExecution } from '../store/utils';
import {
  findLatestShortProject,
  computeShortTermTrial,
  type ShortTrialProject,
  type ShortTrialResult,
} from '../utils/shortTermTrial';
import ConfirmModal from './ui/ConfirmModal';

/** 计划单方向徽章配色 */
const DIRECTION_STYLES: Record<string, string> = {
  buy: 'bg-blue-500/20 text-blue-400',
  sell: 'bg-purple-500/20 text-purple-400',
};

/** 计划单方向标签 */
const DIRECTION_LABELS: Record<string, string> = {
  buy: '买入',
  sell: '卖出',
};

/** 计划单状态徽章配色 */
const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-500/15 text-green-400',
  expired: 'bg-slate-500/15 text-slate-400',
  executed: 'bg-blue-500/15 text-blue-400',
  cancelled: 'bg-slate-500/10 text-slate-500',
};

const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  expired: '已过期',
  executed: '已执行',
  cancelled: '已取消',
};

interface PlanOrderCardProps {
  order: PlannedOrder;
  /** 当前行情（可为 null 表示无行情） */
  quote?: StockQuoteSummary | null;
  /** 当前持仓（用于显示底层仓位对比） */
  position?: Position | null;
  /** 费率配置（用于计算执行后模拟） */
  feeConfig?: FeeConfig | null;
  /** 短线项目池（进行中的短期项目，仅短线计划单用于短线试算匹配） */
  shortProjects?: ShortTrialProject[];
  /** 编辑回调 */
  onEdit?: (order: PlannedOrder) => void;
  /** 执行回调：用户确认执行后，传入实际价格/数量/备注 */
  onExecute?: (order: PlannedOrder, actualPrice: number, actualAmount: number, note: string) => void;
  /** 取消计划单回调 */
  onCancel?: (id: string) => void;
  /** 跳转到对应页面回调（首页快速执行时使用） */
  onNavigate?: (order: PlannedOrder) => void;
}

/**
 * 格式化金额缩写（万/亿）
 */
function formatAmount(value: number): string {
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return value.toFixed(0);
}

/**
 * 计划单卡片组件。
 * 移动端默认折叠，仅显示关键信息；点击展开全部内容。
 * 桌面端默认展开。
 */
export default function PlanOrderCard({
  order,
  quote,
  position,
  feeConfig,
  shortProjects,
  onEdit,
  onExecute,
  onCancel,
  onNavigate,
}: PlanOrderCardProps) {
  // 折叠状态：移动端默认折叠，桌面端默认展开
  const [collapsed, setCollapsed] = useState(true);
  const [isMobile, setIsMobile] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    setIsMobile(mq.matches);
    setCollapsed(mq.matches);
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setCollapsed(e.matches);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const [showExecuteModal, setShowExecuteModal] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [execPrice, setExecPrice] = useState(String(order.plannedPrice));
  const [execAmount, setExecAmount] = useState(String(order.plannedAmount));
  const [execNote, setExecNote] = useState('');

  // 当前现价
  const currentPrice = quote?.currentPrice ?? 0;
  const hasQuote = currentPrice > 0;
  // 【短线/中长期强隔离】短线计划单不参与任何中长期成本摊薄试算
  const isShortTerm = order.context === 'short-term';

  // 计划价 vs 现价对比
  const priceDiff = hasQuote ? currentPrice - order.plannedPrice : 0;
  const diffPercent = hasQuote && order.plannedPrice > 0 ? (priceDiff / order.plannedPrice) * 100 : 0;

  // 计划金额
  const plannedTotal = order.plannedPrice * order.plannedAmount;

  // 过期倒计时
  const now = Date.now();
  const expiresAt = new Date(order.expiresAt).getTime();
  const remainingMs = expiresAt - now;
  const remainingDays = remainingMs > 0 ? Math.ceil(remainingMs / 86400000) : 0;
  const isExpiredDisplay = order.status === 'expired' || (order.status === 'active' && remainingMs <= 0);

  // 执行弹窗校验
  const execPriceNum = Number(execPrice);
  const execAmountNum = Number(execAmount);
  const execValid = execPriceNum > 0 && execAmountNum > 0;

  // 执行后模拟计算（中长期上下文，执行弹窗用）
  // 【短线/中长期强隔离】短线计划单不参与 calcBatchExecution，返回 null
  const execSimulation = useMemo(() => {
    if (!position || position.isClosed || !feeConfig || isShortTerm) return null;
    if (execPriceNum <= 0 || execAmountNum <= 0) return null;
    const type = order.direction === 'buy' ? 'add' : 'reduce';
    try {
      return calcBatchExecution(position, type, execPriceNum, execAmountNum, feeConfig);
    } catch (e) {
      console.warn('[PlanOrderCard] execSimulation calcBatchExecution error:', e);
      return null;
    }
  }, [position, feeConfig, order.context, order.direction, execPriceNum, execAmountNum]);

  // 试算预览（活跃计划卡片上用计划价模拟）
  // 【短线/中长期强隔离】短线计划单不参与 calcBatchExecution，返回 null
  const trialSimulation = useMemo(() => {
    if (!position || position.isClosed || !feeConfig || isShortTerm || order.status !== 'active') return null;
    const type = order.direction === 'buy' ? 'add' : 'reduce';
    try {
      return calcBatchExecution(position, type, order.plannedPrice, order.plannedAmount, feeConfig);
    } catch (e) {
      console.warn('[PlanOrderCard] trialSimulation calcBatchExecution error:', e, { position, type, price: order.plannedPrice, amount: order.plannedAmount });
      return null;
    }
  }, [position, feeConfig, order.context, order.direction, order.status, order.plannedPrice, order.plannedAmount]);

  // 动态金字塔/加仓健康度（仅中长期买入计划单事前试算）
  // 【短线/中长期强隔离】短线计划单不参与，仅在中长期加仓且已有买入批次时评估
  const pyramidHealth = useMemo<DynamicPyramidResult | null>(() => {
    if (!position || position.isClosed || isShortTerm || order.status !== 'active' || order.direction !== 'buy') return null;
    if (order.plannedPrice <= 0 || order.plannedAmount <= 0) return null;
    const buyBatches = position.batches.filter((b) => (b.type === 'open' || b.type === 'add') && b.amount > 0 && b.price > 0);
    if (!buyBatches.length) return null;
    try {
      return evaluateDynamicPyramid(buyBatches, { price: order.plannedPrice, amount: order.plannedAmount });
    } catch (e) {
      console.warn('[PlanOrderCard] evaluateDynamicPyramid error:', e);
      return null;
    }
  }, [position, isShortTerm, order.status, order.direction, order.plannedPrice, order.plannedAmount]);

  // 短线试算：匹配已匹配的最新进行中的短期项目（按 openedAt 倒序）
  // 【短线/中长期强隔离】仅依赖短线项目池，绝不读取中长期底仓
  const matchedProject = useMemo(
    () => (shortProjects ? findLatestShortProject(order.fullCode, shortProjects) : null),
    [shortProjects, order.fullCode],
  );

  // 【短线/中长期强隔离】短线试算引擎：严格按分支逻辑计算，杜绝向下穿透到底仓
  const trialResult = useMemo<ShortTrialResult | null>(() => {
    if (!isShortTerm || order.status !== 'active') return null;
    if (order.plannedPrice <= 0 || order.plannedAmount <= 0) return null;
    try {
      return computeShortTermTrial(
        order.direction,
        order.plannedPrice,
        order.plannedAmount,
        order.fullCode,
        order.stockName,
        matchedProject,
        feeConfig,
      );
    } catch (e) {
      console.warn('[PlanOrderCard] computeShortTermTrial error:', e);
      return null;
    }
  }, [
    isShortTerm,
    order.status,
    order.direction,
    order.plannedPrice,
    order.plannedAmount,
    order.fullCode,
    order.stockName,
    matchedProject,
    feeConfig,
  ]);

  const handleExecuteConfirm = () => {
    if (!execValid) return;
    onExecute?.(order, execPriceNum, execAmountNum, execNote);
    setShowExecuteModal(false);
  };

  // 计算差额是否「利好」
  const isFavorable = order.direction === 'buy' ? priceDiff <= 0 : priceDiff >= 0;

  // 已执行统计
  const executedQty = order.actual?.actualAmount ?? 0;
  const executedTotal = order.actual ? order.actual.actualPrice * order.actual.actualAmount : 0;

  return (
    <div className={`bg-slate-900 rounded-lg border overflow-hidden ${
      order.status === 'executed'
        ? 'border-blue-700/50'
        : isExpiredDisplay
          ? 'border-slate-700/40'
          : 'border-slate-700'
    }`}>
      {/* ========== 折叠头部（始终可见） ========== */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full text-left focus:outline-none"
      >
        <div className="flex items-center justify-between p-3 pb-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-slate-200 truncate">{order.stockName}</span>
            <span className="text-[10px] text-slate-500 font-mono shrink-0">{order.fullCode}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${DIRECTION_STYLES[order.direction]}`}>
              {DIRECTION_LABELS[order.direction]}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_STYLES[order.status]}`}>
              {STATUS_LABELS[order.status]}
            </span>
            {order.context === 'short-term' && (
              <span className="text-[10px] text-sky-400 bg-sky-500/10 px-1.5 py-0.5 rounded">短线</span>
            )}
            {order.context === 'long-term' && (
              <span className="text-[10px] text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded">中长期</span>
            )}
            {order.context === 'both' && (
              <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">通用</span>
            )}
            {collapsed ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            )}
          </div>
        </div>

        {/* 计划内容（关键信息，始终可见） */}
        <div className="px-3 pb-2">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-slate-100 tabular-nums">
              ¥{order.plannedPrice.toFixed(2)}
            </span>
            <span className="text-xs text-slate-500">×</span>
            <span className="text-sm font-medium text-slate-300 tabular-nums">
              {order.plannedAmount.toLocaleString()}股
            </span>
            {!collapsed && (
              <span className="text-xs text-slate-500 ml-auto tabular-nums">
                = ¥{plannedTotal.toFixed(0)}
              </span>
            )}
          </div>

          {/* 折叠时：紧凑摘要行 */}
          {collapsed && (
            <div className="flex items-center gap-3 mt-1">
              {/* 剩余天数/过期状态 */}
              {order.status === 'active' && remainingDays > 0 ? (
                <span className="text-[10px] text-slate-500 flex items-center gap-0.5">
                  <Clock className="w-2.5 h-2.5" />
                  剩余 {remainingDays} 天
                </span>
              ) : order.status === 'active' && remainingDays <= 0 ? (
                <span className="text-[10px] text-amber-400 flex items-center gap-0.5">
                  <AlertTriangle className="w-2.5 h-2.5" />已过期
                </span>
              ) : order.status === 'executed' && order.actual ? (
                <span className="text-[10px] text-blue-400 flex items-center gap-0.5">
                  <CheckCircle className="w-2.5 h-2.5" />
                  实¥{order.actual.actualPrice.toFixed(2)} × {order.actual.actualAmount}股
                </span>
              ) : order.status === 'expired' ? (
                <span className="text-[10px] text-slate-500">已过期</span>
              ) : null}

              {/* 价格差额（紧凑） */}
              {hasQuote && order.status === 'active' && (
                <span className={`text-[10px] font-medium ${isFavorable ? 'text-green-400' : 'text-amber-400'}`}>
                  {diffPercent >= 0 ? '+' : ''}{diffPercent.toFixed(1)}%
                </span>
              )}

              {/* 达成状态（已执行） */}
              {order.status === 'executed' && order.actual && (
                <span className="text-[10px] flex items-center gap-0.5">
                  {order.actual.isAchieved ? (
                    <span className="text-green-400">✅ 达成</span>
                  ) : (
                    <span className="text-amber-400">⚠️ 未达成</span>
                  )}
                </span>
              )}
            </div>
          )}

          {order.note && !collapsed && (
            <p className="text-[11px] text-slate-500 italic mt-0.5 truncate">「{order.note}」</p>
          )}
        </div>
      </button>

      {/* ========== 展开内容（折叠时隐藏） ========== */}
      {!collapsed && (
        <>
          {/* 实时对比（仅在有行情时显示） */}
          {hasQuote && (
            <div className="mx-3 mb-2 p-2 rounded-lg bg-slate-800/60">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">当前现价</span>
                <span className={`font-mono tabular-nums font-medium ${
                  quote?.changePercent && quote.changePercent >= 0 ? 'text-red-400' : 'text-green-400'
                }`}>
                  ¥{currentPrice.toFixed(2)}
                  {quote?.changePercent !== undefined && (
                    <span className="ml-1">
                      {quote.changePercent >= 0 ? '+' : ''}{quote.changePercent.toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs mt-1">
                <span className="text-slate-500">计划价</span>
                <span className="font-mono tabular-nums text-slate-300">¥{order.plannedPrice.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-xs mt-1 pt-1 border-t border-slate-700/50">
                <span className="text-slate-500">差额</span>
                <span className={`font-mono tabular-nums font-medium ${isFavorable ? 'text-green-400' : 'text-red-400'}`}>
                  {priceDiff >= 0 ? '+' : ''}¥{priceDiff.toFixed(2)}
                  <span className="ml-1">
                    ({diffPercent >= 0 ? '+' : ''}{diffPercent.toFixed(1)}%)
                  </span>
                </span>
              </div>
              {/* 方向提示 */}
              <div className="mt-1.5 text-[10px] flex items-center gap-1">
                {order.direction === 'buy' ? (
                  priceDiff <= 0 ? (
                    <span className="text-green-400 flex items-center gap-0.5">
                      <TrendingDown className="w-3 h-3" />低于计划价，适合买入
                    </span>
                  ) : (
                    <span className="text-amber-400 flex items-center gap-0.5">
                      <TrendingUp className="w-3 h-3" />高于计划价，可考虑等待
                    </span>
                  )
                ) : (
                  priceDiff >= 0 ? (
                    <span className="text-green-400 flex items-center gap-0.5">
                      <TrendingUp className="w-3 h-3" />高于计划价，适合卖出
                    </span>
                  ) : (
                    <span className="text-amber-400 flex items-center gap-0.5">
                      <TrendingDown className="w-3 h-3" />低于计划价，可考虑等待
                    </span>
                  )
                )}
              </div>
            </div>
          )}

          {/* 底层仓位对比（中长期专用；短线严格隔离，不展示底仓成本/持仓/累计投入） */}
          {!isShortTerm && position && !position.isClosed && (
            <div className="mx-3 mb-2 p-2 rounded-lg bg-slate-800/40 border border-slate-700/40">
              <div className="flex items-center gap-1 text-[10px] text-slate-500 mb-1.5">
                <span>📦 当前底仓</span>
                <span className="text-slate-600">|</span>
                <span className="text-slate-600">成本 ¥{position.currentCost.toFixed(3)}</span>
                <span className="text-slate-600">× {position.currentAmount}股</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">累计投入</span>
                <span className="font-mono text-slate-300">¥{formatAmount(position.totalInvested ?? 0)}</span>
              </div>
              {position.realizedPnL !== undefined && (
                <div className="flex items-center justify-between text-[11px] mt-0.5">
                  <span className="text-slate-500">已实现盈亏</span>
                  <span className={`font-mono ${position.realizedPnL >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {position.realizedPnL >= 0 ? '+' : ''}¥{formatAmount(position.realizedPnL)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 试算预览（活跃计划 + 有持仓 + 中长期，直接用计划价模拟） */}
          {/* 【短线/中长期强隔离】短线计划单不渲染中长期成本摊薄试算面板 */}
          {order.status === 'active' && position && !position.isClosed && feeConfig && !isShortTerm && trialSimulation && (
            <div className="mx-3 mb-2 p-2 rounded-lg bg-emerald-900/20 border border-emerald-700/30">
              <div className="text-[10px] text-emerald-400 mb-1.5 flex items-center gap-1">
                <span>🔮 按计划价试算</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <div className="text-slate-500">执行后成本</div>
                <div className="font-mono text-slate-200 text-right">¥{trialSimulation.newCost.toFixed(3)}</div>
                <div className="text-slate-500">执行后持有</div>
                <div className="font-mono text-slate-200 text-right">{trialSimulation.newAmount.toLocaleString()}股</div>
                <div className="text-slate-500">新增投入</div>
                <div className="font-mono text-slate-200 text-right">¥{formatAmount(trialSimulation.newTotalInvested - (position.totalInvested ?? 0))}</div>
                <div className="text-slate-500">规费</div>
                <div className="font-mono text-amber-400 text-right">¥{trialSimulation.totalFee.toFixed(2)}</div>
              </div>
            </div>
          )}

          {/* 动态金字塔健康度（仅中长期买入计划单事前试算） */}
          {/* 【短线/中长期强隔离】短线计划单不参与，仅在中长期加仓且已有买入批次时展示 */}
          {pyramidHealth && (
            <div className={`mx-3 mb-2 p-2 rounded-lg border ${
              pyramidHealth.level === 'HEALTHY' ? 'bg-emerald-900/20 border-emerald-700/30' :
              pyramidHealth.level === 'NEUTRAL' ? 'bg-amber-900/20 border-amber-700/30' :
              'bg-red-900/20 border-red-700/30'
            }`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider">金字塔健康度</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                    pyramidHealth.level === 'HEALTHY' ? 'bg-emerald-500/20 text-emerald-400' :
                    pyramidHealth.level === 'NEUTRAL' ? 'bg-amber-500/20 text-amber-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>
                    {pyramidHealth.level === 'HEALTHY' ? '健康' : pyramidHealth.level === 'NEUTRAL' ? '中性' : '风险'}
                  </span>
                  <span className="text-[11px] font-mono text-slate-300">{pyramidHealth.score}分</span>
                </div>
                {pyramidHealth.centerDeviation !== 0 && (
                  <span className={`text-[10px] font-mono ${
                    pyramidHealth.centerDeviation <= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {pyramidHealth.centerDeviation > 0 ? '+' : ''}{(pyramidHealth.centerDeviation * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-400 leading-relaxed">
                {pyramidHealth.suggestion}
              </div>
            </div>
          )}

          {/* 试算预览 */}
          {order.status === 'active' && isShortTerm && trialResult && (
            <div className="mx-3 mb-2 p-2 rounded-lg bg-sky-900/20 border border-sky-700/30">
              <div className="text-[10px] text-sky-400 mb-1.5 flex items-center gap-1">
                <span>🔮 短线试算</span>
              </div>
              <div className="space-y-1 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">方向</span>
                  <span className={order.direction === 'buy' ? 'text-blue-400' : 'text-purple-400'}>
                    {order.direction === 'buy' ? '正T · 买入' : '倒T · 卖出'}
                  </span>
                </div>
                {trialResult.kind === 'blocked-sell' && (
                  <div className="flex items-center justify-between">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5 text-amber-400" />
                    <span className="text-[10px] text-amber-300">{trialResult.message}</span>
                  </div>
                )}
                {trialResult.kind === 'new-project-buy' && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">新建短期项目</span>
                      <span className="text-sky-400">🆕</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">初始成本基准</span>
                      <span className="font-mono text-slate-200">¥{trialResult.initCost.toFixed(3)} × {trialResult.initAmount}股</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">预估规费</span>
                      <span className="font-mono text-amber-400">¥{trialResult.fee.toFixed(2)}</span>
                    </div>
                  </>
                )}
                {trialResult.kind === 'matched-buy' && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">追加买入后新均价</span>
                      <span className="font-mono text-slate-200">¥{trialResult.newAvgCost.toFixed(3)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">追加后总持仓</span>
                      <span className="font-mono text-slate-200">{trialResult.newAmount.toLocaleString()}股</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">预估规费</span>
                      <span className="font-mono text-amber-400">¥{trialResult.addedFee.toFixed(2)}</span>
                    </div>
                  </>
                )}
                {trialResult.kind === 'matched-sell' && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">对冲差价</span>
                      <span className="font-mono text-slate-200">¥{trialResult.avgCost.toFixed(3)} → 计划 ¥{order.plannedPrice.toFixed(2)} ({trialResult.spreadPct >= 0 ? '+' : ''}{trialResult.spreadPct.toFixed(2)}%)</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">对冲数量</span>
                      <span className="font-mono text-slate-200">{trialResult.hedgeAmount.toLocaleString()}股</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">预估规费</span>
                      <span className="font-mono text-amber-400">¥{trialResult.fee.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">预估净收益</span>
                      <span className={`font-mono ${trialResult.netIncome >= 0 ? 'text-red-400' : 'text-green-400'}`}>{trialResult.netIncome >= 0 ? '+' : ''}¥{trialResult.netIncome.toFixed(2)}</span>
                    </div>
                  </>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">执行方式</span>
                  <span className="text-slate-300">添加流水记录，不改变底层仓位</span>
                </div>
              </div>
            </div>
          )}

          {/* 已执行：显示实际执行对比（含数量） */}
          {order.status === 'executed' && order.actual && (
            <div className="mx-3 mb-2 p-2 rounded-lg bg-blue-900/20 border border-blue-700/30">
              <div className="flex items-center gap-1 text-xs text-blue-300 mb-1.5">
                <CheckCircle className="w-3 h-3" />
                <span>执行对比</span>
              </div>
              <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px]">
                <div className="text-slate-500">项目</div>
                <div className="text-slate-500 text-center">计划</div>
                <div className="text-slate-500 text-center">实际</div>

                <div className="text-slate-400">价格</div>
                <div className="font-mono text-slate-300 text-center">¥{order.plannedPrice.toFixed(2)}</div>
                <div className={`font-mono text-center ${order.actual.isAchieved ? 'text-green-400' : 'text-amber-400'}`}>
                  ¥{order.actual.actualPrice.toFixed(2)}
                </div>

                <div className="text-slate-400">数量</div>
                <div className="font-mono text-slate-300 text-center">{order.plannedAmount.toLocaleString()}股</div>
                <div className="font-mono text-slate-300 text-center">{order.actual.actualAmount.toLocaleString()}股</div>

                <div className="text-slate-400">总额</div>
                <div className="font-mono text-slate-300 text-center">¥{formatAmount(order.plannedPrice * order.plannedAmount)}</div>
                <div className="font-mono text-slate-300 text-center">¥{formatAmount(executedTotal)}</div>

                {!isShortTerm && order.actual.newCost !== undefined && (
                  <>
                    <div className="text-slate-400 border-t border-blue-700/10 pt-1">执行后成本</div>
                    <div className="font-mono text-slate-300 text-center border-t border-blue-700/10 pt-1">—</div>
                    <div className="font-mono text-slate-300 text-center border-t border-blue-700/10 pt-1">¥{order.actual.newCost.toFixed(3)}</div>

                    <div className="text-slate-400">执行后持有</div>
                    <div className="font-mono text-slate-300 text-center">—</div>
                    <div className="font-mono text-slate-300 text-center">{order.actual.newAmount?.toLocaleString() ?? '—'}股</div>

                    {order.actual.newTotalInvested !== undefined && (
                      <>
                        <div className="text-slate-400">累计投入</div>
                        <div className="font-mono text-slate-300 text-center">—</div>
                        <div className="font-mono text-slate-300 text-center">¥{formatAmount(order.actual.newTotalInvested)}</div>
                      </>
                    )}

                    {order.actual.totalFee !== undefined && (
                      <>
                        <div className="text-slate-400">规费</div>
                        <div className="font-mono text-slate-300 text-center">—</div>
                        <div className="font-mono text-amber-400 text-center">¥{order.actual.totalFee.toFixed(2)}</div>
                      </>
                    )}
                  </>
                )}

                {isShortTerm && order.actual.avgPrice !== undefined && (
                  <>
                    <div className="text-slate-400 border-t border-blue-700/10 pt-1">加权均价</div>
                    <div className="font-mono text-slate-300 text-center border-t border-blue-700/10 pt-1 col-span-2">¥{order.actual.avgPrice.toFixed(2)}</div>

                    <div className="text-slate-400">净收益</div>
                    <div className={`font-mono text-center col-span-2 ${(order.actual.netProfit ?? 0) >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {(order.actual.netProfit ?? 0) >= 0 ? '+' : ''}¥{formatAmount(order.actual.netProfit ?? 0)}
                    </div>
                  </>
                )}

                {order.context === 'both' && (
                  <>
                    {order.actual.newCost !== undefined && (
                      <>
                        <div className="text-slate-400 border-t border-blue-700/10 pt-1">执行后成本</div>
                        <div className="font-mono text-slate-300 text-center border-t border-blue-700/10 pt-1">—</div>
                        <div className="font-mono text-slate-300 text-center border-t border-blue-700/10 pt-1">¥{order.actual.newCost.toFixed(3)}</div>

                        <div className="text-slate-400">执行后持有</div>
                        <div className="font-mono text-slate-300 text-center">—</div>
                        <div className="font-mono text-slate-300 text-center">{order.actual.newAmount?.toLocaleString() ?? '—'}股</div>
                      </>
                    )}
                    {order.actual.avgPrice !== undefined && (
                      <>
                        <div className="text-slate-400 border-t border-blue-700/10 pt-1">短线均价</div>
                        <div className="font-mono text-slate-300 text-center border-t border-blue-700/10 pt-1 col-span-2">¥{order.actual.avgPrice.toFixed(2)}</div>

                        <div className="text-slate-400">短线收益</div>
                        <div className={`font-mono text-center col-span-2 ${(order.actual.netProfit ?? 0) >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                          {(order.actual.netProfit ?? 0) >= 0 ? '+' : ''}¥{formatAmount(order.actual.netProfit ?? 0)}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center gap-1 mt-1.5 pt-1.5 border-t border-blue-700/20 text-[10px]">
                {order.actual.isAchieved ? (
                  <span className="text-green-400 flex items-center gap-0.5">
                    <CheckCircle className="w-2.5 h-2.5" />达成计划目标
                  </span>
                ) : (
                  <span className="text-amber-400 flex items-center gap-0.5">
                    <AlertTriangle className="w-2.5 h-2.5" />未完全达成计划
                  </span>
                )}
                <span className="text-slate-600 ml-auto">
                  {new Date(order.actual.executedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          )}

          {/* 过期/剩余时间 */}
          <div className="px-3 pb-2">
            {order.status === 'active' && remainingDays > 0 ? (
              <div className="flex items-center gap-1 text-[10px] text-slate-500">
                <Clock className="w-3 h-3" />
                <span>剩余 {remainingDays} 天</span>
                <span className="text-slate-600 ml-2">
                  过期时间：{new Date(order.expiresAt).toLocaleDateString()}
                </span>
              </div>
            ) : order.status === 'active' && remainingDays <= 0 ? (
              <div className="flex items-center gap-1 text-[10px] text-amber-400">
                <AlertTriangle className="w-3 h-3" />
                <span>已过期，3 天后自动隐藏</span>
              </div>
            ) : order.status === 'expired' ? (
              <div className="flex items-center gap-1 text-[10px] text-slate-500">
                <Clock className="w-3 h-3" />
                <span>已过期，3 天后自动隐藏</span>
              </div>
            ) : order.status === 'executed' ? (
              <div className="flex items-center gap-1 text-[10px] text-slate-500">
                <CheckCircle className="w-3 h-3" />
                <span>已执行，3 天后自动隐藏</span>
                <span className="text-slate-600 ml-auto">
                  {order.actual?.executedAt ? new Date(order.actual.executedAt).toLocaleDateString() : ''}
                </span>
              </div>
            ) : null}
          </div>

          {/* 操作按钮 */}
          <div className="flex border-t border-slate-800">
            {order.status === 'active' && (
              <>
                {onEdit && (
                  <button
                    onClick={() => onEdit(order)}
                    className="flex-1 flex items-center justify-center gap-1 py-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                  >
                    <Edit3 className="w-3 h-3" />编辑
                  </button>
                )}
                {onExecute && (
                  <button
                    onClick={() => {
                      setExecPrice(String(order.plannedPrice));
                      setExecAmount(String(order.plannedAmount));
                      setExecNote('');
                      setShowExecuteModal(true);
                    }}
                    className="flex-1 flex items-center justify-center gap-1 py-2 text-xs text-blue-400 hover:text-blue-300 hover:bg-slate-800 transition-colors"
                  >
                    <CheckCircle className="w-3 h-3" />执行
                  </button>
                )}
                {onCancel && (
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    className="flex-1 flex items-center justify-center gap-1 py-2 text-xs text-slate-500 hover:text-red-400 hover:bg-slate-800 transition-colors"
                  >
                    <XCircle className="w-3 h-3" />取消
                  </button>
                )}
                {onNavigate && (
                  <button
                    onClick={() => onNavigate(order)}
                    className="flex-1 flex items-center justify-center gap-1 py-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                  >
                    <ArrowRight className="w-3 h-3" />跳转
                  </button>
                )}
              </>
            )}
            {order.status === 'executed' && (
              <div className="flex-1 text-center py-2 text-[10px] text-slate-600">
                已于 {order.actual?.executedAt ? new Date(order.actual.executedAt).toLocaleDateString() : ''} 执行
              </div>
            )}
            {(order.status === 'expired' || order.status === 'cancelled') && (
              <div className="flex-1 text-center py-2 text-[10px] text-slate-600">
                {order.status === 'expired' ? '已过期未执行' : '已取消'}
              </div>
            )}
          </div>
        </>
      )}

      {/* 执行确认弹窗（与折叠状态无关） */}
      {showExecuteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowExecuteModal(false)}>
          <div className="bg-slate-900 rounded-xl p-5 w-full max-w-sm mx-4 shadow-2xl border border-slate-700 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-semibold text-slate-200 mb-1">
              执行计划单
            </h4>
            <p className="text-xs text-slate-500 mb-3">
              {order.stockName} · {order.direction === 'buy' ? '买入' : '卖出'} · 计划价 ¥{order.plannedPrice.toFixed(2)}
            </p>

            {/* 仓位变化预览（中长期） */}
            {position && !position.isClosed && execSimulation && (
              <div className="mb-3 p-3 rounded-lg bg-slate-800/60 border border-slate-700/50">
                <div className="text-[11px] font-medium text-slate-400 mb-2">📊 仓位变化预览</div>
                <div className="space-y-1.5">
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    <div className="text-slate-500">项目</div>
                    <div className="text-slate-500 text-center">当前</div>
                    <div className="text-slate-500 text-center">执行后</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                    <div className="text-slate-400">成本价</div>
                    <div className="text-slate-300 text-center">¥{position.currentCost.toFixed(3)}</div>
                    <div className="text-slate-300 text-center">¥{execSimulation.newCost.toFixed(3)}</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                    <div className="text-slate-400">持有数量</div>
                    <div className="text-slate-300 text-center">{position.currentAmount}股</div>
                    <div className="text-slate-300 text-center">{execSimulation.newAmount}股</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                    <div className="text-slate-400">累计投入</div>
                    <div className="text-slate-300 text-center">¥{formatAmount(position.totalInvested ?? 0)}</div>
                    <div className="text-slate-300 text-center">¥{formatAmount(execSimulation.newTotalInvested)}</div>
                  </div>
                  {execSimulation.newRealizedPnL !== undefined && (
                    <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                      <div className="text-slate-400">已实现盈亏</div>
                      <div className="text-slate-300 text-center">
                        {position.realizedPnL !== undefined ? `${position.realizedPnL >= 0 ? '+' : ''}¥${formatAmount(position.realizedPnL)}` : '—'}
                      </div>
                      <div className={`text-center ${execSimulation.newRealizedPnL >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {execSimulation.newRealizedPnL >= 0 ? '+' : ''}¥{formatAmount(execSimulation.newRealizedPnL)}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-2 text-[11px] font-mono border-t border-slate-700/50 pt-1.5 mt-1.5">
                    <div className="text-slate-500">规费</div>
                    <div className="text-slate-500 text-center">—</div>
                    <div className="text-amber-400 text-center">¥{execSimulation.totalFee.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            )}

            {/* 短线提示 + 倒T校验 */}
            {/* 【短线/中长期强隔离】短线侧监听自持（正T先买后卖）可独立持有并卖出，无需强制依赖中长期底仓 */}
            {isShortTerm && (
              <div className="mb-3">
                {order.direction === 'sell' && (!position || position.isClosed) ? (
                  <div className="bg-red-900/20 border border-red-700/30 p-2 rounded-lg">
                    <p className="text-[10px] text-red-400 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      <span>该标的无中长期底仓：若短线流水池中无正T买入自持，倒T卖出可能被拒绝</span>
                    </p>
                  </div>
                ) : (
                  <div className="bg-sky-900/20 border border-sky-700/30 p-2 rounded-lg">
                    <p className="text-[10px] text-sky-400 flex items-center gap-1">
                      <span>⚡ 短线执行将添加一条流水记录，不改变底层仓位</span>
                    </p>
                    {order.direction === 'sell' && position && !position.isClosed && (
                      <p className="text-[10px] text-green-400 mt-1 flex items-center gap-1">
                        <CheckCircle className="w-2.5 h-2.5 shrink-0" />
                        <span>底仓可用：成本 ¥{position.currentCost.toFixed(3)} × {position.currentAmount}股</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="mb-3">
              <label className="block text-xs text-slate-500 mb-1">实际成交价（元）</label>
              <input
                type="text"
                inputMode="decimal"
                value={execPrice}
                onChange={(e) => setExecPrice(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                autoFocus
              />
            </div>

            <div className="mb-3">
              <label className="block text-xs text-slate-500 mb-1">实际成交数量（股）</label>
              <input
                type="text"
                inputMode="numeric"
                value={execAmount}
                onChange={(e) => setExecAmount(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="mb-3">
              <label className="block text-xs text-slate-500 mb-1">备注（选填）</label>
              <input
                type="text"
                placeholder="执行备注"
                value={execNote}
                onChange={(e) => setExecNote(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* 达成判定 */}
            <div className="mb-4 p-2 rounded-lg bg-slate-800/40">
              <div className="text-[10px] text-slate-500">
                达成判定：{order.direction === 'buy' ? '实际价 ≤ 计划价' : '实际价 ≥ 计划价'} →
                <span className={`ml-1 font-medium ${
                  (order.direction === 'buy' ? execPriceNum <= order.plannedPrice : execPriceNum >= order.plannedPrice)
                    ? 'text-green-400' : 'text-amber-400'
                }`}>
                  {(order.direction === 'buy' ? execPriceNum <= order.plannedPrice : execPriceNum >= order.plannedPrice)
                    ? '✅ 达成' : '⚠️ 未达成'}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setShowExecuteModal(false)}
                className="btn btn-outline btn-block text-sm"
              >
                取消
              </button>
              <button
                onClick={handleExecuteConfirm}
                disabled={!execValid}
                className={`btn btn-block text-sm ${execValid ? 'btn-primary' : 'bg-slate-700 text-slate-500 cursor-not-allowed'}`}
              >
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 取消确认弹窗 */}
      <ConfirmModal
        open={showCancelConfirm}
        title="取消计划单"
        message={`确定取消 ${order.stockName} 的${order.direction === 'buy' ? '买入' : '卖出'}计划吗？`}
        confirmText="确认取消"
        danger
        onConfirm={() => {
          onCancel?.(order.id);
          setShowCancelConfirm(false);
        }}
        onCancel={() => setShowCancelConfirm(false)}
      />
    </div>
  );
}