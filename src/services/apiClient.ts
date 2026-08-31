/**
 * @file apiClient.ts
 * @description E2EE 用户服务（Spring Boot :18080/api/auth）HTTP 客户端底座：
 *              JSON 信封解析（恒 200 + code 分支）、Bearer 注入、超时控制、
 *              统一错误类型（AuthApiError / SessionExpiredError）。
 *              契约：《E2EE 用户服务 · 接口文档 v1.0》§1——HTTP 状态恒 200，
 *              唯一例外是未认证请求由拦截器直写 HTTP 401（信封 code 同为 401）。
 * @layer Service
 * @storage_impact 无持久化读写；令牌由调用方（authSession/authApi）传入。
 */

/** 后端信封结构 */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 业务错误（信封 code ≠ 200），message 为后端生成的用户可读中文文案 */
export class AuthApiError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'AuthApiError';
    this.code = code;
    this.data = data;
  }
}

/** 会话失效（code 401）：调用方必须转 SIGNED_OUT 本地清理，不得当作普通错误展示重试 */
export class SessionExpiredError extends AuthApiError {
  constructor(message = '会话已失效，请重新登录') {
    super(401, message);
    this.name = 'SessionExpiredError';
  }
}

/** 基地址：默认本地后端；Vercel 部署时以 VITE_AUTH_API_BASE_URL 覆盖 */
export const AUTH_API_BASE_URL: string =
  import.meta.env.VITE_AUTH_API_BASE_URL ?? 'http://localhost:18080/api/auth';

const REQUEST_TIMEOUT_MS = 15_000;

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`服务响应异常（HTTP ${response.status}），请稍后重试`);
  }
  const envelope = body as Partial<ApiEnvelope<T>> | null;
  if (!envelope || typeof envelope.code !== 'number') {
    throw new Error('服务响应格式异常，请稍后重试');
  }
  return envelope as ApiEnvelope<T>;
}

/**
 * 统一请求入口：
 * - 信封 code === 200 → 返回 data；
 * - code === 401（含 HTTP 401 拦截器直写）→ SessionExpiredError；
 * - 其他 code → AuthApiError（code/message/data 原样透出，409 必带 data.updatedAt）；
 * - 网络失败 / 超时 → 原生 Error（调用方按"网络异常"提示）。
 */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT';
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const { method = 'GET', body, token, headers } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${AUTH_API_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // AbortController 超时与网络故障统一按网络异常处理
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：请求超时，请检查连接后重试');
    }
    throw new Error('网络异常：无法连接认证服务，请检查网络后重试');
  }
  clearTimeout(timer);

  const envelope = await parseEnvelope<T>(response);
  if (envelope.code === 200) return envelope.data;
  if (envelope.code === 401) throw new SessionExpiredError(envelope.message);
  throw new AuthApiError(envelope.code, envelope.message, envelope.data);
}
