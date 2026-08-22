/**
 * @file klineService.ts
 * @description K 线数据服务：腾讯 ifzq 前复权日 K 线获取 + 三级缓存
 *              （内存 Map → IndexedDB klineCache → 网络），增量合并与
 *              除权漂移检测；同时计算「复权系数表」（qfq收盘 / raw收盘），
 *              供沙盘 store 把真实成交价（未复权）换算到前复权口径，
 *              保证推演引擎、成本线与 K 线图处于同一价格基准。
 *
 * 【上游实测结论（2026-08-20 验证，替代规格书 §10.1 的错误 URL）】
 *  - /appstock/app/kline/mkline 与带 fq 后缀的 /kline 均返回参数错误，不可用；
 *  - /appstock/app/kline/kline?param={code},day,{start},{end},{count}
 *    返回【未复权】day（如平安 2024-01-02 开 40.30）；
 *  - /appstock/app/fqkline/get?param={code},day,{start},{end},{count},qfq
 *    返回【前复权】qfqday（同日开 33.589，已扣分红除权）；
 *  - 数组字段序 = [日期, 开盘, 收盘, 最高, 最低, 成交量, ...]（收盘在最高/最低之前）；
 *  - qfq 锚点为"今日"：跨窗口请求同一历史日期数值一致 → 增量追加安全；
 *    新除权发生后整条历史会重锚定 → 用边界 K 线对比检测漂移并全量刷新。
 * @layer Service
 * @storage_impact 读写 IndexedDB klineCache 表（putKlineCache / loadKlineCache）；
 *                 另有模块级内存缓存（会话内零网络、零 IO）。
 * @author 开发团队
 */

import { loadKlineCache, putKlineCache, type KlineCachePayload } from '../db';
import type { KlineItem } from '../types/sandbox';

/** 复权系数表：日期（YYYY-MM-DD）→ qfq收盘 / raw收盘 */
export type AdjustFactorMap = Record<string, number>;

/** K 线数据包：前复权 K 线 + 复权系数表（沙盘 store 消费的统一载荷） */
export interface KlineBundle {
  /** 前复权日 K 线（时间升序） */
  klines: KlineItem[];
  /** 复权系数表（仅含无除权差异日期之外的全部交易日期，缺失即视为 1） */
  adjustFactors: AdjustFactorMap;
}

/** 代理前缀（本地 Vite / 线上 Vercel Middleware 均转发到 ifzq.gtimg.cn） */
const PROXY_BASE = '/api-kline';

/** 单次请求最大 K 线根数（上游上限，逐年分页保证不触顶） */
const COUNT_PER_REQUEST = 640;

/** 每年并行请求数上限（控制并发，避免触发上游限流） */
const YEAR_CONCURRENCY = 3;

/** 增量合并时边界日收盘价漂移阈值（新除权导致整条历史重锚定 → 全量刷新） */
const DRIFT_THRESHOLD = 0.005;

/** 全量拉取缺省起点：10 年前（store 通常会传首笔操作日 − 90 天更精确） */
const DEFAULT_HISTORY_YEARS = 10;

// ============================================================
// 纯解析函数（可单测）
// ============================================================

/**
 * 解析腾讯 K 线 JSON 响应为 KlineItem[]。
 *
 * @param {string} raw - 响应文本（UTF-8 JSON，与上游实测一致）
 * @param {string} fullCode - 标的完整代码（含市场前缀，如 sh601318）
 * @param {'qfq' | 'raw'} mode - qfq 读 qfqday（前复权，优先）；raw 读 day（未复权）
 * @returns {KlineItem[]} 解析结果；载荷无效 / code≠0 / 字段不足的行自动跳过
 */
export function parseKlinePayload(raw: string, fullCode: string, mode: 'qfq' | 'raw' = 'qfq'): KlineItem[] {
  try {
    const json = JSON.parse(raw) as {
      code?: number;
      data?: Record<string, { qfqday?: unknown[]; day?: unknown[] }>;
    };
    if (json.code !== 0 || !json.data) return [];
    const node = json.data[fullCode];
    // 前复权优先读 qfqday；raw 模式只读 day；均缺省时容错回退
    const rows = mode === 'qfq' ? (node?.qfqday ?? node?.day ?? []) : (node?.day ?? []);
    const klines: KlineItem[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      // 字段序：[日期, 开盘, 收盘, 最高, 最低, 成交量, ...]（收盘在最高/最低之前）
      const date = String(row[0]);
      const open = Number(row[1]);
      const close = Number(row[2]);
      const high = Number(row[3]);
      const low = Number(row[4]);
      const volume = Number(row[5]);
      if (!date || !Number.isFinite(open) || open <= 0 || !Number.isFinite(close)) continue;
      klines.push({ date, open, close, high, low, volume });
    }
    return klines;
  } catch {
    return [];
  }
}

/**
 * 构建复权系数表：factor(date) = qfq收盘 / raw收盘。
 *
 * @param {KlineItem[]} raw - 未复权 K 线
 * @param {KlineItem[]} qfq - 前复权 K 线
 * @returns {AdjustFactorMap} 日期 → 复权系数（仅在两侧都有收盘价的日期生成）
 */
export function buildAdjustFactors(raw: KlineItem[], qfq: KlineItem[]): AdjustFactorMap {
  const rawCloseByDate = new Map<string, number>();
  for (const bar of raw) {
    if (bar.close > 0) rawCloseByDate.set(bar.date, bar.close);
  }
  const factors: AdjustFactorMap = {};
  for (const bar of qfq) {
    const rawClose = rawCloseByDate.get(bar.date);
    if (rawClose && rawClose > 0 && bar.close > 0) {
      factors[bar.date] = bar.close / rawClose;
    }
  }
  return factors;
}

/**
 * 取某交易日的复权系数；非交易日向前回退最多 10 个自然日；仍无则视为 1（无除权差异）。
 *
 * @param {string} date - 订单日期（YYYY-MM-DD）
 * @param {AdjustFactorMap} factors - 复权系数表
 * @returns {number} 复权系数（前复权价格 = 未复权价格 × 系数）
 */
export function getAdjustFactor(date: string, factors: AdjustFactorMap): number {
  const exact = factors[date];
  if (exact !== undefined) return exact;
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return 1;
  const base = Date.UTC(y, m - 1, d);
  for (let i = 1; i <= 10; i++) {
    const prev = new Date(base - i * 86400000);
    const key = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
    const f = factors[key];
    if (f !== undefined) return f;
  }
  return 1;
}

// ============================================================
// 网络层
// ============================================================

/** 按日期去重合并（入参均为时间升序） */
function mergeByDate(base: KlineItem[], extra: KlineItem[]): KlineItem[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((k) => k.date));
  const out = [...base];
  for (const bar of extra) {
    if (!seen.has(bar.date)) {
      seen.add(bar.date);
      out.push(bar);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 拆分 [start, end] 为自然年列表（含首尾年） */
function enumerateYears(start: string, end: string): number[] {
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  if (!startYear || !endYear || endYear < startYear) return [];
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);
  return years;
}

/** 数组分块 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/** 单年双请求：raw（kline）+ qfq（fqkline/get），并行拉取 */
async function fetchYearKline(fullCode: string, year: number): Promise<{ raw: KlineItem[]; qfq: KlineItem[] }> {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const rawUrl = `${PROXY_BASE}/appstock/app/kline/kline?param=${fullCode},day,${start},${end},${COUNT_PER_REQUEST}`;
  const qfqUrl = `${PROXY_BASE}/appstock/app/fqkline/get?param=${fullCode},day,${start},${end},${COUNT_PER_REQUEST},qfq`;

  const [rawRes, qfqRes] = await Promise.all([
    fetch(rawUrl, { method: 'GET', headers: { Referer: 'https://finance.qq.com/' } }),
    fetch(qfqUrl, { method: 'GET', headers: { Referer: 'https://finance.qq.com/' } }),
  ]);
  const [rawText, qfqText] = await Promise.all([rawRes.text(), qfqRes.text()]);
  if (!rawRes.ok) throw new Error(`K 线请求失败(未复权): ${rawRes.status} ${rawRes.statusText}`);
  if (!qfqRes.ok) throw new Error(`K 线请求失败(前复权): ${qfqRes.status} ${qfqRes.statusText}`);

  return {
    raw: parseKlinePayload(rawText, fullCode, 'raw'),
    qfq: parseKlinePayload(qfqText, fullCode, 'qfq'),
  };
}

/**
 * 从网络拉取 [start, end] 区间的 K 线（按年分页 + 年内 raw/qfq 并行）。
 *
 * @param {string} fullCode - 标的完整代码（含市场前缀）
 * @param {{ start: string; end: string }} range - 日期区间（YYYY-MM-DD）
 * @returns {Promise<KlineBundle>} 前复权 K 线 + 复权系数表
 * @throws {Error} 任一 HTTP 请求失败时抛出（解析失败不抛，返回空数组）
 */
export async function fetchKlineFromNetwork(
  fullCode: string,
  range: { start: string; end: string },
): Promise<KlineBundle> {
  const years = enumerateYears(range.start, range.end);
  if (years.length === 0) return { klines: [], adjustFactors: {} };

  const rawAll: KlineItem[] = [];
  const qfqAll: KlineItem[] = [];
  // 分块限并发（每块内并行，块间串行），避免 20+ 并发请求触发上游限流
  for (const chunk of chunkArray(years, YEAR_CONCURRENCY)) {
    const results = await Promise.all(chunk.map((year) => fetchYearKline(fullCode, year)));
    for (const r of results) {
      rawAll.push(...r.raw);
      qfqAll.push(...r.qfq);
    }
  }

  const dedupRaw = mergeByDate([], rawAll);
  const dedupQfq = mergeByDate([], qfqAll);
  return {
    klines: dedupQfq,
    adjustFactors: buildAdjustFactors(dedupRaw, dedupQfq),
  };
}

// ============================================================
// 三级缓存入口
// ============================================================

/** 会话内内存缓存（非响应式：避免渲染风暴，见规格书 §6.3） */
const memoryCache = new Map<string, KlineBundle>();

/** 在途请求去重（同一标的并发调用共享同一网络流程） */
const inFlight = new Map<string, Promise<KlineBundle>>();

/** 今日（YYYY-MM-DD，本地时区） */
function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 缺省全量起点：今天往前 DEFAULT_HISTORY_YEARS 年 */
function defaultStartDate(): string {
  const now = new Date();
  return `${now.getFullYear() - DEFAULT_HISTORY_YEARS}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 基于缓存做增量刷新：拉取 [lastDate, 今日] 增量 → 边界日漂移检测 →
 * 正常则去重合并，检测到除权重锚定或请求范围前移则全量重拉。
 *
 * @param {string} fullCode - 标的完整代码
 * @param {KlineCachePayload} cached - 缓存载荷
 * @param {string | undefined} startDate - 期望的行情起点（首笔操作日 − 90 天）
 * @returns {Promise<KlineBundle>} 合并后的数据包（网络失败时回退缓存）
 */
async function refreshFromCache(
  fullCode: string,
  cached: KlineCachePayload,
  startDate: string | undefined,
): Promise<KlineBundle> {
  const today = todayStr();
  const baseBundle: KlineBundle = { klines: cached.klines, adjustFactors: cached.factors };

  // 缓存已含今日数据，或需要更早的起点 → 直接返回 / 全量重拉
  if (cached.lastDate >= today && (!startDate || startDate >= cached.klines[0].date)) {
    return baseBundle;
  }

  try {
    // 增量窗口含边界日（用于漂移检测），去重时边界日以缓存为准
    const delta = await fetchKlineFromNetwork(fullCode, {
      start: cached.lastDate,
      end: today,
    });
    if (delta.klines.length === 0) return baseBundle;

    // 除权漂移检测：新除权会令整条 qfq 历史重锚定，边界日收盘价随之变化
    const boundary = cached.klines[cached.klines.length - 1];
    const boundaryNew = delta.klines.find((k) => k.date === boundary.date);
    const drifted = boundaryNew && Math.abs(boundaryNew.close - boundary.close) / boundary.close > DRIFT_THRESHOLD;

    const needFull = drifted || (startDate !== undefined && startDate < cached.klines[0].date);
    if (needFull) {
      const full = await fetchKlineFromNetwork(fullCode, {
        start: startDate ?? cached.klines[0].date,
        end: today,
      });
      if (full.klines.length > 0) {
        await putKlineCache(fullCode, full.klines, full.adjustFactors);
        return full;
      }
      return baseBundle;
    }

    // 正常增量合并：追加新 K 线 + 合并新系数
    const mergedKlines = mergeByDate(cached.klines, delta.klines);
    const mergedFactors = { ...cached.factors, ...delta.adjustFactors };
    if (mergedKlines.length > cached.klines.length) {
      await putKlineCache(fullCode, mergedKlines, mergedFactors);
    }
    return { klines: mergedKlines, adjustFactors: mergedFactors };
  } catch {
    // 网络失败：用缓存数据继续（规格书 §14 三级缓存兜底）
    return baseBundle;
  }
}

/**
 * 获取标的的前复权日 K 线（三级缓存：内存 → IndexedDB → 网络）。
 *
 * @param {string} fullCode - 标的完整代码（含市场前缀，如 sh601318）
 * @param {{ startDate?: string }} options - startDate：行情起点（首笔真实操作日 − 90 天缓冲），
 *                                           缺省取近 10 年
 * @returns {Promise<KlineBundle>} 前复权 K 线 + 复权系数表
 * @throws {Error} 无缓存且网络失败时抛出（由调用方提示用户）
 */
export async function getKline(
  fullCode: string,
  options: { startDate?: string } = {},
): Promise<KlineBundle> {
  const mem = memoryCache.get(fullCode);
  if (mem) return mem;

  const inflight = inFlight.get(fullCode);
  if (inflight) return inflight;

  const promise = (async () => {
    const cached = await loadKlineCache(fullCode);
    if (cached && cached.klines.length > 0) {
      const bundle = await refreshFromCache(fullCode, cached, options.startDate);
      memoryCache.set(fullCode, bundle);
      return bundle;
    }

    // 无缓存 → 全量拉取（首笔操作日 − 90 天 或 近 10 年 → 今日）
    const bundle = await fetchKlineFromNetwork(fullCode, {
      start: options.startDate ?? defaultStartDate(),
      end: todayStr(),
    });
    if (bundle.klines.length > 0) {
      await putKlineCache(fullCode, bundle.klines, bundle.adjustFactors);
    }
    memoryCache.set(fullCode, bundle);
    return bundle;
  })();

  inFlight.set(fullCode, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(fullCode);
  }
}

/** 清空会话内内存缓存（数据源切换 / 强制刷新时调用） */
export function clearMemoryCache(): void {
  memoryCache.clear();
}
