/**
 * @file kgService.ts
 * @description 新闻联播图谱 HTTP 客户端（Spring Boot :18080 /api/kg，与资讯检索同源同鉴权）：
 *              时间轴卡片流 / 实体检索建议 / 实体热榜 / 实体详情摘要卡四个常规 GET 端点。
 *              请求底座镜像 searchService.searchRequest（15s 超时、统一信封分支、401 →
 *              SessionExpiredError），前端契约见《kg 时间轴查询 API · 前端对接文档》——
 *              业务错误为 HTTP 200 + 信封 code 分支（40001 参数错误 / 404 实体不存在 / 500）。
 * @layer Service
 * @storage_impact 无持久化读写；token 由调用方传参注入（禁 import store，R 层护栏）。
 * @author 开发团队
 */

import { AuthApiError, SessionExpiredError } from './apiClient';
import type {
  KgEntityDetail,
  KgEntityRef,
  KgEntitySuggest,
  KgEntityType,
  KgTimelineDay,
  KgTimelineEvent,
  KgTimelineQuery,
  KgTimelineResult,
} from '../types/kg';

export const KG_API_BASE_URL = '/api/kg';

/** 常规请求超时（毫秒）：与 apiClient / searchService 底座保持一致 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 后端信封结构（与 apiClient.ApiEnvelope 同构；独立声明避免扩大耦合面） */
interface ApiEnvelopeShape<T> {
  code: number;
  message: string;
  data: T;
}

/** 携带 HTTP 状态的响应异常：非信封响应（代理报错页 / 网关 HTML）时使用 */
function httpStatusError(status: number): Error {
  const err = new Error('服务响应异常（HTTP ' + status + '），请稍后重试');
  (err as Error & { status?: number }).status = status;
  return err;
}

/**
 * 图谱服务统一请求入口（内部底座，镜像 searchService.searchRequest）：
 * - 返回原始信封（code/message/data），由各 API 函数自行分支处理；
 * - 401（信封 code 401 或非信封 HTTP 401）→ SessionExpiredError（调用方静默降级，不弹窗）；
 * - 非 JSON / 非信封响应 → 携带 HTTP 状态的 Error；
 * - 网络失败 / 超时 → Error（统一「网络异常」文案）。
 */
async function kgRequest<T>(
  path: string,
  options: { token?: string } = {},
): Promise<ApiEnvelopeShape<T>> {
  const { token } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(KG_API_BASE_URL + path, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：请求超时，请检查连接后重试');
    }
    throw new Error('网络异常：无法连接图谱服务，请检查网络后重试');
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

/** query string 拼接（跳过 null/undefined/空串；数字与字符串原样 encodeURIComponent） */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (v === undefined || v === null || v === '') continue;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

// ============================================================
// 防御性归一：线上脏数据（null 元素 / 字段缺省 / 类型漂移）不得流入状态机
// ============================================================

const ENTITY_TYPES: ReadonlyArray<KgEntityType> = [
  'STOCK', 'SUBJECT', 'ORG', 'PERSON', 'PLACE', 'POLICY', 'EVENT', 'OTHER',
];

/** 实体类型窄化：契约外值（后端升级新枚举）降级 OTHER 而非整行丢弃 */
function normalizeEntityType(v: unknown): KgEntityType {
  return ENTITY_TYPES.includes(v as KgEntityType) ? (v as KgEntityType) : 'OTHER';
}

/** 实体 chips 归一：缺 id/name 的脏行直接丢弃（chips 无法渲染也无法点击） */
function normalizeEntityRef(raw: unknown): KgEntityRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || typeof r.name !== 'string' || !r.name) return null;
  return {
    id: r.id,
    name: r.name,
    entityType: normalizeEntityType(r.entityType),
    anchorType: r.anchorType === 'STOCK' || r.anchorType === 'CLS_SUBJECT' ? r.anchorType : null,
  };
}

function normalizeEntityList(raw: unknown): KgEntityRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeEntityRef).filter((e): e is KgEntityRef => e !== null);
}

/** 实体建议/热榜/命中行归一：mentionCount 缺省按 0（排序权重失效但不炸渲染） */
function normalizeEntitySuggest(raw: unknown): KgEntitySuggest | null {
  const ref = normalizeEntityRef(raw);
  if (!ref) return null;
  const mentionCount = (raw as { mentionCount?: unknown }).mentionCount;
  return { ...ref, mentionCount: typeof mentionCount === 'number' ? mentionCount : 0 };
}

/** 时间轴事件归一：缺 id/title 的脏行丢弃；时间字段缺省兜底 null */
function normalizeEvent(raw: unknown): KgTimelineEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || typeof r.title !== 'string' || !r.title) return null;
  const eventDate = typeof r.eventDate === 'string' && r.eventDate ? r.eventDate : null;
  const eventTimeText = typeof r.eventTimeText === 'string' && r.eventTimeText ? r.eventTimeText : null;
  return {
    id: r.id,
    eventDate,
    eventTimeText,
    title: r.title,
    detail: typeof r.detail === 'string' && r.detail ? r.detail : null,
    eventType: typeof r.eventType === 'string' && r.eventType ? r.eventType : '其他',
    articleId: typeof r.articleId === 'number' ? r.articleId : 0,
    entities: normalizeEntityList(r.entities),
  };
}

/** 日组归一：无有效事件的日组丢弃（空日组无展示价值）；date 空串保留（弱一致场景前端防御展示） */
function normalizeDay(raw: unknown): KgTimelineDay | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const events = (Array.isArray(r.events) ? r.events : [])
    .map(normalizeEvent)
    .filter((e): e is KgTimelineEvent => e !== null);
  if (events.length === 0) return null;
  return {
    articleId: typeof r.articleId === 'number' ? r.articleId : 0,
    date: typeof r.date === 'string' ? r.date : '',
    articleTitle: typeof r.articleTitle === 'string' ? r.articleTitle : '',
    eventCount: typeof r.eventCount === 'number' ? r.eventCount : events.length,
    events,
  };
}

/** 时间轴响应整体归一（接口文档 §二）：matchedEntities 仅 keyword 态有值，缺省 [] */
function normalizeTimeline(data: unknown): KgTimelineResult {
  const empty: KgTimelineResult = {
    page: 0, pageSize: 0, totalDays: 0, hasMore: false, matchedEntities: [], days: [],
  };
  if (!data || typeof data !== 'object') return empty;
  const d = data as Record<string, unknown>;
  const matched = (Array.isArray(d.matchedEntities) ? d.matchedEntities : [])
    .map(normalizeEntitySuggest)
    .filter((e): e is KgEntitySuggest => e !== null);
  const days = (Array.isArray(d.days) ? d.days : [])
    .map(normalizeDay)
    .filter((day): day is KgTimelineDay => day !== null);
  return {
    page: typeof d.page === 'number' ? d.page : 0,
    pageSize: typeof d.pageSize === 'number' ? d.pageSize : 0,
    totalDays: typeof d.totalDays === 'number' ? d.totalDays : days.length,
    hasMore: d.hasMore === true,
    matchedEntities: matched,
    days,
  };
}

/** 实体详情摘要卡归一（接口文档 §五）：锚点键统一转字符串，数组缺省兜底空 */
function normalizeEntityDetail(data: unknown): KgEntityDetail {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const ref = normalizeEntityRef(d) ?? { id: 0, name: '', entityType: 'OTHER' as KgEntityType, anchorType: null };
  const anchorId = typeof d.anchorId === 'number' ? String(d.anchorId)
    : typeof d.anchorId === 'string' && d.anchorId ? d.anchorId : null;
  const related = (Array.isArray(d.relatedEntities) ? d.relatedEntities : [])
    .map((raw): (KgEntityRef & { coMentionCount: number }) | null => {
      const ref = normalizeEntityRef(raw);
      if (!ref) return null;
      const co = (raw as { coMentionCount?: unknown }).coMentionCount;
      return { ...ref, coMentionCount: typeof co === 'number' ? co : 0 };
    })
    .filter((e): e is KgEntityRef & { coMentionCount: number } => e !== null);
  const seen = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    id: ref.id,
    name: ref.name,
    entityType: ref.entityType,
    anchorType: ref.anchorType,
    anchorId,
    aliases: Array.isArray(d.aliases) ? d.aliases.filter((a): a is string => typeof a === 'string' && !!a) : [],
    mentionCount: typeof d.mentionCount === 'number' ? d.mentionCount : 0,
    eventCount: typeof d.eventCount === 'number' ? d.eventCount : 0,
    firstSeenAt: seen(d.firstSeenAt),
    lastSeenAt: seen(d.lastSeenAt),
    relatedEntities: related,
  };
}

// ============================================================
// 四端点（全部 GET + Bearer；信封 code ≠ 200 → AuthApiError，401 由底座抛）
// ============================================================

/**
 * 时间轴卡片流（GET /timeline，接口文档 §二）：默认浏览（无过滤参数）与搜索态共用。
 * entityId 语义提示：调用方传 entityId 时不应再传 keyword（互斥由后端定义，前端单选下发）。
 */
export async function fetchKgTimeline(
  token: string,
  query: KgTimelineQuery = {},
): Promise<KgTimelineResult> {
  const path = '/timeline' + buildQuery({
    keyword: query.keyword,
    entityId: query.entityId,
    page: query.page,
    pageSize: query.pageSize,
  });
  const envelope = await kgRequest<unknown>(path, { token });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  return normalizeTimeline(envelope.data);
}

/**
 * 实体检索建议（GET /entities/suggest，接口文档 §三）：实体名或别名命中，mentionCount 倒序。
 * 空白 keyword 直接短路返回空数组（不算请求；防抖与 ≥1 字符约束在调用方）。
 */
export async function fetchKgEntitySuggest(
  token: string,
  keyword: string,
  limit = 10,
): Promise<KgEntitySuggest[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const envelope = await kgRequest<unknown>(
    '/entities/suggest' + buildQuery({ keyword: kw, limit }),
    { token },
  );
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  return (Array.isArray(envelope.data) ? envelope.data : [])
    .map(normalizeEntitySuggest)
    .filter((e): e is KgEntitySuggest => e !== null);
}

/** 实体热榜（GET /entities/hot，接口文档 §四）：全局提及次数倒序；空态 chips 一次取数 */
export async function fetchKgHotEntities(token: string, limit = 20): Promise<KgEntitySuggest[]> {
  const envelope = await kgRequest<unknown>('/entities/hot' + buildQuery({ limit }), { token });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  return (Array.isArray(envelope.data) ? envelope.data : [])
    .map(normalizeEntitySuggest)
    .filter((e): e is KgEntitySuggest => e !== null);
}

/**
 * 实体详情摘要卡（GET /entities/{id}，接口文档 §五）。
 * 实体不存在 → 信封 code=404 → AuthApiError（调用方按「实体不存在」降级，关闭详情卡）。
 */
export async function fetchKgEntityDetail(token: string, id: number): Promise<KgEntityDetail> {
  const envelope = await kgRequest<unknown>('/entities/' + encodeURIComponent(String(id)), { token });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  return normalizeEntityDetail(envelope.data);
}
