/**
 * @file customStatsSyncService.ts
 * @description 自定义统计定义的服务端同步通道（HTTP 客户端）：登录用户把本地认可的
 *              统计定义（含代码、提示词、缓存结果）备份到服务端数据库，跨设备恢复。
 *              与 serverSync（E2EE 核心数据快照通道）的关键差异：
 *              - 自定义统计不是用户核心数据（不含账本流水），明文 JSONB 直存服务端；
 *              - 只需 Bearer token，无需 MEK，登录即可用；
 *              - 粒度为单条定义 upsert/delete，非全量快照，无 CAS 版本冲突。
 *              合并语义（编排在本文件对应的 store 切片）：按 updatedAt LWW，
 *              删除优先（本地墓碑覆盖远端较新版本）。
 * @layer Service
 * @storage_impact 无本地持久化读写；仅与服务端 /api/custom-stats 交换 JSON。
 * @author 开发团队
 */

import type { CustomStatDefinition } from '../types/domain';

export const CUSTOM_STATS_API_BASE_URL = '/api/custom-stats';

/** 请求超时（毫秒）：与 serverSync 底座保持一致 */
const REQUEST_TIMEOUT_MS = 15_000;

interface ApiEnvelopeShape<T> {
  code: number;
  message: string;
  data: T;
}

type StatSyncMethod = 'GET' | 'PUT' | 'DELETE';

interface StatSyncRequestOptions {
  method: StatSyncMethod;
  body?: unknown;
  token: string;
}

/** 统一请求底座（仿 serverSync.syncRequest：AbortController 超时 + Bearer 注入 + ApiResponse 信封） */
async function statSyncRequest<T>(path: string, options: StatSyncRequestOptions): Promise<ApiEnvelopeShape<T>> {
  const { method, body, token } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${CUSTOM_STATS_API_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`自定义统计同步失败（HTTP ${response.status}），请稍后重试`);
    }
    return (await response.json()) as ApiEnvelopeShape<T>;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 服务端定义收窄（防御性：服务端返回的条目逐字段校验，非法条目跳过不崩）
// ============================================================

/** GET 响应 data 形状：{ list: DefDto[] } */
interface ServerListData {
  list?: unknown;
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asOptionalBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asOptionalFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * unknown → CustomStatDefinition。id/code/kind/schemaVersion/updatedAt 为合并必需键，
 * 缺失或 updatedAt 不可解析即返回 null（调用方跳过该条，绝不让脏数据进画廊）。
 */
function normalizeServerDef(raw: unknown): CustomStatDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const id = asOptionalString(d.id);
  const code = asOptionalString(d.code);
  const kind = d.kind === 'card' || d.kind === 'chart' ? d.kind : null;
  const updatedAt = asOptionalString(d.updatedAt);
  if (!id || !code || !kind || !updatedAt || Number.isNaN(Date.parse(updatedAt))) return null;
  if (typeof d.schemaVersion !== 'number' || !Number.isFinite(d.schemaVersion)) return null;
  return {
    id,
    name: asOptionalString(d.name) ?? '',
    description: asOptionalString(d.description),
    prompt: asOptionalString(d.prompt),
    code,
    schemaVersion: d.schemaVersion,
    kind,
    lastResult: (d.lastResult ?? undefined) as CustomStatDefinition['lastResult'],
    lastRunAt: asOptionalString(d.lastRunAt),
    favorite: asOptionalBoolean(d.favorite),
    pinned: asOptionalBoolean(d.pinned),
    pinnedAt: asOptionalString(d.pinnedAt),
    runCount: asOptionalFiniteNumber(d.runCount),
    originMessageId: asOptionalString(d.originMessageId),
    createdAt: asOptionalString(d.createdAt) ?? updatedAt,
    updatedAt,
    isDeleted: 0,
  };
}

// ============================================================
// API 封装：list / upsert / delete（DELETE 幂等：不存在也返回 200）
// ============================================================

/**
 * 拉取当前用户全部自定义统计定义（活跃行，按 updatedAt 倒序由服务端保证）。
 * 业务非 200 或响应缺 list → 抛错，由调用方决定静默降级。
 */
export async function fetchServerCustomStats(token: string): Promise<CustomStatDefinition[]> {
  const envelope = await statSyncRequest<ServerListData>('', { method: 'GET', token });
  if (envelope.code !== 200) throw new Error(envelope.message || '自定义统计拉取失败');
  const list = Array.isArray(envelope.data?.list) ? envelope.data.list : [];
  return list.map(normalizeServerDef).filter((d): d is CustomStatDefinition => d !== null);
}

/**
 * 单条定义 upsert（新增或整体覆盖；服务端按 (userId, defId) 幂等落库，信任客户端 updatedAt）。
 * 上传前剥离 isDeleted：墓碑走 deleteServerCustomStat，永不上传。
 */
export async function putServerCustomStat(token: string, def: CustomStatDefinition): Promise<void> {
  const { isDeleted: _ignored, ...payload } = def;
  const envelope = await statSyncRequest<null>(`/${encodeURIComponent(def.id)}`, {
    method: 'PUT',
    body: payload,
    token,
  });
  if (envelope.code !== 200) throw new Error(envelope.message || '自定义统计上传失败');
}

/** 单条定义删除（幂等：服务端不存在也返回 200，重复传播删除无副作用） */
export async function deleteServerCustomStat(token: string, id: string): Promise<void> {
  const envelope = await statSyncRequest<null>(`/${encodeURIComponent(id)}`, { method: 'DELETE', token });
  if (envelope.code !== 200) throw new Error(envelope.message || '自定义统计删除失败');
}

// ---- 门面 ----

export const customStatsSyncService = {
  fetchServerCustomStats,
  putServerCustomStat,
  deleteServerCustomStat,
};
