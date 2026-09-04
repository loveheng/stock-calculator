/**
 * @file copilotService.ts
 * @description Context-Aware Copilot API 封装（P0）：基于恒 200 信封（code/subCode/message/data）
 *              的 HTTP 客户端，Bearer 自动注入、60s 超时（LLM 编排耗时长，D13）、
 *              错误规范化（CopilotApiError + subCode 枚举）、本地 Mock 桩（VITE_COPILOT_MOCK=1）、
 *              localStorage 辅助（离线删除墓碑 / 首次使用知情同意）。
 *              传输/存储分离（D28）：contextSummary 明细 ephemeral 阅后即焚；
 *              contextOverview（≤255 字符标量概览）与 timeAnchor 才落库。
 * @layer Service
 * @storage_impact localStorage：stockcalc.copilot.tombstones.v1（墓碑）、
 *                 stockcalc.copilot.consent.v1（知情同意）；不读写 Dexie。
 * @author 开发团队
 */

import type { ApiEnvelope } from './apiClient';
import { AuthApiError } from './apiClient';
import { loadStoredAuthSession } from './authSession';
import { ulid } from 'ulid';
import type { CopilotAction, CopilotAskRequest, CopilotAskResponse, CopilotContextData, CopilotThreadPage } from '../types/domain';
import { applySizeGuard, COPILOT_MAX_BYTES } from '../utils/copilotSnapshots';

/** Copilot 服务基地址：默认同源相对路径，走 vite 代理 / 线上 Edge Middleware */
const COPILOT_API_BASE_URL: string = import.meta.env.VITE_COPILOT_API_BASE_URL ?? '/api/copilot';

/** 60s 超时（D13）：LLM 多渠道容灾编排 + 流式外呼耗时远超普通接口的 15s */
const REQUEST_TIMEOUT_MS = 60_000;

/** Mock 桩开关：VITE_COPILOT_MOCK=1 时全链路本地模拟，不发起真实请求 */
export const COPILOT_MOCK = import.meta.env.VITE_COPILOT_MOCK === '1';

// ──────────────────────────────────────────────
// 错误规范化（恒 200 信封 + subCode 枚举，P2 #15）
// ──────────────────────────────────────────────

/** 标准化错误子码（与 /api/auth 底座信封对齐，业务异常全走信封字段） */
export type CopilotErrorSubCode =
  | 'CONTEXT_TOO_LARGE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'UPSTREAM_ERROR'
  | 'SESSION_NOT_FOUND'
  | 'UNAUTHENTICATED';

/** subCode → 用户可读提示与可否重发（交互指引闭环，impl §9.6） */
const SUB_CODE_FEEDBACK: Record<CopilotErrorSubCode, { code: number; hint: string; retryable: boolean }> = {
  CONTEXT_TOO_LARGE: { code: 413, hint: '当前数据量较大，请缩小时间筛选范围后再试', retryable: false },
  RATE_LIMIT_EXCEEDED: { code: 429, hint: '今日 AI 调用已达上限，明日再试', retryable: false },
  UPSTREAM_ERROR: { code: 503, hint: 'AI 服务暂不可用，请稍后重试', retryable: true },
  SESSION_NOT_FOUND: { code: 404, hint: '会话已清理，请重新提问', retryable: true },
  UNAUTHENTICATED: { code: 401, hint: '请先登录后再使用 AI 助手', retryable: false },
};

/** 无 subCode 时按信封 code 兜底映射 */
const CODE_FALLBACK: Record<number, CopilotErrorSubCode> = {
  429: 'RATE_LIMIT_EXCEEDED',
  413: 'CONTEXT_TOO_LARGE',
  404: 'SESSION_NOT_FOUND',
};

/** Copilot 统一错误：message 供 Toast/日志，hint 供失败气泡展示，retryable 决定是否出「重发」按钮 */
export class CopilotApiError extends Error {
  readonly code: number;
  readonly subCode: CopilotErrorSubCode;
  readonly hint: string;
  readonly retryable: boolean;

  constructor(code: number, subCode: CopilotErrorSubCode, message: string) {
    super(message);
    this.name = 'CopilotApiError';
    this.code = code;
    this.subCode = subCode;
    const feedback = SUB_CODE_FEEDBACK[subCode];
    this.hint = feedback.hint || message;
    this.retryable = feedback.retryable;
  }
}

/** 任意异常 → CopilotApiError（未知错误一律按 UPSTREAM_ERROR 可重发处理） */
export function toCopilotError(e: unknown): CopilotApiError {
  if (e instanceof CopilotApiError) return e;
  if (e instanceof AuthApiError) {
    if (e.code === 401) {
      return new CopilotApiError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录');
    }
    const subCode = CODE_FALLBACK[e.code] ?? 'UPSTREAM_ERROR';
    return new CopilotApiError(e.code, subCode, e.message || SUB_CODE_FEEDBACK[subCode].hint);
  }
  return new CopilotApiError(
    503,
    'UPSTREAM_ERROR',
    e instanceof Error ? e.message : 'AI 服务暂不可用，请稍后重试',
  );
}

// ──────────────────────────────────────────────
// 请求底座（信封解析模式复用 apiClient，超时/基地址独立）
// ──────────────────────────────────────────────

/** 恒 200 信封解析（copilotRequest 与流式回落路径共用）：业务异常全走 code/subCode 字段 */
async function parseEnvelopeResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`服务响应异常（HTTP ${response.status}），请稍后重试`);
  }
  const envelope = body as (Partial<ApiEnvelope<T>> & { subCode?: string }) | null;
  if (!envelope || typeof envelope.code !== 'number') {
    throw new Error('服务响应格式异常，请稍后重试');
  }
  if (envelope.code === 200) return envelope.data as T;
  if (envelope.code === 401) {
    throw new CopilotApiError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录');
  }
  const subCode = (
    SUB_CODE_FEEDBACK[envelope.subCode as CopilotErrorSubCode]
      ? (envelope.subCode as CopilotErrorSubCode)
      : CODE_FALLBACK[envelope.code] ?? 'UPSTREAM_ERROR'
  );
  throw new CopilotApiError(envelope.code, subCode, envelope.message || SUB_CODE_FEEDBACK[subCode].hint);
}

async function copilotRequest<T>(
  path: string,
  options: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  const token = loadStoredAuthSession()?.token;
  if (!token) throw new CopilotApiError(401, 'UNAUTHENTICATED', '请先登录后再使用 AI 助手');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${COPILOT_API_BASE_URL}${path}`, {
      method: options.method,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：请求超时，请检查连接后重试');
    }
    throw new Error('网络异常：无法连接 AI 服务，请检查网络后重试');
  }
  clearTimeout(timer);

  return parseEnvelopeResponse<T>(response);
}

// ──────────────────────────────────────────────
// 契约组装（D28：护栏调用点 + 概览压缩）
// ──────────────────────────────────────────────

/** 概览 JSON 压缩：≤255 字符（DB 列宽 VARCHAR(255)，保头删尾） */
export function compactOverviewJson(overview: Record<string, string | number | boolean>): string {
  const json = JSON.stringify(overview);
  return json.length <= 255 ? json : json.slice(0, 255);
}

/** 幂等键：ULID（提问生成新键；重发沿用同键，由 slice 负责取旧值） */
export function newClientMessageId(): string {
  return ulid();
}

/** 组装提问请求：ephemeral 明细过 applySizeGuard 护栏（D5④），标量概览/时间锚点落库字段 */
export function buildAskRequest(
  sessionTitle: string,
  question: string,
  clientMessageId: string,
  data: CopilotContextData,
  focusBlockId?: string,
): CopilotAskRequest {
  const guarded = applySizeGuard(data, COPILOT_MAX_BYTES);
  return {
    question,
    sessionTitle,
    clientMessageId,
    // 后端 AskRequest.contextSummary 为 String：线格式 = JSON 字符串（ephemeral，不落库）
    contextSummary: JSON.stringify(guarded),
    contextOverview: compactOverviewJson(data.overview),
    timeAnchor: JSON.stringify(data.timeAnchor),
    // V2 Click-to-Focus：区块级 Prompt 路由（缺省 = 整页策略）；
    // Spring Boot 默认忽略未知字段，后端未升级前向后兼容
    ...(focusBlockId ? { focusBlockId } : {}),
  };
}

// ──────────────────────────────────────────────
// 三个基础方法（Mock 桩见文件尾）
// ──────────────────────────────────────────────

/** 提问：POST /threads/{scopeId}/messages（幂等键 clientMessageId） */
export async function sendQuestion(scopeId: string, request: CopilotAskRequest): Promise<CopilotAskResponse> {
  if (COPILOT_MOCK) return mockSendQuestion(request);
  return copilotRequest<CopilotAskResponse>(`/threads/${encodeURIComponent(scopeId)}/messages`, {
    method: 'POST',
    body: request,
  });
}

// ──────────────────────────────────────────────
// 流式提问（SSE 内容协商，向后兼容）
// 线契约（与后端 /threads/{scopeId}/messages 对齐）：
//   请求：同 POST 报文 + Accept: text/event-stream；后端阶段一校验失败时仍回
//         application/json 恒 200 信封（前端自动回落解析，旧行为不变）。
//   响应（event-stream）：
//     event: delta  data: {"text":"增量token"}
//     event: done   data: {…CopilotAskResponse}（content=权威全文，自愈丢块；可含 actions）
//     event: error  data: {"code":503,"subCode":"UPSTREAM_ERROR","message":"…"}
//     ":" 开头注释行 = 心跳，解析器忽略
// ──────────────────────────────────────────────

/** 空闲超时：TTFB（阶段一事务 + LLM 首 token）与块间隔共用，每收到字节重置。
 *  服务端 LLM callTimeout 60s，前端放宽到 90s 防竞态误杀 */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

/** SSE 事件块解析（纯函数，供单测）：事件间以空行分隔，event:/data: 行组成 */
export function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue; // 空行 / 心跳注释
    if (rawLine.startsWith('event:')) event = rawLine.slice(6).trim();
    else if (rawLine.startsWith('data:')) dataLines.push(rawLine.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** SSE 事件消费循环：delta 逐段回调，done 返回权威应答，error 抛规范化业务异常 */
async function consumeAskStream(
  response: Response,
  onDelta: (text: string) => void,
  armIdle: () => void,
): Promise<CopilotAskResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('服务响应异常（无响应体），请稍后重试');
  const decoder = new TextDecoder();
  let buffer = '';
  let settled: CopilotAskResponse | null = null;

  const handleBlock = (block: string): void => {
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    if (parsed.event === 'delta') {
      const payload = JSON.parse(parsed.data) as { text?: string };
      if (typeof payload.text === 'string' && payload.text.length > 0) onDelta(payload.text);
      return;
    }
    if (parsed.event === 'done') {
      settled = JSON.parse(parsed.data) as CopilotAskResponse;
      return;
    }
    if (parsed.event === 'error') {
      const payload = JSON.parse(parsed.data) as { code?: number; subCode?: string; message?: string };
      const subCode: CopilotErrorSubCode =
        payload.subCode && SUB_CODE_FEEDBACK[payload.subCode as CopilotErrorSubCode]
          ? (payload.subCode as CopilotErrorSubCode)
          : 'UPSTREAM_ERROR';
      throw new CopilotApiError(payload.code ?? 503, subCode, payload.message || SUB_CODE_FEEDBACK[subCode].hint);
    }
    // 未知事件忽略（向前兼容）
  };

  try {
    for (;;) {
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
    if (buffer.trim()) handleBlock(buffer); // 容错：流结束仍有未终止的最后一块
  } catch (e) {
    void reader.cancel().catch(() => {}); // 中途异常释放连接
    throw e;
  }
  if (!settled) throw new Error('AI 响应流异常中断，请重试');
  return settled;
}

/**
 * 流式提问：同一提问端点，Accept: text/event-stream 内容协商。
 * - 新后端回 event-stream：delta 逐段回调 onDelta（聊天框增量渲染），done 返回权威
 *   CopilotAskResponse（与 sendQuestion 同形，含 actions）；
 * - 旧后端回 JSON 信封：自动回落 parseEnvelopeResponse（不回调 onDelta，行为与
 *   sendQuestion 完全一致），前端可先于后端上线。
 */
export async function streamQuestion(
  scopeId: string,
  request: CopilotAskRequest,
  onDelta: (text: string) => void,
): Promise<CopilotAskResponse> {
  if (COPILOT_MOCK) return mockStreamQuestion(request, onDelta);

  const token = loadStoredAuthSession()?.token;
  if (!token) throw new CopilotApiError(401, 'UNAUTHENTICATED', '请先登录后再使用 AI 助手');

  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
  };
  armIdle();

  let response: Response;
  try {
    response = await fetch(`${COPILOT_API_BASE_URL}/threads/${encodeURIComponent(scopeId)}/messages`, {
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
    if (idleTimer) clearTimeout(idleTimer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：请求超时，请检查连接后重试');
    }
    throw new Error('网络异常：无法连接 AI 服务，请检查网络后重试');
  }

  // 内容协商回落：非 event-stream = 旧后端 JSON 信封（或网关错误页），走既有解析
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    if (idleTimer) clearTimeout(idleTimer);
    return parseEnvelopeResponse<CopilotAskResponse>(response);
  }

  try {
    return await consumeAskStream(response, onDelta, armIdle);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：AI 响应流超时中断，请重试');
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

/** 历史分页：GET /threads/{scopeId}/messages?before=&limit=20（keyset 倒序取出正序返回） */
export async function fetchMessages(scopeId: string, before?: number): Promise<CopilotThreadPage> {
  if (COPILOT_MOCK) return mockFetchMessages(scopeId);
  const query = before != null ? `?before=${before}&limit=20` : '?limit=20';
  return copilotRequest<CopilotThreadPage>(`/threads/${encodeURIComponent(scopeId)}/messages${query}`);
}

/** 会话清理（软删除 + 级联）：DELETE /threads/{scopeId} */
export async function clearThread(scopeId: string): Promise<void> {
  if (COPILOT_MOCK) return;
  await copilotRequest<null>(`/threads/${encodeURIComponent(scopeId)}`, { method: 'DELETE' });
}

// ──────────────────────────────────────────────
// localStorage 辅助：墓碑（离线级联删除对账，P2 #13）+ 知情同意
// ──────────────────────────────────────────────

const TOMBSTONE_KEY = 'stockcalc.copilot.tombstones.v1';
const CONSENT_KEY = 'stockcalc.copilot.consent.v1';

/** 读取墓碑集合（node 环境/隐私模式下 localStorage 不可用时安全降级为空） */
export function loadCopilotTombstones(): string[] {
  try {
    const raw = localStorage.getItem(TOMBSTONE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveCopilotTombstones(scopes: string[]): void {
  try {
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(scopes));
  } catch {
    // 存储不可用时静默：墓碑仅影响离线对账体验
  }
}

export function loadCopilotConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveCopilotConsent(acknowledged: boolean): void {
  try {
    localStorage.setItem(CONSENT_KEY, acknowledged ? '1' : '0');
  } catch {
    // 静默
  }
}

// ──────────────────────────────────────────────
// Mock 桩（VITE_COPILOT_MOCK=1）：延迟 600ms，回显字段返回假应答
// ──────────────────────────────────────────────

const MOCK_DELAY_MS = 600;
let mockIdSeq = 900_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mockSendQuestion(request: CopilotAskRequest): Promise<CopilotAskResponse> {
  await sleep(MOCK_DELAY_MS);
  mockIdSeq += 1;
  // 动作后处理演示（V1 Action Pipeline）：提问含关键词时附带 actions，
  // 前端管线将白名单校验后自动执行 notify 弹窗 / focus_block 聚焦 / apply_filter 筛选
  const actions: CopilotAction[] = [];
  if (request.question.includes('提醒')) {
    actions.push({
      type: 'notify',
      payload: { title: 'Mock 风控提醒', message: '这是 mock 桩的 notify 动作演示：检测到倒T待回补风险敞口。', severity: 'warning' },
    });
  }
  if (request.question.includes('聚焦')) {
    actions.push({ type: 'focus_block', payload: { scopeId: 'home', blockId: 'home:short_term' } });
  }
  if (request.question.includes('切到30天')) {
    actions.push({ type: 'apply_filter', payload: { filter: 'homeTimeRange', value: '30d' } });
  }
  return {
    assistantMessageId: mockIdSeq,
    content:
      `【Mock 应答】已收到你在「${request.sessionTitle}」的提问：\n${request.question}\n\n` +
      `上下文概览：${request.contextOverview}\n时间锚点：${request.timeAnchor}\n` +
      `（VITE_COPILOT_MOCK=1 本地桩，未调用真实 LLM）`,
    promptTokens: 0,
    completionTokens: 0,
    channel: 'mock',
    userMessageId: mockIdSeq,
    ctime: Math.floor(Date.now() / 1000),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

/** Mock 流式：复用 mockSendQuestion 桩（含 actions 演示），按片延迟前送模拟 token 流 */
async function mockStreamQuestion(
  request: CopilotAskRequest,
  onDelta: (text: string) => void,
): Promise<CopilotAskResponse> {
  const resp = await mockSendQuestion(request);
  for (let i = 0; i < resp.content.length; i += 6) {
    await sleep(40);
    onDelta(resp.content.slice(i, i + 6));
  }
  return resp;
}

async function mockFetchMessages(scopeId: string): Promise<CopilotThreadPage> {
  await sleep(200);
  // Mock 无持久化：返回空页，会话内容仅存内存（刷新即清空）
  return { sessionId: 0, scopeId, title: scopeId, messages: [], hasMore: false, oldestId: 0 };
}
