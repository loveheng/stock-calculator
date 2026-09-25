/**
 * @file brokerService.ts
 * @description 股票经纪代理 HTTP 客户端（Spring Boot :18080 /api/broker，v3 定案）：
 *              画布域 K 线**唯一通道** = GET /api/broker/klines（服务端代理行情商，
 *              前端不直连、不上传、零数据管理）。同源信封契约（200 + code 分支），
 *              Bearer 由调用方传参注入（禁 import store，R 层护栏）。
 *              错误口径：code/HTTP 401 → SessionExpiredError（画布数据需登录，游客不可见）；
 *              429/5xx/超时/网络故障 → BrokerUnavailableError（区块显示「行情服务暂不可用」，
 *              重试仍走代理——画布域没有直连兜底，禁止回退 klineService）。
 *              存量域（沙盘/风控/做T）继续用 klineService 直连，本服务与其零耦合。
 * @layer Service
 * @storage_impact 无持久化读写；内存缓存（Map）由本服务持有，画布区块渲染时消费。
 * @author 开发团队
 */

import { SessionExpiredError } from './apiClient';
import { parseSseBlock } from './copilotService';
import type { CopilotAction } from '../types/domain';
import type { KlineItem } from '../types/sandbox';

/** 与 announcementService 同构的信封契约（main 统一出口） */
interface BrokerEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 代理通道不可用（429/5xx/超时/网络故障）：调用方转区块占位，不做直连兜底 */
export class BrokerUnavailableError extends Error {
  constructor(message = '行情服务暂不可用，请稍后重试') {
    super(message);
    this.name = 'BrokerUnavailableError';
  }
}

export const BROKER_API_BASE_URL = '/api/broker';

const REQUEST_TIMEOUT_MS = 15_000;

/** getKlines 返回条目（契约对齐 klineService 的 KlineItem：date 为 YYYY-MM-DD 字符串） */
export type BrokerKline = KlineItem;

/** getKlines 查询参数 */
export interface BrokerKlinesParams {
  /** 腾讯形态代码（sh600519），规范主键 */
  fullCode: string;
  /** 复权类型，默认 qfq */
  adjustType?: 'qfq' | 'raw';
  /** 拉取根数上限，默认 120（画布区块标准窗口） */
  limit?: number;
}

/** 能力端点条目：agent 指标白名单（spec §2.6） */
export interface BrokerIndicatorCap {
  /** 计算名（白名单键，如 "macd"） */
  name: string;
  /** 展示名 */
  label: string;
  /** 最少暖机根数（短切片占位渲染与本地校验依据） */
  minBars: number;
  /** 可挂的区块类型（前端据此过滤设置弹层选项） */
  applicableBlocks: string[];
}

/** 能力端点返回（含 version，缓存对齐依据） */
export interface BrokerIndicatorCaps {
  version: number;
  indicators: BrokerIndicatorCap[];
}

/**
 * 统一请求底座：信封解析 + 401 会话失效 + 可用性降级分类。
 * 与 apiClient.apiRequest 分离的原因：基地址不同（/api/broker vs /api/auth），
 * 且 429/5xx 需映射为 BrokerUnavailableError 而非普通业务错误。
 */
async function brokerRequest<T>(
  path: string,
  options: { token: string; method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const url = new URL(BROKER_API_BASE_URL + path, window.location.origin);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${options.token}`,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // 超时（AbortSignal.timeout 抛 TimeoutError DOMException）与网络故障统一归类
    throw new BrokerUnavailableError();
  }

  // HTTP 层：401 会话失效走现成链路；429/5xx 归「服务暂不可用」（重试仍走代理）
  if (response.status === 401) throw new SessionExpiredError();
  if (response.status === 429 || response.status >= 500) throw new BrokerUnavailableError('行情服务繁忙，请稍后重试');

  let envelope: BrokerEnvelope<T>;
  try {
    envelope = (await response.json()) as BrokerEnvelope<T>;
  } catch {
    throw new BrokerUnavailableError('行情服务响应异常，请稍后重试');
  }
  if (!envelope || typeof envelope.code !== 'number') throw new BrokerUnavailableError('行情服务响应异常，请稍后重试');
  if (envelope.code === 401) throw new SessionExpiredError(envelope.message);
  if (envelope.code === 429 || envelope.code >= 500) throw new BrokerUnavailableError('行情服务繁忙，请稍后重试');
  if (envelope.code !== 200) throw new BrokerUnavailableError(envelope.message || '行情获取失败，请稍后重试');
  return envelope.data;
}

/**
 * 内存缓存（fullCode|adjustType → 条目）：画布区块重渲染/换页免重复请求。
 * 与 klineService 三级缓存无关（画布域独立通道）；刷新动作（refreshCanvasKlines）
 * 调 force 参数绕过。
 */
const klineCache = new Map<string, BrokerKline[]>();

function cacheKey(fullCode: string, adjustType: 'qfq' | 'raw'): string {
  return `${fullCode}|${adjustType}`;
}

/** 内存缓存读取（区块重渲染免请求） */
export function getCachedBrokerKlines(fullCode: string, adjustType: 'qfq' | 'raw' = 'qfq'): BrokerKline[] | null {
  return klineCache.get(cacheKey(fullCode, adjustType)) ?? null;
}

/** 清空内存缓存（会话登出/强制刷新场景） */
export function clearBrokerKlineCache(): void {
  klineCache.clear();
}

/**
 * 拉取画布 K 线（代理唯一通道）。
 * 命中内存缓存直接返回；force=true 跳过缓存（画布「刷新行情」动作）。
 *
 * @param {BrokerKlinesParams} params - fullCode（腾讯形态）必填；adjustType/limit 可选
 * @param {string} token - 用户 Bearer（401 → SessionExpiredError 由调用方 auth 链路处理）
 * @param {object} [opts] - force: 跳过内存缓存
 * @returns {Promise<BrokerKline[]>} 升序日K条目（date: YYYY-MM-DD）
 * @throws {SessionExpiredError} 会话失效（弹登录）
 * @throws {BrokerUnavailableError} 429/5xx/超时/网络故障（区块占位，重试走代理）
 */
export async function getBrokerKlines(
  params: BrokerKlinesParams,
  token: string,
  opts: { force?: boolean } = {},
): Promise<BrokerKline[]> {
  const adjustType = params.adjustType ?? 'qfq';
  const key = cacheKey(params.fullCode, adjustType);
  if (!opts.force) {
    const cached = klineCache.get(key);
    if (cached) return cached;
  }
  const data = await brokerRequest<{ klines: BrokerKline[] }>('/klines', {
    token,
    query: {
      fullCode: params.fullCode,
      adjustType,
      limit: String(params.limit ?? 120),
    },
  });
  // 形状防御：非数组/空数据不缓存（服务端异常形态不落内存）
  if (!Array.isArray(data?.klines) || data.klines.length === 0) {
    throw new BrokerUnavailableError('无行情数据（停牌或代码失效）');
  }
  klineCache.set(key, data.klines);
  return data.klines;
}

// ============================================================
// 能力端点（spec §2.6）：agent 指标白名单 + version 缓存
// ============================================================

/** 能力缓存（内存态）：null = 尚未拉取；失败保留上次缓存（首次失败则隐藏 agent 指标选项） */
let capsCache: BrokerIndicatorCaps | null = null;

/** 读取已缓存的能力清单（未拉取过返回 null；调用方据此隐藏选项，不发请求） */
export function getCachedIndicatorCaps(): BrokerIndicatorCaps | null {
  return capsCache;
}

/**
 * 拉取能力端点并缓存（spec §2.5-8：本地计算函数表与渲染以它为准）。
 * 失败时保留上次缓存（返回 null，调用方降级）；401 会话失效正常上抛。
 *
 * @param {string} token - 用户 Bearer
 * @returns {Promise<BrokerIndicatorCaps | null>} 能力清单；失败且无缓存时 null
 * @throws {SessionExpiredError} 会话失效（弹登录）
 */
export async function fetchIndicatorCaps(token: string): Promise<BrokerIndicatorCaps | null> {
  try {
    const data = await brokerRequest<BrokerIndicatorCaps>('/indicators', { token });
    // 形状防御：version 非数字或 indicators 非数组不落缓存
    if (typeof data?.version !== 'number' || !Array.isArray(data?.indicators)) return capsCache;
    capsCache = data;
    return capsCache;
  } catch (e) {
    // 会话失效上抛；其余失败保留旧缓存
    if (e instanceof SessionExpiredError) throw e;
    return capsCache;
  }
}

/** 按区块类型过滤可挂指标（设置弹层选项依据；能力未拉取时返回空） */
export function indicatorsForBlockType(blockType: string): BrokerIndicatorCap[] {
  return capsCache?.indicators.filter((c) => c.applicableBlocks.includes(blockType)) ?? [];
}

// ============================================================
// compute 端点（spec §2.1）：无状态复杂指标计算（算完即弃）
// ============================================================

/** compute 请求切片（klines 升序 ≤120 根，date YYYY-MM-DD 字符串口径） */
export interface BrokerComputeSlice {
  fullCode: string;
  adjustType: 'qfq' | 'raw';
  klines: KlineItem[];
  /** 逐日复权因子表（可选；v3 代理通道不产因子，缺省传空对象占位——字段保留以对齐契约） */
  adjustFactors?: Record<string, number>;
  /** 指标名白名单（能力端点清单内），白名单外后端 400 */
  indicators: string[];
}

/** compute 返回：version 数字自增（只比对相等）；指标数组与 klines 一一对齐，暖机期 null 占位 */
export interface BrokerComputeResult {
  version: number;
  indicators: Record<string, Record<string, (number | null)[]>>;
}

/**
 * 无状态复杂指标计算（spec §2.1）：前端传 K 线切片，agent 算完即弃。
 * 本地预校验：切片 ≤120 根、指标名在能力清单内（超限/白名单外直接拒绝，不发请求）。
 * 错误口径与 getKlines 一致：401 上抛、429/5xx/超时 → BrokerUnavailableError、400 → 业务错误原样。
 *
 * @throws {SessionExpiredError} 会话失效
 * @throws {BrokerUnavailableError} 429/5xx/超时/网络故障
 * @throws {Error} 本地预校验失败（切片超限/指标未注册）——message 用户可读
 */
export async function computeIndicators(slice: BrokerComputeSlice, token: string): Promise<BrokerComputeResult> {
  if (slice.klines.length === 0) throw new Error('无 K 线数据，请先选择股票');
  if (slice.klines.length > 120) throw new Error('切片超限（≤120 根）');
  if (!slice.indicators.length) throw new Error('未选择指标');
  const caps = getCachedIndicatorCaps();
  if (caps) {
    const known = new Set(caps.indicators.map((c) => c.name));
    const unknown = slice.indicators.filter((n) => !known.has(n));
    if (unknown.length) throw new Error(`指标未注册：${unknown.join('、')}`);
  }
  return brokerRequest<BrokerComputeResult>('/indicators/compute', {
    token,
    method: 'POST' as const,
    body: {
      fullCode: slice.fullCode,
      adjustType: slice.adjustType,
      klines: slice.klines,
      adjustFactors: slice.adjustFactors ?? {},
      indicators: slice.indicators,
    } satisfies BrokerComputeSlice,
  });
}

// ============================================================
// ask 端点（spec §2.2）：经纪分析问询（SSE，画布线程）
// ============================================================

/** ask 请求体（spec §2.2）：cid 复用 newClientMessageId（§2.5-6）；canvasContext 为标号摘要 */
export interface BrokerAskRequest {
  cid: string;
  question: string;
  /** 可选：聚焦区块的标的（缺省时 agent 只看 canvasContext） */
  fullCode?: string;
  /** 可选：K 线切片（结构同 compute，阅后即焚） */
  klines?: KlineItem[];
  /** 画布标号摘要（useCanvasContext.buildCanvasSummary 产出） */
  canvasContext: string;
}

/** ask 权威响应（done 事件）：actions 随 done 返回（无独立 actions 事件，与 copilot 现网一致） */
export interface BrokerAskResponse {
  content: string;
  /** AI 建议动作（annotate_block / canvas_* / execute_local_calc，经前端白名单守卫消费） */
  actions?: readonly CopilotAction[];
}

/**
 * 经纪分析问询（SSE，spec §2.2）：POST /api/broker/ask，Accept: text/event-stream。
 * 事件协议与 copilot 现网一致：delta 逐段回调 / done 权威响应（含 actions）/ error 信封错误；
 * 未知事件忽略（向前兼容）。空闲超时/外部取消语义对齐 streamQuestion。
 * 复用 copilotService.parseSseBlock（同构解析，禁复制粘贴第二套实现）。
 *
 * @throws {SessionExpiredError} 会话失效（弹登录）
 * @throws {BrokerUnavailableError} 429/5xx/超时/网络故障/流中断
 */
export async function askBroker(
  request: BrokerAskRequest,
  token: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<BrokerAskResponse> {
  const controller = new AbortController();
  let onExternalAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      onExternalAbort = () => controller.abort();
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const detach = () => {
    if (onExternalAbort && signal) signal.removeEventListener('abort', onExternalAbort);
  };
  /** 空闲超时（无字节 30s 判流挂死；与 copilot 流式空闲口径对齐） */
  const STREAM_IDLE_TIMEOUT_MS = 30_000;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
  };
  armIdle();

  let response: Response;
  try {
    response = await fetch(BROKER_API_BASE_URL + '/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (e) {
    detach();
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw signal?.aborted ? new Error('已停止生成') : new BrokerUnavailableError('行情服务响应超时，请重试');
    }
    throw new BrokerUnavailableError();
  }
  if (response.status === 401) {
    detach();
    throw new SessionExpiredError();
  }
  if (response.status === 429 || response.status >= 500) {
    detach();
    throw new BrokerUnavailableError('行情服务繁忙，请稍后重试');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    detach();
    throw new BrokerUnavailableError('行情服务响应异常，请稍后重试');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let settled: BrokerAskResponse | null = null;

  const handleBlock = (block: string): void => {
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    if (parsed.event === 'delta') {
      try {
        const payload = JSON.parse(parsed.data) as { text?: string };
        if (typeof payload.text === 'string' && payload.text.length > 0) onDelta(payload.text);
      } catch {
        // 形状不符的 delta 静默忽略（向前兼容）
      }
      return;
    }
    if (parsed.event === 'done') {
      settled = JSON.parse(parsed.data) as BrokerAskResponse;
      return;
    }
    if (parsed.event === 'error') {
      const payload = JSON.parse(parsed.data) as { message?: string };
      throw new BrokerUnavailableError(payload.message || 'AI 分析失败，请稍后重试');
    }
    // 未知事件忽略（向前兼容）
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const sep = buffer.match(/\r?\n\r?\n/);
        if (!sep || sep.index === undefined) break;
        const block = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        handleBlock(block);
      }
    }
    if (buffer.trim()) handleBlock(buffer);
  } catch (e) {
    void reader.cancel().catch(() => {});
    throw e;
  } finally {
    detach();
    if (idleTimer) clearTimeout(idleTimer);
  }
  if (!settled) throw new BrokerUnavailableError('AI 响应流异常中断，请重试');
  return settled;
}
