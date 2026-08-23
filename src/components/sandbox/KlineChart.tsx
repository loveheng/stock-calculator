/**
 * @file KlineChart.tsx
 * @description 沙盘推演 K 线图组件：封装 lightweight-charts v5，在同一时间轴上绘制
 *              ① 前复权蜡烛图（A 股配色：阳线红 / 阴线绿）② 持仓成本线（LineSeries，
 *              随买卖点动态变化）③ 买卖操作标记（SeriesMarkers 插件：买=上箭头红 /
 *              卖=下箭头绿，带股数文本）④ 成交量副图（Histogram，独立 pane，柱色随涨跌）
 *              ＋ Vol-MA20 成交量 20 日均线；对 user 分支开启「点击 K 线 → 下单」交互
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

import React, { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
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
import { extractFactors, type CoreFactors } from '../../utils/strategyGenerators';

/**
 * 轻量 K 线形态白话解析（纯函数，无副作用）：
 * 复用「5 大基石因子」中的 bodyRatio / upperShadowRatio / volumeRatio20，
 * 并按优先级（自顶向下）判定唯一形态；不命中则归为「普通K线」。
 */
export function describeKlinePattern(f: CoreFactors, bar: KlineItem, prevClose?: number): string {
  const amp = bar.high - bar.low;

  // ① 优先过滤一字涨跌停/停牌：盘中振幅为零（四价合一 high === low），无常规形态可套用。
  //    方向按收盘较昨收的涨跌幅粗判：≤-4.5% 视为跌停（覆盖 ST 的 -5% 与主板的 -10%），
  //    ≥+4.5% 视为涨停；无昨收或涨跌幅≈0 则归为停牌/平盘。
  if (bar.high === bar.low) {
    if (prevClose != null && prevClose > 0) {
      const pct = (bar.close - prevClose) / prevClose;
      if (pct <= -0.045) return '一字跌停 (流动性丧失/高危)';
      if (pct >= 0.045) return '一字涨停 (极强多头)';
    }
    return '停牌/平盘';
  }

  // 下影线比例：min(Open, Close) 至 Low 占用整根振幅的比例（因子层未单列，此处就地计算）
  const lowerShadow = (Math.min(bar.open, bar.close) - bar.low) / amp;

  // ② 饱满大阳线：实体 > 0.6、收盘高于开盘、几乎无上影
  if (f.bodyRatio > 0.6 && bar.close > bar.open && f.upperShadowRatio < 0.2) {
    return '饱满大阳线 (动能强劲)';
  }
  // ③ 长上影线：上影 > 0.5 且放量（量比 > 1.5）→ 冲高受阻
  if (f.upperShadowRatio > 0.5 && f.volumeRatio20 > 1.5) {
    return '长上影线 (冲高受阻)';
  }
  // ④ 下影锤子线：长下影（> 0.5）且收盘高于开盘 → 探底回升
  if (lowerShadow > 0.5 && bar.close > bar.open) {
    return '下影锤子线 (探底回升)';
  }
  // ⑤ 十字星：①过滤后已达 high > low（存在实际盘中振幅）；仅当实体占比极小才允许判定
  if (f.bodyRatio < 0.2) {
    // 均线破位、单边下行 → 仅标注弱势整理，避免误导用户盲目抄底
    if (f.biasMa20 <= -0.05) {
      return '窄幅十字星 (弱势整理)';
    }
    // 均线多头且回踩企稳（未破位）、缩量 → 蓄势企稳
    if (f.volumeRatio20 < 0.75) {
      return '缩量十字星 (蓄势企稳)';
    }
    return '十字星 (多空拉锯)';
  }
  return '普通K线';
}

/** A 股约定配色（与全站涨红跌绿一致） */
const UP_COLOR = '#ef4444';
const DOWN_COLOR = '#22c55e';
const COST_LINE_COLOR = '#60a5fa';
const GRID_COLOR = 'rgba(148, 163, 184, 0.08)';
const TEXT_COLOR = '#94a3b8';
/** 成交量副图配色：涨红(#EF4444) / 跌绿(#10B981)，Vol-MA20 金线(#F59E0B) */
const VOL_UP_COLOR = '#ef4444';
const VOL_DOWN_COLOR = '#10b981';
const VOL_MA_COLOR = '#F59E0B';
/** 成交量均线周期 */
const VOL_MA_PERIOD = 20;

/** ATR 动态止损辅助线配色（玫红） */
const ATR_STOP_COLOR = '#F43F5E';
/** ATR 周期（14）与止损倍数（止损 = 入场以来最高价 − N × ATR14） */
const ATR_STOP_PERIOD = 14;
const ATR_STOP_MULT = 3;
/** 账户净值（Equity Curve）副图配色（紫） */
const EQUITY_COLOR = '#a78bfa';

/** 均线配置：周期 → 颜色 / 线宽（MA5 金 / MA20 蓝 / MA60 绿）
 * 注：lightweight-charts 的 LineWidth 仅支持 1~4 整数，需求中的 1.5 无法表达，
 *     故取最近整数并保持「MA5<MA20<MA60」递增层次。 */
const MA_CONFIG = [
  { period: 5, key: 'ma5' as const, color: '#F59E0B', width: 1 as const },
  { period: 20, key: 'ma20' as const, color: '#3B82F6', width: 2 as const },
  { period: 60, key: 'ma60' as const, color: '#10B981', width: 3 as const },
];

/** 悬浮图例行 (key → 标签) */
const MA_LABELS: Record<(typeof MA_CONFIG)[number]['key'], string> = {
  ma5: 'MA5',
  ma20: 'MA20',
  ma60: 'MA60',
};

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
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const volMaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  // ATR14 动态止损辅助线（主图）
  const atrStopSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  // 账户净值（Equity Curve）副图 Series（可选折叠面板，动态创建/删除）
  const equitySeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  // 三条均线 Series ref（跨挂载回调读取，避免重复创建）
  const maSeriesRef = useRef<Record<(typeof MA_CONFIG)[number]['key'], ISeriesApi<'Line'> | null>>({
    ma5: null,
    ma20: null,
    ma60: null,
  });
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const onBarClickRef = useRef(onBarClick);
  onBarClickRef.current = onBarClick;
  // K 线数组 ref：点击回调只在挂载时注册一次，需用 ref 读取最新数据
  const klineRef = useRef(kline);
  klineRef.current = kline;
  // 5 大基石因子 ref：crosshair 回调只注册一次，需用 ref 读取最新因子用于形态解析
  const factorsRef = useRef<CoreFactors[]>([]);
  useEffect(() => {
    factorsRef.current = kline.length > 0 ? extractFactors(kline) : [];
  }, [kline]);
  // 订单 ref：Hover 触发点需要在只注册一次的 crosshair 回调中读取最新订单
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  // 账户净值副图是否展开（默认折叠）
  const [equityVisible, setEquityVisible] = useState(false);
  // 悬浮买卖点 Tooltip 状态
  const [tip, setTip] = useState<{ x: number; y: number; items: SandboxOrder[] } | null>(null);
  // 悬浮处均线图例状态（无悬浮时 null）
  const [maLegend, setMaLegend] = useState<{
    date?: string;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    ma5?: number;
    ma20?: number;
    ma60?: number;
    vol?: number;
    volMa20?: number;
    /** 光标悬浮处 K 线形态白话解析（如「饱满大阳线 (动能强劲)」） */
    pattern?: string;
  } | null>(null);

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

    // ATR14 动态止损辅助线（主图叠加，玫红虚线；数据由快照+ATR 计算）
    const atrStopSeries = chart.addSeries(LineSeries, {
      color: ATR_STOP_COLOR,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    });

    // 三条均线 Series（颜色 / 宽度见 MA_CONFIG，关闭自身价格线与图例以免视觉干扰）
    for (const cfg of MA_CONFIG) {
      const maSeries = chart.addSeries(LineSeries, {
        color: cfg.color,
        lineWidth: cfg.width,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      maSeriesRef.current[cfg.key] = maSeries;
    }

    // 成交量副图：独立 pane（索引 1），Histogram 渲染成交量柱，柱色由当日涨跌决定
    const volumeSeries = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
        // 整体基色仅作兜底，每根柱子颜色在 setData 时按涨跌单独指定
        color: VOL_UP_COLOR,
      },
      1,
    );

    // Vol-MA20：叠加在成交量 pane 上的 20 日成交量均线（虚线细线）
    const volMaSeries = chart.addSeries(
      LineSeries,
      {
        color: VOL_MA_COLOR,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      1,
    );

    // 主图（K线+MA）与成交量副图垂直比例 75% : 25%（pane0 : pane1）
    const panes = chart.panes();
    if (panes.length >= 2) {
      panes[0].setStretchFactor(0.75);
      panes[1].setStretchFactor(0.25);
    }

    const markersApi = createSeriesMarkers(candleSeries, []);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    costSeriesRef.current = costSeries;
    atrStopSeriesRef.current = atrStopSeries;
    volumeSeriesRef.current = volumeSeries;
    volMaSeriesRef.current = volMaSeries;
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

    // 十字线移动 → ① 命中买卖订单日期时显示详情 Tooltip（含逐笔触发原因 note）
    //                 ② 更新悬浮处 MA5/MA20/MA60 图例数值
    chart.subscribeCrosshairMove((param) => {
      const t = param.time;

      // ② 均线图例：读取光标下各均线 Series 的数据点
      const legend: {
        date?: string;
        open?: number;
        high?: number;
        low?: number;
        close?: number;
        ma5?: number;
        ma20?: number;
        ma60?: number;
        vol?: number;
        volMa20?: number;
      } = {};
      let legendDirty = false;
      for (const cfg of MA_CONFIG) {
        const series = maSeriesRef.current[cfg.key];
        if (!series) continue;
        const point = param.seriesData.get(series) as { value?: number } | undefined;
        const value = point?.value;
        if (value !== undefined && Number.isFinite(value)) {
          legend[cfg.key] = value;
          legendDirty = true;
        }
      }
      // ③ 成交量图例：当日 Volume 与 Vol-MA20
      const volPoint = param.seriesData.get(volumeSeriesRef.current!) as
        | { value?: number }
        | undefined;
      if (volPoint?.value !== undefined && Number.isFinite(volPoint.value)) {
        legend.vol = volPoint.value;
        legendDirty = true;
      }
      const volMaPoint = param.seriesData.get(volMaSeriesRef.current!) as
        | { value?: number }
        | undefined;
      if (volMaPoint?.value !== undefined && Number.isFinite(volMaPoint.value)) {
        legend.volMa20 = volMaPoint.value;
        legendDirty = true;
      }

      // ④ OHLC 基础行情 + 形态白话解析：命中某根 K 线时读取其 OHLC 与 5 大基石因子判读形态
      let pattern: string | undefined;
      if (t) {
        const dayStr = String(t);
        const idx = klineRef.current.findIndex((k) => k.date === dayStr);
        if (idx >= 0 && idx < factorsRef.current.length) {
          const bar = klineRef.current[idx];
          const prevClose = idx > 0 ? klineRef.current[idx - 1].close : undefined;
          legend.date = bar.date;
          legend.open = bar.open;
          legend.high = bar.high;
          legend.low = bar.low;
          legend.close = bar.close;
          pattern = describeKlinePattern(factorsRef.current[idx], bar, prevClose);
          legendDirty = true;
        }
      }
      setMaLegend(legendDirty ? { ...legend, pattern } : null);

      if (!param.point || !t) {
        setTip(null);
        return;
      }
      const dayStr = String(t);
      const matched = ordersRef.current.filter((o) => o.timestamp.slice(0, 10) === dayStr);
      if (matched.length === 0) {
        setTip(null);
        return;
      }
      setTip({ x: param.point.x, y: param.point.y, items: matched });
    });

    return () => {
      setTip(null);
      setMaLegend(null);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      costSeriesRef.current = null;
      atrStopSeriesRef.current = null;
      equitySeriesRef.current = null;
      volumeSeriesRef.current = null;
      volMaSeriesRef.current = null;
      maSeriesRef.current = { ma5: null, ma20: null, ma60: null };
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

  // 成交量柱更新：柱色按当日涨跌动态着色（close>=open 红 / close<open 绿）
  useEffect(() => {
    const series = volumeSeriesRef.current;
    if (!series) return;
    series.setData(
      kline.map((k) => ({
        time: k.date as Time,
        value: k.volume,
        color: k.close >= k.open ? VOL_UP_COLOR : VOL_DOWN_COLOR,
      })),
    );
  }, [kline]);

  // Vol-MA20 数据更新：20 日滚动成交量均联合值（不足周期前缀自然跳过）
  useEffect(() => {
    const series = volMaSeriesRef.current;
    if (!series) return;
    const p = VOL_MA_PERIOD;
    const points: { time: Time; value: number }[] = [];
    let sum = 0;
    for (let i = 0; i < kline.length; i++) {
      sum += kline[i].volume;
      if (i >= p) sum -= kline[i - p].volume;
      if (i >= p - 1) {
        points.push({ time: kline[i].date as Time, value: sum / p });
      }
    }
    series.setData(points);
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

  // ATR14 动态止损线：基于日 K 计算 ATR14（Wilder 平滑），结合推演快照的持仓状态
  // 绘制「入场以来最高价 − N×ATR14」的动态止损价；仅在持仓期间取值，并只向上抬升（ratchet），
  // 空仓期间插入空白点以断开连线。
  useEffect(() => {
    const series = atrStopSeriesRef.current;
    if (!series) return;
    if (kline.length === 0) {
      series.setData([]);
      return;
    }

    // 1) 计算 ATR14（Wilder 平滑：首值用前 ATR_STOP_PERIOD 根 TR 的均值，其后指数递推）
    const tr = new Array<number>(kline.length);
    for (let i = 0; i < kline.length; i++) {
      const k = kline[i];
      const prevClose = i > 0 ? kline[i - 1].close : k.open;
      tr[i] = Math.max(k.high - k.low, Math.abs(k.high - prevClose), Math.abs(k.low - prevClose));
    }
    const atr = new Array<number>(kline.length);
    if (kline.length >= ATR_STOP_PERIOD) {
      let sum = 0;
      for (let i = 0; i < ATR_STOP_PERIOD; i++) sum += tr[i];
      atr[ATR_STOP_PERIOD - 1] = sum / ATR_STOP_PERIOD;
      for (let i = ATR_STOP_PERIOD; i < kline.length; i++) {
        atr[i] = (atr[i - 1] * (ATR_STOP_PERIOD - 1) + tr[i]) / ATR_STOP_PERIOD;
      }
    }

    // 2) 快照按日取末值 → 判断当日是否持仓
    const byDate = new Map<string, SandboxSnapshot>();
    if (snapshots) {
      for (const s of snapshots) {
        byDate.set(s.timestamp.slice(0, 10), s);
      }
    }

    // 3) 遍历每日：持仓时跟踪入场以来最高价，止损价 = 最高价 − N×ATR14（只升不降）
    let holding = false;
    let highestHigh = 0;
    let stop = 0;
    const points: ({ time: Time; value: number } | { time: Time })[] = [];
    for (let i = 0; i < kline.length; i++) {
      const day = kline[i].date;
      const snap = byDate.get(day);
      const pos = snap ? snap.position : 0;
      const atrVal = atr[i];
      if (pos > 0 && Number.isFinite(atrVal)) {
        if (!holding) {
          // 入场首日：以当日高点为锚初始化止损
          holding = true;
          highestHigh = kline[i].high;
          stop = highestHigh - ATR_STOP_MULT * atrVal;
        } else {
          highestHigh = Math.max(highestHigh, kline[i].high);
          const cand = highestHigh - ATR_STOP_MULT * atrVal;
          stop = Math.max(stop, cand);
        }
        points.push({ time: day as Time, value: stop });
      } else {
        // 空仓：重置持仓状态，并插入空白点断开止损线
        holding = false;
        highestHigh = 0;
        stop = 0;
        points.push({ time: day as Time });
      }
    }
    series.setData(points);
  }, [kline, snapshots]);

  // 账户净值（Equity Curve）副图：可选折叠面板。
  // 展开时在 pane 2 动态创建 LineSeries（与主图共用同一时间轴 → 十字光标天然对齐），
  // 收起时移除对应 pane，恢复主图+成交量比例。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    let panes = chart.panes();
    if (equityVisible) {
      let series = equitySeriesRef.current;
      if (!series) {
        series = chart.addSeries(
          LineSeries,
          {
            color: EQUITY_COLOR,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false,
          },
          2,
        );
        equitySeriesRef.current = series;
      }
      // 每个交易日节点取快照末值 → totalAsset
      if (snapshots && snapshots.length) {
        const byDate = new Map<string, SandboxSnapshot>();
        for (const s of snapshots) byDate.set(s.timestamp.slice(0, 10), s);
        const pts: { time: Time; value: number }[] = [...byDate.entries()]
          .map(([day, s]) => ({ time: day as Time, value: s.totalAsset }))
          .sort((a, b) => String(a.time).localeCompare(String(b.time)));
        series.setData(pts);
      }
      // 三栏垂直比例：主图 : 成交量 : 净值 = 0.6 : 0.2 : 0.2
      panes = chart.panes();
      panes[0]?.setStretchFactor(0.6);
      panes[1]?.setStretchFactor(0.2);
      panes[2]?.setStretchFactor(0.2);
    } else {
      // 收起：移除净值为 pane 2 的整块面板，并恢复双栏比例
      if (equitySeriesRef.current) {
        if (panes.length >= 3) {
          chart.removePane(2);
        }
        equitySeriesRef.current = null;
      }
      panes = chart.panes();
      if (panes.length >= 2) {
        panes[0].setStretchFactor(0.75);
        panes[1].setStretchFactor(0.25);
      }
    }
  }, [equityVisible, snapshots]);

  // 均线数据更新：基于前复权收盘价计算 5/20/60 日均线（不足周期前缀自然跳过）
  useEffect(() => {
    for (const cfg of MA_CONFIG) {
      const series = maSeriesRef.current[cfg.key];
      if (!series) continue;
      const p = cfg.period;
      const points: { time: Time; value: number }[] = [];
      let sum = 0;
      for (let i = 0; i < kline.length; i++) {
        sum += kline[i].close;
        if (i >= p) sum -= kline[i - p].close;
        // 从满足周期的首个点开始输出，前缀空数据安全跳过
        if (i >= p - 1) {
          points.push({ time: kline[i].date as Time, value: sum / p });
        }
      }
      series.setData(points);
    }
  }, [kline]);

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
      <div ref={containerRef} style={{ height }} className="relative w-full">
        {tip && (() => {
          const cw = containerRef.current?.clientWidth ?? 0;
          return (
            <div
              className="pointer-events-none absolute z-20 min-w-52 rounded-lg border border-slate-700 bg-slate-900/95 px-3 py-2 shadow-xl backdrop-blur-sm"
              style={{
                left: Math.max(4, Math.min(tip.x + 12, cw - 220)),
                top: Math.max(4, tip.y - 24),
              }}
            >
              <div className="space-y-1.5">
                {tip.items.map((o, i) => (
                  <div key={o.id ?? i} className="space-y-1">
                  <div className={`inline-flex items-center gap-1 text-[10px] font-semibold ${o.action === 'buy' ? 'text-red-400' : 'text-green-400'}`}>
                    <span>{o.action === 'buy' ? '🟢 买入' : '🔴 卖出'}</span>
                    <span className="font-normal text-slate-300">{o.timestamp.slice(0, 10)}</span>
                  </div>
                  <div className="text-[11px] text-slate-200">
                    成交价 <span className="font-mono text-slate-100">¥{o.price.toFixed(2)}</span> · {o.quantity} 股
                  </div>
                  {o.note && (
                    <div className="mt-1 border-t border-slate-700/60 pt-1 text-[10px] leading-snug text-amber-300">
                      触发：{o.note}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          );
        })()}
        {maLegend && (
          <div className="pointer-events-none absolute left-1.5 top-1.5 z-10 max-w-[85%] rounded-md bg-slate-900/50 px-2 py-1.5 font-mono text-[11px] backdrop-blur-sm">
            <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-slate-400">{maLegend.date ?? '--'}</span>
              <span className={maLegend.close !== undefined && maLegend.open !== undefined && maLegend.close >= maLegend.open ? 'text-red-400' : 'text-green-400'}>开{maLegend.open ?? '--'} 高{maLegend.high ?? '--'} 低{maLegend.low ?? '--'} 收{maLegend.close ?? '--'}</span>
              {maLegend.pattern && (
                <span key="pattern" className="bg-slate-800/80 px-2 py-0.5 text-xs text-amber-300 rounded">
                  {maLegend.pattern}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {MA_CONFIG.map((cfg) => {
              const v = maLegend[cfg.key];
              return (
                <span key={cfg.key} className="inline-flex items-center gap-1" style={{ color: cfg.color }}>
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: cfg.color }} />
                  {MA_LABELS[cfg.key]}
                  <span className="text-slate-100">{v !== undefined ? v.toFixed(2) : '--'}</span>
                </span>
              );
            })}
            <span key="vol" className="inline-flex items-center gap-1" style={{ color: VOL_UP_COLOR }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: VOL_UP_COLOR }} />
              <span className="text-slate-100">{maLegend.vol !== undefined ? maLegend.vol.toLocaleString() : '--'}</span>
              <span className="text-slate-500">VOL</span>
            </span>
            <span key="volMa20" className="inline-flex items-center gap-1" style={{ color: VOL_MA_COLOR }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: VOL_MA_COLOR }} />
              Vol-MA20
              <span className="text-slate-100">{maLegend.volMa20 !== undefined ? maLegend.volMa20.toLocaleString() : '--'}</span>
            </span>
          </div>
        </div>
        )}
      </div>
      <div className="flex items-center justify-between mt-1 px-0.5">
        <div className="text-[10px] text-slate-600">
          📊 前复权价格（已扣掉分红除权影响的历史价格）· 绿线 = 持仓成本线 · 玫红虚线
          = ATR14 动态止损 · 金/蓝/绿线 = MA5 / MA20 / MA60 · 下方柱 = 成交量，金色虚线 =
          Vol-MA20
        </div>
        <button
          type="button"
          onClick={() => setEquityVisible((v) => !v)}
          className="shrink-0 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] font-medium text-slate-300 transition-colors hover:border-violet-500/50 hover:text-violet-300"
          aria-pressed={equityVisible}
        >
          {equityVisible ? '▾ 收起净值曲线' : '▸ 展开净值曲线'}
        </button>
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
