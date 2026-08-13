/**
 * @file TCalculator.tsx
 * @description 做T账本与计算器（页面核心）：管理做T（Round）全生命周期 ——
 *              流水池撮合（FIFO/加权平均/部分对冲/级联重算）、正T/倒T记录追加、
 *              一键划转底仓（绝对现金流法）、倒T结算归档，并内嵌归档历史库
 *              （Round 卡片 + 胜率 + 累计净收益）。
 * @layer UI
 * @storage_impact 写表：tStreams（流水池，applyStreamRecord）、tRounds（结算归档）、
 *                 positions/batches/cashTransactions（划转/现金流）；
 *                 读表：settings（费率）。
 * @author 开发团队
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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
  type TStreamRecord,
  type StockStreamResult,
} from '../utils/tStreamEngine';
import StockAutocomplete from '../components/ui/StockAutocomplete';
import ConfirmModal from '../components/ui/ConfirmModal';
import type { StockQuoteSummary, StockSearchItem } from '../types/stock';
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
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-400">
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
  buy: 'bg-red-500/10 border-red-500/30',
  sell: 'bg-emerald-500/10 border-emerald-500/30',
};

/** 结算标签颜色映射 */
const SETTLE_LABEL_COLORS: Record<string, string> = {
  green: 'bg-emerald-500/15 text-emerald-400',
  red: 'bg-red-500/15 text-red-400',
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
function StepNodeCard({ node }: { node: TStepNode }) {
  const isBuy = node.direction === 'buy';
  return (
    <div className={`rounded-lg border p-2.5 text-xs space-y-1 ${STEP_COLORS[node.direction]}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 font-mono tabular-nums">#{node.index}</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
            isBuy ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'
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
          <span className="text-slate-500">当前持仓</span>
          <div className="font-mono font-semibold text-blue-400 tabular-nums">
            ¥{node.currentCost.toFixed(3)}
          </div>
          <span className="text-[10px] text-slate-500 tabular-nums">{node.currentQuantity} 股</span>
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
          <div className="font-mono font-semibold text-red-400 tabular-nums">{formatCurrency(card.totalFrictionCost)}</div>
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
}: {
  entries: TStreamRecord[];
  basePosition: BasePosition | null;
  feeConfig: FeeConfig | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [defenseSMCopy, setDefenseSMCopy] = useState<TStateMachineState | null>(null);

  // 逐条推进状态机
  const { smState, triggeredDefense } = useMemo(() => {
    if (!basePosition || entries.length === 0) return { smState: null, triggeredDefense: false };
    // 按时间升序排列流水
    const sorted = [...entries].sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb;
    });

    let state = createInitialState(basePosition);
    let defense = false;
    for (const entry of sorted) {
      if (!feeConfig) break;
      const output = stepTEngine({
        state,
        record: entry,
        feeConfig,
        basePosition,
      });
      state = output.newState;
      if (output.triggeredDefense) {
        defense = true;
        setDefenseSMCopy(state);
        break;
      }
      if (state.isClosed) break;
    }
    return { smState: state, triggeredDefense: defense };
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

  return (
    <div className="pt-1 border-t border-slate-600/50 mt-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-xs text-purple-400 hover:text-purple-300 underline"
      >
        {expanded
          ? '🔼 收起状态机详情'
          : `🔽 状态机详情（${smState.steps.length} 步${smState.isClosed ? ' · ' + (smState.settlementCard?.label ?? '已结束') : ''}）`}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {/* 步骤节点卡片 */}
          {smState.steps.map((step) => (
            <StepNodeCard key={step.recordId} node={step} />
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
      )}
    </div>
  );
}

/**
 * 单个进行中做T项目卡片（核心业务卡片）。
 *
 * @description 展示某标的的实时流水池撮合状态：剩余待对冲/倒T待回补、加权成本、
 *              累计已实现盈亏、流水明细列表（逐条可删除）、[+追加记录] 快速录入，
 *              并提供「一键划转底仓」「结算倒T」「归档」等写操作入口。
 * @param {{ result: StockStreamResult; basePosition: Position | undefined }} props
/**
 * 单个进行中做T项目卡片（核心业务卡片）。
 *
 * @description 展示某标的的实时流水池撮合状态：剩余待对冲/倒T待回补、加权成本、
 *              累计已实现盈亏、流水明细列表（逐条可删除）、[+追加记录] 快速录入，
 *              并提供「一键划转底仓」「结算倒T」「归档」等写操作入口。
 * @param {{ result: StockStreamResult; basePosition: Position | undefined; quote: StockQuoteSummary | null }} props
 *  - result: 该标的的流水池撮合结果
 *  - basePosition: 对应底仓持仓（用于超卖校验与划转）
 *  - quote: 该标的最新实时行情（批量请求返回，无行情时为 null）
 * @returns {JSX.Element} 做T项目卡片视图
 * @note 写操作均委托 Store Action 落库并触发级联重算；超卖/数量校验由
 *       validateStreamTrade 在录入前拦截
 */
function CurrentProjectCard({
  result,
  basePosition,
  feeConfig,
  quote,
}: {
  result: StockStreamResult;
  basePosition: Position | undefined;
  feeConfig: FeeConfig | undefined;
  quote: StockQuoteSummary | null;
}) {
  const [showAppend, setShowAppend] = useState(false);
  const [showEntries, setShowEntries] = useState(false);
  const removeStreamRecord = useAppStore((s) => s.removeStreamRecord);
  /** entries 按时间倒序（最新在最上方），仅最新一条可撤销删除 */
  const sortedEntries = [...result.entries].sort(
    //(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    (a, b) => b.id.localeCompare(a.id)
  );
  const transferToPosition = useAppStore((s) => s.transferToPosition);
  const settleShortRound = useAppStore((s) => s.settleShortRound);
  const addToast = (msg: string) => window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));
  const addStreamRecordFn = useAppStore((s) => s.addStreamRecord);

  const baseHolding = basePosition?.currentAmount ?? 0;

  const handleSettleShort = async () => {
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

  // ---- [+ 追加记录] 快速录入（同标的便捷追加，走同一撮合引擎） ----
  const [apDir, setApDir] = useState<'buy' | 'sell'>('buy');
  const [apPrice, setApPrice] = useState('');
  const [apAmount, setApAmount] = useState('');
  const [apTime, setApTime] = useState(() => {
    const now = new Date();
    now.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  });
  const [apNote, setApNote] = useState('');
  const [apError, setApError] = useState('');

  const apValidation = (() => {
    const p = parseFloat(apPrice);
    const a = parseFloat(apAmount);
    return validateStreamTrade(result, baseHolding, apDir, p || 0, a || 0);
  })();

  const fillAppendMaxSell = () => {
    const max = Math.max(0, result.netPendingAmount + baseHolding);
    if (max > 0) setApAmount(String(max));
    setApDir('sell');
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

  const handleAppend = async () => {
    setApError('');
    const p = parseFloat(apPrice);
    const a = parseFloat(apAmount);
    if (!apValidation.valid) {
      setApError(apValidation.error ?? '输入无效');
      return;
    }
    const txnFee = calcTradeFees(p, a, apDir, useAppStore.getState().feeConfig, matchSecurityKind('', result.fullCode.replace(/^sh|sz|bj/, ''))).total;
    const rec: TStreamRecord = {
      id: generateId(),
      timestamp: apTime,
      fullCode: result.fullCode,
      stockName: result.stockName,
      direction: apDir,
      price: p,
      amount: a,
      fee: roundTo(txnFee, 2),
      note: apNote.trim() || undefined,
    };
    const res = await addStreamRecordFn(rec);
    // Store 层兜底校验拒绝（倒T首笔卖出缺少底仓/超可卖数量）-> 阻止提交并弹出 Toast
    if (res?.rejected) {
      addToast(`🛑 ${res.rejectedReason ?? '校验未通过'}`);
      setApError(res.rejectedReason ?? '校验未通过');
      return;
    }
    if (res.cleared) {
      addToast(`🎉 本轮做T已完全结清！累计净盈亏：¥${(res.netProfit ?? 0).toFixed(2)}`);
    } else {
      addToast(`已追加 ${apDir === 'buy' ? '买入' : '卖出'} ${a} 股流水`);
    }
    setApPrice('');
    setApAmount('');
    setApNote('');
    setShowAppend(false);
  };

  return (
    <div className="card space-y-3 !mb-0">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-semibold text-slate-200 truncate">{result.stockName}</span>
          <span className="text-xs text-slate-500 shrink-0">{result.fullCode}</span>
          <span className="text-xs bg-slate-700/80 text-slate-200 px-1.5 py-0.5 rounded-full font-bold shrink-0">
            {roundCode}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 ${result.mode === 'short' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
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

      {/* 当前项目指标 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <div className="bg-slate-900 rounded-lg p-2.5">
          <div className="text-xs text-slate-500">加权均价 P_avg</div>
          <div className="font-mono font-semibold text-blue-400 tabular-nums">
            {result.avgPrice > 0 ? `¥${result.avgPrice.toFixed(3)}` : '--'}
          </div>
        </div>
        <div className="bg-slate-900 rounded-lg p-2.5">
          <div className="text-xs text-slate-500">已卖对冲数量</div>
          <div className="font-mono font-semibold text-slate-200 tabular-nums">{result.realizedSellAmount} 股</div>
        </div>
        <div className="bg-slate-900 rounded-lg p-2.5">
          <div className="text-xs text-slate-500">剩余待处理持仓</div>
          <div className="font-mono font-semibold text-slate-200 tabular-nums">
            {Math.max(0, result.netPendingAmount)} 股
          </div>
        </div>
        <div className="bg-slate-900 rounded-lg p-2.5">
          <div className="text-xs text-slate-500">已实现净收益</div>
          <div className={`font-mono font-semibold tabular-nums ${pnlColor(result.realizedPnL)}`}>
            {formatCurrency(result.realizedPnL)}
          </div>
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
            className="text-xs text-blue-400 hover:text-blue-300 underline"
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
                            ? 'bg-red-500/15 text-red-400'
                            : 'bg-emerald-500/15 text-emerald-400'
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
                          className="text-slate-400 hover:text-red-400 transition-colors"
                          aria-label="撤销最新一笔流水"
                          title="撤销最新一笔流水"
                        >
                          🗑️
                        </button>
                      ) : (
                        <span
                          className="text-slate-600 cursor-not-allowed"
                          title="为保证对冲逻辑正确，仅支持按顺序撤销最新的一条操作"
                        >
                          🔒
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
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

      <TStateMachinePanel
        entries={result.entries.map((e) => ({ ...e, fullCode: (e as unknown as TStreamRecord).fullCode ?? result.fullCode, stockName: (e as unknown as TStreamRecord).stockName ?? result.stockName } as TStreamRecord))}
        basePosition={basePosition ? { cost: basePosition.currentCost, quantity: basePosition.currentAmount } : null}
        feeConfig={feeConfig}
      />

      <div className="pt-3 grid grid-cols-4 gap-2">
        <button
          type="button"
          onClick={() => setShowAppend(true)}
          className="col-span-4 md:col-span-3 btn btn-primary !py-3"
        >
          + 追加记录
        </button>
        <button
          type="button"
          onClick={result.mode === 'short' ? handleSettleShort : handleTransfer}
          className="col-span-4 md:col-span-1 btn btn-warning !py-3"
          disabled={result.mode !== 'short' && result.netPendingAmount <= 0}
        >
          {result.mode === 'short' ? '结算 / 转底仓' : '一键划转底仓'}
        </button>
      </div>

      {showAppend && (
        <div className="fixed inset-0 z-[90] bg-black/60 p-4 flex items-center justify-center">
          <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div>
                <p className="text-sm font-semibold text-slate-100">追加流水记录</p>
                <p className="text-xs text-slate-500">可录入买入/卖出流水，系统实时撮合当前做T Round。</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAppend(false)}
                className="rounded-lg p-2 text-slate-400 hover:text-white hover:bg-slate-800"
              >
                关闭
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setApDir('buy')}
                  className={`text-sm px-3 py-2 rounded-lg font-medium transition-colors ${
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
                  className={`text-sm px-3 py-2 rounded-lg font-medium transition-colors ${
                    apDir === 'sell'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                  卖出
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="form-group">
                  <label>价格（元）</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.001"
                    value={apPrice}
                    onChange={(e) => setApPrice(e.target.value)}
                    placeholder="0.000"
                  />
                </div>
                <div className="form-group">
                  <label>数量（股）</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="100"
                    value={apAmount}
                    onChange={(e) => setApAmount(e.target.value)}
                    placeholder="100"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
              {!apValidation.valid && (
                <div className="flex items-center justify-between gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300">
                  <span>🛑 {apValidation.error}</span>
                  {(apValidation.maxSellable ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={fillAppendMaxSell}
                      className="text-xs px-2 py-1 rounded-lg bg-red-600 text-white hover:bg-red-700"
                    >
                      全部卖出
                    </button>
                  )}
                </div>
              )}
              {apError && (
                <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {apError}
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  onClick={handleAppend}
                  className="btn btn-primary flex-1"
                >
                  追加提交
                </button>
                <button
                  type="button"
                  onClick={() => setShowAppend(false)}
                  className="btn btn-outline flex-1"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 归档历史库 Round 战报卡片。
 *
 * @description 展示已归档做T战报：Round 编号、正/倒T标签、结算类型（平仓/归并/划转）、
 *              净收益、卖出数量、融合均价、成交明细穿透；
 *              提供「删除战报」操作，自动级联撤销归并底仓数据。
 * @param {{ round: TRound; onRemove: (id) => { ok: boolean; message?: string } }} props
 *  - round: 归档战报记录（列表加载为轮次摘要，不含明细；展开「查看成交明细」时按需查询）
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
  // 成交明细按需加载：列表加载器只返回轮次摘要（不含 transactions），
  // 首次展开时才查询 IndexedDB（fetchTransactionsByRoundId）
  const [txns, setTxns] = useState<RoundTxn[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
  const txnsLoadedRef = useRef(false);
  const toggleTxns = () => {
    if (showTxns) {
      setShowTxns(false);
      return;
    }
    setShowTxns(true);
    if (txnsLoadedRef.current) return;
    txnsLoadedRef.current = true;
    setTxnsLoading(true);
    ledgerService
      .fetchTransactionsByRoundId(round.id)
      .then((list) => setTxns(list))
      .catch(() => setTxns([]))
      .finally(() => setTxnsLoading(false));
  };

  const hasMerge = round.transferAmount && round.transferAmount > 0;
  const mergeLabel = round.mode === 'long' ? '正T归并' : '倒T归并';

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
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 ${round.mode === 'short' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
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
      {round.netProfit !== 0 && (
        <div>
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${round.win ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
            {round.win ? '✓ 盈利' : '✗ 亏损'}
          </span>
        </div>
      )}
      <div className="text-xs text-slate-500">
        {new Date(round.openedAt ?? '').toLocaleDateString()} ~ {new Date(round.closedAt ?? '').toLocaleDateString()} · 持股 {round.holdingDays ?? 0} 天 · {round.tradeCount ?? 0} 笔
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-slate-500">净收益</span>
          <div className={`font-mono font-semibold tabular-nums ${pnlColor(round.netProfit)}`}>
            {formatCurrency(round.netProfit)}
          </div>
        </div>
        <div>
          <span className="text-slate-500">卖出</span>
          <div className="font-mono font-semibold text-slate-200 tabular-nums">{round.sellAmount} 股</div>
        </div>
        <div>
          <span className="text-slate-500">均价</span>
          <div className="font-mono font-semibold text-blue-400 tabular-nums">¥{(round.avgPrice ?? 0).toFixed(3)}</div>
        </div>
      </div>
      {/* 成交明细穿透（含撮合配对与划转记录） */}
      {round.transferAmount && (
        <div className="text-xs text-slate-400 pb-2">
          划转底仓：{round.transferAmount} 股 @ ¥{(round.avgPrice ?? 0).toFixed(3)}
        </div>
      )}
      <div>
        <button
          onClick={toggleTxns}
          className="text-[11px] text-blue-400 hover:text-blue-300 underline"
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
              txns.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 text-[11px] text-slate-400"
                >
                  <span className="shrink-0">{new Date(t.timestamp).toLocaleString()}</span>
                  <span
                    className={`px-1 rounded text-[10px] font-bold shrink-0 ${
                      t.direction === 'buy'
                        ? 'bg-red-500/15 text-red-400'
                        : t.direction === 'sell'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-purple-500/15 text-purple-400'
                    }`}
                  >
                    {t.direction === 'buy' ? '买' : t.direction === 'sell' ? '卖' : '转'}
                  </span>
                  <span className="font-mono shrink-0">
                    {t.amount} 股  ¥{t.price.toFixed(2)}
                  </span>
                  <span className="font-mono tabular-nums shrink-0">
                    {(t.matchedAmount ?? 0) > 0 ? `⚡${t.matchedAmount}股 ` : ''}
                    {t.realizedProfit !== 0 &&
                      (t.direction === 'sell' ? (
                        <span className={pnlColor(t.realizedProfit ?? 0)}>{formatCurrency(t.realizedProfit ?? 0)}</span>
                      ) : (
                        <span className="text-slate-500">--</span>
                      ))}
                  </span>
                </div>
              ))
            ) : (
              <div className="text-[11px] text-slate-500 py-1">暂无成交明细</div>
            )}
          </div>
        )}
      </div>
      <button
        onClick={() => setShowDeleteConfirm(true)}
        className="text-[11px] text-slate-500 hover:text-red-400 underline"
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
 * 做T账本与计算器主页面组件。
 *
 * @description 组合：
 *  - 添加交易流水表单（正T买入/倒T卖出，含费用预览、超卖校验与[全部卖出]快捷键）
 *  - 当前做T项目卡片流（实时撮合状态 + 追加记录 + 划转/结算 + 流水明细列表逐条删除）
 *  - 历史战报归档库（胜率 + 累计净收益 + 战报卡片）
 *  所有写操作均通过 Store Action 落库 IndexedDB 并级联重算流水池。
 * @returns {JSX.Element} 做T账本与计算器页面视图
 * @note 页面挂载即订阅 tStreams/positions/tRounds 实时响应 Store 变化（数据由 useLoadCoreData 按需加载）
 */
export default function TCalculator() {
  const tStreams = useAppStore((s) => s.tStreams);
  const feeConfig = useAppStore((s) => s.feeConfig);
  const positions = useAppStore((s) => s.positions);
  const tRounds = useAppStore((s) => s.tRounds);
  // 已归档 Round（按需懒加载，进入页面时异步加载）
  const { archivedRounds, archivedLoading } = useArchivedRounds();
  const addStreamRecord = useAppStore((s) => s.addStreamRecord);
  const validateSellWithPosition = useAppStore((s) => s.validateSellWithPosition);
  const importLegacyTRecords = useAppStore((s) => s.importLegacyTRecords);
  const removeRound = useAppStore((s) => s.removeRound);
  const clearStreams = useAppStore((s) => s.clearStreams);
  const results = useStreamResults();

  // 仅展示进行中的做T项目（CLEARED = 池内流水已全部配对并自动归档为战报，不再属于当前项目）
  const activeResults = useMemo(() => results.filter((r) => r.status !== 'CLEARED'), [results]);

  // 表单状态
  const [stock, setStock] = useState<StockSearchItem | null>(null);

  // 实时行情：订阅「当前页面显示的标的」= 选中股票 + 所有进行中做T项目的 fullCode，
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
  const toastTimer = useRef<number | null>(null);

  // 监听全局 toast 事件
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<string>).detail;
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast(msg);
      toastTimer.current = window.setTimeout(() => setToast(null), 4000);
    };
    window.addEventListener('app-toast', handler);
    return () => {
      window.removeEventListener('app-toast', handler);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // 持仓清零自动结清 Toast：监听撮合结果变化
  const prevClearedRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    const prev = prevClearedRef.current;
    for (const r of results) {
      const wasCleared = prev.get(r.fullCode) ?? false;
      if (!wasCleared && r.status === 'CLEARED' && r.entries.some((e) => e.direction === 'sell')) {
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        setToast(`🎉 本轮做T已完全结清！累计净盈亏：¥${r.realizedPnL.toFixed(2)}`);
        toastTimer.current = window.setTimeout(() => setToast(null), 5000);
      }
      prev.set(r.fullCode, r.status === 'CLEARED');
    }
    prevClearedRef.current = prev;
  }, [results]);

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
    // 倒T（先卖后买）：调用 Store 共享的严格底仓校验（标的存在性 + 可卖数量 N_base）
    if (direction === 'sell') {
      return validateSellWithPosition(stock?.fullCode ?? '', direction, p || 0, a || 0);
    }
    return validateStreamTrade(selectedResult, basePosition?.currentAmount ?? 0, 'buy', p || 0, a || 0);
  }, [validateSellWithPosition, stock?.fullCode, selectedResult, basePosition?.currentAmount, direction, price, amount]);

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
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast(`🛑 ${validation.error ?? '输入无效'}`);
      setError(validation.error ?? '输入无效');
      toastTimer.current = window.setTimeout(() => setToast(null), 4000);
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
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast(`🛑 ${result.rejectedReason ?? '校验未通过'}`);
      setError(result.rejectedReason ?? '校验未通过');
      toastTimer.current = window.setTimeout(() => setToast(null), 4000);
      return;
    }
    setPrice('');
    setAmount('');
    setNote('');
    setError('');
  };

  const handleImportLegacy = () => {
    const n = importLegacyTRecords();
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(n > 0 ? `已导入 ${n} 条历史流水` : '暂无历史做T记录可导入');
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };

  // ---- 归档历史库胜率统计（仅统计「今日」完成的战报） ----
  const todayArchivedRounds = useMemo(() => {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    return archivedRounds.filter((r) => {
      const t = new Date(r.closedAt ?? r.openedAt).getTime();
      return t >= dayStart && t < dayEnd;
    });
  }, [archivedRounds]);

  const archiveStats = useMemo(() => {
    const wins = todayArchivedRounds.filter((r) => r.win).length;
    const total = todayArchivedRounds.length;
    return {
      wins,
      total,
      rate: total > 0 ? (wins / total) * 100 : 0,
      cumulative: todayArchivedRounds.reduce((s, r) => s + r.netProfit, 0),
    };
  }, [todayArchivedRounds]);

  // 汇总卡片口径：包含已结清（CLEARED）轮次在内，累计已实现净收益与「今日战报归档库」累计口径一致
  const totalPending = results.reduce((s, r) => s + Math.max(0, r.netPendingAmount), 0);
  const totalRealizedPnl = results.reduce((s, r) => s + r.realizedPnL, 0);

  return (
    <div className="page-container space-y-5">
      {/* Header 标题 */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div>
          <h2 className="text-lg font-bold text-slate-200">做T账本 · Round 生命周期</h2>
          <p className="text-xs text-slate-500">流水池 FIFO 撮合 · 绝对现金流法 · 自动归档战报</p>
        </div>
        <button
          onClick={handleImportLegacy}
          className="btn btn-outline btn-sm shrink-0"
        >
          导入历史记录
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-slate-800 text-white text-sm shadow-lg border border-slate-600 animate-pulse">
          {toast}
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
          <div className="text-xs text-slate-500">累计已实现做T净收益</div>
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

      {/* 添加流水表单 */}
      <div className="card">
        <h3>添加交易流水</h3>

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
            <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
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
            <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
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
              type="number"
              inputMode="decimal"
              min="0"
              step="0.001"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.000"
            />
          </div>
          <div className="form-group">
            <label>数量（股）</label>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              step="100"
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
                className="text-xs px-2.5 py-1.5 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 shrink-0"
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

        <button
          onClick={handleSubmit}
          className="btn btn-primary btn-block mt-2"
        >
          提交流水
        </button>
      </div>

      {/* 当前项目 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-200">当前做T项目</h3>
          {activeResults.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm('确认清空全部做T流水？')) clearStreams();
              }}
              className="text-xs text-slate-500 hover:text-red-400 underline"
            >
              清空流水池
            </button>
          )}
        </div>

        {activeResults.length === 0 ? (
          <div className="bg-slate-800 border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            暂无进行中的做T项目（已自动归档的战报请在下方「今日战报归档库」查看）
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
              />
            );
          })
        )}
      </div>

      {/* 归档历史库 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-200">🏆 今日战报归档</h3>
          {todayArchivedRounds.length > 0 && (
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
        ) : todayArchivedRounds.length === 0 ? (
          <div className="bg-slate-800 border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            今日暂无已完成战报（做T持仓归零自动锁定战报 → 生成 Round 卡片）
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[...todayArchivedRounds]
              .sort((a, b) => new Date(b.closedAt ?? b.openedAt).getTime() - new Date(a.closedAt ?? a.openedAt).getTime())
              .map((round) => (
                <ArchiveRoundCard key={round.id} round={round} onRemove={(id) => removeRound(id)} />
              ))}
          </div>
        )}
      </div>

    </div>
  );
}