/**
 * @file KlineChart.tsx
 * @description 沙盘推演 K 线图组件：封装 lightweight-charts v5，在同一时间轴上绘制
 *              ① 前复权蜡烛图（A 股配色：阳线红 / 阴线绿）② 持仓成本线（LineSeries，
 *              随买卖点动态变化）③ 买卖操作标记（SeriesMarkers 插件：买=上箭头红 /
 *              卖=下箭头绿，带股数文本）；对 user 分支开启「点击 K 线 → 下单」交互
 *              （回调当日 open/high/low/close，由外部弹出买入/卖出面板，见规格书 §9.2-①）。
 *
 * 【v5 API 要点（与 v4 不同，勿按旧记忆写）】
 *  - chart.addSeries(CandlestickSeries, opts) 取代 v4 的 addCandlestickSeries()；
 *  - 标记为独立插件：createSeriesMarkers(series, markers) → api.setMarkers(...)；
 *  - Time 直接使用 'YYYY-MM-DD' 业务日字符串（ISO 格式兼容）；
 *  - 尺寸自适应用 autoSize: true（内部 ResizeObserver，容器需有确定高度）。
 * @layer UI
 * @storage_impact 纯展示组件，不读写任何存储；仅通过回调向父级上报点击的 K 线。
 * @author 开发团队
 */

import React, { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type SeriesMarker,
} from 'lightweight-charts';
import type { KlineItem, SandboxBranchType, SandboxOrder, SandboxSnapshot } from '../../types/sandbox';

/** A 股约定配色（与全站涨红跌绿一致） */
const UP_COLOR = '#ef4444';
const DOWN_COLOR = '#22c55e';
const COST_LINE_COLOR = '#60a5fa';
const GRID_COLOR = 'rgba(148, 163, 184, 0.08)';
const TEXT_COLOR = '#94a3b8';

/** 点击 K 线回调：barIndex 与当日 K 线（供下单面板取高/低/收） */
export interface BarClickInfo {
  barIndex: number;
  item: KlineItem;
}

interface KlineChartProps {
  /** 前复权日 K 线（时间升序） */
  kline: KlineItem[];
  /** 参与推演的订单（渲染买卖标记；可能含引擎抖动后的成交价，但标记只按日期） */
  orders: SandboxOrder[];
  /** 推演快照（成本线数据源；可为 null/空 → 不画成本线） */
  snapshots?: SandboxSnapshot[] | null;
  /** 分支类型：baseline / preset 为只读，user 可点击下单 */
  branchType: SandboxBranchType;
  /** 是否开启「点击 K 线下单」（仅 user 分支 + 已选中时 true） */
  onBarClick?: (info: BarClickInfo) => void;
  /** 容器高度（默认 400px，配合 autoSize 自适应宽度） */
  height?: number;
}

/**
 * K 线图组件。
 *
 * @param {KlineChartProps} props - 见接口定义
 * @returns {JSX.Element} 图表容器
 */
export default function KlineChart({
  kline,
  orders,
  snapshots = null,
  branchType,
  onBarClick,
  height = 400,
}: KlineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const costSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const onBarClickRef = useRef(onBarClick);
  onBarClickRef.current = onBarClick;
  // K 线数组 ref：点击回调只在挂载时注册一次，需用 ref 读取最新数据
  const klineRef = useRef(kline);
  klineRef.current = kline;

  // 创建图表（仅一次）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: TEXT_COLOR,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      rightPriceScale: {
        borderColor: GRID_COLOR,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: GRID_COLOR,
        timeVisible: false,
        rightOffset: 4,
        barSpacing: 6,
      },
      crosshair: {
        vertLine: { color: 'rgba(148, 163, 184, 0.4)', labelBackgroundColor: '#334155' },
        horzLine: { color: 'rgba(148, 163, 184, 0.4)', labelBackgroundColor: '#334155' },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const costSeries = chart.addSeries(LineSeries, {
      color: COST_LINE_COLOR,
      lineWidth: 1,
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineStyle: LineStyle.Dashed,
      priceLineColor: COST_LINE_COLOR,
      crosshairMarkerVisible: false,
    });

    const markersApi = createSeriesMarkers(candleSeries, []);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    costSeriesRef.current = costSeries;
    markersApiRef.current = markersApi;

    // 点击 K 线 → 上报（仅 user 分支由父级决定是否启用）
    chart.subscribeClick((param) => {
      const handler = onBarClickRef.current;
      if (!handler || !param.time) return;
      const timeStr = String(param.time);
      const klineNow = klineRef.current;
      const barIndex = klineNow.findIndex((k) => k.date === timeStr);
      if (barIndex >= 0) {
        handler({ barIndex, item: klineNow[barIndex] });
      }
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      costSeriesRef.current = null;
      markersApiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 蜡烛数据更新
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    series.setData(
      kline.map((k) => ({
        time: k.date as Time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      })),
    );
  }, [kline]);

  // 买卖标记更新（按日期去重：同日多笔合并为一行标记）
  useEffect(() => {
    const api = markersApiRef.current;
    if (!api) return;

    const byDate = new Map<string, { buys: number; sells: number }>();
    for (const o of orders) {
      const day = o.timestamp.slice(0, 10);
      const entry = byDate.get(day) ?? { buys: 0, sells: 0 };
      if (o.action === 'buy') entry.buys += o.quantity;
      else entry.sells += o.quantity;
      byDate.set(day, entry);
    }

    const markers: SeriesMarker<Time>[] = [];
    for (const [day, v] of byDate) {
      if (v.buys > 0) {
        markers.push({
          time: day as Time,
          position: 'belowBar',
          shape: 'arrowUp',
          color: UP_COLOR,
          size: 1,
          text: `买${v.buys}`,
        });
      }
      if (v.sells > 0) {
        markers.push({
          time: day as Time,
          position: 'aboveBar',
          shape: 'arrowDown',
          color: DOWN_COLOR,
          size: 1,
          text: `卖${v.sells}`,
        });
      }
    }
    api.setMarkers(markers);
  }, [orders]);

  // 成本线更新（快照按日去重取末值；仅持仓 > 0 且有成本时绘制）
  useEffect(() => {
    const series = costSeriesRef.current;
    if (!series) return;
    if (!snapshots || snapshots.length === 0) {
      series.setData([]);
      return;
    }
    const byDate = new Map<string, SandboxSnapshot>();
    for (const s of snapshots) {
      const day = s.timestamp.slice(0, 10);
      byDate.set(day, s);
    }
    const points: { time: Time; value: number }[] = [];
    for (const s of byDate.values()) {
      if (s.position > 0 && s.cost > 0) {
        points.push({ time: s.timestamp.slice(0, 10) as Time, value: s.cost });
      }
    }
    points.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    series.setData(points);
  }, [snapshots]);

  const editable = branchType === 'user' && !!onBarClick;

  if (kline.length === 0) {
    return (
      <div
        className="flex items-center justify-center bg-slate-900/50 border border-slate-800 rounded-xl text-slate-500 text-sm"
        style={{ height }}
      >
        暂无 K 线数据，请先选择标的
      </div>
    );
  }

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height }} className="w-full" />
      <div className="text-[10px] text-slate-600 mt-1 px-0.5">
        📊 前复权价格（已扣掉分红除权影响的历史价格）· 绿线 = 持仓成本线
      </div>
      {editable && (
        <span className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30 pointer-events-none">
          点击 K 线可下单
        </span>
      )}
      {branchType !== 'user' && (
        <span className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30 pointer-events-none">
          {branchType === 'baseline' ? '真实操作 · 只读' : '系统策略基准 · 只读'}
        </span>
      )}
    </div>
  );
}
