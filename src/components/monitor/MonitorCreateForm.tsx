/**
 * @file MonitorCreateForm.tsx
 * @description 价格预告单新建表单：选股 → 方向（低吸/高抛）→ 类型（区间/跌破）→ 目标价（+ 容差）→ 提交。
 *              提示规范落点（docs/monitor/api.md §6）：
 *              L1 必做——单边触发边界、容差宽度与占目标价百分比（前端纯算）；
 *              L2 建议——当前价（K 线最后收盘）、距触发距离、**是否已落在触发侧**（建单即触发黄色警示）；
 *              另含容差过窄警示（30 分钟采样可能穿过区间 → 永不触发、白占额度）。
 *              表单底部常驻「检查节奏 / 3 次封顶 / 剩余额度」三行，提交后由父组件刷新列表。
 * @layer UI
 * @storage_impact 不直接读写存储；选股经 StockAutocomplete upsert stocks 表，提交经 services/monitorService。
 * @author 开发团队
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, AlertTriangle } from 'lucide-react';
import StockAutocomplete from '../ui/StockAutocomplete';
import ModeTabs from '../ui/ModeTabs';
import { showToast } from '../../utils/toast';
import { getKline } from '../../services/klineService';
import { SessionExpiredError } from '../../services/apiClient';
import {
  MONITOR_MAX_RUNNING,
  MonitorBadRequestError,
  MonitorLimitError,
  startMonitor,
} from '../../services/monitorService';
import type { MonitorAlertType, MonitorDirection } from '../../utils/monitorRule';
import {
  bandPctOfThreshold,
  computeTriggerBoundary,
  distanceToTrigger,
  isBandTooNarrow,
  isPriceInTriggerSide,
} from '../../utils/monitorRule';
import type { StockSearchItem } from '../../types/stock';

/** 方向切换项（模块级常量，避免每次渲染重建数组） */
const DIRECTION_TABS: ReadonlyArray<{ id: MonitorDirection; label: string }> = [
  { id: 'BUY', label: '低吸买入' },
  { id: 'SELL', label: '高抛卖出' },
];

/** 类型切换项：跌破仅用于低吸，高抛下不展示（后端 SELL + PRICE_BELOW 组合返 400） */
const TYPE_TABS: ReadonlyArray<{ id: MonitorAlertType; label: string }> = [
  { id: 'PRICE_NEAR', label: '区间' },
  { id: 'PRICE_BELOW', label: '跌破' },
];

interface MonitorCreateFormProps {
  /** 剩余额度（上限 − runningCount）；为 0 时禁用提交 */
  remaining: number;
  /** 创建成功回调（父组件刷新列表） */
  onCreated: () => void;
}

/**
 * 价格预告单新建表单。
 *
 * @returns {JSX.Element} 表单视图
 */
export default function MonitorCreateForm({ remaining, onCreated }: MonitorCreateFormProps) {
  const [stock, setStock] = useState<StockSearchItem | null>(null);
  const [direction, setDirection] = useState<MonitorDirection>('BUY');
  const [type, setType] = useState<MonitorAlertType>('PRICE_NEAR');
  const [threshold, setThreshold] = useState('');
  const [band, setBand] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /** L2 参考价：K 线最后一根收盘价（取价失败为 null → 隐藏当前价行，不阻断创建） */
  const [refPrice, setRefPrice] = useState<number | null>(null);
  const [refPriceLoading, setRefPriceLoading] = useState(false);

  // 选中/换股后拉一次 K 线取最后收盘价；三级缓存命中时无网络开销，失败静默降级
  useEffect(() => {
    if (!stock) {
      setRefPrice(null);
      setRefPriceLoading(false);
      return;
    }
    let alive = true;
    setRefPriceLoading(true);
    getKline(stock.fullCode)
      .then((bundle) => {
        if (!alive) return;
        const last = bundle.klines.length > 0 ? bundle.klines[bundle.klines.length - 1] : null;
        setRefPrice(last ? last.close : null);
      })
      .catch(() => {
        if (alive) setRefPrice(null);
      })
      .finally(() => {
        if (alive) setRefPriceLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [stock]);

  const thresholdNum = Number(threshold);
  const bandNum = Number(band);
  const thresholdValid = Number.isFinite(thresholdNum) && thresholdNum > 0;
  const bandValid = type === 'PRICE_NEAR' ? Number.isFinite(bandNum) && bandNum >= 0 : true;

  const rule = useMemo(
    () =>
      thresholdValid
        ? computeTriggerBoundary({ direction, type, threshold: thresholdNum, band: bandNum })
        : null,
    [direction, type, thresholdNum, bandNum, thresholdValid],
  );

  const bandPct = bandPctOfThreshold({ direction, type, threshold: thresholdNum, band: bandNum });
  const distance = rule && refPrice !== null ? distanceToTrigger(refPrice, rule) : null;
  const inTriggerSide = rule && refPrice !== null ? isPriceInTriggerSide(refPrice, rule) : false;
  const narrowBand = type === 'PRICE_NEAR' && isBandTooNarrow(bandNum, refPrice ?? thresholdNum);

  const canSubmit = Boolean(stock) && Boolean(rule) && bandValid && !submitting && remaining > 0;

  /** 高抛不支持跌破：切方向时收敛类型，避免提交被后端 400 拒绝 */
  const handleDirectionChange = (next: MonitorDirection) => {
    setDirection(next);
    if (next === 'SELL' && type === 'PRICE_BELOW') setType('PRICE_NEAR');
  };

  const handleSubmit = async () => {
    if (!stock || !rule) return;
    setSubmitting(true);
    try {
      await startMonitor({
        fullCode: stock.fullCode,
        direction,
        type,
        threshold: thresholdNum,
        ...(type === 'PRICE_NEAR' ? { band: bandNum } : {}),
      });
      showToast(
        `✅ 已开启追踪 · ${stock.Name} ${direction === 'BUY' ? '低吸' : '高抛'} ${rule.operator === '<=' ? '≤' : '≥'} ${rule.bound.toFixed(2)}`,
      );
      setStock(null);
      setThreshold('');
      setBand('');
      onCreated();
    } catch (err) {
      if (err instanceof MonitorLimitError) showToast(`⚠️ ${err.message}`);
      else if (err instanceof MonitorBadRequestError) showToast(`❌ ${err.message}`);
      else if (err instanceof SessionExpiredError) showToast('⚠️ 登录已失效，请重新登录');
      else showToast('❌ 开启失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4 space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
        <Plus className="h-4 w-4" />
        新建价格提醒
      </h3>

      <StockAutocomplete value={stock} onChange={setStock} placeholder="搜索股票代码/名称..." />

      <div className="space-y-2">
        <ModeTabs
          tabs={DIRECTION_TABS}
          value={direction}
          onChange={handleDirectionChange}
          ariaLabel="预告单方向"
          variant="solid"
        />
        <ModeTabs
          tabs={direction === 'BUY' ? TYPE_TABS : TYPE_TABS.filter((t) => t.id === 'PRICE_NEAR')}
          value={type}
          onChange={setType}
          ariaLabel="触发类型"
          variant="solid"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-slate-400">目标价（元）</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="1450"
            className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
          />
        </label>
        {type === 'PRICE_NEAR' && (
          <label className="block">
            <span className="text-xs text-slate-400">容差（元）</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={band}
              onChange={(e) => setBand(e.target.value)}
              placeholder="20"
              className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
            />
          </label>
        )}
      </div>

      {/* 提示区：L1 触发边界（必做）+ L2 当前价与风险警示 */}
      <div className="space-y-1.5 rounded-lg bg-slate-900/50 p-3 text-xs">
        {rule && thresholdValid ? (
          <p className="text-slate-300">
            触发边界 {rule.operator === '<=' ? '≤' : '≥'} {rule.bound.toFixed(2)}
            <span className="text-slate-500">
              （目标价 {thresholdNum.toFixed(2)}
              {type === 'PRICE_NEAR'
                ? ` ${direction === 'BUY' ? '+' : '−'} 容差 ${(Number.isFinite(bandNum) ? bandNum : 0).toFixed(2)}，约 ${bandPct.toFixed(2)}%`
                : ''}
              ）
            </span>
          </p>
        ) : (
          <p className="text-slate-500">填写目标价后显示触发边界</p>
        )}

        {refPriceLoading && <p className="text-slate-500">取价中…</p>}

        {!refPriceLoading && refPrice !== null && rule && (
          <p className={inTriggerSide ? 'text-amber-300' : 'text-slate-400'}>
            当前价 {refPrice.toFixed(2)}
            {inTriggerSide ? '，已落在触发侧 → 下一轮即提醒' : ''}
            {!inTriggerSide && distance
              ? `，距触发还需${direction === 'BUY' ? '下跌' : '上涨'} ${Math.abs(distance.diff).toFixed(2)}（${Math.abs(distance.pct).toFixed(2)}%）`
              : ''}
          </p>
        )}

        {inTriggerSide && (
          <p className="flex items-start gap-1 text-amber-300">
            <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
            当前价已满足触发条件，提交后立即开始提醒，3 次额度进入倒计时
          </p>
        )}

        {narrowBand && (
          <p className="flex items-start gap-1 text-amber-300">
            <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
            容差偏窄（不足 0.3%），30 分钟检查可能错过，建议放宽
          </p>
        )}

        {/* 提交前常驻说明（api.md §6.2） */}
        <div className="pt-1 space-y-0.5 text-slate-500">
          <p>交易时段内每 30 分钟检查一次，条件成立后最迟约 30 分钟提醒；非交易时段与周末不检查。</p>
          <p>同一预告单最多提醒 3 次，提醒满 3 次后自动结束（同一单两次提醒至少间隔 30 分钟）。</p>
          <p>当前剩余 {Math.max(0, remaining)} 条额度（上限 {MONITOR_MAX_RUNNING}）</p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        className="tap-target w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? '提交中…' : '开启提醒'}
      </button>
    </div>
  );
}
