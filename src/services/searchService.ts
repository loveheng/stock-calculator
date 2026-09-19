/**
 * @file searchService.ts
 * @description 资讯搜索 HTTP 客户端（Spring Boot :18080 /api/search，与 E2EE 认证服务同源）：
 *              公告摘要检索 / CLS 电报检索 / 股票档案卡聚合三个常规端点，以及
 *              AI 综合摘要 SSE 流式端点（内容协商回落同步 JSON，镜像 copilotService 模式）。
 *              常规端点走 15s 超时底座（镜像 announcementService）；composite 通道例外——
 *              固定 15s 会掐断 SSE 长流，改用空闲超时（每收到数据块重置，30s 静默才中断）。
 *              契约：《news-search-api.md》v1.5——业务错误为 HTTP 200 + 信封 code 分支
 *              （400/429/500），前端以信封 code 分支；唯一例外是未认证 401 由
 *              AuthInterceptor 直写 HTTP 401 + 信封 401。
 * @layer Service
 * @storage_impact 无持久化读写；token 由调用方传参注入（禁 import store，R 层护栏）。
 * @author 开发团队
 */

import { AuthApiError, SessionExpiredError } from './apiClient';
import { parseSseBlock } from './copilotService';
import type {
  AnnouncementHit,
  ClsHit,
  CompositeResult,
  SearchRequest,
  SearchResultItem,
  StockProfile,
} from '../types/search';

export const SEARCH_API_BASE_URL = '/api/search';

/** 常规检索请求超时（毫秒）：与 apiClient / announcementService 底座保持一致 */
const REQUEST_TIMEOUT_MS = 15_000;

/** composite SSE 空闲超时（毫秒）：TTFB 与块间隔共用，每收到字节重置（接口文档 §4 同步上限 30s） */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

/** 列表检索响应（接口文档 §2/§3 同构；hasMore 为分页专用字段，未分页端点缺省） */
export interface SearchListResult<T> {
  total: number;
  items: T[];
  /** 分页：是否还有下一页（后端多取 1 条精确判定）；公告端点上分页前无此语义 */
  hasMore?: boolean;
}

/** composite 流式回调集合（meta 引用先于 delta 到达，保证引用先上屏） */
export interface CompositeStreamOptions {
  /** meta 事件：整批替换引用来源列表 */
  onMeta?: (citations: CompositeResult['citations']) => void;
  /** delta 事件：增量文本，调用方自行累积拼接 */
  onDelta?: (text: string) => void;
  /** 竞态作废探针：每个数据块检查一次，true 时中断读取并放弃本流（返回 null） */
  isCancelled?: () => boolean;
}

/** 后端信封结构（与 apiClient.ApiEnvelope 同构；独立声明避免扩大耦合面） */
interface ApiEnvelopeShape<T> {
  code: number;
  message: string;
  data: T;
}

interface SearchRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
}

/** 携带 HTTP 状态的响应异常：非信封响应（代理报错页 / 网关 HTML）时使用 */
function httpStatusError(status: number): Error {
  const err = new Error('服务响应异常（HTTP ' + status + '），请稍后重试');
  (err as Error & { status?: number }).status = status;
  return err;
}

/**
 * 检索服务统一请求入口（内部底座，镜像 announcementService.announcementRequest）：
 * - 返回原始信封（code/message/data），由各 API 函数自行分支处理；
 * - 401（信封 code 401 或非信封 HTTP 401）→ SessionExpiredError；
 * - 非 JSON / 非信封响应 → 携带 HTTP 状态的 Error；
 * - 网络失败 / 超时 → Error（统一「网络异常」文案）。
 */
async function searchRequest<T>(
  path: string,
  options: SearchRequestOptions = {},
): Promise<ApiEnvelopeShape<T>> {
  const { method = 'GET', body, token } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(SEARCH_API_BASE_URL + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：请求超时，请检查连接后重试');
    }
    throw new Error('网络异常：无法连接检索服务，请检查网络后重试');
  }
  clearTimeout(timer);

  let parsed: ApiEnvelopeShape<T> | null = null;
  try {
    parsed = (await response.json()) as ApiEnvelopeShape<T> | null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.code !== 'number') {
    // 非信封响应：仅 HTTP 401（拦截器直写）可确定语义，其余按 HTTP 状态抛出
    if (response.status === 401) throw new SessionExpiredError();
    throw httpStatusError(response.status);
  }
  if (parsed.code === 401) throw new SessionExpiredError(parsed.message);
  return parsed;
}

/**
 * 检索命中行归一：kind 缺失/契约外（旧构建后端实测——渲染侧按「非 announcement 即 CLS」
 * 隐式兜底，快照侧却按 kind 严格判别，脏行导致区块快照降级为空、AI 拿到 data={}）时
 * 按字段形状推断修补：publishedAt/mentions → cls，annDate → announcement；
 * 两者皆无的行原样保留不强删（渲染容忍、该行区块快照 exists=false 降级），避免脏行清空整页结果。
 */
function normalizeHit(item: unknown): SearchResultItem {
  if (!item || typeof item !== 'object') return item as SearchResultItem;
  const r = item as Record<string, unknown>;
  if (r.kind === 'announcement' || r.kind === 'cls') return r as unknown as SearchResultItem;
  if (typeof r.publishedAt === 'string' || Array.isArray(r.mentions)) {
    return {
      ...r,
      kind: 'cls',
      mentions: Array.isArray(r.mentions) ? (r.mentions.filter(Boolean) as ClsHit['mentions']) : [],
    } as unknown as SearchResultItem;
  }
  if (typeof r.annDate === 'string') {
    return { ...r, kind: 'announcement' } as unknown as SearchResultItem;
  }
  return r as unknown as SearchResultItem;
}

/** 列表响应防御性归一：items 非数组 / total 缺省时不让脏数据流入状态机 */
function normalizeList<T>(data: unknown): SearchListResult<T> {
  if (data && typeof data === 'object') {
    const d = data as { total?: unknown; items?: unknown; hasMore?: unknown };
    // 元素级过滤 null + kind 缺失修补（线上旧构建后端两类脏数据实测均出现过），脏数据不得流入状态机
    const items = (Array.isArray(d.items) ? d.items.filter(Boolean) : []).map(
      (it) => normalizeHit(it) as unknown as T,
    );
    return {
      total: typeof d.total === 'number' ? d.total : items.length,
      items,
      hasMore: d.hasMore === true,
    };
  }
  return { total: 0, items: [], hasMore: false };
}

/** 综合摘要响应防御性归一（同步 JSON 回落路径；summary/citations 缺省兜底空值） */
function normalizeComposite(data: unknown): CompositeResult {
  if (data && typeof data === 'object') {
    const d = data as { summary?: unknown; citations?: unknown };
    return {
      summary: typeof d.summary === 'string' ? d.summary : '',
      citations: Array.isArray(d.citations) ? (d.citations as CompositeResult['citations']) : [],
    };
  }
  return { summary: '', citations: [] };
}

// ============================================================
// 常规检索端点：公告摘要 / CLS 电报 / 股票档案卡（15s 超时底座）
// ============================================================

/**
 * 公告摘要检索（POST /announcements，接口文档 §2）。
 * stockCodes 提供时为硬过滤（仅返回这些股票的公告）；缺省 = 不限股票。
 * 业务错误（关键词过长 / 检索范围过大等）→ AuthApiError（message 用户可读）；
 * 限流 429 → AuthApiError（data.retryAfterSeconds 经 extractRetryAfterSeconds 提取）。
 */
export async function searchAnnouncements(
  token: string,
  req: SearchRequest,
): Promise<SearchListResult<AnnouncementHit>> {
  const envelope = await searchRequest<unknown>('/announcements', {
    method: 'POST',
    body: req,
    token,
  });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  return normalizeList<AnnouncementHit>(envelope.data);
}

/**
 * CLS 电报检索（POST /cls，接口文档 §3）。
 * 请求体仅 query/dateRange/topK（该端点无 stockCodes 参数，调用方不得传入）。
 * edition 恒 'telegraph'（Q3 终版定案：无早报/晚报，字段仅为契约稳定保留）。
 */
export async function searchCls(
  token: string,
  req: SearchRequest,
): Promise<SearchListResult<ClsHit>> {
  const envelope = await searchRequest<unknown>('/cls', {
    method: 'POST',
    body: req,
    token,
  });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  return normalizeList<ClsHit>(envelope.data);
}

/** 档案卡归一目标类型（从接口文档 §5 契约类型派生，避免双源漂移） */
type ProfileAnnouncement = StockProfile['latestAnnouncements'][number];
type ClsMentionItem = NonNullable<StockProfile['clsMention']>['items'][number];

/**
 * 档案卡响应防御性归一（镜像 normalizeList/normalizeComposite 模式）：
 * 线上环境 §5 响应实测会在 latestAnnouncements / clsMention.items 数组里混入 null 元素
 * （表现：资讯页聊天快照 profileDetail 遍历 items 读 i.publishedAt 时 TypeError）。
 * 注意当前后端源码并无此产出路径（clsMention 恒 null，P2 未实现），疑为旧构建产物——
 * 防御保留为纵深兜底，不因当前源码"干净"而移除。
 */
function normalizeProfile(data: unknown, fallbackStockId: string): StockProfile {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const rawAnns: unknown = d.latestAnnouncements;
  const rawCls =
    d.clsMention && typeof d.clsMention === 'object'
      ? (d.clsMention as { count7d?: unknown; items?: unknown })
      : null;
  const rawClsItems: unknown = rawCls ? rawCls.items : undefined;
  const clsItems = (Array.isArray(rawClsItems) ? rawClsItems.filter(Boolean) : []) as ClsMentionItem[];
  return {
    stockId: typeof d.stockId === 'string' && d.stockId ? d.stockId : fallbackStockId,
    stockName: typeof d.stockName === 'string' ? d.stockName : '',
    latestAnnouncements: (Array.isArray(rawAnns) ? rawAnns.filter(Boolean) : []) as ProfileAnnouncement[],
    clsMention: rawCls
      ? {
          count7d: typeof rawCls.count7d === 'number' ? rawCls.count7d : clsItems.length,
          items: clsItems,
        }
      : null,
  };
}

/**
 * 股票确定性档案卡聚合（GET /stock-profile?stockId=，接口文档 §5）。
 * 未知 stockId（格式合法但语料未收录）→ 200 + 空 latestAnnouncements + clsMention=null，
 * 由调用方按空档案卡展示；格式非法 → 400（AuthApiError，message 用户可读）。
 */
export async function fetchStockProfile(token: string, stockId: string): Promise<StockProfile> {
  const envelope = await searchRequest<StockProfile>('/stock-profile?stockId=' + encodeURIComponent(stockId), {
    token,
  });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  return normalizeProfile(envelope.data, stockId);
}

/**
 * 429 限流响应的类型守卫：data 形如 { retryAfterSeconds: number } 时返回正整数秒。
 * 信封 data 缺省 / 形状不符时返回 null（调用方兜底展示后端 message 文案）。
 */
export function extractRetryAfterSeconds(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const v = (data as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.ceil(v);
  return null;
}

// ============================================================
// AI 综合摘要（POST /composite）：SSE 流式（方案 A）+ 同步 JSON 回落（方案 B）
// 例外通道：不走 15s 固定超时底座（会掐断 SSE 长流），改用空闲超时。
// ============================================================

/**
 * AI 综合摘要流式客户端：
 * - 新后端回 text/event-stream：事件序 meta（引用）→ delta*（增量文本）→ done（收尾），
 *   error 事件抛 AuthApiError（code/message/data）；isCancelled 探针每块检查，
 *   竞态作废时 reader.cancel() + abort 底层连接并返回 null（调用方丢弃本流）；
 * - 后端未升级 / 阶段一校验失败回同步 JSON 信封（方案 B）：自动回落解析，
 *   行为与常规端点一致（不回调 onDelta/onMeta）。
 * - token 缺省快速抛错（防御性检查；未登录门控主判断在 slice/视图，D10）。
 */
export async function searchCompositeStream(
  token: string,
  req: SearchRequest,
  opts: CompositeStreamOptions = {},
): Promise<CompositeResult | null> {
  if (!token) throw new Error('请先登录后再使用 AI 综合摘要');

  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
  };
  armIdle();

  let response: Response;
  try {
    response = await fetch(SEARCH_API_BASE_URL + '/composite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
  } catch (e) {
    if (idleTimer) clearTimeout(idleTimer);
    if (opts.isCancelled?.()) return null;
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：请求超时，请检查连接后重试');
    }
    throw new Error('网络异常：无法连接检索服务，请检查网络后重试');
  }

  // 内容协商回落：非 event-stream = 同步 JSON 信封（接口文档 §4 方案 B）
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    try {
      let parsed: ApiEnvelopeShape<CompositeResult> | null = null;
      try {
        parsed = (await response.json()) as ApiEnvelopeShape<CompositeResult> | null;
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed.code !== 'number') {
        if (response.status === 401) throw new SessionExpiredError();
        throw httpStatusError(response.status);
      }
      if (parsed.code === 401) throw new SessionExpiredError(parsed.message);
      if (parsed.code !== 200) throw new AuthApiError(parsed.code, parsed.message, parsed.data);
      return normalizeComposite(parsed.data);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error('服务响应异常（无响应体），请稍后重试');
  }

  try {
    const decoder = new TextDecoder();
    let buffer = '';
    let summary = '';
    let citations: CompositeResult['citations'] = [];
    let doneSeen = false;
    let cancelled = false;

    const handleBlock = (block: string): void => {
      const parsed = parseSseBlock(block);
      if (!parsed) return;
      if (parsed.event === 'meta') {
        const payload = JSON.parse(parsed.data) as { citations?: CompositeResult['citations'] };
        citations = Array.isArray(payload.citations) ? payload.citations : [];
        opts.onMeta?.(citations);
        return;
      }
      if (parsed.event === 'delta') {
        const payload = JSON.parse(parsed.data) as { text?: string };
        if (typeof payload.text === 'string' && payload.text.length > 0) {
          summary += payload.text;
          opts.onDelta?.(payload.text);
        }
        return;
      }
      if (parsed.event === 'done') {
        doneSeen = true;
        return;
      }
      if (parsed.event === 'error') {
        const payload = JSON.parse(parsed.data) as {
          code?: number;
          message?: string;
          retryAfterSeconds?: number;
        };
        throw new AuthApiError(payload.code ?? 500, payload.message || 'AI 综合摘要生成失败，请稍后重试', {
          retryAfterSeconds: payload.retryAfterSeconds,
        });
      }
      // 未知事件忽略（向前兼容）
    };

    for (;;) {
      if (opts.isCancelled?.()) {
        cancelled = true;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // 收到字节 → 重置空闲计时
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const sep = buffer.match(/\r?\n\r?\n/);
        if (!sep || sep.index === undefined) break;
        const block = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        handleBlock(block);
      }
    }
    if (!cancelled && buffer.trim()) handleBlock(buffer); // 容错：流结束仍有未终止的最后一块
    if (cancelled) {
      void reader.cancel().catch(() => {});
      controller.abort();
      return null;
    }
    if (!doneSeen) throw new Error('AI 响应流异常中断，请重试');
    return { summary, citations };
  } catch (e) {
    void reader.cancel().catch(() => {}); // 中途异常释放连接
    if (e instanceof DOMException && e.name === 'AbortError') {
      if (opts.isCancelled?.()) return null;
      throw new Error('网络异常：AI 响应流超时中断，请重试');
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}
