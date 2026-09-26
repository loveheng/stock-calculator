/**
 * @file PlanReminderField.tsx
 * @description 计划单创建表单内嵌的「开启价格提醒」开关 + 容差输入 + 提示规范落点
 *              （docs/monitor/api.md §6）：L1 单边触发边界、L2 当前价（K 线最后收盘）、
 *              「建单即触发」黄色警示、容差过窄警示、节奏/封顶/额度常驻说明。
 *              计划单方向/目标价已具备，故本组件只承接「是否开启 + 容差」与展示，
 *              由调用方在创建计划单成功后经 usePlanReminder.start 落库预告单。
 * @layer UI
 * @storage_impact 不直接读写存储；取价经 services/klineService（三级缓存）。
 * @author 开发团队
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Bell, AlertTriangle } from 'lucide-react';
import type { StockSearchItem } from '../../types/stock';
import { getKline } from '../../services/klineService';
import { useAuthStore } from '../../store/useAuthStore';
import { MONITOR_MAX_RUNNING } from '../../services/monitorService';
import {
  bandPctOfThreshold,
  computeTriggerBoundary,
  distanceToTrigger,
  isBandTooNarrow,
  isPriceInTriggerSide,
  type MonitorAlertType,
  type MonitorDirection,
} from '../../utils/monitorRule';

interface PlanReminderFieldProps {
  /** 计划单方向（buy/sell） */
  direction: 'buy' | 'sell';
  /** 计划目标价（元） */
  threshold: number;
  /** 价格阈值带（可选），用于推导默认容差与边界提示 */
  thresholdRange?: { low: number; high: number };
  /** 已选股票（用于 L2 取当前价）；未选时无 L2 提示 */
  stock: StockSearchItem | null;
  /** 是否开启（受控） */
  enabled: boolean;
  /** 开关回调 */
  onEnabledChange: (v: boolean) => void;
  /** 容差输入值（受控，字符串） */
  band: string;
  /** 容差输入回调 */
  onBandChange: (v: string) => void;
}

/**
 * 计划单价格提醒字段。
 *
 * @returns {JSX.Element} 开关 + 容差 + 提示区
 */
export default function PlanReminderField({
  direction,
  threshold,
  thresholdRange,
  stock,
  enabled,
  onEnabledChange,
  band,
  onBandChange,
}: PlanReminderFieldProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setAuthModalOpen = useAuthStore((s) => s.setAuthModalOpen);

  const bandNum = Number(band);
  const bandValid = band === '' || (Number.isFinite(bandNum) && bandNum >= 0);
  const effectiveBand = band === '' ? 0 : bandNum;

  const monitorDirection: MonitorDirection = direction === 'buy' ? 'BUY' : 'SELL';
  const monitorType: MonitorAlertType =
    monitorDirection === 'BUY' && effectiveBand <= 0 ? 'PRICE_BELOW' : 'PRICE_NEAR';

  const rule = useMemo(
    () =>
      threshold > 0
        ? computeTriggerBoundary({
            direction: monitorDirection,
            type: monitorType,
            threshold,
            band: effectiveBand,
          })
        : null,
    [monitorDirection, monitorType, threshold, effectiveBand],
  );

  const bandPct = bandPctOfThreshold({
    direction: monitorDirection,
    type: monitorType,
    threshold,
    band: effectiveBand,
  });

  // L2 当前价：K 线最后一根收盘价（取价失败静默降级，不阻断创建）
  const [refPrice, setRefPrice] = useState<number | null>(null);
  const [refPriceLoading, setRefPriceLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !stock) {
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
  }, [enabled, stock]);

  const distance = rule && refPrice !== null ? distanceToTrigger(refPrice, rule) : null;
  const inTriggerSide = rule && refPrice !== null ? isPriceInTriggerSide(refPrice, rule) : false;
  const narrowBand = monitorType === 'PRICE_NEAR' && isBandTooNarrow(effectiveBand, refPrice ?? threshold);

  const handleToggle = () => {
    if (!enabled && !isAuthenticated) {
      setAuthModalOpen(true);
      return;
    }
    onEnabledChange(!enabled);
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 space-y-2">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between tap-target"
        aria-pressed={enabled}
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
          <Bell className={`h-3.5 w-3.5 ${enabled ? 'text-amber-300' : 'text-slate-500'}`} />
          开启价格提醒
          <span className="text-[10px] font-normal text-slate-500">到价后端自动推送</span>
        </span>
        <span
          className={`relative h-4 w-7 rounded-full transition-colors ${
            enabled ? 'bg-amber-500' : 'bg-slate-600'
          }`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
              enabled ? 'left-3.5' : 'left-0.5'
            }`}
          />
        </span>
      </button>

      {enabled && (
        <div className="space-y-2">
          {!isAuthenticated && (
            <p className="text-[10px] text-amber-300">价格提醒需登录后生效，请先登录</p>
          )}

          {monitorType === 'PRICE_NEAR' && (
            <label className="block">
              <span className="text-[10px] text-slate-400">容差（元，可不填）</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={band}
                onChange={(e) => onBandChange(e.target.value)}
                placeholder="0"
                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
              />
            </label>
          )}

          {/* L1 触发边界 + L2 当前价与风险警示 */}
          <div className="space-y-1 rounded-lg bg-slate-900/50 p-2.5 text-[11px]">
            {rule && threshold > 0 ? (
              <p className="text-slate-300">
                触发边界 {rule.operator === '<=' ? '≤' : '≥'} {rule.bound.toFixed(2)}
                <span className="text-slate-500">
                  （目标价 {threshold.toFixed(2)}
                  {monitorType === 'PRICE_NEAR'
                    ? ` ${monitorDirection === 'BUY' ? '+' : '−'} 容差 ${effectiveBand.toFixed(2)}，约 ${bandPct.toFixed(2)}%`
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
                  ? `，距触发还需${monitorDirection === 'BUY' ? '下跌' : '上涨'} ${Math.abs(distance.diff).toFixed(2)}（${Math.abs(distance.pct).toFixed(2)}%）`
                  : ''}
              </p>
            )}

            {!refPriceLoading && refPrice !== null && rule && !inTriggerSide && distance && (
              <p className="text-slate-500">
                窗口内触及即触发（无需停留），价格跨过边界即计入提醒。
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

            {/* §6.2 节奏与封顶常驻说明 */}
            <div className="space-y-0.5 pt-1 text-slate-500">
              <p>交易时段内每 30 分钟检查一次，条件成立后最迟约 30 分钟提醒；非交易时段与周末不检查。</p>
              <p>同一预告单最多提醒 3 次，提醒满 3 次后自动结束（同一单两次提醒至少间隔 30 分钟）。</p>
              <p>创建后占用价格提醒额度（上限 {MONITOR_MAX_RUNNING} 条）</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
