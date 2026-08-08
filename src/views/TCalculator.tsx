// ============================================================
// 做T账本与计算器（Round 生命周期 + 绝对现金流法）
//  - 流水池撮合：FIFO、加权平均成本、部分对冲、级联重算
//  - 边界校验：超卖拦截 + [全部卖出]、数量/价格 > 0
//  - 持仓清零弹出 Toast；Round 自动归档
//  - 一键划转底仓（绝对现金流法）
//  - 归档历史库：Round 卡片 + 胜率 + 累计净收益
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useAppStore,
  useStreamResults,
  generateId,
  type Position,
} from '../store';
import { calcTradeFees, roundTo } from '../utils/mathUtils';
import {
  validateStreamTrade,
  type TStreamRecord,
  type StockStreamResult,
} from '../utils/tStreamEngine';
import StockAutocomplete from '../components/ui/StockAutocomplete';
import type { StockSearchItem } from '../types/stock';

/** 格式化金额为 ¥xxx.xx */
function formatCurrency(value: number): string {
  return `¥${(value ?? 0).toFixed(2)}`;
}

/** 盈利红 / 亏损绿（与全局红涨绿跌一致） */
function pnlColor(value: number): string {
  return value >= 0 ? 'text-red-400' : 'text-green-400';
}

// ---------- 状态 Badge ----------
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

// ---------- 单个当前项目卡片 ----------
function CurrentProjectCard({
  result,
  basePosition,
}: {
  result: StockStreamResult;
  basePosition: Position | undefined;
}) {
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const transferToPosition = useAppStore((s) => s.transferToPosition);
  const addToast = (msg: string) => window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));

  const baseHolding = basePosition?.currentAmount ?? 0;

  const handleTransfer = () => {
    const res = transferToPosition(result.fullCode);
    if (res.ok) {
      setConfirmTransfer(false);
      addToast(res.message);
    } else {
      addToast(res.message);
    }
  };

  // ---- [+ 追加记录] 快速录入（同标的便捷追加，走同一撮合引擎） ----
  const addStreamRecord = useAppStore((s) => s.addStreamRecord);
  const [showAppend, setShowAppend] = useState(false);
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

  const handleAppend = () => {
    setApError('');
    const p = parseFloat(apPrice);
    const a = parseFloat(apAmount);
    if (!apValidation.valid) {
      setApError(apValidation.error ?? '输入无效');
      return;
    }
    const txnFee = calcTradeFees(p, a, apDir, useAppStore.getState().feeConfig).total;
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
    const res = addStreamRecord(rec);
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
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-slate-200 truncate">{result.stockName}</span>
          <span className="text-xs text-slate-500 shrink-0">{result.fullCode}</span>
          <StreamStatusBadge result={result} />
        </div>
        {baseHolding > 0 && (
          <span className="text-xs text-slate-400 shrink-0">
            底仓 <b className="text-slate-200">{baseHolding}</b> 股
          </span>
        )}
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
      </div>

      {/* 一键划转底仓 */}
      {result.status !== 'CLEARED' && result.netPendingAmount > 0 && (
        <div className="pt-1">
          {!confirmTransfer ? (
            <button
              onClick={() => setConfirmTransfer(true)}
              className="btn btn-primary btn-block"
            >
              📦 一键划转底仓（绝对现金流法）
            </button>
          ) : (
            <div className="space-y-2 p-3 bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
                将剩余 <b className="text-amber-400">{result.netPendingAmount}</b> 股按 P_avg（¥{result.avgPrice.toFixed(3)}）平价划转入底仓，
                做T归零后自动归档本轮战报。
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleTransfer}
                  className="btn btn-primary flex-1 !py-2"
                >
                  确认划转
                </button>
                <button
                  onClick={() => setConfirmTransfer(false)}
                  className="btn btn-outline flex-1 !py-2"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* [+ 追加记录] 快速录入 */}
      {result.status !== 'CLEARED' && (
        <div className="pt-1">
          <button
            onClick={() => setShowAppend((v) => !v)}
            className="text-xs text-blue-400 hover:text-blue-300 underline"
          >
            {showAppend ? '▾ 收起追加表单' : '+ 追加记录'}
          </button>
          {showAppend && (
            <div className="mt-2 space-y-2 p-3 bg-slate-900 rounded-lg">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setApDir('buy')}
                  className={`text-xs px-2 py-1.5 rounded-lg font-medium transition-colors ${
                    apDir === 'buy'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                   买入
                </button>
                <button
                  onClick={() => setApDir('sell')}
                  className={`text-xs px-2 py-1.5 rounded-lg font-medium transition-colors ${
                    apDir === 'sell'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                  卖出
                </button>
              </div>
              <div className="form-row">
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
              {!apValidation.valid && (
                <div className="flex items-center justify-between gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                  <span className="text-[11px] font-medium text-red-300">🛑 {apValidation.error}</span>
                  <button
                    onClick={fillAppendMaxSell}
                    className="text-[11px] px-2 py-1 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 shrink-0"
                  >
                    全部卖出
                  </button>
                </div>
              )}
              {apError && (
                <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {apError}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleAppend}
                  className="btn btn-primary flex-1 !py-2"
                >
                  追加提交
                </button>
                <button
                  onClick={() => setShowAppend(false)}
                  className="btn btn-outline flex-1 !py-2"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 归档历史库 Round 卡片 ----------
function ArchiveRoundCard({
  round,
  onRemove,
}: {
  round: NonNullable<ReturnType<typeof useAppStore.getState>['tRounds']>[number];
  onRemove: (id: string) => void;
}) {
  const [showTxns, setShowTxns] = useState(false);
  const txns = round.transactions ?? [];
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-slate-200 truncate">{round.stockName}</span>
          <span className="text-xs bg-blue-600 text-white px-1.5 py-0.5 rounded-full font-bold shrink-0">
            Round {round.roundNo}
          </span>
          {round.settleType === 'transfer' && (
            <span className="text-xs bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded-full font-bold shrink-0">
              📦 划转结清
            </span>
          )}
          {round.settleType === 'clear' && (
            <span className="text-xs bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 rounded-full font-bold shrink-0">
              [已结清]
            </span>
          )}
        </div>
        {round.netProfit !== 0 && (
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${round.win ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
            {round.win ? '✓ 盈利' : '✗ 亏损'}
          </span>
        )}
      </div>
      <div className="text-xs text-slate-500">
        {new Date(round.openedAt).toLocaleDateString()} ~ {new Date(round.closedAt).toLocaleDateString()} · 持股 {round.holdingDays} 天 · {round.tradeCount} 笔
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
          <div className="font-mono font-semibold text-blue-400 tabular-nums">¥{round.avgPrice.toFixed(3)}</div>
        </div>
      </div>
      {/* 成交明细穿透（含撮合配对与划转记录） */}
      {txns.length > 0 && (
        <div>
          <button
            onClick={() => setShowTxns((v) => !v)}
            className="text-[11px] text-blue-400 hover:text-blue-300 underline"
          >
            {showTxns ? '▾ 收起成交明细' : `▸ 查看成交明细（${txns.length} 笔）`}
          </button>
          {showTxns && (
            <div className="mt-2 space-y-1 bg-slate-900 rounded-lg p-2 max-h-48 overflow-y-auto">
              {txns.map((t) => (
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
                    {t.amount} 股 @ ¥{t.price.toFixed(2)}
                  </span>
                  <span className="font-mono tabular-nums shrink-0">
                    {t.matchedAmount > 0 ? `⚡${t.matchedAmount}股 ` : ''}
                    {t.realizedProfit !== 0 &&
                      (t.direction === 'sell' ? (
                        <span className={pnlColor(t.realizedProfit)}>{formatCurrency(t.realizedProfit)}</span>
                      ) : (
                        <span className="text-slate-500">--</span>
                      ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        onClick={() => onRemove(round.id)}
        className="text-[11px] text-slate-500 hover:text-red-400 underline"
      >
        删除战报
      </button>
    </div>
  );
}

// ============================================================
// 主组件
// ============================================================
export default function TCalculator() {
  const tStreams = useAppStore((s) => s.tStreams);
  const feeConfig = useAppStore((s) => s.feeConfig);
  const positions = useAppStore((s) => s.positions);
  const tRounds = useAppStore((s) => s.tRounds);
  const addStreamRecord = useAppStore((s) => s.addStreamRecord);
  const removeStreamRecord = useAppStore((s) => s.removeStreamRecord);
  const importLegacyTRecords = useAppStore((s) => s.importLegacyTRecords);
  const removeRound = useAppStore((s) => s.removeRound);
  const clearStreams = useAppStore((s) => s.clearStreams);

  const results = useStreamResults();

  // 表单状态
  const [stock, setStock] = useState<StockSearchItem | null>(null);
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
    return results.find((r) => r.fullCode === stock.fullCode) ?? null;
  }, [results, stock?.fullCode]);

  const basePosition = useMemo(() => {
    if (!stock?.fullCode) return undefined;
    return positions.find((p) => p.fullCode === stock.fullCode && !p.isClosed);
  }, [positions, stock?.fullCode]);

  const validation = useMemo(() => {
    const p = parseFloat(price);
    const a = parseFloat(amount);
    return validateStreamTrade(selectedResult, basePosition?.currentAmount ?? 0, direction, p || 0, a || 0);
  }, [selectedResult, basePosition?.currentAmount, direction, price, amount]);

  // ---- 费用预览 ----
  const feePreview = useMemo(() => {
    const p = parseFloat(price);
    const a = parseFloat(amount);
    if (!p || p <= 0 || !a || a <= 0) return null;
    return calcTradeFees(p, a, direction, feeConfig);
  }, [price, amount, direction, feeConfig]);

  // ---- 全部卖出快捷键 ----
  const fillMaxSell = () => {
    const max = Math.max(0, (selectedResult?.netPendingAmount ?? 0) + (basePosition?.currentAmount ?? 0));
    if (max > 0) setAmount(String(max));
    setDirection('sell');
  };

  const handleSubmit = () => {
    setError('');
    if (!stock?.fullCode) {
      setError('请先选择股票');
      return;
    }
    const p = parseFloat(price);
    const a = parseFloat(amount);
    if (validation && !validation.valid) {
      setError(validation.error ?? '输入无效');
      return;
    }

    const txnFee = calcTradeFees(p, a, direction, feeConfig).total;
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

    addStreamRecord(record);
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

  // ---- 归档历史库胜率统计 ----
  const archiveStats = useMemo(() => {
    const wins = tRounds.filter((r) => r.win).length;
    const total = tRounds.length;
    return {
      wins,
      total,
      rate: total > 0 ? (wins / total) * 100 : 0,
      cumulative: tRounds.reduce((s, r) => s + r.netProfit, 0),
    };
  }, [tRounds]);

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
            {results.length > 0
              ? `¥${roundTo(
                  results.reduce((s, r) => s + r.weightedBuyCost * Math.max(0, r.netPendingAmount), 0) /
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
            正做T · 买入
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
            倒做T · 卖出
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
            <button
              onClick={fillMaxSell}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 shrink-0"
            >
              全部卖出
            </button>
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
          {results.length > 0 && (
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

        {results.length === 0 ? (
          <div className="bg-slate-800 border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            暂无做T流水，从上方添加首笔买入/卖出自动开启 <b className="text-blue-400">Round 1</b>
          </div>
        ) : (
          results.map((r) => (
            <CurrentProjectCard
              key={r.fullCode}
              result={r}
              basePosition={positions.find((p) => p.fullCode === r.fullCode && !p.isClosed)}
            />
          ))
        )}
      </div>

      {/* 流水明细（可选展开） */}
      {results.length > 0 && (
        <div className="card">
          <h3>流水明细（级联重算）</h3>
          <div className="divide-y divide-slate-700">
            {results.flatMap((r) =>
              r.entries.map((e) => (
                <div key={e.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-slate-200 truncate">{r.stockName}</span>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded font-bold ${e.direction === 'buy' ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
                        {e.direction === 'buy' ? '买' : '卖'}
                      </span>
                      {e.direction === 'buy' && (
                        <span className={`text-[11px] font-mono tabular-nums ${e.remaining > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                          {e.remaining > 0 ? `剩 ${e.remaining} 股待对冲` : '已对冲'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 font-mono tabular-nums">
                      {e.timestamp} · ¥{e.price} × {e.amount} · 费 {e.fee.toFixed(2)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {e.direction === 'sell' && e.matchedAmount > 0 && (
                      <span className={`text-xs font-mono tabular-nums ${pnlColor(e.realizedProfit)}`}>
                        {e.realizedProfit >= 0 ? '+' : ''}
                        {e.realizedProfit.toFixed(2)}
                      </span>
                    )}
                    <button
                      onClick={() => removeStreamRecord(e.id)}
                      className="text-xs text-slate-600 hover:text-red-400"
                      aria-label="删除"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 归档历史库 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-200">🏆 历史战报归档库</h3>
          {tRounds.length > 0 && (
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

        {tRounds.length === 0 ? (
          <div className="bg-slate-800 border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            做T持仓归零自动锁定战报 → 生成 Round 卡片
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[...tRounds]
              .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
              .map((round) => (
                <ArchiveRoundCard key={round.id} round={round} onRemove={removeRound} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}