/**
 * @file announcementService.ts
 * @description 公告订阅 HTTP 客户端（Spring Boot :18080 /api/announcement，与 E2EE 认证服务同源）：
 *              订阅列表查询 / 订阅 / 取消订阅三类端点封装 + 统一 ApiResponse 信封解析。
 *              管道纯净：token 一律由调用方传参注入（禁 import store，R 层护栏）。
 *              契约：响应统一 ApiResponse 信封（code/message/data），成功 code===200；
 *              业务错误（stockId 非法 / 订阅数量已达上限）以 BusinessException 信封返回，
 *              message 为用户可读中文文案，调用方直接透出展示。
 * @layer Service
 * @storage_impact 无持久化读写；订阅关系以服务端为准，本地仅镜像（见 announcementSlice）。
 * @author 开发团队
 */

import { AuthApiError, SessionExpiredError } from './apiClient';

export const ANNOUNCEMENT_API_BASE_URL = '/api/announcement';

/** 请求超时（毫秒）：与 apiClient / serverSync 底座保持一致 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 后端信封结构（与 apiClient.ApiEnvelope 同构；独立声明避免扩大耦合面） */
interface ApiEnvelopeShape<T> {
  code: number;
  message: string;
  data: T;
}

interface AnnouncementRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
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
 * 公告服务统一请求入口（内部底座，镜像 serverSync.syncRequest）：
 * - 返回原始信封（code/message/data），由各 API 函数自行分支处理；
 * - 401（信封 code 401 或非信封 HTTP 401 拦截器直写）→ SessionExpiredError；
 * - 非 JSON / 非信封响应 → 携带 HTTP 状态的 Error；
 * - 网络失败 / 超时 → Error（统一「网络异常」文案）。
 */
async function announcementRequest<T>(
  path: string,
  options: AnnouncementRequestOptions = {},
): Promise<ApiEnvelopeShape<T>> {
  const { method = 'GET', body, token } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(ANNOUNCEMENT_API_BASE_URL + path, {
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
    throw new Error('网络异常：无法连接公告服务，请检查网络后重试');
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

// ============================================================
// API 封装：订阅列表 / 订阅 / 取消订阅
// ============================================================

/** fetchSubscriptions 解析结果：recognized=false 表示 data 不是任何已知形状（调用方保留重试机会，不得置「已加载」） */
export interface SubscriptionsParseResult {
  /** 归一化前的原始股票码列表（形状可识别时；可能为空数组 = 服务端确实无订阅） */
  stockIds: string[];
  /** 形状是否可识别 */
  recognized: boolean;
}

/**
 * 查询当前用户的公告订阅列表（GET /subscriptions）。
 * 兼容三种 data 形状（后端实际返回 { items: [{ stockId, orgId, createdAt }] }）：
 * 1. string[]；2. { stockId: string }[]；3. { items: [...] }（上述任一数组包一层 items）。
 * 形状可识别时 recognized=true（空 items = 服务端确实无订阅）；
 * 形状不可识别（null / 结构不符）时 recognized=false，调用方不得置「已加载」，保留下次挂载重试机会。
 * 业务错误（非 200）→ AuthApiError；401 → SessionExpiredError；网络失败 → Error。
 */
export async function fetchSubscriptions(token: string): Promise<SubscriptionsParseResult> {
  const envelope = await announcementRequest<unknown>('/subscriptions', { token });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  let raw: unknown[];
  if (Array.isArray(envelope.data)) {
    raw = envelope.data;
  } else if (
    envelope.data !== null &&
    typeof envelope.data === 'object' &&
    Array.isArray((envelope.data as { items?: unknown }).items)
  ) {
    raw = (envelope.data as { items: unknown[] }).items;
  } else {
    return { stockIds: [], recognized: false };
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      ids.push(item);
    } else if (item && typeof item === 'object') {
      const sid = (item as { stockId?: unknown }).stockId;
      if (typeof sid === 'string') ids.push(sid);
    }
  }
  return { stockIds: ids, recognized: true };
}

/**
 * 订阅公告摘要（POST /subscriptions，body { stockId }）。
 * 首次订阅某标的会触发后端异步 CNINFO 全量首拉（2023 至今，数分钟内渐进入库），
 * 前端无需等待抓取完成，提示文案由 UI 层承担。
 * 业务错误（stockId 非法 / 订阅数量已达上限）→ AuthApiError（message 用户可读）。
 */
export async function subscribeStock(token: string, stockId: string): Promise<void> {
  const envelope = await announcementRequest<unknown>('/subscriptions', {
    method: 'POST',
    body: { stockId },
    token,
  });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
}

/** 取消订阅公告摘要（DELETE /subscriptions/{stockId}）。业务错误 → AuthApiError */
export async function unsubscribeStock(token: string, stockId: string): Promise<void> {
  const envelope = await announcementRequest<unknown>('/subscriptions/' + stockId, {
    method: 'DELETE',
    token,
  });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
}
