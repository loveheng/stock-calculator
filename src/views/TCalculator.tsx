/**
 * @file TCalculator.tsx
 * @description 短线账本与计算器（页面核心）：管理短线（Round）全生命周期 ——
 *              流水池撮合（FIFO/加权平均/部分对冲/级联重算）、正T/倒T记录追加、
 *              一键划转底仓（绝对现金流法）、倒T结算归档，并内嵌归档历史库
 *              （Round 卡片 + 胜率 + 累计净收益）。
 * @layer UI
 * @storage_impact 写表：tTransactions（短线流水，随录入逐笔落库）、tRounds（Round 概览与结清）、
 *                 positions/positionBatches（划转/结清经 store 与 positionAdjustmentPort 落库）；
 *                 读表：feeConfigs（费率）。
 * @author 开发团队
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAppStore,
  useStreamResults,
  generateId,
  type Position,
  type RoundTxn,
} from '../store';
import { ledgerService } from '../services/ledgerService';
import { useArchivedRounds } from '../hooks/useArchivedRounds';
import { useLiveQuotes } from '../hooks/useLiveQuotes';
import { calcTradeFees, roundTo, matchSecurityKind, type FeeConfig } from '../utils/mathUtils';
import { toShortTrialProject } from '../utils/shortTermTrial';
import {
  validateStreamTrade,
  createInitialState,
  stepTEngine,
  mergeLongToBase,
  finalizeShortPartialReduce,
  finalizeShortTransfer,
  resolveOverSellAutoHedge,
  resolveOverSellHedgeThenReverse,
  resolveOverBuyAutoHedge,
  resolveOverBuyHedgeThenReverse,
  cancelDefenseDialog,
  calcHedgeBreakeven,
  type TStreamRecord,
  type StockStreamResult,
} from '../utils/tStreamEngine';
import { validateSellWithStreamResult } from '../utils/validation';
import StockAutocomplete from '../components/ui/StockAutocomplete';
import ConfirmModal from '../components/ui/ConfirmModal';
import PlanOrderCard from '../components/PlanOrderCard';
import type { StockQuoteSummary, StockSearchItem } from '../types/stock';
import type { PlannedOrder } from '../store/types';
import type {
  BasePosition,
  TStepNode,
  TSettlementCard,
  TStateMachineState,
} from '../types/tStrategy';

/**
 * 格式化金额为人民币字符串。
 *
 * @description 将数值格式化为两位数小数的 ¥ 金额展示（如 ¥12.50）。
 * @param {number} value - 原始金额数值
 * @returns {string} 格式化后的金额字符串（如 "¥12.50"）
 */
function formatCurrency(value: number): string {
  return `¥${(value ?? 0).toFixed(2)}`;
}

/**
 * 盈亏红绿配色（与全局红涨绿跌一致）。
 *
 * @param {number} value - 盈亏数值，>=0 视为盈利
 * @returns {string} Tailwind 颜色类名：盈利 text-red-400 / 亏损 text-green-400
 */
function pnlColor(value: number): string {
  return value >= 0 ? 'text-red-400' : 'text-green-400';
}

/**
 * 流水池状态徽章组件。
 *
 * @description 根据撮合结果状态渲染对应彩色徽章：
 *              CLEARED(已完全结清) / SHORT_PENDING(倒T待回补) /
 *              PARTIAL(部分对冲) / 其余(待对冲)。
 * @param {{ result: StockStreamResult }} props - 单个标的的流水池撮合结果
 * @returns {JSX.Element} 状态徽章视图
 */
function StreamStatusBadge({ result }: { result: StockStreamResult }) {
  if (result.status === 'CLEARED') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-blue-500/15 text-blue-400">
        ✓ 已完全结清
      </span>
    );
  }
  if (result.status === 'SHORT_PENDING') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/15 text-amber-400">
        倒T待回补 {result.shortPendingAmount} 股
      </span>
    );
  }
  if (result.status === 'PARTIAL') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-sky-500/15 text-sky-400">
        部分对冲 (剩 {result.netPendingAmount} 股待对冲)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-slate-700 text-slate-300">
      待对冲
    </span>
  );
}

/** 步骤节点颜色映射 */
const STEP_COLORS: Record<string, string> = {
  buy: 'bg-blue-500/10 border-blue-500/30',
  sell: 'bg-purple-500/10 border-purple-500/30',
};

/** 结算标签颜色映射 */
const SETTLE_LABEL_COLORS: Record<string, string> = {
  green: 'bg-blue-500/15 text-blue-400',
  red: 'bg-purple-500/15 text-purple-400',
  blue: 'bg-blue-500/15 text-blue-400',
  purple: 'bg-purple-500/15 text-purple-400',
  orange: 'bg-orange-500/15 text-orange-400',
};

/**
 * 过程节点卡片组件。
 *
 * @description 渲染做 T 状态机中的单步快照：动作、本步支出/回收、摩擦成本、
 *              累计利润、当前持仓成本与数量。
 */
function StepNodeCard({
  node,
  baseCost,
  baseQty,
  netPendingQty,
}: {
  node: TStepNode;
  baseCost: number;
  baseQty: number;
  netPendingQty: number;
}) {
  const isBuy = node.direction === 'buy';
  return (
    <div className={`rounded-lg border p-2.5 text-xs space-y-1 ${STEP_COLORS[node.direction]}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 font-mono tabular-nums">#{node.index}</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
            isBuy ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400'
          }`}>
            {isBuy ? '买入' : '卖出'}
          </span>
          <span className="font-mono text-slate-300 tabular-nums">{node.amount} 股</span>
          <span className="font-mono text-blue-400 tabular-nums">¥{node.price.toFixed(3)}</span>
        </div>
        <span className="text-xs text-slate-500">{new Date(node.timestamp).toLocaleString()}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        <div>
          <span className="text-slate-500">
            {isBuy ? '本步支出' : '本步回收'}
          </span>
          <div className="font-mono font-semibold text-slate-200 tabular-nums">
            {isBuy
              ? `¥${(node.netOutflow ?? 0).toFixed(2)}`
              : `¥${(node.netInflow ?? 0).toFixed(2)}`}
          </div>
          <span className="text-[10px] text-slate-500">
            {isBuy ? `(含摩擦 ${node.stepFrictionCost.toFixed(2)})` : `(扣摩擦 ${node.stepFrictionCost.toFixed(2)})`}
          </span>
        </div>
        <div>
          <span className="text-slate-500">单步摩擦</span>
          <div className="font-mono font-semibold text-slate-200 tabular-nums">¥{node.stepFrictionCost.toFixed(2)}</div>
        </div>
        <div>
          <span className="text-slate-500">累计利润</span>
          <div className={`font-mono font-semibold tabular-nums ${pnlColor(node.cumulativeProfit)}`}>
            {formatCurrency(node.cumulativeProfit)}
          </div>
        </div>
        <div>
          <span className="text-slate-500">底仓基准</span>
          <div className="font-mono font-semibold text-blue-400 tabular-nums">
            {baseQty} 股 @ ¥{baseCost.toFixed(3)}
          </div>
          <span className="text-[10px] text-amber-400 tabular-nums">
            在途敞口 +{netPendingQty} 股
          </span>
        </div>
      </div>
      {node.note && <div className="text-[10px] text-slate-500 italic">{node.note}</div>}
    </div>
  );
}

/**
 * 结算卡片视图组件。
 *
 * @description 渲染做 T 最终结算结果：结算标签、总支出/总回收、总摩擦、
 *              已实现利润、更新后底仓、归并/减持信息。
 */
function SettlementCardView({ card }: { card: TSettlementCard }) {
  const colorClass = SETTLE_LABEL_COLORS[card.labelColor] ?? 'bg-slate-500/15 text-slate-400';
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-800/80 p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${colorClass}`}>
          {card.label}
        </span>
        <span className="text-[10px] text-slate-500">{card.mode === 'long' ? '正T' : '倒T'}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div>
          <span className="text-slate-500">总支出（含摩擦）</span>
          <div className="font-mono font-semibold text-slate-200 tabular-nums">{formatCurrency(card.totalOutflow)}</div>
        </div>
        <div>
          <span className="text-slate-500">总回收（扣摩擦）</span>
          <div className="font-mono font-semibold text-slate-200 tabular-nums">{formatCurrency(card.totalInflow)}</div>
        </div>
        <div>
          <span className="text-slate-500">总摩擦成本</span>
          <div className="font-mono font-semibold text-slate-400 tabular-nums">{formatCurrency(card.totalFrictionCost)}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div>
          <span className="text-slate-500">已实现套利利润</span>
          <div className={`font-mono font-bold text-sm tabular-nums ${pnlColor(card.realizedArbitrageProfit)}`}>
            {formatCurrency(card.realizedArbitrageProfit)}
          </div>
        </div>
        <div>
          <span className="text-slate-500">更新后底仓成本</span>
          <div className="font-mono font-semibold text-blue-400 tabular-nums">¥{card.updatedBaseCost.toFixed(3)}</div>
        </div>
        <div>
          <span className="text-slate-500">最终持有数量</span>
          <div className="font-mono font-semibold text-slate-200 tabular-nums">{card.finalQuantity} 股</div>
        </div>
      </div>
      {(card.mergeQuantity ?? 0) > 0 && (
        <div className="flex items-center gap-3 pt-1 border-t border-slate-700">
          <div>
            <span className="text-slate-500">归并/减持数量</span>
            <div className="font-mono font-semibold text-purple-400 tabular-nums">{card.mergeQuantity} 股</div>
          </div>
          <div>
            <span className="text-slate-500">归并/减持金额</span>
            <div className="font-mono font-semibold text-purple-400 tabular-nums">{formatCurrency(card.mergeAmount ?? 0)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 超限防御弹窗组件。
 *
 * @description 当出现卖超或买超场景时，渲染 Modal 提供 3 个防御分支选项。
 */
function DefenseOverflowModal({
  dialog,
  onSelect,
  onCancel,
}: {
  dialog: NonNullable<TStateMachineState['defenseDialog']>;
  onSelect: (key: string) => void;
  onCancel: () => void;
}) {
  if (!dialog.visible) return null;
  return (
    <div className="fixed inset-0 z-[100] bg-black/60 p-4 flex items-center justify-center">
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700">
          <p className="text-sm font-semibold text-slate-100">{dialog.title}</p>
          <p className="text-xs text-slate-500 mt-1">{dialog.description}</p>
        </div>
        <div className="p-4 space-y-2">
          {dialog.options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onSelect(opt.key)}
              className="w-full text-left px-3 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sm text-slate-200 transition-colors"
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-slate-700 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 状态机可视化面板组件。
 *
 * @description 接受原始流水记录，通过 stepTEngine 逐条推进状态机，
 *              渲染步骤节点卡片、结算卡片，并管理超限防御弹窗交互。
 */
function TStateMachinePanel({
  entries,
  basePosition,
  feeConfig,
  embedded,
}: {
  entries: TStreamRecord[];
  basePosition: BasePosition | null;
  feeConfig: FeeConfig | undefined;
  embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [defenseSMCopy, setDefenseSMCopy] = useState<TStateMachineState | null>(null);

  // 逐条推进状态机
  const { smState, triggeredDefense, pendingPerStep } = useMemo(() => {
    if (!basePosition || entries.length === 0) return { smState: null, triggeredDefense: false, pendingPerStep: [] as number[] };
    // 按时间升序排列流水
    const sorted = [...entries].sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb;
    });

    let state = createInitialState(basePosition);
    let defense = false;
    const pendingPerStep: number[] = [];
    for (const entry of sorted) {
      if (!feeConfig) break;
      const output = stepTEngine({
        state,
        record: entry,
        feeConfig,
        basePosition,
      });
      state = output.newState;
      // 在途敞口：正T = 未平买入剩余量；倒T = 未回补卖出剩余量
      const pendingQty =
        state.mode === 'long'
          ? (state.pendingBuys ?? []).reduce((s, b) => s + b.quantity, 0)
          : (state.pendingSells ?? []).reduce((s, b) => s + b.quantity, 0);
      pendingPerStep.push(pendingQty);
      if (output.triggeredDefense) {
        defense = true;
        setDefenseSMCopy(state);
        break;
      }
      if (state.isClosed) break;
    }
    return { smState: state, triggeredDefense: defense, pendingPerStep };
  }, [entries, basePosition, feeConfig]);

  const handleDefenseSelect = (key: string) => {
    if (!defenseSMCopy || !feeConfig) return;
    let newState: TStateMachineState;
    switch (key) {
      case 'auto_hedge':
        if (defenseSMCopy.defenseDialog?.type === 'over_sell') {
          newState = resolveOverSellAutoHedge(defenseSMCopy);
        } else {
          newState = resolveOverBuyAutoHedge(defenseSMCopy);
        }
        break;
      case 'hedge_then_reverse':
        if (defenseSMCopy.defenseDialog?.type === 'over_sell') {
          newState = resolveOverSellHedgeThenReverse(defenseSMCopy, feeConfig);
        } else {
          newState = resolveOverBuyHedgeThenReverse(defenseSMCopy, feeConfig);
        }
        break;
      default:
        newState = cancelDefenseDialog(defenseSMCopy);
        break;
    }
    // 检查是否需要进一步处理
    if (!newState.isClosed && newState.defenseDialog?.visible) {
      setDefenseSMCopy(newState);
    } else {
      setDefenseSMCopy(newState);
    }
  };

  const handleDefenseCancel = () => {
    if (defenseSMCopy) {
      setDefenseSMCopy(cancelDefenseDialog(defenseSMCopy));
    }
  };

  if (!basePosition || entries.length === 0 || !smState || smState.steps.length === 0) return null;

  const stateContent = (
    <div className="mt-2 space-y-2">
      {/* 步骤节点卡片 */}
      {smState.steps.map((step, i) => (
        <StepNodeCard
          key={step.recordId}
          node={step}
          baseCost={basePosition.cost}
          baseQty={basePosition.quantity}
          netPendingQty={pendingPerStep[i] ?? 0}
        />
      ))}

      {/* 结算卡片 */}
      {smState.settlementCard && (
        <SettlementCardView card={smState.settlementCard} />
      )}

      {/* 防御弹窗 */}
      {defenseSMCopy?.defenseDialog && (
        <DefenseOverflowModal
          dialog={defenseSMCopy.defenseDialog}
          onSelect={handleDefenseSelect}
          onCancel={handleDefenseCancel}
        />
      )}

      {/* 未触发防御但有活跃弹窗 */}
      {!triggeredDefense && smState.defenseDialog && !defenseSMCopy && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          ⚠️ 防御弹窗待处理：{smState.defenseDialog.type} — 请通过原有流程处理
        </div>
      )}
    </div>
  );

  if (embedded) {
    return <div className="pt-1 border-t border-slate-600/50 mt-1">{stateContent}</div>;
  }

  return (
    <div className="pt-1 border-t border-slate-600/50 mt-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="tap-target text-xs text-purple-400 hover:text-purple-300 underline"
      >
        {expanded
          ? '🔼 收起状态机详情'
          : `🔽 状态机详情（${smState.steps.length} 步${smState.isClosed ? ' · ' + (smState.settlementCard?.label ?? '已结束') : ''}）`}
      </button>
      {expanded && stateContent}
    </div>
  );
}

/**
 * 单个进行中短线项目卡片（核心业务卡片）。
 *
 * @description 展示某标的的实时流水池撮合状态：剩余待对冲/倒T待回补、加权成本、
 *              累计已实现盈亏、流水明细列表（逐条可删除）、[+追加记录] 快速录入，
 *              并提供「一键划转底仓」「结算倒T」「归档」等写操作入口。
 * @param {{ result: StockStreamResult; basePosition: Position | undefined }} props
/**
 * 单个进行中短线项目卡片（核心业务卡片）。
 *
 * @description 展示某标的的实时流水池撮合状态：剩余待对冲/倒T待回补、加权成本、
 *              累计已实现盈亏、流水明细列表（逐条可删除）、[+追加记录] 快速录入，
 *              并提供「一键划转底仓」「结算倒T」「归档」等写操作入口。
 * @param {{ result: StockStreamResult; basePosition: Position | undefined; quote: StockQuoteSummary | null }} props
 *  - result: 该标的的流水池撮合结果
 *  - basePosition: 对应底仓持仓（用于超卖校验与划转）
 *  - quote: 该标的最新实时行情（批量请求返回，无行情时为 null）
 * @returns {JSX.Element} 短线项目卡片视图
 * @note 写操作均委托 Store Action 落库并触发级联重算；超卖/数量校验由
 *       validateStreamTrade 在录入前拦截
 */
function CurrentProjectCard({
  result,
  basePosition,
  feeConfig,
  quote,
  onAppend,
  onQuickHedge,
}: {
  result: StockStreamResult;
  basePosition: Position | undefined;
  feeConfig: FeeConfig | undefined;
  quote: StockQuoteSummary | null;
  onAppend: () => void;
  onQuickHedge: () => void;
}) {
  const [showEntries, setShowEntries] = useState(false);
  const removeStreamRecord = useAppStore((s) => s.removeStreamRecord);
  /** entries 按时间倒序（最新在最上方），仅最新一条可撤销删除 */
  const sortedEntries = [...result.entries].sort(
    (a, b) => b.id.localeCompare(a.id)
  );
  const transferToPosition = useAppStore((s) => s.transferToPosition);
  const settleShortRound = useAppStore((s) => s.settleShortRound);
  const addToast = (msg: string) => window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));

  const baseHolding = basePosition?.currentAmount ?? 0;

  // ── 决策辅助派生量（仅 UI 展示，不参与底层撮合/状态机） ──
  const remainingQty = Math.max(0, result.netPendingAmount);
  const hasLivePrice = !!quote && quote.currentPrice > 0;
  // 浮动盈亏（口径见下）：正T = (现价 - 加权买入均价) × 剩余；倒T = (平均卖出价 - 现价) × 剩余
  const floatPnl = (() => {
    if (!hasLivePrice || remainingQty <= 0) return null;
    const cp = (quote as StockQuoteSummary).currentPrice;
    if (result.mode === 'long') {
      const basis = result.weightedBuyCost;
      if (basis <= 0) return null;
      return { amount: (cp - basis) * remainingQty, pct: ((cp - basis) / basis) * 100 };
    }
    const sellAmount = result.sellAmount > 0 ? result.sellAmount : 1;
    const avgSell = result.sellValue / sellAmount;
    if (avgSell <= 0) return null;
    return { amount: (avgSell - cp) * remainingQty, pct: ((avgSell - cp) / avgSell) * 100 };
  })();
  // 保本对冲价（≥ ：正T 应卖出到位；≤ ：倒T 应回补至此价内）
  const breakeven = calcHedgeBreakeven(result, feeConfig);

  const handleSettleShort = async () => {
    // 倒T结算：直接走 settleShortRound（移除出借 + 未回补转真实卖出）
    // 不能用 transferToPosition，因为倒T下 netPendingAmount 代表「未回补卖出量」
    // 而非可划转的买入持仓，传给 transferToPosition 会导致错误加仓（如卖出300买回200 → 加仓100而非减仓100）
    const res = await settleShortRound(result.fullCode);
    if (res.ok) {
      addToast(res.message ?? '操作完成');
    } else {
      addToast(`🛑 ${res.message}`);
    }
  };

  const handleTransfer = async () => {
    const res = await transferToPosition(result.fullCode);
    if (res.ok) {
      addToast(res.message ?? '操作完成');
    } else {
      addToast(`🛑 ${res.message}`);
    }
  };

  // 根据首笔流水时间生成纯时间戳流水号（不为空时使用 closedAt，否则使用 openedAt）
  const roundCode = (() => {
    const ts = result.openedAt ?? result.entries[0]?.timestamp ?? new Date().toISOString();
    const d = new Date(ts);
    const y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `#${y}${M}${D}-${h}${m}`;
  })();

  return (
    <div className="card space-y-3 !mb-0">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-semibold text-slate-200 truncate">{result.stockName}</span>
          <span className="text-xs text-slate-500 shrink-0">{result.fullCode}</span>
          <span className="text-xs bg-slate-700/80 text-slate-200 px-1.5 py-0.5 rounded-full font-bold shrink-0">
            {roundCode}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 ${result.mode === 'short' ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'}`}>
            {result.mode === 'short' ? '倒T' : '正T'}
          </span>
          <StreamStatusBadge result={result} />
          {quote && quote.currentPrice > 0 && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-bold shrink-0 ${quote.changePercent >= 0 ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-400'}`}>
              现价 ¥{quote.currentPrice.toFixed(3)}（{quote.changePercent >= 0 ? '+' : ''}
              {quote.changePercent.toFixed(2)}%）
            </span>
          )}
        </div>
        {basePosition && basePosition.currentAmount === 0 ? (
          <span className="text-xs text-amber-300 shrink-0 bg-amber-500/10 px-2 py-0.5 rounded-full">
            底仓出空
          </span>
        ) : baseHolding > 0 ? (
          <span className="text-xs text-slate-400 shrink-0">
            底仓 <b className="text-slate-200">{baseHolding}</b> 股
          </span>
        ) : null}
      </div>

      {/* 当前项目指标（移动端 2×2 紧凑布局） */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="bg-slate-900 rounded-lg p-2 min-w-0">
          <div className="text-slate-500 whitespace-nowrap">加权均价 P_avg</div>
          <div className="font-mono font-semibold text-blue-400 tabular-nums">
            {result.avgPrice > 0 ? `¥${result.avgPrice.toFixed(3)}` : '--'}
          </div>
        </div>
        <div className="bg-slate-900 rounded-lg p-2 min-w-0">
          <div className="text-slate-500 whitespace-nowrap">已卖对冲数量</div>
          <div className="font-mono font-semibold text-slate-200 tabular-nums whitespace-nowrap">{result.realizedSellAmount} 股</div>
        </div>
        <div className="bg-slate-900 rounded-lg p-2 min-w-0">
          <div className="text-slate-500 whitespace-nowrap">剩余待处理持仓</div>
          <div className="font-mono font-semibold text-slate-200 tabular-nums whitespace-nowrap">
            {Math.max(0, result.netPendingAmount)} 股
          </div>
        </div>
        <div className="bg-slate-900 rounded-lg p-2 min-w-0">
          <div className="text-slate-500 whitespace-nowrap">已实现净收益</div>
          <div className={`font-mono font-semibold tabular-nums whitespace-nowrap ${pnlColor(result.realizedPnL)}`}>
            {formatCurrency(result.realizedPnL)}
          </div>
          {floatPnl && (
            <div className="mt-0.5 font-mono text-[10px] tabular-nums whitespace-nowrap">
              <span className="text-slate-500">浮动 </span>
              <span className={pnlColor(floatPnl.amount)}>
                {floatPnl.amount >= 0 ? '+' : ''}{formatCurrency(floatPnl.amount)}
              </span>
              <span className="text-slate-500">（</span>
              <span className={pnlColor(floatPnl.pct)}>
                {floatPnl.pct >= 0 ? '+' : ''}{floatPnl.pct.toFixed(1)}%
              </span>
              <span className="text-slate-500">）</span>
            </div>
          )}
        </div>
      </div>

      {/* 已实现卖出对冲明细（绝对现金流口径） */}
      <div className="text-xs text-slate-500 space-y-0.5">
        <div>
          Round 绝对现金流净收益：
          <span className={`font-mono font-semibold tabular-nums ${pnlColor(result.transferProfit)}`}>
            {formatCurrency(result.transferProfit)}
          </span>
          <span className="text-slate-500 ml-1">
            （卖出 {result.realizedSellValue.toFixed(0)} - 成本 {roundTo(result.avgPrice * result.realizedSellAmount, 2).toFixed(0)} - 规费 {result.realizedFee.toFixed(2)}）
          </span>
        </div>
        <div>
          已卖 {result.realizedSellAmount} 股 / 总买 {result.buyAmount} 股 / {result.tradeCount} 笔 / 持股 {result.holdingDays} 天
        </div>
        {/* 决策辅助：保本对冲价（正T ≥ 卖出到位；倒T ≤ 回补到位） */}
        {breakeven && remainingQty > 0 && (
          <div>
            保本对冲价：
            <span className="font-mono font-semibold text-amber-400 tabular-nums">
              {breakeven.symbol === 'gte' ? '≥' : '≤'} ¥{breakeven.price.toFixed(3)}
            </span>
          </div>
        )}
        {/* 倒T成本继承：底仓 (P_base × N_sell) 并入 P_avg 加权池，全部卖出统一按融合 P_avg 结算 */}
        {result.firstSellCostBasis && result.firstSellCostBasis > 0 && result.inheritedBaseAmount && (
          <div className="text-xs">
            ⚙ 倒T成本继承：底仓 ¥{result.firstSellCostBasis.toFixed(3)} × {result.inheritedBaseAmount} 股并入 P_avg 加权池
            <span className="text-slate-500 ml-1">
              → 融合 P_avg <span className="font-mono font-semibold text-amber-400">¥{result.avgPrice.toFixed(3)}</span>，全部卖出/转底仓统一按此结算
            </span>
          </div>
        )}
      </div>

      {result.entries.length > 0 && (
        <div className="pt-1">
          <button
            onClick={() => setShowEntries((v) => !v)}
            className="tap-target text-xs text-blue-400 hover:text-blue-300 underline"
          >
            {showEntries
              ? '🔼 收起明细'
              : `🔽 展开明细（${result.entries.length} 笔）`}
          </button>
          {showEntries && (
            <div className="mt-2 bg-slate-900 rounded-lg p-3 space-y-2 text-xs text-slate-300">
              {sortedEntries.map((entry, idx) => (
                <div
                  key={entry.id}
                  className="grid grid-cols-1 md:grid-cols-2 gap-2 border-b border-slate-700 pb-2 last:border-b-0 last:pb-0"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          entry.direction === 'buy'
                            ? 'bg-blue-500/15 text-blue-400'
                            : 'bg-purple-500/15 text-purple-400'
                        }`}
                      >
                        {entry.direction === 'buy' ? '买入' : '卖出'}
                      </span>
                      <span className="text-slate-500">
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-slate-400">
                      <span>¥{entry.price.toFixed(3)}</span>
                      <span>{entry.amount} 股</span>
                      <span>手续费 ¥{entry.fee.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-slate-500">对冲/收益</div>
                      {idx === 0 ? (
                        <button
                          onClick={() => removeStreamRecord(entry.id)}
                          className="tap-target text-slate-400 hover:text-red-400 transition-colors rounded-lg"
                          aria-label="撤销最新一笔流水"
                          title="撤销最新一笔流水"
                        >
                          🗑️
                        </button>
                      ) : (
                        <span
                          className="tap-target text-slate-600 cursor-not-allowed"
                          title="为保证对冲逻辑正确，仅支持按顺序撤销最新的一条操作"
                        >
                          🔒
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                      {entry.direction === 'buy' ? (
                        /* BUY（开仓腿）：无撮合收益，仅展示对冲进度，隐藏误导性的 +¥0.00 */
                        <span
                          className={`font-mono tabular-nums ${
                            entry.matchedAmount > 0 ? 'text-sky-400' : 'text-amber-400'
                          }`}
                        >
                          {entry.matchedAmount <= 0
                            ? `待对冲 (${entry.amount}股未平)`
                            : `已对冲 ${entry.matchedAmount}股 / 余 ${entry.amount - entry.matchedAmount}股`}
                        </span>
                      ) : (
                        /* SELL（平仓腿）：保持原有撮合量与收益展示 */
                        <>
                          <span className="font-mono text-slate-200">撮合 {entry.matchedAmount} 股</span>
                          <span
                            className={
                              entry.realizedProfit >= 0
                                ? 'text-red-400'
                                : 'text-green-400'
                            }
                          >
                            {entry.realizedProfit >= 0 ? '+' : ''}
                            {formatCurrency(entry.realizedProfit)}
                          </span>
                        </>
                      )}
                    </div>
                    {entry.note && (
                      <div className="text-slate-500">{entry.note}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="pt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
        <button
          type="button"
          onClick={onAppend}
          className="col-span-2 md:col-span-2 btn btn-primary !py-3"
        >
          + 追加记录
        </button>
        <button
          type="button"
          onClick={onQuickHedge}
          className={`col-span-1 md:col-span-1 btn !py-3 ${
            remainingQty > 0
              ? 'bg-amber-500 hover:bg-amber-400 text-slate-900'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
          }`}
          disabled={remainingQty <= 0}
          title={remainingQty > 0 ? `以最新价 ¥${quote?.currentPrice?.toFixed?.(3) ?? '--'} 对冲剩余 ${remainingQty} 股` : '无剩余待对冲持仓'}
        >
          ⚡ 快捷对冲
        </button>
        <button
          type="button"
          onClick={result.mode === 'short' ? handleSettleShort : handleTransfer}
          className="col-span-1 md:col-span-1 btn btn-warning !py-3"
          disabled={result.mode !== 'short' && result.netPendingAmount <= 0}
        >
          {result.mode === 'short' ? '结算 / 转底仓' : '一键划转底仓'}
        </button>
      </div>

      </div>
  );
}

/**
 * 归档历史库 Round 战报卡片。
 *
 * @description 展示已归档短线战报：Round 编号、正/倒T标签、结算类型（平仓/归并/划转）、
 *              顶部一行状态徽章（左侧）+ 右上角结算徽章；中部 2×2 核心指标：
 *              落袋净收益（高亮）/ 已对冲数量 / 买·卖加权均价 / 归并底仓（或「全部结清」）；
 *              成交明细穿透逐行标注「撮合量+已实现收益」「买入规费」「归并」对冲状态；
 *              提供「删除战报」操作，自动级联撤销归并底仓数据。
 * @param {{ round: TRound; onRemove: (id) => { ok: boolean; message?: string } }} props
 *  - round: 归档战报记录（列表加载为轮次摘要，不含明细；卡片挂载时预取一次明细用于推导买/卖均价）
 *  - onRemove: 删除回调，返回删除结果
 * @returns {JSX.Element} 战报卡片视图
 * @note 删除属于写操作，通过 store.removeRound 落库，自动处理归并回滚
 */
function ArchiveRoundCard({
  round,
  onRemove,
}: {
  round: NonNullable<ReturnType<typeof useAppStore.getState>['tRounds']>[number];
  onRemove: (id: string) => { ok: boolean; message?: string };
}) {
  const [showTxns, setShowTxns] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // 成交明细按需加载：列表加载器只返回轮次摘要（不含 transactions）。
  // 为在卡片主体直接呈现「买/卖均价」，需在挂载时预取一次明细；
  // 展开/收起仅切换可视性（toggleTxns），不再重复查询。
  const [txns, setTxns] = useState<RoundTxn[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
  const txnsLoadedRef = useRef(false);
  const loadTxns = useCallback(() => {
    if (txnsLoadedRef.current) return;
    txnsLoadedRef.current = true;
    setTxnsLoading(true);
    ledgerService
      .fetchTransactionsByRoundId(round.id)
      .then((list) => setTxns(list))
      .catch(() => setTxns([]))
      .finally(() => setTxnsLoading(false));
  }, [round.id]);
  useEffect(() => {
    loadTxns();
  }, [loadTxns]);
  // 明细已在挂载时预取（见 loadTxns/useEffect），此处仅切换展开/收起。
  const toggleTxns = () => setShowTxns((v) => !v);

  const hasMerge = round.transferAmount && round.transferAmount > 0;
  const mergeLabel = round.mode === 'long' ? '正T归并' : '倒T归并';

  // ── 由成交明细派生的核心指标（买/卖加权均价、已对冲数量）──
  // 买均价优先用明细加权实算；缺明细时回退到 round.avgPrice（= 买入加权均价 buyTotal/buyAmount）。
  const buyAmt = txns.filter((t) => t.direction === 'buy').reduce((s, t) => s + t.amount, 0);
  const buyVal = txns.filter((t) => t.direction === 'buy').reduce((s, t) => s + t.price * t.amount, 0);
  const sellAmt = txns.filter((t) => t.direction === 'sell').reduce((s, t) => s + t.amount, 0);
  const sellVal = txns.filter((t) => t.direction === 'sell').reduce((s, t) => s + t.price * t.amount, 0);
  const buyAvg = buyAmt > 0 ? buyVal / buyAmt : (round.avgPrice ?? NaN);
  const sellAvg = sellAmt > 0 ? sellVal / sellAmt : NaN;
  const hasSellAvg = Number.isFinite(sellAvg) && sellAvg > 0;
  const fmtAvg = (v: number) => (Number.isFinite(v) && v > 0 ? v.toFixed(3) : '--');
  // 已对冲数量 = 已撮合卖出量（round.sellAmount 即 realizedSellAmount）
  const hedgedQty = Math.max(0, round.sellAmount ?? 0);

  const deleteConfirmMessage = hasMerge
    ? `删除此战报将同步撤销归并的 ${round.transferAmount} 股持仓及对应金额（约 ¥${((round.avgPrice ?? 0) * (round.transferAmount ?? 0)).toFixed(2)}），底仓成本将重新计算，并同步删除中长期记录中对应的【归并】历史，是否确认删除？`
    : `确认删除本条历史战报？`;

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-semibold text-slate-200 truncate">{round.stockName}</span>
          <span className="text-xs bg-blue-600 text-white px-1.5 py-0.5 rounded-full font-bold shrink-0">
            {round.roundCode}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 ${round.mode === 'short' ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'}`}>
            {round.mode === 'short' ? '倒T' : '正T'}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {round.settleType === 'transfer' && round.sellAmount === 0 ? (
            <>
              <span className="text-xs bg-slate-700/15 text-slate-200 px-1.5 py-0.5 rounded-full font-bold shrink-0">平仓</span>
              <span className="text-xs bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded-full font-bold shrink-0">划转</span>
            </>
          ) : round.settleType === 'transfer' ? (
            <>
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 ${round.win ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
                {round.win ? '盈利' : '亏损'}
              </span>
              <span className="text-xs bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded-full font-bold shrink-0">划转</span>
            </>
          ) : (
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 ${(round.sellAmount ?? 0) > 0 ? (round.win ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400') : 'bg-slate-700/15 text-slate-200'}`}>
              {(round.sellAmount ?? 0) > 0 ? (round.win ? '盈利' : '亏损') : '平仓'}
            </span>
          )}
          {hasMerge && (
            <span className="text-xs bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded-full font-bold shrink-0">
              {mergeLabel}
            </span>
          )}
        </div>
      </div>
      <div className="text-xs text-slate-500">
        {new Date(round.openedAt ?? '').toLocaleDateString()} ~ {new Date(round.closedAt ?? '').toLocaleDateString()} · 持股 {round.holdingDays ?? 0} 天 · {round.tradeCount ?? 0} 笔
        {round.totalFees ? ` · 规费合计 ¥${round.totalFees.toFixed(2)}` : ''}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-slate-900/70 border border-slate-700/60 p-3">
        {/* 落袋净收益（Round 绝对现金流净收益） */}
        <div>
          <div className="text-[11px] text-slate-500">落袋净收益</div>
          <div className={`font-mono text-xl font-bold tabular-nums mt-0.5 leading-tight ${pnlColor(round.netProfit)}`}>
            {round.netProfit >= 0 ? '+' : ''}{formatCurrency(round.netProfit)}
          </div>
        </div>
        {/* 已对冲数量（已撮合卖出量） */}
        <div>
          <div className="text-[11px] text-slate-500">已对冲数量</div>
          <div className="font-mono font-semibold text-slate-200 tabular-nums mt-0.5">{hedgedQty} 股</div>
        </div>
        {/* 买 / 卖均价（加权实算，缺明细时回退） */}
        <div>
          <div className="text-[11px] text-slate-500">买 / 卖均价</div>
          {/* 紧凑双行排列，避免均值被 truncate 截断成 "¥17..." */}
          <div className="font-mono font-semibold tabular-nums mt-0.5 leading-snug">
            <div className="whitespace-nowrap text-blue-400">买 ¥{fmtAvg(buyAvg)}</div>
            <div className={hasSellAvg ? 'whitespace-nowrap text-purple-400' : 'whitespace-nowrap text-slate-500'}>
              卖 ¥{fmtAvg(sellAvg)}
            </div>
          </div>
        </div>
        {/* 归并底仓：有归并则高亮数量与价位；无归并显示全部结清 */}
        <div>
          <div className="text-[11px] text-slate-500">归并底仓</div>
          <div className="font-mono font-semibold tabular-nums mt-0.5 leading-tight">
            {hasMerge ? (
              <span className="text-amber-400">+{round.transferAmount} 股 @ ¥{(round.avgPrice ?? 0).toFixed(3)}</span>
            ) : (
              <span className="text-emerald-400">全部结清</span>
            )}
          </div>
        </div>
      </div>
      <div>
        <button
          onClick={toggleTxns}
          className="tap-target text-[11px] text-blue-400 hover:text-blue-300 underline"
        >
          {showTxns
            ? '▾ 收起成交明细'
            : `▸ 查看成交明细（${txns.length > 0 ? txns.length : round.tradeCount ?? 0} 笔）`}
        </button>
        {showTxns && (
          <div className="mt-2 space-y-1 bg-slate-900 rounded-lg p-2 max-h-48 overflow-y-auto">
            {txnsLoading ? (
              <div className="text-[11px] text-slate-500 py-1">成交明细加载中…</div>
            ) : txns.length > 0 ? (
              txns.map((t) => {
              const isSell = t.direction === 'sell';
              const isMerge = t.direction === 'merge';
              // 卖出行=平仓腿：以成交量为撮合量；仅当明细持久化了有效 matchedAmount(>0) 时
              // 才用它覆盖（归档写路径缺 matchedAmount，读回恒为 0，需回退到成交量）。
              const matched = isSell ? ((t.matchedAmount ?? 0) > 0 ? t.matchedAmount : t.amount) : 0;
              const hasProfit = isSell && (t.realizedProfit ?? 0) !== 0;
              return (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 text-[11px] text-slate-400"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="shrink-0">{new Date(t.timestamp).toLocaleString()}</span>
                    <span
                      className={`px-1 rounded text-[10px] font-bold shrink-0 ${
                        t.direction === 'buy'
                          ? 'bg-blue-500/15 text-blue-400'
                          : isMerge
                          ? 'bg-amber-500/15 text-amber-400'
                          : 'bg-purple-500/15 text-purple-400'
                      }`}
                    >
                      {t.direction === 'buy' ? '买' : isMerge ? '归' : '卖'}
                    </span>
                    <span className="font-mono shrink-0">
                      {t.amount} 股 ¥{t.price.toFixed(2)}
                    </span>
                  </div>
                  {/* 右侧：对冲/归并状态 */}
                  {isMerge ? (
                    <span className="font-mono tabular-nums text-amber-400 shrink-0">
                      归并 {t.amount} 股
                    </span>
                  ) : isSell ? (
                    <span className="font-mono tabular-nums shrink-0">
                      <span className="text-slate-200">撮合 {matched} 股</span>
                      {hasProfit && (
                        <span className={pnlColor(t.realizedProfit ?? 0)}>
                          {(t.realizedProfit ?? 0) >= 0 ? ' +' : ' '}
                          {formatCurrency(t.realizedProfit ?? 0)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="font-mono tabular-nums text-slate-500 shrink-0">
                      规费 ¥{t.fee.toFixed(2)}
                    </span>
                  )}
                </div>
              );
            })
            ) : (
              <div className="text-[11px] text-slate-500 py-1">暂无成交明细</div>
            )}
          </div>
        )}
      </div>
      <button
        onClick={() => setShowDeleteConfirm(true)}
        className="tap-target text-[11px] text-slate-500 hover:text-red-400 underline"
      >
        删除战报
      </button>

      <ConfirmModal
        open={showDeleteConfirm}
        title="删除战报确认"
        message={deleteConfirmMessage}
        confirmLabel="确认删除"
        cancelLabel="取消"
        danger
        onConfirm={() => {
          const result = onRemove(round.id);
          if (!result.ok && result.message) {
            window.dispatchEvent(new CustomEvent('app-toast', { detail: `❌ ${result.message}` }));
          }
          setShowDeleteConfirm(false);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}

/**
 * 短线账本与计算器主页面组件。
 *
 * @description 组合：
 *  - 添加交易流水表单（正T买入/倒T卖出，含费用预览、超卖校验与[全部卖出]快捷键）
 *  - 当前短线项目卡片流（实时撮合状态 + 追加记录 + 划转/结算 + 流水明细列表逐条删除）
 *  - 历史战报归档库（胜率 + 累计净收益 + 战报卡片）
 *  所有写操作均通过 Store Action 落库 IndexedDB 并级联重算流水池。
 * @returns {JSX.Element} 短线账本与计算器页面视图
 * @note 页面挂载即订阅 tRounds（OPENED 流水池 + 归档）/positions 实时响应 Store 变化（数据由 useLoadCoreData 按需加载）
 */
/** 生成本地时间输入框值：YYYY-MM-DD HH:mm（秒清零），与主表单 timestamp 保持一致 */
function formatLocalNowInput(date = new Date()) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 底部面板错误文案：优先展示提交错误，其次展示实时校验错误 */
function apDialogError(
  apError: string,
  validation: { valid: boolean; error?: string } | null | undefined
): string {
  if (apError) return apError;
  if (validation && !validation.valid) return validation.error ?? '';
  return '';
}

/**
 * 移动端折叠卡片：仅在手机屏幕（<768px）下默认折叠标题，点击展开内容。
 * 桌面端始终展开。
 */
function MobileCollapse({ title, badge, defaultCollapsed, children }: { title: string; badge?: React.ReactNode; defaultCollapsed?: boolean; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const effectiveCollapsed = isMobile ? collapsed : false;
  return (
    <>
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="tap-target md:hidden flex items-center justify-between w-full text-left"
      >
        <h3 className="text-base font-semibold text-slate-200">{title}</h3>
        {effectiveCollapsed && badge && (
          <span className="text-xs text-slate-400 ml-2">{badge}</span>
        )}
        <span className="text-slate-400 text-lg transition-transform duration-200" style={{ transform: effectiveCollapsed ? 'rotate(0deg)' : 'rotate(180deg)' }}>
          ▾
        </span>
      </button>
      <h3 className="hidden md:block text-base font-semibold text-slate-200">{title}</h3>
      {!effectiveCollapsed && children}
    </>
  );
}

export default function TCalculator() {
  const feeConfig = useAppStore((s) => s.feeConfig);
  const positions = useAppStore((s) => s.positions);
  const tRounds = useAppStore((s) => s.tRounds);
  // 已归档 Round（按需懒加载，进入页面时异步加载）
  const { archivedRounds, archivedLoading } = useArchivedRounds();
  const addStreamRecord = useAppStore((s) => s.addStreamRecord);
  const removeRound = useAppStore((s) => s.removeRound);
  const clearStreams = useAppStore((s) => s.clearStreams);
  const plannedOrders = useAppStore((s) => s.plannedOrders);
  const setPlannedOrder = useAppStore((s) => s.setPlannedOrder);
  const markPlanExecuted = useAppStore((s) => s.markPlanExecuted);
  const cancelPlan = useAppStore((s) => s.cancelPlan);
  const results = useStreamResults();

  // 仅展示进行中的短线项目（CLEARED = 池内流水已全部配对并自动归档为战报，不再属于当前项目）
  const activeResults = useMemo(() => results.filter((r) => r.status !== 'CLEARED'), [results]);

  // 【短线/中长期强隔离】短线试算项目池：由进行中的短线项目派生，供计划单卡片短线试算匹配（绝不包含中长期底仓）
  const shortTrialProjects = useMemo(() => activeResults.map(toShortTrialProject), [activeResults]);

  // 表单状态
  const [stock, setStock] = useState<StockSearchItem | null>(null);

  // 实时行情：订阅「当前页面显示的标的」= 选中股票 + 所有进行中短线项目的 fullCode，
  // 批量合并为单次请求（q=sh600745,sz002594），返回后各卡片一起更新现价
  const quoteCodes = useMemo(
    () =>
      Array.from(
        new Set(
          [...(stock?.fullCode ? [stock.fullCode] : []), ...activeResults.map((r) => r.fullCode)]
            .map((c) => c.trim())
            .filter(Boolean)
        )
      ),
    [stock, activeResults]
  );
  const { quotes, isTrading, lastUpdated } = useLiveQuotes(quoteCodes);

  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [timestamp, setTimestamp] = useState(() => {
    const now = new Date();
    now.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  // 计划单状态
  const [planFormOpen, setPlanFormOpen] = useState(false);
  const [planStock, setPlanStock] = useState<StockSearchItem | null>(null);
  const [planDirection, setPlanDirection] = useState<'buy' | 'sell'>('buy');
  const [planPrice, setPlanPrice] = useState('');
  const [planAmount, setPlanAmount] = useState('');
  const [planValidity, setPlanValidity] = useState(3);
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<number | null>(null);

  /** 统一显示 Toast 并自动消失 */
  const showToast = useCallback((msg: string, duration = 4000) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(msg);
    // 下一帧触发淡入
    requestAnimationFrame(() => requestAnimationFrame(() => setToastVisible(true)));
    toastTimer.current = window.setTimeout(() => {
      setToastVisible(false);
      // 淡出动画结束后清理 DOM
      toastTimer.current = window.setTimeout(() => setToast(null), 300);
    }, duration);
  }, []);

  // 监听全局 toast 事件
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<string>).detail;
      showToast(msg, 4000);
    };
    window.addEventListener('app-toast', handler);
    return () => {
      window.removeEventListener('app-toast', handler);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, [showToast]);

  // 持仓清零自动结清 Toast：由各录入入口（主表单 handleSubmit / 底部面板 submitAp）
  // 基于 addStreamRecord 返回的 cleared 标志触发；v8 下 CLEARED 轮次会立即归档为
  // COMPLETED Round 并从撮合结果中消失，因此不再基于 results 轮询检测。

  // ---- 派生：选中股票撮合结果 + 底仓 ----
  const selectedResult = useMemo(() => {
    if (!stock?.fullCode) return null;
    return activeResults.find((r) => r.fullCode === stock.fullCode) ?? null;
  }, [activeResults, stock?.fullCode]);

  const basePosition = useMemo(() => {
    if (!stock?.fullCode) return undefined;
    return positions.find((p) => p.fullCode === stock.fullCode && !p.isClosed);
  }, [positions, stock?.fullCode]);

  const validation = useMemo(() => {
    const p = parseFloat(price);
    const a = parseFloat(amount);
    // 倒T（先卖后买）：两级阶梯式校验
    if (direction === 'sell') {
      return validateSellWithStreamResult(selectedResult, basePosition, a || 0);
    }
    return validateStreamTrade(selectedResult, basePosition?.currentAmount ?? 0, 'buy', p || 0, a || 0);
  }, [selectedResult, basePosition, direction, price, amount]);

  // ---- 费用预览 ----
  const feePreview = useMemo(() => {
    const p = parseFloat(price);
    const a = parseFloat(amount);
    if (!p || p <= 0 || !a || a <= 0) return null;
    return calcTradeFees(p, a, direction, feeConfig);
  }, [price, amount, direction, feeConfig]);

  // ---- 全部卖出快捷键 ----
  // 使用 strict 校验返回的 maxSellable：倒T首笔卖出 = 底仓 N_base；后续卖出 = 待对冲持仓 + 底仓
  const fillMaxSell = () => {
    const max = Math.max(0, validation?.maxSellable ?? 0);
    if (max > 0) setAmount(String(max));
    setDirection('sell');
  };

  const handleSubmit = async () => {
    setError('');
    if (!stock?.fullCode) {
      setError('请先选择股票');
      return;
    }
    const p = parseFloat(price);
    const a = parseFloat(amount);
    if (validation && !validation.valid) {
      // 倒T首笔卖出底仓校验失败（缺少持仓/超可卖数量）-> 阻止提交并弹出 Toast
      showToast(`🛑 ${validation.error ?? '输入无效'}`, 4000);
      setError(validation.error ?? '输入无效');
      return;
    }

    const txnFee = calcTradeFees(p, a, direction, feeConfig, matchSecurityKind(stock.SecurityType, stock.Code)).total;
    const record: TStreamRecord = {
      id: generateId(),
      timestamp,
      fullCode: stock.fullCode,
      stockName: stock.Name || stock.ShortName || stock.fullCode,
      direction,
      price: p,
      amount: a,
      fee: roundTo(txnFee, 2),
      note: note.trim() || undefined,
      quoteId: stock.QuoteID,
      selectedStock: stock,
    };

    const result = await addStreamRecord(record);
    // Store 层兜底校验拒绝（倒T首笔卖出缺少底仓/超可卖数量）-> 阻止提交并弹出 Toast
    if (result?.rejected) {
      showToast(`🛑 ${result.rejectedReason ?? '校验未通过'}`, 4000);
      setError(result.rejectedReason ?? '校验未通过');
      return;
    }
    // 自动结清：本轮短线全部配对完成，Round 已归档
    if (result.cleared) {
      showToast(`🎉 本轮短线已完全结清！累计净盈亏：¥${(result.netProfit ?? 0).toFixed(2)}`, 5000);
    }
    setPrice('');
    setAmount('');
    setNote('');
    setError('');
  };

  // ---- 计划单（短线上下文） ----
  // 【短线/中长期强隔离】短线页只展示/管理 context === 'short-term' 的计划单，
  // 严禁穿透到 both/long-term；短线侧永不向 CostAveraging 的 Position 写计划结果。
  const shortTermPlans = useMemo(() => {
    const now = Date.now();
    const displayWindow = 3 * 24 * 60 * 60 * 1000;
    return plannedOrders.filter((p) => {
      if (p.status === 'cancelled') return false;
      if (p.context !== 'short-term') return false;
      if (p.status === 'expired' || p.status === 'executed') {
        const expiresAt = new Date(p.expiresAt).getTime();
        return (now - expiresAt) <= displayWindow;
      }
      return true;
    });
  }, [plannedOrders]);

  const handlePlanExecute = useCallback((order: PlannedOrder, actualPrice: number, actualAmount: number, note: string) => {
    const direction = order.direction;
    const txnFee = calcTradeFees(actualPrice, actualAmount, direction, feeConfig).total;
    const record: TStreamRecord = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      fullCode: order.fullCode,
      stockName: order.stockName,
      direction,
      price: actualPrice,
      amount: actualAmount,
      fee: roundTo(txnFee, 2),
      note: note || undefined,
    };
    const result = addStreamRecord(record);
    if (result?.rejected) {
      showToast(`🛑 ${result.rejectedReason ?? '校验未通过'}`, 4000);
      return;
    }
    const isAchieved = order.direction === 'buy' ? actualPrice <= order.plannedPrice : actualPrice >= order.plannedPrice;
    markPlanExecuted(order.id, {
      executedAt: new Date().toISOString(),
      actualPrice,
      actualAmount,
      note: note || undefined,
      isAchieved,
      avgPrice: result?.avgPrice,
      netProfit: result?.netProfit,
    });
    showToast(`✅ 计划单已执行 · ${order.stockName}`, 3000);
  }, [addStreamRecord, markPlanExecuted, feeConfig, showToast]);

  const handleCreatePlan = () => {
    if (!planStock?.fullCode) { showToast('请选择股票', 3000); return; }
    const p = parseFloat(planPrice);
    const a = parseFloat(planAmount);
    if (!p || p <= 0) { showToast('请输入有效价格', 3000); return; }
    if (!a || a <= 0) { showToast('请输入有效数量', 3000); return; }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + planValidity * 24 * 60 * 60 * 1000);
    const order: PlannedOrder = {
      id: generateId(),
      fullCode: planStock.fullCode,
      stockName: planStock.Name || planStock.ShortName || planStock.fullCode,
      context: 'short-term',
      direction: planDirection,
      plannedPrice: p,
      plannedAmount: a,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      validityDays: planValidity,
      status: 'active',
    };
    setPlannedOrder(order);
    setPlanFormOpen(false);
    setPlanStock(null);
    setPlanPrice('');
    setPlanAmount('');
    setPlanDirection('buy');
    setPlanValidity(3);
    showToast(`📋 计划单已创建 · ${order.stockName}`, 3000);
  };

  const planQuoteCodes = useMemo(() => shortTermPlans.map((p) => p.fullCode), [shortTermPlans]);
  const { quotes: planQuotes } = useLiveQuotes(planQuoteCodes);

  // ---- 归档历史库胜率统计（仅统计近14天完成的战报） ----
  const recentArchivedRounds = useMemo(() => {
    const now = Date.now();
    const cutoff = now - 14 * 24 * 60 * 60 * 1000;
    return archivedRounds.filter((r) => {
      const t = new Date(r.closedAt ?? r.openedAt).getTime();
      return t >= cutoff;
    });
  }, [archivedRounds]);

  const archiveStats = useMemo(() => {
    const wins = recentArchivedRounds.filter((r) => r.win).length;
    const total = recentArchivedRounds.length;
    return {
      wins,
      total,
      rate: total > 0 ? (wins / total) * 100 : 0,
      cumulative: recentArchivedRounds.reduce((s, r) => s + r.netProfit, 0),
    };
  }, [recentArchivedRounds]);

  // 汇总卡片口径：包含已结清（CLEARED）轮次在内，累计已实现净收益与「今日战报归档库」累计口径一致
  const totalPending = results.reduce((s, r) => s + Math.max(0, r.netPendingAmount), 0);
  const totalRealizedPnl = results.reduce((s, r) => s + r.realizedPnL, 0);

  // ============================================================
  // 追加流水 / 快捷对冲：底部固定动作条 + 底部滑出面板（Bottom Sheet）
  // 与主表单共用 addStreamRecord 提交管道（记录创建 + 校验 + 撮合归档），
  // 卡片内按钮与底部动作条共享同一套打开/提交逻辑，避免双写路径。
  // ============================================================
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetFullCode, setSheetFullCode] = useState<string | null>(null);
  const [apDir, setApDir] = useState<'buy' | 'sell'>('buy');
  const [apPrice, setApPrice] = useState('');
  const [apAmount, setApAmount] = useState('');
  const [apTime, setApTime] = useState(() => formatLocalNowInput());
  const [apNote, setApNote] = useState('');
  const [apError, setApError] = useState('');

  // 面板目标标的的派生数据（全在页面级派生，保证移动端/桌面端行为一致）
  const apResult = useMemo(
    () => (sheetFullCode ? activeResults.find((r) => r.fullCode === sheetFullCode) ?? null : null),
    [activeResults, sheetFullCode]
  );
  const apQuote = sheetFullCode ? quotes[sheetFullCode] ?? null : null;
  const apPosition = useMemo(
    () => (sheetFullCode ? positions.find((p) => p.fullCode === sheetFullCode && !p.isClosed) : undefined),
    [positions, sheetFullCode]
  );
  // 从该 Round 首笔流水还原 StockSearchItem 快照（用于费率匹配与 selectedStock 落库）
  const apStock = useMemo(() => {
    const ent = apResult?.entries[0] as unknown as TStreamRecord | undefined;
    return (ent?.selectedStock as StockSearchItem | undefined) ?? null;
  }, [apResult]);
  const apBaseHolding = apPosition?.currentAmount ?? 0;
  const apPendingQty = Math.max(0, apResult?.netPendingAmount ?? 0);

  const apValidation = useMemo(() => {
    const p = parseFloat(apPrice);
    const a = parseFloat(apAmount);
    // 倒T（先卖后买）：两级阶梯式校验；正T买入：数量校验
    if (apDir === 'sell') return validateSellWithStreamResult(apResult, apPosition, a || 0);
    return validateStreamTrade(apResult, apBaseHolding, 'buy', p || 0, a || 0);
  }, [apResult, apPosition, apDir, apPrice, apAmount, apBaseHolding]);

  const apFee = useMemo(() => {
    const p = parseFloat(apPrice);
    const a = parseFloat(apAmount);
    if (!p || p <= 0 || !a || a <= 0) return null;
    return calcTradeFees(
      p,
      a,
      apDir,
      feeConfig,
      matchSecurityKind(apStock?.SecurityType ?? '', apStock?.Code ?? '')
    );
  }, [apPrice, apAmount, apDir, feeConfig, apStock]);

  // 快捷数量胶囊：从「剩余待平仓」推导，全部 / 一半 / 整手
  const qtyCapsules = useMemo(() => {
    const all = apPendingQty;
    return [
      { label: '全部待平仓', qty: Math.max(0, all) },
      { label: '1/2', qty: Math.max(0, Math.round(all / 2)) },
      { label: '100股', qty: 100 },
    ].filter((c) => c.qty > 0);
  }, [apPendingQty]);

  const openSheet = (fullCode: string, dir: 'buy' | 'sell', pricePrefill = '', amountPrefill = '') => {
    setSheetFullCode(fullCode);
    setApDir(dir);
    setApPrice(pricePrefill);
    setApAmount(amountPrefill);
    setApTime(formatLocalNowInput());
    setApNote('');
    setApError('');
    setSheetOpen(true);
  };

  /** 追加记录：默认买入方向，预填最新价 */
  const openAppendFor = (fullCode: string) => {
    const q = quotes[fullCode];
    openSheet(
      fullCode,
      'buy',
      q?.currentPrice ? String(roundTo(q.currentPrice, 3)) : '',
      ''
    );
  };

  /** 快捷对冲：正T（待平仓>0）→ 卖出、倒T → 买入，预填 |netPendingAmount| 与最新价 */
  const openQuickHedgeFor = (fullCode: string) => {
    const res = activeResults.find((r) => r.fullCode === fullCode);
    const q = quotes[fullCode];
    const qty = Math.max(0, res?.netPendingAmount ?? 0);
    openSheet(
      fullCode,
      qty > 0 ? 'sell' : 'buy',
      q?.currentPrice ? String(roundTo(q.currentPrice, 3)) : '',
      qty > 0 ? String(qty) : ''
    );
  };

  /** 价格 ±0.01 步进（无有效输入时以最新价为基准） */
  const stepApPrice = (delta: number) => {
    const cur = parseFloat(apPrice);
    const base = Number.isNaN(cur) ? (apQuote?.currentPrice ?? 0) : cur;
    setApPrice(roundTo(Math.max(0, base + delta), 3).toFixed(3));
  };

  const submitAp = async () => {
    setApError('');
    if (!sheetFullCode || !apResult) return;
    const p = parseFloat(apPrice);
    const a = parseFloat(apAmount);
    if (!p || p <= 0) { setApError('请输入有效价格'); return; }
    if (!a || a <= 0) { setApError('请输入有效数量'); return; }
    if (apValidation && !apValidation.valid) {
      const msg = apValidation.error ?? '输入无效';
      setApError(msg);
      showToast(`🛑 ${msg}`, 4000);
      return;
    }
    const secType = apStock?.SecurityType ?? '';
    const code = apStock?.Code ?? sheetFullCode.replace(/^(sh|sz)/i, '');
    const txnFee = calcTradeFees(p, a, apDir, feeConfig, matchSecurityKind(secType, code)).total;
    const record: TStreamRecord = {
      id: generateId(),
      timestamp: apTime,
      fullCode: sheetFullCode,
      stockName: apStock?.Name || apStock?.ShortName || apResult.stockName || sheetFullCode,
      direction: apDir,
      price: p,
      amount: a,
      fee: roundTo(txnFee, 2),
      note: apNote.trim() || undefined,
      quoteId: apStock?.QuoteID ?? '',
      selectedStock: apStock ?? undefined,
    };
    const result = await addStreamRecord(record);
    // Store 层兜底校验拒绝（倒T首笔卖出缺少底仓/超可卖数量、买入超过底仓）-> 阻止提交
    if (result?.rejected) {
      const msg = result.rejectedReason ?? '校验未通过';
      setApError(msg);
      showToast(`🛑 ${msg}`, 4000);
      return;
    }
    // 自动结清：本轮短线全部配对完成，Round 已归档
    if (result.cleared) {
      showToast(`🎉 本轮短线已完全结清！累计净盈亏：¥${(result.netProfit ?? 0).toFixed(2)}`, 5000);
    }
    setSheetOpen(false);
    setSheetFullCode(null);
    setApDir('buy');
    setApPrice('');
    setApAmount('');
    setApNote('');
    setApError('');
  };

  const firstActive = activeResults[0] ?? null;

  return (
    <div className="page-container space-y-5 pb-[calc(env(safe-area-inset-bottom)+96px)] md:pb-12">
      {/* Header 标题 */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div>
          <h2 className="text-lg font-bold text-slate-200">短线账本</h2>
          <p className="text-xs text-slate-500">流水池 FIFO 撮合 · 绝对现金流法 · 自动归档战报</p>
        </div>
      </div>

      {/* Toast — 自动消失 + 淡入淡出 + 手动关闭 */}
      {toast && (
        <div
          className={`fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-slate-800 text-white text-sm shadow-lg border border-slate-600 transition-opacity duration-300 ${
            toastVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <span className="mr-3">{toast}</span>
          <button
            onClick={() => { setToastVisible(false); setTimeout(() => setToast(null), 300); }}
            className="text-slate-400 hover:text-white transition-colors text-base leading-none"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
      )}

      {/* 实时行情状态：当前页全部标的批量合并为一次请求，交易时段每 5 秒刷新 */}
      <div className="flex items-center justify-between px-1 text-xs">
        <span className={isTrading ? 'text-blue-400 font-medium' : 'text-slate-500'}>
          {isTrading ? '● 交易时段 · 行情每 5 秒自动刷新' : '○ 非交易时段 · 打开时刷新一次'}
        </span>
        {lastUpdated !== null && (
          <span className="text-slate-600">
            行情更新于 {new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        )}
      </div>

      {/* 汇总卡片 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-3">
          <div className="text-xs text-slate-500">累计已实现短线净收益</div>
          <div className={`font-mono font-bold text-lg tabular-nums ${pnlColor(totalRealizedPnl)}`}>
            {formatCurrency(totalRealizedPnl)}
          </div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-3">
          <div className="text-xs text-slate-500">当前待对冲持仓量</div>
          <div className="font-mono font-bold text-lg text-slate-200 tabular-nums">{totalPending} 股</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-3">
          <div className="text-xs text-slate-500">待对冲加权成本</div>
          <div className="font-mono font-bold text-lg text-blue-400 tabular-nums">
            {activeResults.length > 0
              ? `¥${roundTo(
                  activeResults.reduce((s, r) => s + r.weightedBuyCost * Math.max(0, r.netPendingAmount), 0) /
                    Math.max(1, totalPending),
                  3
                )}`
              : '--'}
          </div>
        </div>
      </div>

      {/* 添加流水表单（移动端默认折叠，点击展开） */}
      <div className="card">
        <MobileCollapse title="添加交易流水" defaultCollapsed={true}>
        {/* 方向切换（仿涨跌幅模式切换样式） */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <button
            onClick={() => setDirection('buy')}
            className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              direction === 'buy'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'bg-slate-900 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
            正T · 买入
          </button>
          <button
            onClick={() => setDirection('sell')}
            className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              direction === 'sell'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'bg-slate-900 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-purple-400 inline-block" />
            倒T · 卖出
          </button>
        </div>

        <div className="mb-3.5">
          <StockAutocomplete
            value={stock}
            onChange={(s) => {
              setStock(s);
              setError('');
            }}
            placeholder="搜索股票代码/名称..."
          />
        </div>

        {/* 选中股票的实时现价（来自批量行情请求） */}
        {stock?.fullCode && quotes[stock.fullCode] && quotes[stock.fullCode]!.currentPrice > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-slate-500">实时现价</span>
            <span className={`font-mono font-bold text-sm tabular-nums ${quotes[stock.fullCode]!.changePercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
              ¥{quotes[stock.fullCode]!.currentPrice.toFixed(3)}
            </span>
            <span className={`font-mono ${quotes[stock.fullCode]!.changePercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
              {quotes[stock.fullCode]!.changePercent >= 0 ? '+' : ''}
              {quotes[stock.fullCode]!.changePercent.toFixed(2)}%
            </span>
          </div>
        )}

        <div className="form-row">
          <div className="form-group">
            <label>价格（元）</label>
            <input
              type="text"
              inputMode="decimal"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.000"
            />
          </div>
          <div className="form-group">
            <label>数量（股）</label>
            <input
              type="text"
              inputMode="numeric"
              min="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100"
            />
          </div>
        </div>

        <div className="form-group">
          <label>时间</label>
          <input
            type="datetime-local"
            value={timestamp}
            onChange={(e) => setTimestamp(e.target.value)}
            step="60"
            className="[color-scheme:dark]"
          />
        </div>

        <div className="form-group">
          <label>备注</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="可选"
          />
        </div>

        {/* 费用预览 + 超卖提示 + 全部卖出 */}
        {feePreview && (
          <div className="mt-3 p-3 bg-slate-900 rounded-lg text-xs text-slate-400 font-mono">
            规费：佣金 ¥{feePreview.commission.toFixed(2)} · 印花税 ¥{feePreview.stamp.toFixed(2)} · 过户费 ¥{feePreview.transfer.toFixed(2)} · 合计 <span className="text-slate-200">¥{feePreview.total.toFixed(2)}</span>
          </div>
        )}

        {validation && !validation.valid && (
          <div className="mt-3 flex items-center justify-between gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <span className="text-xs font-medium text-red-300">🛑 {validation.error}</span>
            {/* 超可卖数量时才提供 [全部卖出] 快捷填入；缺少持仓（maxSellable=0）时无可卖数量可填 */}
            {(validation.maxSellable ?? 0) > 0 && (
              <button
                onClick={fillMaxSell}
                className="tap-target text-xs px-2.5 py-1.5 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 shrink-0"
              >
                全部卖出
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="mt-3 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* 借仓对冲提示（仅卖出且需占用底仓时显示） */}
        {validation?.warning && (
          <div className="mt-3 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
            <span className="text-xs text-amber-300">⚠️ {validation.warning}</span>
          </div>
        )}

        <button
          onClick={handleSubmit}
          className="btn btn-primary btn-block mt-2 tap-target"
        >
          提交流水
        </button>
        </MobileCollapse>
      </div>

      {/* 当前项目（移动端默认折叠） */}
      <div className="space-y-3">
        <MobileCollapse title="当前短线项目" defaultCollapsed={true} badge={`${activeResults.length} 个项目`}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-200 hidden md:block">当前短线项目</h3>
          {activeResults.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm('确认清空全部短线流水？')) clearStreams();
              }}
              className="text-xs text-slate-500 hover:text-red-400 underline"
            >
              清空流水池
            </button>
          )}
        </div>

        {activeResults.length === 0 ? (
          <div className="bg-slate-800 border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            暂无进行中的短线项目（已自动归档的战报请在下方「今日战报归档库」查看）
          </div>
        ) : (
          activeResults.map((r) => {
            return (
              <CurrentProjectCard
                key={r.fullCode}
                result={r}
                basePosition={positions.find((p) => p.fullCode === r.fullCode && !p.isClosed)}
                feeConfig={feeConfig}
                quote={quotes[r.fullCode] ?? null}
                onAppend={() => openAppendFor(r.fullCode)}
                onQuickHedge={() => openQuickHedgeFor(r.fullCode)}
              />
            );
          })
        )}
        </MobileCollapse>
      </div>

      {/* 计划单（短线） */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-200">📋 计划单（短线）</h3>
          {shortTermPlans.length > 0 && (
            <span className="text-xs text-slate-500">{shortTermPlans.filter(p => p.status === 'active').length} 个进行中</span>
          )}
        </div>

        {/* 创建计划单按钮/表单 */}
        {!planFormOpen ? (
          <button
            onClick={() => setPlanFormOpen(true)}
            className="w-full py-2 text-xs text-slate-400 hover:text-slate-200 border border-dashed border-slate-700 rounded-lg hover:border-slate-600 transition-colors"
          >
            + 添加计划单
          </button>
        ) : (
          <div className="bg-slate-900 rounded-lg border border-slate-700 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">新建计划单</span>
              <button
                onClick={() => { setPlanFormOpen(false); setPlanStock(null); }}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>
            <StockAutocomplete
              value={planStock}
              onChange={(s) => setPlanStock(s)}
              placeholder="搜索股票代码/名称..."
            />
            {/* 方向选择 */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setPlanDirection('buy')}
                className={`text-xs rounded-lg py-2 font-medium transition-colors ${
                  planDirection === 'buy' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'
                }`}
              >
                计划买入
              </button>
              <button
                onClick={() => setPlanDirection('sell')}
                className={`text-xs rounded-lg py-2 font-medium transition-colors ${
                  planDirection === 'sell' ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-400'
                }`}
              >
                计划卖出
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-slate-500 mb-1">计划价格（元）</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={planPrice}
                  onChange={(e) => setPlanPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-500 mb-1">计划数量（股）</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={planAmount}
                  onChange={(e) => setPlanAmount(e.target.value)}
                  placeholder="100"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
            {/* 有效期选择 */}
            <div>
              <label className="block text-[10px] text-slate-500 mb-1">有效期</label>
              <div className="flex gap-1.5">
                {[1, 3, 7, 14, 30].map((d) => (
                  <button
                    key={d}
                    onClick={() => setPlanValidity(d)}
                    className={`flex-1 text-xs py-1.5 rounded-lg transition-colors ${
                      planValidity === d ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    {d}天
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={handleCreatePlan}
              className="w-full text-xs py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors"
            >
              确认创建
            </button>
          </div>
        )}

        {/* 计划单列表 */}
        {shortTermPlans.length === 0 ? (
          <div className="bg-slate-800 border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            暂无计划单，创建后可在执行前看到价格对比变化
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {shortTermPlans.map((p) => (
              <PlanOrderCard
                key={p.id}
                order={p}
                quote={planQuotes[p.fullCode] ?? null}
                position={positions.find((pos) => pos.fullCode === p.fullCode && !pos.isClosed) ?? null}
                feeConfig={feeConfig}
                shortProjects={shortTrialProjects}
                onEdit={(order) => {
                  setPlanStock({ fullCode: order.fullCode, Name: order.stockName, ShortName: '', Code: order.fullCode.replace(/^sh|sz|bj/, ''), SecurityType: '', QuoteID: '', PinYin: '', SecurityTypeName: '', MktNum: '', MarketType: '', Classify: '', Type: '', UnifiedCode: '', InnerCode: '' });
                  setPlanDirection(order.direction);
                  setPlanPrice(String(order.plannedPrice));
                  setPlanAmount(String(order.plannedAmount));
                  setPlanValidity(order.validityDays);
                  setPlanFormOpen(true);
                }}
                onExecute={handlePlanExecute}
                onCancel={(id) => cancelPlan(id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 归档历史库 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-200">🏆 近期记录归档（近14天）</h3>
          {recentArchivedRounds.length > 0 && (
            <div className="text-xs text-slate-400 flex items-center gap-3">
              <span>
                胜率{' '}
                <b className={archiveStats.rate >= 50 ? 'text-red-400' : 'text-green-400'}>
                  {archiveStats.wins}/{archiveStats.total}（{archiveStats.rate.toFixed(0)}%）
                </b>
              </span>
              <span>
                累计净现金{' '}
                <b className={`font-mono tabular-nums ${pnlColor(archiveStats.cumulative)}`}>
                  {formatCurrency(archiveStats.cumulative)}
                </b>
              </span>
            </div>
          )}
        </div>

        {archivedLoading ? (
          <div className="bg-slate-800 border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            加载历史战报数据...
          </div>
        ) : recentArchivedRounds.length === 0 ? (
          <div className="bg-slate-800 border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            近14天暂无已完成战报
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[...recentArchivedRounds]
              .sort((a, b) => new Date(b.closedAt ?? b.openedAt).getTime() - new Date(a.closedAt ?? a.openedAt).getTime())
              .map((round) => (
                <ArchiveRoundCard key={round.id} round={round} onRemove={(id) => removeRound(id)} />
              ))}
          </div>
        )}
      </div>

      {/* 追加 / 快捷对冲 底部滑出面板（Bottom Sheet），移动端 + 桌面端共用同一套逻辑 */}
      {sheetOpen && sheetFullCode && apResult && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          {/* 遮罩：点击空白关闭 */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setSheetOpen(false)}
          />
          <div className="bottom-sheet relative w-full max-w-lg bg-slate-900 border border-slate-700 border-b-0 rounded-t-2xl shadow-2xl px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+16px)] max-h-[88dvh] overflow-y-auto">
            {/* 拖拽手柄 */}
            <div className="mx-auto h-1.5 w-12 rounded-full bg-slate-700 mb-3" />

            {/* 标题 + 关闭 */}
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-100 truncate">追加流水 · {apResult.stockName}</p>
                <p className="text-[11px] text-slate-500">{sheetFullCode}</p>
              </div>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="tap-target rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 shrink-0"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>

            {/* 方向切换 */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                type="button"
                onClick={() => setApDir('buy')}
                className={`tap-target text-sm rounded-lg font-medium transition-colors ${
                  apDir === 'buy'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                买入
              </button>
              <button
                type="button"
                onClick={() => setApDir('sell')}
                className={`tap-target text-sm rounded-lg font-medium transition-colors ${
                  apDir === 'sell'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                卖出
              </button>
            </div>

            {/* 价格（带 ±0.01 步进）+ 数量 */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="form-group">
                <label>价格（元）</label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => stepApPrice(-0.01)}
                    className="tap-target rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 shrink-0"
                    aria-label="价格减 0.01"
                  >
                    −0.01
                  </button>
                  <input
                    type="text"
                    inputMode="decimal"
                    min="0"
                    value={apPrice}
                    onChange={(e) => setApPrice(e.target.value)}
                    placeholder="0.000"
                  />
                  <button
                    type="button"
                    onClick={() => stepApPrice(0.01)}
                    className="tap-target rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 shrink-0"
                    aria-label="价格加 0.01"
                  >
                    +0.01
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label>数量（股）</label>
                <input
                  type="text"
                  inputMode="numeric"
                  min="1"
                  value={apAmount}
                  onChange={(e) => setApAmount(e.target.value)}
                  placeholder="100"
                />
              </div>
            </div>

            {/* 快捷数量胶囊 + 最新价 */}
            {qtyCapsules.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {qtyCapsules.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => setApAmount(String(c.qty))}
                    className="tap-target text-xs px-3 rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700"
                  >
                    {c.label}
                  </button>
                ))}
                {apQuote && apQuote.currentPrice > 0 && (
                  <button
                    type="button"
                    onClick={() => setApPrice(String(roundTo(apQuote.currentPrice, 3)))}
                    className="tap-target text-xs px-3 rounded-full bg-slate-800 text-blue-300 hover:bg-slate-700"
                  >
                    用最新价
                  </button>
                )}
              </div>
            )}

            {/* 时间 + 备注 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <div className="form-group">
                <label>时间</label>
                <input
                  type="datetime-local"
                  value={apTime}
                  onChange={(e) => setApTime(e.target.value)}
                  step="60"
                  className="[color-scheme:dark]"
                />
              </div>
              <div className="form-group">
                <label>备注</label>
                <input
                  type="text"
                  value={apNote}
                  onChange={(e) => setApNote(e.target.value)}
                  placeholder="可选"
                />
              </div>
            </div>

            {/* 校验错误 + 全部卖出快捷键 */}
            {apDialogError(apError, apValidation) && (
              <div className="flex items-center justify-between gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300 mb-3">
                <span className="min-w-0 break-words">🛑 {apDialogError(apError, apValidation)}</span>
                {apValidation && !apValidation.valid && (apValidation as { maxSellable?: number }).maxSellable ? (
                  <button
                    type="button"
                    onClick={() => setApAmount(String((apValidation as { maxSellable: number }).maxSellable))}
                    className="tap-target text-xs px-2 rounded-lg bg-red-600 text-white hover:bg-red-700 shrink-0"
                  >
                    全部卖出
                  </button>
                ) : null}
              </div>
            )}
            {apValidation?.warning && (
              <div className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 mb-3">
                ⚠️ {apValidation.warning}
              </div>
            )}
            {apFee && (
              <div className="text-xs text-slate-500 mb-3 flex items-center justify-between">
                <span>预计手续费</span>
                <span className="font-mono tabular-nums text-slate-400">¥{apFee.total.toFixed(2)}</span>
              </div>
            )}

            <button type="button" onClick={submitAp} className="btn btn-primary w-full tap-target">
              追加提交
            </button>
          </div>
        </div>
      )}

      {/* 底部固定动作条：移动端常驻，一键进入 追加 / 快捷对冲（桌面端保留卡片内按钮） */}
      {activeResults.length > 0 && firstActive && (
        <div className="fixed inset-x-0 bottom-0 z-40 md:hidden">
          <div className="fixed-bar px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+8px)]">
            <div className="mx-auto w-full max-w-2xl grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => openAppendFor(firstActive.fullCode)}
                className="btn btn-primary tap-target"
              >
                + 追加记录
              </button>
              <button
                type="button"
                onClick={() => openQuickHedgeFor(firstActive.fullCode)}
                className={`btn tap-target ${
                  apPendingQty > 0 ? 'bg-amber-500 hover:bg-amber-400 text-slate-900' : 'bg-slate-700 text-slate-300'
                }`}
              >
                ⚡ 快捷对冲
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
