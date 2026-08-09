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
import { useLiveQuery } from 'dexie-react-hooks';
import {
  useAppStore,
  useStreamResults,
  generateId,
  type Position,
} from '../store';
import { ledgerService } from '../services/ledgerService';
import { calcTradeFees, roundTo } from '../utils/mathUtils';
import {
  validateStreamTrade,
  type TStreamRecord,
  type StockStreamResult,
} from '../utils/tStreamEngine';
import StockAutocomplete from '../components/ui/StockAutocomplete';
import type { StockSearchItem } from '../types/stock';

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
 * 判断两个 ISO 时间戳是否处于同一自然日。
 *
 * @description 比较年/月/日三个维度是否完全相同。
 * @param {string} timestampA - 第一个时间戳（ISO 字符串）
 * @param {string} timestampB - 第二个时间戳（ISO 字符串）
 * @returns {boolean} 同一自然日返回 true，否则 false
 */
function isSameDay(timestampA: string, timestampB: string): boolean {
  const a = new Date(timestampA);
  const b = new Date(timestampB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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

/**
 * 单个进行中做T项目卡片（核心业务卡片）。
 *
 * @description 展示某标的的实时流水池撮合状态：剩余待对冲/倒T待回补、加权成本、
 *              累计已实现盈亏、流水明细列表（逐条可删除）、[+追加记录] 快速录入，
 *              并提供「一键划转底仓」「结算倒T」「归档」等写操作入口。
 * @param {{ result: StockStreamResult; basePosition: Position | undefined; roundNo: number }} props
 *  - result: 该标的的流水池撮合结果
 *  - basePosition: 对应底仓持仓（用于超卖校验与划转）
 *  - roundNo: 该标的当前做T轮次序号
 * @returns {JSX.Element} 做T项目卡片视图
 * @note 写操作均委托 ledgerService 落库并触发 store 级联重算；超卖/数量校验由
 *       validateStreamTrade 在录入前拦截
 */
function CurrentProjectCard({
  result,
  basePosition,
  roundNo,
}: {
  result: StockStreamResult;
  basePosition: Position | undefined;
  roundNo: number;
}) {
  const [showAppend, setShowAppend] = useState(false);
  const removeStreamRecord = useAppStore((s) => s.removeStreamRecord);
  const transferToPosition = (fullCode: string) => ledgerService.transferToPositionService(fullCode);
  const settleShortRound = (fullCode: string) => ledgerService.settleShortRoundService(fullCode);
  const addToast = (msg: string) => window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));

  const baseHolding = basePosition?.currentAmount ?? 0;

  const handleSettleShort = async () => {
    const res = await settleShortRound(result.fullCode);
    if (res.ok) {
      addToast(res.message);
    } else {
      addToast(`🛑 ${res.message}`);
    }
  };

  const handleTransfer = async () => {
    const res = await transferToPosition(result.fullCode);
    if (res.ok) {
      addToast(res.message);
    } else {
      addToast(`🛑 ${res.message}`);
    }
  };

  // ---- [+ 追加记录] 快速录入（同标的便捷追加，走同一撮合引擎） ----
  const addStreamRecord = (rec: any) => ledgerService.applyStreamRecord(rec);
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

  const handleAppend = async () => {
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
    const res = await addStreamRecord(rec);
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
            Round {roundNo}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 ${result.mode === 'short' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
            {result.mode === 'short' ? '倒T' : '正T'}
          </span>
          <StreamStatusBadge result={result} />
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
        <div className="bg-slate-900 rounded-lg p-3 space-y-2 text-xs text-slate-300">
          {result.entries.map((entry) => (
            <div key={entry.id} className="grid grid-cols-1 md:grid-cols-2 gap-2 border-b border-slate-700 pb-2 last:border-b-0 last:pb-0">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${entry.direction === 'buy' ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
                    {entry.direction === 'buy' ? '买入' : '卖出'}
                  </span>
                  <span className="text-slate-500">{new Date(entry.timestamp).toLocaleString()}</span>
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
                  <button
                    onClick={() => removeStreamRecord(entry.id)}
                    className="text-slate-600 hover:text-red-400"
                    aria-label="删除该笔流水"
                    title="删除该笔流水"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="font-mono text-slate-200">撮合 {entry.matchedAmount} 股</span>
                  <span className={entry.realizedProfit >= 0 ? 'text-red-400' : 'text-green-400'}>
                    {entry.realizedProfit >= 0 ? '+' : ''}{formatCurrency(entry.realizedProfit)}
                  </span>
                </div>
                {entry.note && <div className="text-slate-500">{entry.note}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

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
 * @description 展示已归档做T战报：Round 编号、正/倒T标签、结算类型（平仓/划转）、
 *              净收益、卖出数量、融合均价、成交明细穿透；
 *              提供「删除战报」操作（划转且当天结算时可选回滚底仓）。
 * @param {{ round: TRound; onRemove: (id, options?) => void }} props
 *  - round: 归档战报记录（含 transactions 明细）
 *  - onRemove: 删除回调；options.rollbackBase=true 时同步回滚底仓
 * @returns {JSX.Element} 战报卡片视图
 * @note 删除属于写操作，通过 store.removeRound 落库
 */
function ArchiveRoundCard({
  round,
  onRemove,
}: {
  round: NonNullable<ReturnType<typeof useAppStore.getState>['tRounds']>[number];
  onRemove: (id: string, options?: { rollbackBase?: boolean }) => void;
}) {
  const [showTxns, setShowTxns] = useState(false);
  const txns = round.transactions ?? [];
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-semibold text-slate-200 truncate">{round.stockName}</span>
          <span className="text-xs bg-blue-600 text-white px-1.5 py-0.5 rounded-full font-bold shrink-0">
            Round {round.roundNo}
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
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 ${round.sellAmount > 0 ? (round.win ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400') : 'bg-slate-700/15 text-slate-200'}`}>
              {round.sellAmount > 0 ? (round.win ? '盈利' : '亏损') : '平仓'}
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
      {round.transferAmount && (
        <div className="text-xs text-slate-400 pb-2">
          划转底仓：{round.transferAmount} 股 @ ¥{round.avgPrice.toFixed(3)}
        </div>
      )}
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
        onClick={() => {
          const sameDay = isSameDay(round.openedAt, round.closedAt);
          if (round.settleType === 'transfer' && sameDay) {
            if (window.confirm('当日划转战报删除将同步回滚底仓，确认删除？')) {
              onRemove(round.id, { rollbackBase: true });
            }
          } else if (round.settleType === 'transfer') {
            if (window.confirm('系统仅会移除此条做T战报，不会自动扣减当前底仓。如需修改底仓，请前往持仓页面手动调整。确认删除？')) {
              onRemove(round.id);
            }
          } else {
            if (window.confirm('确认删除本条历史战报？')) {
              onRemove(round.id);
            }
          }
        }}
        className="text-[11px] text-slate-500 hover:text-red-400 underline"
      >
        删除战报
      </button>
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
 *  所有写操作均通过 ledgerService/store 落库 IndexedDB 并级联重算流水池。
 * @returns {JSX.Element} 做T账本与计算器页面视图
 * @note 页面挂载即订阅 tStreams/positions/tRounds 实时响应 IndexedDB 变化
 */
export default function TCalculator() {
  const tStreams = useAppStore((s) => s.tStreams);
  const feeConfig = useLiveQuery(async () => await ledgerService.getFeeConfig(), [], undefined) as any;
  const positions = useLiveQuery(async () => await ledgerService.getPositionsWithStockInfo(), [], []) as Position[];
  const tRounds = useLiveQuery(async () => await ledgerService.getTRoundsWithTransactions(), [], []) as any[];
  const addStreamRecord = (rec: TStreamRecord) => ledgerService.applyStreamRecord(rec);
  const validateSellWithPosition = useAppStore((s) => s.validateSellWithPosition);
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
    // 倒T（先卖后买）：调用 Store 共享的严格底仓校验（标的存在性 + 可卖数量 N_base）
    if (direction === 'sell') {
      return validateSellWithPosition(stock?.fullCode ?? '', p || 0, a || 0);
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
          results.map((r) => {
            const roundNo = 1 + tRounds.filter((round) => round.fullCode === r.fullCode).length;
            return (
              <CurrentProjectCard
                key={r.fullCode}
                result={r}
                basePosition={positions.find((p) => p.fullCode === r.fullCode && !p.isClosed)}
                roundNo={roundNo}
              />
            );
          })
        )}
      </div>

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
                <ArchiveRoundCard key={round.id} round={round} onRemove={(id, options) => removeRound(id, options)} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}