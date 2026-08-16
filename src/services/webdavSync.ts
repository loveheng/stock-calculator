/**
 * @file webdavSync.ts
 * @description WebDAV 多端同步与云端备份服务：提供 WebDAV 配置管理、连通性测试、
 *              一键备份/恢复、智能合并同步等功能。
 *              配置信息保存在 localStorage，数据快照为格式化 JSON。
 * @layer Service
 * @author 开发团队
 */

import type { AppStoreExport, TRoundArchive, Position, LongTermRecord } from '../store/types';
import type { FeeConfig } from '../utils/mathUtils';
import type { StockMeta } from '../types/stock';

// ============================================================
// 1. WebDAV 配置类型与 localStorage 管理
// ============================================================

export interface WebDAVConfig {
  /** 服务器地址，如 https://dav.jianguoyun.com/dav/ */
  webdavUrl: string;
  /** 账号/邮箱 */
  username: string;
  /** 应用授权密码 (App Password) */
  password: string;
  /** 备份文件路径，默认 /stock-calculator/data-backup.json */
  remotePath: string;
  /** 自动同步开关 */
  autoSync: boolean;
}

/** 默认配置 */
export const DEFAULT_WEBDAV_CONFIG: WebDAVConfig = {
  webdavUrl: '',
  username: '',
  password: '',
  remotePath: '/stock-calculator/data-backup.json',
  autoSync: false,
};

/** localStorage 存储键名 */
const STORAGE_KEY_CONFIG = 'webdav_config';
const STORAGE_KEY_LAST_SYNC = 'webdav_last_sync';
const STORAGE_KEY_SYNC_HISTORY = 'webdav_sync_history';

/** 同步历史记录 */
export interface SyncHistoryEntry {
  timestamp: string;
  type: 'backup' | 'restore' | 'merge' | 'test';
  success: boolean;
  message?: string;
}

/**
 * 从 localStorage 读取 WebDAV 配置。
 */
export function getWebDAVConfig(): WebDAVConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CONFIG);
    if (!raw) return { ...DEFAULT_WEBDAV_CONFIG };
    return { ...DEFAULT_WEBDAV_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_WEBDAV_CONFIG };
  }
}

/**
 * 保存 WebDAV 配置到 localStorage。
 */
export function saveWebDAVConfig(config: WebDAVConfig): void {
  localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
}

/**
 * 清除 WebDAV 配置。
 */
export function clearWebDAVConfig(): void {
  localStorage.removeItem(STORAGE_KEY_CONFIG);
  localStorage.removeItem(STORAGE_KEY_LAST_SYNC);
  localStorage.removeItem(STORAGE_KEY_SYNC_HISTORY);
}

/**
 * 获取上次同步时间（ISO 字符串）。
 */
export function getLastSyncTime(): string | null {
  return localStorage.getItem(STORAGE_KEY_LAST_SYNC);
}

/**
 * 设置上次同步时间。
 */
export function setLastSyncTime(time?: string): void {
  localStorage.setItem(STORAGE_KEY_LAST_SYNC, time ?? new Date().toISOString());
}

/**
 * 获取同步历史列表。
 */
export function getSyncHistory(): SyncHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SYNC_HISTORY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * 追加同步历史记录（保留最近 50 条）。
 */
export function addSyncHistory(entry: SyncHistoryEntry): void {
  const history = getSyncHistory();
  history.unshift(entry);
  if (history.length > 50) history.length = 50;
  localStorage.setItem(STORAGE_KEY_SYNC_HISTORY, JSON.stringify(history));
}

// ============================================================
// 2. WebDAV HTTP 请求工具
// ============================================================

/**
 * 构建 WebDAV 请求的目标 URL。
 * 所有请求统一通过同源 Edge 代理 /api-webdav 转发，
 * 避免浏览器端跨域 CORS 限制。
 *
 * 代理 URL 格式：/api-webdav?url=<encodeURIComponent(上游地址)>
 */
function buildProxyUrl(config: WebDAVConfig, path: string): string {
  const targetUrl = `${config.webdavUrl.replace(/\/+$/, '')}${path}`;
  return `/api-webdav?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * 构建 WebDAV 请求的 headers（含 Basic Auth）。
 */
function buildWebDAVHeaders(config: WebDAVConfig, extra: Record<string, string> = {}): Record<string, string> {
  const credentials = btoa(`${config.username}:${config.password}`);
  return {
    Authorization: `Basic ${credentials}`,
    'Content-Type': 'application/octet-stream',
    ...extra,
  };
}

/**
 * 通用 WebDAV HTTP 请求。
 * 所有请求统一通过同源 Edge 代理 /api-webdav 转发，
 * 无需设置 mode: 'cors'（代理 URL 与页面同源）。
 */
async function webdavRequest(
  config: WebDAVConfig,
  method: string,
  path: string,
  body?: BodyInit | null,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const url = buildProxyUrl(config, path);
  const headers = buildWebDAVHeaders(config, extraHeaders);

  const fetchOptions: RequestInit = {
    method,
    headers,
    body: body ?? null,
  };

  const response = await fetch(url, fetchOptions);
  return response;
}

// ============================================================
// 3. 核心同步操作
// ============================================================

/**
 * 测试 WebDAV 连接连通性。
 * 优先使用 PROPFIND，若服务器不支持则回退到 HEAD。
 */
export async function testWebDAVConnection(config: WebDAVConfig): Promise<{ ok: boolean; message: string }> {
  try {
    // 尝试 PROPFIND 获取集合信息
    const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:">
  <prop>
    <displayname/>
    <resourcetype/>
  </prop>
</propfind>`;

    const response = await webdavRequest(
      config,
      'PROPFIND',
      '/',
      propfindBody,
      { 'Content-Type': 'application/xml; charset="utf-8"' },
    );

    if (response.ok || response.status === 207) {
      return { ok: true, message: '连接成功' };
    }

    // PROPFIND 失败，回退到 HEAD
    const headResponse = await webdavRequest(config, 'HEAD', '/');
    if (headResponse.ok) {
      return { ok: true, message: '连接成功（HEAD）' };
    }

    return { ok: false, message: `服务器返回 ${response.status}: ${response.statusText}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知网络错误';
    if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
      return {
        ok: false,
        message: '网络错误：请检查服务器地址是否正确，或尝试启用 Edge 代理（部署到 Vercel 后自动生效）',
      };
    }
    return { ok: false, message };
  }
}

/**
 * 导出完整数据快照（调用 Store 的 exportData 获取数据）。
 */
export function serializeSnapshot(data: AppStoreExport): string {
  const snapshot = {
    version: data.version,
    exportedAt: new Date().toISOString(),
    timestamp: Date.now(),
    feeConfig: data.feeConfig,
    tRounds: data.tRounds,
    positions: data.positions,
    stocks: data.stocks,
    longTermRecords: data.longTermRecords,
  };
  return JSON.stringify(snapshot, null, 2);
}

/**
 * 反序列化云端快照 JSON。
 */
export function deserializeSnapshot(json: string): { data: AppStoreExport; timestamp: number } | null {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const snapshot = parsed.version !== undefined ? parsed : (parsed.data ?? parsed);
    if (!snapshot.version || !Array.isArray(snapshot.tRounds)) return null;

    const data: AppStoreExport = {
      version: snapshot.version,
      feeConfig: snapshot.feeConfig ?? {},
      tRounds: snapshot.tRounds ?? [],
      positions: snapshot.positions ?? [],
      stocks: snapshot.stocks ?? [],
      longTermRecords: snapshot.longTermRecords ?? [],
    };

    const timestamp = parsed.timestamp ?? snapshot.timestamp ?? Date.now();
    return { data, timestamp };
  } catch {
    return null;
  }
}

/**
 * 一键备份到云端：将完整数据快照 PUT 到远端。
 */
export async function backupToCloud(
  config: WebDAVConfig,
  snapshotJson: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await webdavRequest(config, 'PUT', config.remotePath, snapshotJson);

    if (response.ok || response.status === 201 || response.status === 204) {
      setLastSyncTime();
      addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: true });
      return { ok: true, message: '备份成功' };
    }

    return { ok: false, message: `备份失败：服务器返回 ${response.status} ${response.statusText}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: false, message });
    return { ok: false, message: `备份失败：${message}` };
  }
}

/**
 * 从云端恢复：GET 远端 JSON 并返回数据。
 */
export async function restoreFromCloud(
  config: WebDAVConfig,
): Promise<{ ok: boolean; data: AppStoreExport | null; message: string }> {
  try {
    const response = await webdavRequest(config, 'GET', config.remotePath);

    if (!response.ok) {
      if (response.status === 404) {
        return { ok: false, data: null, message: '云端未找到备份文件' };
      }
      return { ok: false, data: null, message: `下载失败：服务器返回 ${response.status} ${response.statusText}` };
    }

    const text = await response.text();
    const result = deserializeSnapshot(text);
    if (!result) {
      return { ok: false, data: null, message: '云端数据格式错误，无法解析' };
    }

    setLastSyncTime();
    addSyncHistory({ timestamp: new Date().toISOString(), type: 'restore', success: true });
    return { ok: true, data: result.data, message: '恢复成功' };
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    addSyncHistory({ timestamp: new Date().toISOString(), type: 'restore', success: false, message });
    return { ok: false, data: null, message: `恢复失败：${message}` };
  }
}

// ============================================================
// 4. 智能合并同步算法
// ============================================================

/**
 * 合并结果类型
 */
export interface MergeResult {
  tRounds: TRoundArchive[];
  positions: Position[];
  stocks: StockMeta[];
  longTermRecords: LongTermRecord[];
  feeConfig: FeeConfig;
  mergeStats: {
    roundsAdded: number;
    roundsUpdated: number;
    positionsAdded: number;
    positionsUpdated: number;
    stocksAdded: number;
    longTermRecordsAdded: number;
    longTermRecordsUpdated: number;
  };
}

/**
 * 按 ID 合并两条记录，保留时间戳较新的版本。
 * 若记录有 lastTouched / closedAt / openedAt 等时间字段，取最新值。
 * 若记录有 transactions 数组，合并时取长度较长的版本（更完整）。
 */
function mergeRecordById<T>(
  local: T[],
  remote: T[],
  keyExtractor: (item: T) => string,
  timestampExtractor?: (item: T) => number,
): { merged: T[]; added: number; updated: number } {
  const localMap = new Map<string, T>();
  for (const item of local) {
    localMap.set(keyExtractor(item), item);
  }

  let added = 0;
  let updated = 0;

  for (const remoteItem of remote) {
    const key = keyExtractor(remoteItem);
    const localItem = localMap.get(key);

    if (!localItem) {
      localMap.set(key, remoteItem);
      added++;
    } else {
      const localTime = timestampExtractor ? timestampExtractor(localItem) : 0;
      const remoteTime = timestampExtractor ? timestampExtractor(remoteItem) : 0;

      if (remoteTime > localTime) {
        const merged = { ...remoteItem };
        const localTransactions = (localItem as any).transactions as Array<any> | undefined;
        const remoteTransactions = (remoteItem as any).transactions as Array<any> | undefined;
        if (localTransactions && remoteTransactions) {
          (merged as any).transactions = localTransactions.length >= remoteTransactions.length
            ? localTransactions
            : remoteTransactions;
        } else if (localTransactions) {
          (merged as any).transactions = localTransactions;
        }
        localMap.set(key, merged);
        updated++;
      }
    }
  }

  return {
    merged: Array.from(localMap.values()),
    added,
    updated,
  };
}

/**
 * 从可能含有时间戳字段的对象中提取最大时间戳（毫秒）。
 * 支持 lastTouched / closedAt / openedAt 等字段。
 * 若对象不含任何时间戳字段，返回 0。
 */
function extractTimestamp(item: unknown): number {
  const obj = item as Record<string, unknown>;
  const timestamps: string[] = [];
  if (typeof obj.lastTouched === 'string') timestamps.push(obj.lastTouched);
  if (typeof obj.closedAt === 'string') timestamps.push(obj.closedAt);
  if (typeof obj.openedAt === 'string') timestamps.push(obj.openedAt);
  if (timestamps.length === 0) return 0;
  return Math.max(...timestamps.map(t => new Date(t).getTime()));
}

/**
 * 合并本地与云端数据，按 ID 合并流水、底仓与归档战报，保留最新状态。
 *
 * @param localData 本地当前完整数据快照
 * @param remoteData 从云端下载的完整数据快照
 * @returns 合并后的数据与统计信息
 */
export function mergeData(
  localData: AppStoreExport,
  remoteData: AppStoreExport,
): MergeResult {
  // 1. 合并 tRounds（战报归档）
  const roundsMerge = mergeRecordById<TRoundArchive>(
    localData.tRounds ?? [],
    remoteData.tRounds ?? [],
    (item) => item.id,
    extractTimestamp,
  );

  // 2. 合并 positions（底仓）
  const positionsMerge = mergeRecordById<Position>(
    localData.positions ?? [],
    remoteData.positions ?? [],
    (item) => item.id,
    extractTimestamp,
  );

  // 3. 合并 stocks（股票基础信息）
  const stocksMerge = mergeRecordById(
    localData.stocks ?? [],
    remoteData.stocks ?? [],
    (item: StockMeta) => item.fullCode,
  );

  // 4. 合并 longTermRecords（中长期操作记录）
  const ltMerge = mergeRecordById(
    localData.longTermRecords ?? [],
    remoteData.longTermRecords ?? [],
    (item) => item.id,
  );

  // 5. 费率配置：取时间戳较新的版本
  const localExported = (localData as any).exportedAt ? new Date((localData as any).exportedAt).getTime() : 0;
  const remoteExported = (remoteData as any).exportedAt ? new Date((remoteData as any).exportedAt).getTime() : 0;
  const feeConfig = remoteExported > localExported
    ? remoteData.feeConfig
    : localData.feeConfig;

  return {
    tRounds: roundsMerge.merged,
    positions: positionsMerge.merged,
    stocks: stocksMerge.merged,
    longTermRecords: ltMerge.merged,
    feeConfig,
    mergeStats: {
      roundsAdded: roundsMerge.added,
      roundsUpdated: roundsMerge.updated,
      positionsAdded: positionsMerge.added,
      positionsUpdated: positionsMerge.updated,
      stocksAdded: stocksMerge.added,
      longTermRecordsAdded: ltMerge.added,
      longTermRecordsUpdated: ltMerge.updated,
    },
  };
}

/**
 * 智能合并同步：下载云端数据 → 合并 → 上传合并结果。
 * 流程：
 *   1. 从云端获取 JSON 数据
 *   2. 与本地数据按 ID + 时间戳合并
 *   3. 将合并结果上传回云端
 *   4. 返回合并后的数据（供 importData 使用）
 */
export async function mergeSync(
  config: WebDAVConfig,
  localSnapshot: AppStoreExport,
): Promise<{
  ok: boolean;
  mergeResult?: MergeResult;
  message: string;
}> {
  try {
    // 1. 下载云端数据
    const remoteResult = await restoreFromCloud(config);
    if (!remoteResult.ok) {
      // 如果云端没有数据，则直接上传本地数据作为初始备份
      if (remoteResult.message.includes('未找到')) {
        const json = serializeSnapshot(localSnapshot);
        const backupResult = await backupToCloud(config, json);
        if (backupResult.ok) {
          return {
            ok: true,
            message: '云端尚无数据，已创建初始备份',
          };
        }
        return { ok: false, message: `创建初始备份失败：${backupResult.message}` };
      }
      return { ok: false, message: remoteResult.message };
    }

    // 2. 合并
    const mergeResult = mergeData(localSnapshot, remoteResult.data!);

    // 3. 上传合并结果
    const mergedSnapshot: AppStoreExport = {
      version: mergeResult.feeConfig ? 1 : localSnapshot.version,
      feeConfig: mergeResult.feeConfig,
      tRounds: mergeResult.tRounds,
      positions: mergeResult.positions,
      stocks: mergeResult.stocks,
      longTermRecords: mergeResult.longTermRecords,
    };

    const json = serializeSnapshot(mergedSnapshot);
    const uploadResult = await backupToCloud(config, json);

    if (!uploadResult.ok) {
      return { ok: false, message: `合并完成但上传失败：${uploadResult.message}` };
    }

    const stats = mergeResult.mergeStats;
    const detail = [
      stats.roundsAdded > 0 ? `新增战报 ${stats.roundsAdded}` : '',
      stats.roundsUpdated > 0 ? `更新战报 ${stats.roundsUpdated}` : '',
      stats.positionsAdded > 0 ? `新增底仓 ${stats.positionsAdded}` : '',
      stats.positionsUpdated > 0 ? `更新底仓 ${stats.positionsUpdated}` : '',
    ].filter(Boolean).join('，');

    addSyncHistory({
      timestamp: new Date().toISOString(),
      type: 'merge',
      success: true,
      message: detail || '无变更',
    });

    return {
      ok: true,
      mergeResult,
      message: `智能合并同步成功${detail ? `（${detail}）` : ''}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    addSyncHistory({ timestamp: new Date().toISOString(), type: 'merge', success: false, message });
    return { ok: false, message: `合并同步失败：${message}` };
  }
}

/**
 * 格式化相对时间（如 "10 分钟前"）。
 */
export function formatRelativeTime(isoTime: string): string {
  const now = Date.now();
  const then = new Date(isoTime).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return '刚刚';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return `${months} 个月前`;
}