/**
 * @file serverSync.ts
 * @description 服务端密文同步（登录即备份）HTTP 客户端与推送编排底座：
 *              meta 对账 / 拉取密文 / CAS 上传三类端点封装、AES-GCM 信封 build/parse、
 *              SHA-256 校验和、设备本地 lastSeen 读写、防抖推送管线（镜像 webdavSync 模式）。
 *              管道纯净：mek/token 一律由调用方传参注入（禁 import store，R 层护栏）。
 *              契约：《服务端密文同步 · 开发实施文档 v1.2》§5.2——
 *              HTTP 恒 200 信封、成功 code===200（E5）、
 *              错误码 40001/40002/40003/40401/40901/40902/42901。
 * @layer Service
 * @storage_impact localStorage 键 'server_sync_meta_v1'：设备级 lastSeenCloudVersion / enabled。
 * @author 开发团队
 */

import { AuthApiError, SessionExpiredError } from './apiClient';
import type { AppStoreExport } from '../store/types';

export const SYNC_API_BASE_URL = '/api/sync';

/** 请求超时（毫秒）：与 apiClient 底座保持一致 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 强制最小推送间隔（毫秒）：10 秒冷却，从上次【成功】推送起算 */
const MIN_SYNC_INTERVAL = 10_000;

/** 默认防抖窗口（毫秒）：与 WebDAV 通道 scheduleBackup 一致 */
const DEFAULT_DEBOUNCE_MS = 800;

/** 设备本地同步元数据的 localStorage 键名 */
const DEVICE_META_STORAGE_KEY = 'server_sync_meta_v1';

// ============================================================
// 类型定义
// ============================================================

/** 云端备份元信息（GET meta 响应 data；40901/40902 冲突 data 同构） */
export interface ServerSyncMeta {
  hasData: boolean;
  version: number;
  updatedAt?: string;
  payloadHash?: string;
  payloadBytes?: number;
}

/** AES-GCM 密文信封（v1 格式冻结，spec §4.1；服务端只验结构不碰内容） */
export interface BackupEnvelopeV1 {
  v: 1;
  alg: 'A256GCM';
  /** base64 编码的 12 字节随机 IV */
  iv: string;
  /** base64 编码的密文 */
  ct: string;
}

export type ServerPushResult =
  | { ok: true; version: number; deduped: boolean }
  | {
      ok: false;
      reason: 'conflict' | 'empty-conflict' | 'rate' | 'invalid' | 'network';
      /** conflict / empty-conflict 时携带云端最新 meta（来自后端 data） */
      latest?: ServerSyncMeta;
      /** rate 时携带建议重试等待秒数（后端保证 ≥ 1） */
      retryAfterSeconds?: number;
      /** 失败文案（network 细分：HTTP 413 提示反代 client_max_body_size，E6） */
      message?: string;
    };

/** 设备本地同步元数据（localStorage 持久化，跨刷新保留） */
export interface ServerSyncDeviceMeta {
  /** 本设备最后确认的云端版本（推送/拉取成功后由 ioSlice 更新） */
  lastSeenCloudVersion: number;
  /** 服务端自动备份开关（默认开） */
  enabled: boolean;
}

// ============================================================
// 信封与校验和
// ============================================================

/** 组装 v1 信封（iv/ct 均为 base64 字符串） */
export function buildBackupEnvelope(iv: string, ct: string): BackupEnvelopeV1 {
  return { v: 1, alg: 'A256GCM', iv, ct };
}

/** 信封 → JSON 字符串（即 PUT 请求的 envelope 字段与 payloadHash/payloadBytes 的计算对象） */
export function envelopeToString(env: BackupEnvelopeV1): string {
  return JSON.stringify(env);
}

/**
 * 解析信封字符串并做结构校验（v===1 / alg==='A256GCM' / iv、ct 非空字符串）。
 * 结构非法（含 JSON 解析失败）一律返回 null，不抛错。
 */
export function parseBackupEnvelope(raw: string): BackupEnvelopeV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BackupEnvelopeV1> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== 1) return null;
    if (parsed.alg !== 'A256GCM') return null;
    if (typeof parsed.iv !== 'string' || parsed.iv.length === 0) return null;
    if (typeof parsed.ct !== 'string' || parsed.ct.length === 0) return null;
    return { v: 1, alg: 'A256GCM', iv: parsed.iv, ct: parsed.ct };
  } catch {
    return null;
  }
}

/** SHA-256 → 64 位小写 hex。服务端按 spec §4.2 原样存储比对（D7 去重），不重算。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================
// HTTP 底座（仿 apiClient：AbortController 超时 + Bearer 注入 + 信封解析）
// ============================================================

interface SyncRequestOptions {
  method?: 'GET' | 'PUT';
  body?: unknown;
  token?: string;
}

/** 携带 HTTP 状态的响应异常：pushBackup 依赖 status 单独识别 413（E6） */
function httpStatusError(status: number): Error {
  const message =
    status === 413
      ? '请求体积超过代理限制，请检查反代 client_max_body_size 配置（建议 2m）'
      : `服务响应异常（HTTP ${status}），请稍后重试`;
  const err = new Error(message);
  (err as Error & { status?: number }).status = status;
  return err;
}

/**
 * 同步服务统一请求入口（内部底座）：
 * - 返回原始信封（code/message/data），由各 API 函数自行分支处理；
 * - 401（信封 code 401 或非信封 HTTP 401 拦截器直写）→ SessionExpiredError；
 * - 非 JSON / 非信封响应 → 携带 HTTP 状态的 Error（pushBackup 捕获后归 network）；
 * - 网络失败 / 超时 → Error（同上归 network）。
 */
async function syncRequest<T>(path: string, options: SyncRequestOptions = {}): Promise<ApiEnvelopeShape<T>> {
  const { method = 'GET', body, token } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${SYNC_API_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：请求超时，请检查连接后重试');
    }
    throw new Error('网络异常：无法连接同步服务，请检查网络后重试');
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

/** 后端信封结构（与 apiClient.ApiEnvelope 同构；此处独立声明避免扩大耦合面） */
interface ApiEnvelopeShape<T> {
  code: number;
  message: string;
  data: T;
}

/** 宽松收窄 unknown → ServerSyncMeta（409 冲突 data / meta 响应共用） */
function normalizeMeta(data: unknown): ServerSyncMeta {
  const m = (data ?? {}) as Partial<ServerSyncMeta>;
  return {
    hasData: !!m.hasData,
    version: typeof m.version === 'number' ? m.version : 0,
    updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : undefined,
    payloadHash: typeof m.payloadHash === 'string' ? m.payloadHash : undefined,
    payloadBytes: typeof m.payloadBytes === 'number' ? m.payloadBytes : undefined,
  };
}

// ============================================================
// API 封装：meta / pull / push
// ============================================================

/**
 * 轻量对账（D13 轮询/启动检查的基础）：云端空时返回 { hasData:false, version:0 }（code 200，非错误）。
 * 业务错误（非 200）→ AuthApiError；401 → SessionExpiredError；网络失败 → Error。
 */
export async function fetchSyncMeta(token: string): Promise<ServerSyncMeta> {
  const envelope = await syncRequest<unknown>('/backup/meta', { token });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  return normalizeMeta(envelope.data);
}

/**
 * 拉取云端密文（原样透传，不解密）。云端无备份 → AuthApiError(40401)，调用方走首传分支。
 * 本地仅做形状校验（envelope 必须为非空字符串）；信封结构校验由 parseBackupEnvelope 承担。
 */
export async function pullBackupEnvelope(token: string): Promise<{ version: number; envelope: string }> {
  const envelope = await syncRequest<{ version?: unknown; envelope?: unknown }>('/backup', { token });
  if (envelope.code !== 200) throw new AuthApiError(envelope.code, envelope.message, envelope.data);
  const data = envelope.data ?? {};
  const version = typeof data.version === 'number' ? data.version : 0;
  const raw = typeof data.envelope === 'string' ? data.envelope : '';
  if (!raw) throw new Error('云端备份响应格式异常：缺少密文信封');
  return { version, envelope: raw };
}

/** PUT 响应 data 形状 */
interface SyncPushResponseData {
  version?: unknown;
  deduped?: unknown;
}

/** 42901 data：{ retryAfterSeconds }；后端保证剩余毫秒向上取整、最小 1，此处防御性兑底 */
function readRetryAfterSeconds(data: unknown): number {
  if (data && typeof data === 'object') {
    const r = (data as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof r === 'number' && Number.isFinite(r) && r >= 1) return Math.ceil(r);
  }
  return 1;
}

/**
 * CAS 上传（唯一不抛业务错的 API：全部映射为 ServerPushResult；仅 401 透传 SessionExpiredError）。
 * 映射（spec §6.3 + E5/E6）：
 * - 200 → ok（deduped 取响应）；40901 → conflict（latest）；40902 → empty-conflict（latest）；
 * - 42901 → rate（retryAfterSeconds）；40001/40002/40003 → invalid；
 * - fetch 失败 / 超时 / 非信封响应 / 未识别 code → network（HTTP 413 归 network 并带反代配置文案）。
 * payloadHash = SHA-256(信封 JSON 字符串)、payloadBytes = 其 UTF-8 字节数（spec §4.2，客户端计算）。
 */
export async function pushBackup(
  token: string,
  baseVersion: number,
  env: BackupEnvelopeV1,
): Promise<ServerPushResult> {
  const raw = envelopeToString(env);
  const payloadHash = await sha256Hex(raw);
  const payloadBytes = new TextEncoder().encode(raw).length;

  try {
    const envelope = await syncRequest<SyncPushResponseData>('/backup', {
      method: 'PUT',
      body: { baseVersion, envelope: raw, payloadHash, payloadBytes },
      token,
    });

    if (envelope.code === 200) {
      const data = envelope.data ?? {};
      return {
        ok: true,
        version: typeof data.version === 'number' ? data.version : baseVersion,
        deduped: data.deduped === true,
      };
    }
    switch (envelope.code) {
      case 40901:
        return { ok: false, reason: 'conflict', latest: normalizeMeta(envelope.data) };
      case 40902:
        return { ok: false, reason: 'empty-conflict', latest: normalizeMeta(envelope.data) };
      case 42901:
        return { ok: false, reason: 'rate', retryAfterSeconds: readRetryAfterSeconds(envelope.data) };
      case 40001:
      case 40002:
      case 40003:
        return { ok: false, reason: 'invalid', message: envelope.message };
      default:
        // 未识别的业务码（如 5xx 信封）：按暂态网络问题处理，静默退避
        return { ok: false, reason: 'network', message: envelope.message };
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) throw e;
    return {
      ok: false,
      reason: 'network',
      message: e instanceof Error ? e.message : '网络异常：同步服务暂时不可用',
    };
  }
}

// ============================================================
// 设备本地账本（localStorage，独立键名，不触发 Store 响应）
// ============================================================

const DEFAULT_DEVICE_META: ServerSyncDeviceMeta = { lastSeenCloudVersion: 0, enabled: true };

/** 读取设备同步元数据；缺失/损坏/字段非法时回退默认值 {lastSeenCloudVersion:0, enabled:true} */
export function readServerSyncMeta(): ServerSyncDeviceMeta {
  try {
    const raw = localStorage.getItem(DEVICE_META_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DEVICE_META };
    const parsed = JSON.parse(raw) as Partial<ServerSyncDeviceMeta> | null;
    return {
      lastSeenCloudVersion:
        typeof parsed?.lastSeenCloudVersion === 'number' ? parsed.lastSeenCloudVersion : 0,
      enabled: parsed?.enabled !== false,
    };
  } catch {
    return { ...DEFAULT_DEVICE_META };
  }
}

/** 合并写入设备同步元数据（patch 语义，仅覆盖给出的字段） */
export function writeServerSyncMeta(patch: Partial<ServerSyncDeviceMeta>): void {
  const next = { ...readServerSyncMeta(), ...patch };
  try {
    localStorage.setItem(DEVICE_META_STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.error('[ServerSync] 写入设备同步元数据失败:', e);
  }
}

/**
 * 空快照守卫（D9 工具函数，M3 ioSlice.pushServerSnapshot 使用）：
 * 四类核心数据全空视为空快照（plannedOrders 不参与判定）。
 */
export function isEmptySnapshot(data: AppStoreExport): boolean {
  return (
    (!data.tRounds || data.tRounds.length === 0) &&
    (!data.positions || data.positions.length === 0) &&
    (!data.stocks || data.stocks.length === 0) &&
    (!data.longTermRecords || data.longTermRecords.length === 0)
  );
}

// ============================================================
// 防抖推送管线（镜像 webdavSync.scheduleBackup + 四重锁模式）
// ============================================================

export interface ServerSyncGate {
  /** 门控：已登录 && MEK 可用 && readServerSyncMeta().enabled（ioSlice 提供） */
  canPush(): boolean;
  /** 实际推送动作：ioSlice.pushServerSnapshot（含空快照守卫 D9、409 合并重推、E9 等待） */
  doPush(): Promise<void>;
}

/** 防抖窗口内暂存的最新快照（仅签名对齐；真正的序列化在 gate.doPush 内部完成） */
let pendingServerSnapshot: unknown = null;

/** 防抖定时器句柄（window/globalThis 双环境兼容） */
let serverBackupTimer: number | null = null;

/** Promise 互斥锁：同一时刻最多 1 条推送管线在执行，绝不并发 */
let serverPushInFlight = false;

/** 上次【成功】推送的时间戳（冷却起点；doPush 抛错不更新） */
let lastServerPushSuccessTime = 0;

/**
 * 跨标签页写锁（仅 HTTPS 安全上下文可用）：同名锁全局串行，
 * 等待其他标签页推送完成后再执行。不支持 Web Locks 的环境回退直接执行，
 * 由模块级 serverPushInFlight 互斥兑底。
 */
async function withCrossTabPushLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined') {
    const nav = navigator as Navigator & {
      locks?: { request: (name: string, callback: () => Promise<T>) => Promise<T> };
    };
    if (nav.locks) {
      return nav.locks.request('stock-calculator-server-sync-push', fn);
    }
  }
  return fn();
}

/**
 * 推送管线：门控 → 10s 冷却 → Promise 互斥 → Web Locks → doPush（文档 §5.2 锁内顺序）。
 * 锁内复检门控与冷却：等待跨标签页锁期间，其他标签页可能刚完成推送。
 * doPush 抛错仅记日志、不更新冷却起点（失败后下次调度可立即重试）。
 */
async function runServerBackupPipeline(gate: ServerSyncGate): Promise<void> {
  if (!gate.canPush()) return;
  if (Date.now() - lastServerPushSuccessTime < MIN_SYNC_INTERVAL) return;
  if (serverPushInFlight) return;

  serverPushInFlight = true;
  try {
    await withCrossTabPushLock(async () => {
      if (!gate.canPush()) return;
      if (Date.now() - lastServerPushSuccessTime < MIN_SYNC_INTERVAL) return;
      await gate.doPush();
      lastServerPushSuccessTime = Date.now();
    });
  } catch (e) {
    console.error('[ServerSync] 自动推送失败:', e);
  } finally {
    serverPushInFlight = false;
  }
}

/**
 * 单例防抖入口：initAutoSync 在数据变更时调用（双通道之一）。
 * 防抖窗口内连续调用合并为最后一次 payload，仅触发一次管线；
 * 由 10s 冷却 + Promise 互斥 + 跨标签页写锁兜底，绝不产生并发 PUT。
 *
 * @param snapshot - 待备份快照（仅签名对齐 scheduleBackup；空快照守卫 D9 在 gate.doPush 内实现）
 * @param gate - 门控与推送动作（ioSlice 提供）
 * @param delayMs - 防抖窗口（毫秒，默认 800）
 */
export function scheduleServerBackup(
  snapshot: unknown,
  gate: ServerSyncGate,
  delayMs: number = DEFAULT_DEBOUNCE_MS,
): void {
  pendingServerSnapshot = snapshot;
  if (serverBackupTimer !== null) {
    clearTimeout(serverBackupTimer);
    serverBackupTimer = null;
  }
  const timer: (cb: () => void, ms: number) => unknown =
    typeof window !== 'undefined'
      ? (window.setTimeout as (cb: () => void, ms: number) => unknown)
      : (globalThis.setTimeout as (cb: () => void, ms: number) => unknown);
  serverBackupTimer = timer(() => {
    serverBackupTimer = null;
    pendingServerSnapshot = null;
    void runServerBackupPipeline(gate);
  }, delayMs) as number;
}

/** 取消挂起中的防抖推送（登出/导入恢复等场景使用） */
export function cancelServerBackup(): void {
  if (serverBackupTimer !== null) {
    clearTimeout(serverBackupTimer);
    serverBackupTimer = null;
  }
  pendingServerSnapshot = null;
}

/**
 * 测试专用：重置模块级防抖/互斥/冷却状态（不应在生产调用）。
 */
export function __resetServerSync(): void {
  cancelServerBackup();
  serverPushInFlight = false;
  lastServerPushSuccessTime = 0;
}
