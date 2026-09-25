/**
 * @file CanvasKlineChart.tsx
 * @description 画布轻量 K 线图（不复用沙盘 KlineChart——其 orders/snapshots/branchType 强耦合沙盘语义）：
 *              前复权蜡烛 + MA5/20/60 可切换 + 两种划线模式（spec §5）：
 *              ① 水平线：点击价位生成 createPriceLine（带标签），列表可删；
 *              ② 趋势线段：两次点击起终点，LineSeries 两点承载；
 *              交易日吸附细则（spec §5.2）：终点时间取 param.time（图表已吸附到真实 bar），
 *              并防御性强校验必须存在于 kline 序列，否则二分吸附最近交易日——
 *              存储的时间戳必须强等于真实交易日，否则 LineSeries 画不出线段。
 * @layer UI (Canvas)
 * @storage_impact 无直接读写；划线经回调上抛 canvasSlice 持久化（划线即数据）。
 * @author 开发团队
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type Time,
} from 'lightweight-charts';
import type { KlineItem } from '../../types/sandbox';
import type { TrendLine, HLine } from '../../types/domain';

const UP_COLOR = '#ef4444';
const DOWN_COLOR = '#22c55e';
const GRID_COLOR = '#1e293b';
const TEXT_COLOR = '#94a3b8';
const HLINE_COLOR = '#f59e0b';
const TREND_COLOR = '#38bdf8';
const MA_COLORS = ['#facc15', '#38bdf8', '#c084fc'] as const;

export type CanvasDrawMode = 'none' | 'hline' | 'trend';

interface CanvasKlineChartProps {
  kline: KlineItem[];
  trendLines: TrendLine[];
  hLines: HLine[];
  maVisible: boolean;
  drawMode: CanvasDrawMode;
  onAddTrendLine: (line: Omit<TrendLine, 'id'>) => void;
  onAddHLine: (line: Omit<HLine, 'id'>) => void;
  onRemoveDrawing: (kind: 'trend' | 'h', lineId: string) => void;
}

/**
 * 交易日吸附：二分找 kline 序列中与 target 最近（按字符串序 = 时间序）的交易日。
 * 防御性兜底——正常路径 param.time 已是真实 bar 时间。
 */
function snapToTradingDay(target: string, dates: string[]): string {
  if (dates.includes(target)) return target;
  let lo = 0;
  let hi = dates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  // lo 为首个 >= target 的下标；比较前后邻取更近者，返回真实交易日字符串
  const candidates = [lo, Math.max(0, lo - 1)];
  const best = candidates.reduce((b, i) =>
    Math.abs(dates[i].localeCompare(target)) < Math.abs(dates[b].localeCompare(target)) ? i : b,
  candidates[0]);
  return dates[best];
}

/** SMA 计算（窗口不足产出 null，前端跳过渲染） */
function calcMA(kline: KlineItem[], window: number): ({ time: Time; value: number } | null)[] {
  return kline.map((_, i) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += kline[j].close;
    return { time: kline[i].date as Time, value: sum / window };
  });
}

export default function CanvasKlineChart({
  kline,
  trendLines,
  hLines,
  maVisible,
  drawMode,
  onAddTrendLine,
  onAddHLine,
  onRemoveDrawing,
}: CanvasKlineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maRefs = useRef<(ISeriesApi<'Line'> | null)[]>([null, null, null]);
  const trendSeriesRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const priceLineRefs = useRef<Map<string, IPriceLine>>(new Map());

  // 趋势线待选起点（第一次点击后暂存，第二次点击成线）；切出趋势线模式即作废
  const [pendingStart, setPendingStart] = useState<{ time: string; price: number } | null>(null);
  useEffect(() => {
    if (drawMode !== 'trend') setPendingStart(null);
  }, [drawMode]);
  // 划线回调/drawMode/kline 经 ref 透传给只注册一次的 click 监听
  const drawStateRef = useRef({ drawMode, kline, onAddTrendLine, onAddHLine, pendingStart });
  drawStateRef.current = { drawMode, kline, onAddTrendLine, onAddHLine, pendingStart };

  const dates = useMemo(() => kline.map((k) => k.date), [kline]);
  const maSets = useMemo(
    () => (maVisible ? [calcMA(kline, 5), calcMA(kline, 20), calcMA(kline, 60)] : null),
    [kline, maVisible],
  );

  // 创建图表（仅一次）+ click 监听
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: TEXT_COLOR, fontSize: 10 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: GRID_COLOR, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: GRID_COLOR, timeVisible: false, rightOffset: 3, barSpacing: 5 },
      crosshair: {
        vertLine: { color: 'rgba(148,163,184,0.4)', labelBackgroundColor: '#334155' },
        horzLine: { color: 'rgba(148,163,184,0.4)', labelBackgroundColor: '#334155' },
      },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    // MA 三线 Series（maVisible 切换经 setData 空数组隐藏）
    maRefs.current = MA_COLORS.map(
      (color) =>
        chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }),
    );

    chartRef.current = chart;
    candleRef.current = candle;

    chart.subscribeClick((param) => {
      const st = drawStateRef.current;
      if (st.drawMode === 'none' || !param.point || !param.time) return;
      const price = candle.coordinateToPrice(param.point.y);
      if (price === null) return;
      // param.time 已被图表吸附到真实 bar；仍按 spec §5.2 防御性强校验 + 吸附兜底
      const rawTime = String(param.time);
      const time = snapToTradingDay(rawTime, st.kline.map((k) => k.date));
      if (st.drawMode === 'hline') {
        st.onAddHLine({ price: price as number, label: `水平线 ${(price as number).toFixed(2)}` });
        return;
      }
      // trend 模式：两段式点击
      if (!st.pendingStart) {
        setPendingStart({ time, price: price as number });
        return;
      }
      st.onAddTrendLine({
        startTime: st.pendingStart.time,
        startPrice: st.pendingStart.price,
        endTime: time,
        endPrice: price as number,
      });
      setPendingStart(null);
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      maRefs.current = [null, null, null];
      trendSeriesRefs.current.clear();
      priceLineRefs.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 图表仅创建一次
  }, []);

  // 蜡烛数据
  useEffect(() => {
    if (!candleRef.current) return;
    candleRef.current.setData(
      kline.map((k) => ({ time: k.date as Time, open: k.open, high: k.high, low: k.low, close: k.close })),
    );
  }, [kline]);

  // MA 三线（maVisible 切换时 setData 空数组即隐藏）
  useEffect(() => {
    const windows = [5, 20, 60];
    windows.forEach((w, i) => {
      const s = maRefs.current[i];
      if (!s) return;
      s.setData(maSets ? (maSets[i].filter((p) => p !== null) as { time: Time; value: number }[]) : []);
    });
  }, [maSets]);

  // 趋势线段：按 id 增量同步（新增建 Series，删除移除）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const alive = new Set(trendLines.map((l) => l.id));
    for (const [id, series] of trendSeriesRefs.current) {
      if (!alive.has(id)) {
        chart.removeSeries(series);
        trendSeriesRefs.current.delete(id);
      }
    }
    for (const line of trendLines) {
      if (trendSeriesRefs.current.has(line.id)) continue;
      const series = chart.addSeries(LineSeries, {
        color: TREND_COLOR,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData([
        { time: line.startTime as Time, value: line.startPrice },
        { time: line.endTime as Time, value: line.endPrice },
      ]);
      trendSeriesRefs.current.set(line.id, series);
    }
  }, [trendLines]);

  // 水平线：createPriceLine 按 id 增量同步
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    const alive = new Set(hLines.map((l) => l.id));
    for (const [id, pl] of priceLineRefs.current) {
      if (!alive.has(id)) {
        candle.removePriceLine(pl);
        priceLineRefs.current.delete(id);
      }
    }
    for (const line of hLines) {
      if (priceLineRefs.current.has(line.id)) continue;
      const pl = candle.createPriceLine({
        price: line.price,
        color: HLINE_COLOR,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: line.label,
      });
      priceLineRefs.current.set(line.id, pl);
    }
  }, [hLines]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" style={{ cursor: drawMode !== 'none' ? 'crosshair' : undefined }} />
      {/* 划线清单（删除入口；不占用图表事件） */}
      {(hLines.length > 0 || trendLines.length > 0) && (
        <div className="absolute left-2 top-2 max-h-1/2 space-y-1 overflow-auto rounded bg-slate-900/85 p-1.5 text-xs">
          {hLines.map((l) => (
            <div key={l.id} className="flex items-center gap-1 text-amber-400">
              <span className="max-w-[120px] truncate">{l.label}</span>
              <button className="text-slate-500 hover:text-red-400" onClick={() => onRemoveDrawing('h', l.id)}>×</button>
            </div>
          ))}
          {trendLines.map((l) => (
            <div key={l.id} className="flex items-center gap-1 text-sky-400">
              <span className="max-w-[120px] truncate">趋势 {l.startTime}→{l.endTime}</span>
              <button className="text-slate-500 hover:text-red-400" onClick={() => onRemoveDrawing('trend', l.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      {/* 趋势线起点待选提示 */}
      {drawMode === 'trend' && pendingStart && (
        <div className="absolute bottom-2 left-2 rounded bg-sky-500/15 px-2 py-1 text-xs text-sky-300">
          起点 {pendingStart.time} @ {pendingStart.price.toFixed(2)}，点击终点完成
        </div>
      )}
    </div>
  );
}
