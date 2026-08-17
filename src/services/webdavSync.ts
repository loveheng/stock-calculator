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
/** 同步元数据统一存储键：包含 lastSyncTime 和 syncHistory，
 *  使用独立键名避免与主数据 Store 耦合，切断"更新同步时间 → 触发自动上传"的闭环 */
const STORAGE_KEY_META_V1 = 'webdav_meta_v1';

/** 同步元数据结构 */
interface WebDAVMetaV1 {
  lastSyncTime: string | null;
  syncHistory: SyncHistoryEntry[];
}

/**
 * ============================================================
 * 四重锁 & 冷却时间（Cool-down Guard）
 * ============================================================
 * 1. isUploading       上传互斥锁（单例），专门守卫 PUT 上传，同一时刻
 *                      只有 1 个 PUT 请求在途，从根上切断"死循环重复上传"
 * 2. isSyncing         同步操作布尔锁，确保同一时刻最多只有一个同步操作在执行
 * 3. syncLockCount     可重入计数器，支持 mergeSync 嵌套调用链
 * 4. lastSyncTimestamp 冷却时间守卫，防止 10 秒内重复触发
 *
 * 设计原因：
 * - syncLockCount 在嵌套调用时被外层持有，内层调用通过 _skipLock 跳过
 * - isSyncing 作为兜底布尔锁，即使 _skipLock 路径遗漏，仍能拦截重复请求
 * - isUploading 独立于 syncLockCount：它不对 _skipLock 放行，永远拦截并发 PUT，
 *   即使 mergeSync 嵌套路径漏判，也绝不允许第 2 个 PUT 并发发出
 * - lastSyncTimestamp 提供时间维度的保护，防止 React 重渲染/竞态导致背靠背触发
 */

/** 强制最小同步间隔（毫秒）：10 秒 */
const MIN_SYNC_INTERVAL = 10_000;

/** 同步操作执行锁 */
let isSyncing = false;

/**
 * 上传互斥锁（单例 Mutex）。
 * 专门保护 PUT 上传请求：`true` 表示已有上传在途，任何后续上传请求
 * 一律拦截并直接返回，绝不并发发出第二个 PUT，彻底阻断死循环上传链路。
 * 该锁不参与 _skipLock 放行逻辑，无论顶层调用还是 mergeSync 嵌套调用都强制执行。
 */
let isUploading = false;

/** 上次同步完成的时间戳，用于冷却时间判断 */
let lastSyncTimestamp = 0;

/**
 * 同步互斥锁与状态防重入（可重入计数器）。
 * 所有同步操作（backup / restore / merge / test）进入时检查此计数器，
 * 若 > 0 则直接返回，防止重复请求导致无限循环。
 * 操作完成后在 `finally` 块中递减。
 *
 * 使用计数器而非布尔值，以支持 mergeSync → restoreFromCloud/backupToCloud
 * 这样的嵌套调用链不会错误地阻塞自身。
 */
let syncLockCount = 0;

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
  localStorage.removeItem(STORAGE_KEY_META_V1);
}

/**
 * 读取同步元数据（lastSyncTime + syncHistory 统一存储）。
 * 使用独立键名 `webdav_meta_v1`，不经过主数据 Store，避免触发 Store 监听器。
 */
function readMetaV1(): WebDAVMetaV1 {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_META_V1);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          lastSyncTime: parsed.lastSyncTime ?? null,
          syncHistory: Array.isArray(parsed.syncHistory) ? parsed.syncHistory : [],
        };
      }
    }
  } catch {
    // 忽略解析错误
  }
  return { lastSyncTime: null, syncHistory: [] };
}

/**
 * 写入同步元数据（lastSyncTime + syncHistory 统一存储）。
 */
function writeMetaV1(meta: WebDAVMetaV1): void {
  localStorage.setItem(STORAGE_KEY_META_V1, JSON.stringify(meta));
}

/**
 * 获取上次同步时间（ISO 字符串）。
 */
export function getLastSyncTime(): string | null {
  return readMetaV1().lastSyncTime;
}

/**
 * 设置上次同步时间。
 */
export function setLastSyncTime(time?: string): void {
  const meta = readMetaV1();
  meta.lastSyncTime = time ?? new Date().toISOString();
  writeMetaV1(meta);
}

/**
 * 获取同步历史列表。
 */
export function getSyncHistory(): SyncHistoryEntry[] {
  return readMetaV1().syncHistory;
}

/**
 * 追加同步历史记录（保留最近 50 条）。
 */
export function addSyncHistory(entry: SyncHistoryEntry): void {
  const meta = readMetaV1();
  meta.syncHistory.unshift(entry);
  if (meta.syncHistory.length > 50) meta.syncHistory.length = 50;
  writeMetaV1(meta);
}

// ============================================================
// 2. WebDAV HTTP 请求工具
// ============================================================

/**
 * 构建 WebDAV 请求的目标 URL。
 * 所有请求统一通过同源代理 /api/webdav 转发，
 * 避免浏览器端跨域 CORS 限制。
 *
 * 代理 URL 格式：/api/webdav?url=<encodeURIComponent(目标地址)>
 */
function buildProxyUrl(config: WebDAVConfig, path: string): string {
  const targetUrl = `${config.webdavUrl.replace(/\/+$/, '')}${path}`;
  return `/api/webdav?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * 构建 WebDAV 请求的 headers（含 Basic Auth）。
 *
 * 使用标准 `Authorization` 头，线上 Vercel Serverless Function（api/webdav.js）
 * 会严格清洗请求头，保留 authorization 并转发到上游，不再需要自定义头变通方案。
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
 * 需要跨标签页串行化的 WebDAV 写方法。
 * GET / HEAD / OPTIONS / PROPFIND 等只读操作不需要，避免持锁并发限制。
 */
const WRITE_METHODS = new Set(['PUT', 'MKCOL', 'DELETE', 'MOVE', 'COPY']);

/**
 * 跨标签页写入互斥（Web Locks API）。
 *
 * 模块级 isUploading / isSyncing 互斥锁只能在【单个 JS 上下文】（同一标签页）内生效。
 * 若用户在多个标签页同时打开应用，每个标签页都是独立上下文，两个 PUT 会同时打到
 * Koofr 等 WebDAV 服务器，服务器对重叠写入不做原子处理，导致远端文件大小
 * 在 0B 与完整大小之间来回跳变（“文件大小跳动”）。
 *
 * 本函数使用 Web Locks API（仅 HTTPS 安全上下文可用，Vercel 部署满足条件）做
 * 跨标签页串行化：无论多少标签页同时发起写请求，同一时刻只有 1 个写请求能真正
 * 到达上游，其余等待其完成后再执行——彻底杜绝重叠写入，保证远端文件原子且稳定。
 *
 * 不支持 Web Locks 的环境（如极少数浏览器）自动回退为直接执行，
 * 由模块级 isUploading 互斥锁兜底保证单页内串行。
 */
async function withCrossTabWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined') {
    const nav = navigator as Navigator & {
      locks?: { request: (name: string, callback: () => Promise<T>) => Promise<T> };
    };
    if (nav.locks) {
      // 同名锁全局唯一：可靠等待，不设 ifAvailable（宁可串行等待也绝不并发写）。
      return nav.locks.request('stock-calculator-webdav-write', fn);
    }
  }
  return fn();
}

/**
 * 通用 WebDAV HTTP 请求。
 * 所有请求统一通过同源代理 /api/webdav 转发，
 * 无需设置 mode: 'cors'（代理 URL 与页面同源）。
 * 写方法（PUT/MKCOL/DELETE/MOVE/COPY）自动套用跨标签页互斥锁。
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
    // 关键：强制绕过浏览器 HTTP 缓存与任何 Service Worker 层级的缓存/后台重试。
    // 配合 SW 侧对 /api/webdav 的彻底放行，保证 WebDAV 的 PUT/GET/PROPFIND 等
    // 请求直接命中网络代理，杜绝因缓存命中原生 fetch 导致的重复请求风暴 / 423 Locked。
    cache: 'no-store',
  };

  // 写方法做跨标签页串行化：同一时刻只允许 1 个写请求在途，
  // 阻止多标签页的重叠 PUT 把远端文件写成交替的 0B / 完整内容。
  if (WRITE_METHODS.has(method.toUpperCase())) {
    return withCrossTabWriteLock(() => fetch(url, fetchOptions));
  }
  return fetch(url, fetchOptions);
}

/**
 * 自动创建父目录（MKCOL）。
 * 当 PUT 上传遇到 403/404/409 时，自动尝试向目标文件的父级目录发送 MKCOL 创建文件夹。
 *
 * @param config - WebDAV 配置
 * @param filePath - 目标文件路径（如 /stock-calculator/data-backup.json）
 * @returns 是否创建成功（或已存在）
 */
export async function ensureParentDir(config: WebDAVConfig, filePath: string): Promise<boolean> {
  // 提取父级路径
  const normalizedPath = filePath.replace(/\/+$/, '');
  const parentDir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/')) || '/';
  if (parentDir === '/' || parentDir === '') return true; // 根目录无需创建

  try {
    const response = await webdavRequest(
      config,
      'MKCOL',
      parentDir,
      null,
      { 'Content-Type': 'application/xml; charset="utf-8"' },
    );
    // 201 Created = 新建成功；405 Method Not Allowed = 已存在（集合已存在时返回 405）
    // 有时也返回 200 OK
    if (response.status === 201 || response.status === 200 || response.status === 405) {
      return true;
    }
    // 部分服务器返回 409 Conflict 表示中间目录不存在，尝试递归创建
    if (response.status === 409 || response.status === 404) {
      // 递归创建上级目录
      const grandParentOk = await ensureParentDir(config, parentDir);
      if (grandParentOk) {
        // 再次尝试创建当前目录
        const retry = await webdavRequest(
          config,
          'MKCOL',
          parentDir,
          null,
          { 'Content-Type': 'application/xml; charset="utf-8"' },
        );
        return retry.status === 201 || retry.status === 200 || retry.status === 405;
      }
    }
    return false;
  } catch {
    // 网络错误等静默处理
    return false;
  }
}
/**
 * 上传前置的“确保父目录存在”检查（MKCOL）。
 *
 * Koofr 等 WebDAV 服务端在目标文件的父级目录（如 stock-calculator）尚未创建时，
 * 会直接对 PUT 返回 404 Not Found。因此在执行 PUT 写入文件之前，先提取文件所在的
 * 父级目录完整 URL，并向其发送一次 MKCOL 请求自动创建目录：
 *   - 201 Created          —— 目录创建成功；
 *   - 405/301/409 等状态   —— 目录已存在（不同服务端返回码不一），同样视为成功；
 *   - 网络错误/其它非致命异常 —— 忽略，后续仍按原流程执行 PUT（配合 backupToWebDAV
 *     里的 404/409 重试兜底，保证健壮性）。
 *
 * 本函数刻意使用最简实现（直接 fetch 代理 + Authorization 头），作为上传前的一步
 * “尽力而为”预检，返回值无业务含义。
 *
 * @param dirUrl     远端父级目录的完整 URL（如 https://app.koofr.net/dav/Koofr/stock-calculator）
 * @param authHeader Basic Auth 头（如 'Basic xxxxx'）
 */
async function ensureDirectoryExists(dirUrl: string, authHeader: string): Promise<void> {
  try {
    const proxyUrl = `/api/webdav?url=${encodeURIComponent(dirUrl)}`;
    await fetch(proxyUrl, {
      method: 'MKCOL',
      headers: {
        'Authorization': authHeader,
      },
    });
    // 201 Created: 创建成功；405/301/409: 目录已存在，均视为成功
  } catch (e) {
    // 忽略已存在或非致命错误
  }
}

// ============================================================
// 3. 核心同步操作
// ============================================================

/**
 * 测试 WebDAV 连接连通性。
 * 优先使用 PROPFIND（附带 Depth: 0 请求头，Chrome/Koofr 等标准 WebDAV 服务器
 * 均支持），若服务器不支持则回退到 GET。
 * 刻意【不使用 HEAD】作为连通性探测：部分网盘（含部分 WebDAV 服务器）会拒绝
 * HEAD 并返回 405，导致误判连接失败；而 PROPFIND / GET 是 WebDAV 标准读操作，
 * 兼容性更稳。
 */
export async function testWebDAVConnection(config: WebDAVConfig): Promise<{ ok: boolean; message: string }> {
  const now = Date.now();
  const logPrefix = '[WebDAV:testConnection]';

  // 互斥锁 + 冷却时间守卫
  if (isSyncing) {
    console.warn(`${logPrefix} 同步正在进行中，拦截重复请求`);
    return { ok: false, message: '同步正在进行中，请稍后重试' };
  }
  if (now - lastSyncTimestamp < MIN_SYNC_INTERVAL) {
    console.warn(`${logPrefix} 触发过于频繁，处于 ${MIN_SYNC_INTERVAL / 1000}s 冷却期中`);
    return { ok: false, message: `操作过于频繁，请 ${Math.ceil((MIN_SYNC_INTERVAL - (now - lastSyncTimestamp)) / 1000)} 秒后重试` };
  }
  if (syncLockCount > 0) {
    return { ok: false, message: '同步操作正在执行中，请稍后重试' };
  }
  syncLockCount++;
  isSyncing = true;
  lastSyncTimestamp = now;

  console.log(`${logPrefix} 开始测试连接`, { url: config.webdavUrl });

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
      {
        'Content-Type': 'application/xml; charset="utf-8"',
        // Depth: 0 —— 仅探测集合本身，不递归遍历子级，减小响应体积。
        Depth: '0',
      },
    );

    if (response.ok || response.status === 207) {
      console.log(`${logPrefix} 连接成功（PROPFIND）`);
      return { ok: true, message: '连接成功' };
    }

    // 鉴权错误
    if (response.status === 401 || response.status === 403) {
      console.error(`${logPrefix} 鉴权失败`, response.status);
      return { ok: false, message: '鉴权失败或无权限，请确认使用的是网盘专属【应用授权密码/App Password】而非网页登录密码' };
    }

    // 文件锁定错误
    if (response.status === 423) {
      console.error(`${logPrefix} 文件被锁定`, response.status);
      return { ok: false, message: '目标文件已被远端服务器锁定（423 Locked），请稍后重试或确认无其他客户端正在占用该文件。' };
    }

    // PROPFIND 失败，回退到 GET（不用 HEAD：部分网盘对 HEAD 返回 405）。
    console.log(`${logPrefix} PROPFIND 失败，回退到 GET`);
    const getResponse = await webdavRequest(config, 'GET', '/');
    if (getResponse.ok) {
      console.log(`${logPrefix} 连接成功（GET）`);
      return { ok: true, message: '连接成功（GET）' };
    }

    console.error(`${logPrefix} 连接失败`, { status: response.status, statusText: response.statusText });
    return { ok: false, message: `服务器返回 ${response.status}: ${response.statusText}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知网络错误';
    if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
      console.error(`${logPrefix} 网络错误`, { message });
      return {
        ok: false,
        message: '网络错误：请检查服务器地址是否正确，或尝试启用 Edge 代理（部署到 Vercel 后自动生效）',
      };
    }
    console.error(`${logPrefix} 异常`, { message, error: err });
    return { ok: false, message };
  } finally {
    isSyncing = false;
    syncLockCount--;
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
 * PUT 请求头携带 `Overwrite: T` 以覆盖同名文件；
 * 若遇到 403/404/409 错误，自动尝试创建父目录（MKCOL）后重试。
 */
/**
 * 备份到云端（PUT 上传）。
 * 四重保护：isUploading 上传互斥锁 + isSyncing 布尔锁 + syncLockCount 计数器 + 10s 冷却时间。
 *
 * @param force - 为 true 时跳过冷却时间检查（仅限用户手动点击触发）
 */
export async function backupToCloud(
  config: WebDAVConfig,
  snapshotJson: string,
  /** 内部调用时跳过锁检查，由外层函数统一加锁 */
  _skipLock?: boolean,
  force?: boolean,
): Promise<{ ok: boolean; message: string }> {
  const now = Date.now();
  const logPrefix = '[WebDAV:backupToCloud]';

  // ============================================================
  // 四重互斥锁 + 冷却时间守卫
  // ============================================================

  // 0) isUploading 上传互斥锁：无论顶层调用还是 mergeSync 嵌套调用都强制执行，
  //    只要已有 1 个 PUT 在途，就立即拦截后续所有上传，绝不并发发出第 2 个 PUT。
  if (isUploading) {
    console.warn(`${logPrefix} 上传正在进行中，拦截重复请求`);
    return { ok: false, message: '上传正在进行中，请稍后重试' };
  }

  // 1) isSyncing 布尔锁：严格拦截所有并发的同步操作
  //    仅在顶层调用（!_skipLock）时检查；mergeSync 嵌套调用由外层统一持有锁，
  //    跳过此检查以免误伤自身的恢复/合并流程。
  if (!_skipLock && isSyncing) {
    console.warn(`${logPrefix} 同步正在进行中，拦截重复请求`);
    return { ok: false, message: '同步正在进行中，请稍后重试' };
  }

  // 2) 冷却时间守卫：10 秒内禁止重复触发（除非 force=true）
  if (!force && !_skipLock && now - lastSyncTimestamp < MIN_SYNC_INTERVAL) {
    console.warn(`${logPrefix} 触发过于频繁，处于 ${MIN_SYNC_INTERVAL / 1000}s 冷却期中（距上次同步 ${(now - lastSyncTimestamp) / 1000}s）`);
    return { ok: false, message: `操作过于频繁，请 ${Math.ceil((MIN_SYNC_INTERVAL - (now - lastSyncTimestamp)) / 1000)} 秒后重试` };
  }

  // 3) syncLockCount 可重入计数器：防止与 test/restore/merge 等操作冲突
  if (!_skipLock) {
    if (syncLockCount > 0) {
      console.warn(`${logPrefix} 其他同步操作正在进行中（syncLockCount=${syncLockCount}），拦截`);
      return { ok: false, message: '同步操作正在执行中，请稍后重试' };
    }
    syncLockCount++;
  }

  isSyncing = true;
  // 此刻才真正获得上传资格，加锁后进入上传临界区
  isUploading = true;
  lastSyncTimestamp = now;

  const dataSize = new Blob([snapshotJson]).size;
  console.log(`${logPrefix} 开始上传`, { dataSize: `${(dataSize / 1024).toFixed(1)}KB`, remotePath: config.remotePath });

  try {
    const response = await webdavRequest(
      config, 'PUT', config.remotePath, snapshotJson,
      { 'Overwrite': 'T' },
    );

    if (response.ok || response.status === 201 || response.status === 204) {
      // 写入隔离的 localStorage 键 webdav_meta_v1，不经过主数据 Store，
      // 避免触发 Store 监听器导致自动同步循环
      setLastSyncTime();
      addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: true });
      console.log(`${logPrefix} 上传成功`, { status: response.status, dataSize: `${(dataSize / 1024).toFixed(1)}KB` });
      return { ok: true, message: '备份成功' };
    }

    // 鉴权错误
    if (response.status === 401 || response.status === 403) {
      const msg = '鉴权失败或无权限，请确认使用的是网盘专属【应用授权密码/App Password】而非网页登录密码';
      addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: false, message: msg });
      console.error(`${logPrefix} 鉴权失败`, response.status);
      return { ok: false, message: `备份失败：${msg}` };
    }

    // 文件锁定错误
    if (response.status === 423) {
      const msg = '目标文件已被远端服务器锁定（423 Locked）。请尝试修改备份文件名（如 backup-v2.json）或确认无其他客户端正在占用该文件。';
      addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: false, message: msg });
      console.error(`${logPrefix} 文件被锁定`, response.status);
      return { ok: false, message: `备份失败：${msg}` };
    }

    // 目录不存在错误：自动尝试创建父目录后重试
    if (response.status === 404 || response.status === 409) {
      console.log(`${logPrefix} 目录不存在，尝试创建父目录后重试`);
      const dirCreated = await ensureParentDir(config, config.remotePath);
      if (dirCreated) {
        const retry = await webdavRequest(
          config, 'PUT', config.remotePath, snapshotJson,
          { 'Overwrite': 'T' },
        );
        if (retry.ok || retry.status === 201 || retry.status === 204) {
          setLastSyncTime();
          addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: true });
          console.log(`${logPrefix} 重试上传成功`, { status: retry.status });
          return { ok: true, message: '备份成功（已自动创建目录）' };
        }
        console.error(`${logPrefix} 重试上传失败`, retry.status);
        return { ok: false, message: `备份失败：重试后服务器返回 ${retry.status} ${retry.statusText}` };
      }
      console.error(`${logPrefix} 目录创建失败`);
      return { ok: false, message: `备份失败：目录创建失败，请检查远程路径是否正确` };
    }

    console.error(`${logPrefix} 服务器返回错误`, { status: response.status, statusText: response.statusText });
    return { ok: false, message: `备份失败：服务器返回 ${response.status} ${response.statusText}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: false, message });
    console.error(`${logPrefix} 异常`, { message, error: err });
    return { ok: false, message: `备份失败：${message}` };
  } finally {
    // 上传互斥锁始终必须复位：无论成功/失败/嵌套，都释放上传资格
    isUploading = false;
    // isSyncing / syncLockCount 仅由持有锁的顶层调用复位；
    // mergeSync 嵌套调用（_skipLock=true）不在此处复位，交由外层 mergeSync 的 finally 处理
    if (!_skipLock) {
      isSyncing = false;
      syncLockCount--;
    }
  }
}

/**
 * 从云端恢复：GET 远端 JSON 并返回数据。
 */
export async function restoreFromCloud(
  config: WebDAVConfig,
  /** 内部调用时跳过锁检查，由外层函数统一加锁 */
  _skipLock?: boolean,
): Promise<{ ok: boolean; data: AppStoreExport | null; message: string }> {
  const now = Date.now();
  const logPrefix = '[WebDAV:restoreFromCloud]';

  // 互斥锁 + 冷却时间守卫
  if (!_skipLock) {
    if (isSyncing) {
      console.warn(`${logPrefix} 同步正在进行中，拦截重复请求`);
      return { ok: false, data: null, message: '同步正在进行中，请稍后重试' };
    }
    if (now - lastSyncTimestamp < MIN_SYNC_INTERVAL) {
      console.warn(`${logPrefix} 触发过于频繁，处于 ${MIN_SYNC_INTERVAL / 1000}s 冷却期中`);
      return { ok: false, data: null, message: `操作过于频繁，请 ${Math.ceil((MIN_SYNC_INTERVAL - (now - lastSyncTimestamp)) / 1000)} 秒后重试` };
    }
    if (syncLockCount > 0) {
      console.warn(`${logPrefix} 其他同步操作正在进行中（syncLockCount=${syncLockCount}），拦截`);
      return { ok: false, data: null, message: '同步操作正在执行中，请稍后重试' };
    }
    syncLockCount++;
  }

  isSyncing = true;
  lastSyncTimestamp = now;

  console.log(`${logPrefix} 开始下载`, { remotePath: config.remotePath });

  try {
    const response = await webdavRequest(config, 'GET', config.remotePath);

    if (!response.ok) {
      if (response.status === 404) {
        console.warn(`${logPrefix} 云端未找到备份文件`);
        return { ok: false, data: null, message: '云端未找到备份文件' };
      }
      if (response.status === 401 || response.status === 403) {
        console.error(`${logPrefix} 鉴权失败`, response.status);
        return { ok: false, data: null, message: '下载失败：鉴权失败或无权限，请确认使用的是网盘专属【应用授权密码/App Password】而非网页登录密码' };
      }
      if (response.status === 423) {
        console.error(`${logPrefix} 文件被锁定`, response.status);
        return { ok: false, data: null, message: '下载失败：目标文件已被远端服务器锁定（423 Locked），请稍后重试或确认无其他客户端正在占用该文件。' };
      }
      console.error(`${logPrefix} 服务器返回错误`, { status: response.status, statusText: response.statusText });
      return { ok: false, data: null, message: `下载失败：服务器返回 ${response.status} ${response.statusText}` };
    }

    const text = await response.text();
    const dataSize = new Blob([text]).size;
    console.log(`${logPrefix} 下载成功`, { dataSize: `${(dataSize / 1024).toFixed(1)}KB` });

    const result = deserializeSnapshot(text);
    if (!result) {
      console.error(`${logPrefix} 数据格式错误，无法解析`);
      return { ok: false, data: null, message: '云端数据格式错误，无法解析' };
    }

    // 写入隔离的 localStorage 键 webdav_meta_v1，不经过主数据 Store
    setLastSyncTime();
    addSyncHistory({ timestamp: new Date().toISOString(), type: 'restore', success: true });
    return { ok: true, data: result.data, message: '恢复成功' };
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    addSyncHistory({ timestamp: new Date().toISOString(), type: 'restore', success: false, message });
    console.error(`${logPrefix} 异常`, { message, error: err });
    return { ok: false, data: null, message: `恢复失败：${message}` };
  } finally {
    // isSyncing / syncLockCount 仅由持有锁的顶层调用复位；
    // mergeSync 嵌套调用（_skipLock=true）不在此处复位，交由外层 mergeSync 的 finally 处理
    if (!_skipLock) {
      isSyncing = false;
      syncLockCount--;
    }
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
  const now = Date.now();
  const logPrefix = '[WebDAV:mergeSync]';

  // 互斥锁 + 冷却时间守卫
  // 注意：mergeSync 内部调用 restoreFromCloud / backupToCloud 时均传入 _skipLock=true，
  // 由本函数统一持有 syncLockCount / isSyncing 锁。而 backupToCloud 内部会额外检查
  // isUploading 上传互斥锁（该锁不随 _skipLock 放行），确保无论顶层还是嵌套路径，
  // 同一时刻都只会发出 1 个 PUT 请求，绝不并发。
  // 顶层 mergeSync 之上再由 isSyncing + syncLockCount + 冷却时间提供整体串行化。
  if (isSyncing) {
    console.warn(`${logPrefix} 同步正在进行中，拦截重复请求`);
    return { ok: false, message: '同步正在进行中，请稍后重试' };
  }
  if (now - lastSyncTimestamp < MIN_SYNC_INTERVAL) {
    console.warn(`${logPrefix} 触发过于频繁，处于 ${MIN_SYNC_INTERVAL / 1000}s 冷却期中`);
    return { ok: false, message: `操作过于频繁，请 ${Math.ceil((MIN_SYNC_INTERVAL - (now - lastSyncTimestamp)) / 1000)} 秒后重试` };
  }
  if (syncLockCount > 0) {
    return { ok: false, message: '同步操作正在执行中，请稍后重试' };
  }
  syncLockCount++;
  isSyncing = true;
  lastSyncTimestamp = now;

  console.log(`${logPrefix} 开始合并同步`, { remotePath: config.remotePath });

  try {
    // 1. 下载云端数据（内部调用跳过锁检查）
    const remoteResult = await restoreFromCloud(config, true);
    if (!remoteResult.ok) {
      // 如果云端没有数据，则直接上传本地数据作为初始备份
      if (remoteResult.message.includes('未找到')) {
        console.log(`${logPrefix} 云端尚无数据，创建初始备份`);
        const json = serializeSnapshot(localSnapshot);
        const backupResult = await backupToCloud(config, json, true);
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
    const uploadResult = await backupToCloud(config, json, true);

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

    console.log(`${logPrefix} 合并同步成功`, { detail: detail || '无变更' });

    // 写入隔离的 localStorage 键 webdav_meta_v1，不经过主数据 Store
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
    console.error(`${logPrefix} 异常`, { message, error: err });
    return { ok: false, message: `合并同步失败：${message}` };
  } finally {
    isSyncing = false;
    syncLockCount--;
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

// ============================================================
// 10. 全局唯一执行锁 + 10s 绝对冷却（backupToWebDAV 单例防抖）
// ============================================================
// 重构要点：
//   - 彻底废除任何隐式的全局 Store 监听 / useEffect 自动触发数据同步；
//     备份只允许由用户在“完成保存动作”时【显式】调用本模块的单例防抖入口。
//   - 无论 UI 组件如何重复挂载/重复触发，同一时间只允许 1 个 HTTP 流程在飞：
//       1) activeUploadPromise —— Promise 互斥锁：已有请求在途则直接复用同一
//          Promise，绝不并发发出第 2 个 PUT（彻底阻断“文件大小跳变”与重复请求）。
//       2) BACKUP_COOLDOWN_MS —— 10s 绝对冷却：最后一次成功后 10s 内再次触发
//          一律静默合并，不产生新的网络请求。
//   - 同步元数据（lastSyncTime / syncHistory）只写入独立 localStorage 键，不经过
//     主数据 Store，保证“更新同步时间”不会反向驱动任何监听或重放。

/** 单次备份的执行结果（专供 UI 展示，不依赖全局 Store）。 */
export interface BackupResult {
  success: boolean;
  message: string;
}

/** 模块级 Promise 互斥锁：同一时间仅允许 1 个上传任务在途。 */
let activeUploadPromise: Promise<BackupResult> | null = null;

/** 最后一次成功上传的时间戳（绝对冷却基准）。 */
let lastUploadSuccessTime = 0;

/** 绝对冷却时长：10 秒。 */
const BACKUP_COOLDOWN_MS = 10_000;

/** 单例防抖定时器引用。 */
let backupDebounceTimer: number | null = null;

/** 防抖窗口内待上传的最新 payload（合并连续触发）。 */
let pendingBackupPayload: unknown = null;

/**
 * 全局唯一的上传执行锁 + 10s 绝对冷却。
 *
 * 从独立 localStorage 读取 WebDAV 配置，完全接管并发锁与冷却逻辑，
 * 杜绝任何外部状态重入。
 *
 * @param payload - 要上传的数据（对象或已序列化的 JSON 字符串）
 * @param force   - 为 true 时跳过冷却期检查（仅限用户点击“立即备份”等显式动作）
 */
export async function backupToWebDAV(payload: unknown, force = false): Promise<BackupResult> {
  const now = Date.now();

  // 1) 10s 绝对冷却：最后一次成功后的冷却期内再次触发一律静默合并，不再发请求。
  if (!force && now - lastUploadSuccessTime < BACKUP_COOLDOWN_MS) {
    console.warn('[WebDAV] 处于冷却期中，跳过本次触发（已合并操作）');
    return { success: true, message: '处于冷却期，已合并操作' };
  }

  // 2) Promise 互斥锁：已有上传在途则直接复用同一个 Promise，
  //    绝不并发发出第 2 个 PUT。
  if (activeUploadPromise) {
    console.warn('[WebDAV] 检测到已有上传任务在途，排队复用同一请求');
    return activeUploadPromise;
  }

  activeUploadPromise = (async () => {
    try {
      const config = getWebDAVConfig();
      if (!config || !config.webdavUrl || !config.username || !config.password) {
        return { success: false, message: 'WebDAV 未配置' };
      }

      const cleanPath = (config.remotePath || '/stock-calculator/data-backup.json').replace(/^\/+/, '');
      const baseUrl = (config.webdavUrl || '').replace(/\/+$/, '');
      const targetUrl = `${baseUrl}/${cleanPath}`;
      // 统一走 buildProxyUrl 生成代理地址（/api/webdav?url=…）。
      // 刻意不再使用旧别名 /api-webdav —— 线上没有该 /api 函数，会滑落到 SPA 静态层报 405。
      const proxyUrl = buildProxyUrl(config, `/${cleanPath}`);
      const authHeader = 'Basic ' + btoa(`${config.username}:${config.password}`);

      // 上传前置检查：先确保远端父目录存在（MKCOL）。
      // Koofr 等 WebDAV 服务端在目标文件的父级目录（如 stock-calculator）尚未创建时，
      // 会直接对 PUT 返回 404 Not Found。这里提取文件所在的父级目录 URL，发起一次
      // MKCOL 请求自动创建目录（若已存在或非致命错误则忽略），随后再执行 PUT 写入。
      const parentDir = cleanPath.substring(0, cleanPath.lastIndexOf('/'));
      if (parentDir) {
        const parentDirUrl = `${baseUrl}/${parentDir}`;
        await ensureDirectoryExists(parentDirUrl, authHeader);
      }

      console.log(`[WebDAV] 发起单次 PUT 上传 -> ${targetUrl}`);

      const putBody = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      const doPut = () => fetch(proxyUrl, {
        method: 'PUT',
        cache: 'no-store',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Overwrite: 'T',
        },
        body: putBody,
      });

      let res = await doPut();

      // 远端父目录不存在时（Koofr 等 WebDAV 服务端对 PUT 直接返回 404/409），
      // 先 MKCOL 自动创建父级文件夹，再重试一次 PUT。
      if (res.status === 404 || res.status === 409) {
        const dirCreated = await ensureParentDir(config, `/${cleanPath}`);
        if (dirCreated) {
          console.log(`[WebDAV] 已自动创建父目录，重试 PUT -> ${targetUrl}`);
          res = await doPut();
        }
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      lastUploadSuccessTime = Date.now();
      // 仅在独立的 storage 键写入同步元数据，禁止触发全局 Store 响应。
      setLastSyncTime(new Date(lastUploadSuccessTime).toISOString());
      addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: true });
      console.log('[WebDAV] 上传成功并已释放锁');
      return { success: true, message: '备份成功' };
    } catch (err) {
      const message = err instanceof Error ? err.message : '备份失败';
      console.error('[WebDAV] 上传失败:', err);
      addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: false, message });
      return { success: false, message };
    } finally {
      // 无论成功/失败，都必须释放互斥锁，让后续触发可以再次上传。
      activeUploadPromise = null;
    }
  })();

  return activeUploadPromise;
}

/**
 * 单例防抖入口：用户完成保存动作时【显式】调用本函数，而非通过隐式监听触发。
 * 在防抖窗口内连续调用会合并为最后一次 payload，仅执行一次真正的备份；
 * 由 backupToWebDAV 内部的 Promise 锁 + 10s 绝对冷却兜底，绝不会产生并发 PUT。
 *
 * @param payload - 要上传的数据
 * @param delayMs - 防抖窗口（毫秒，默认 800）
 */
export function scheduleBackup(payload: unknown, delayMs = 800): void {
  pendingBackupPayload = payload;
  if (backupDebounceTimer !== null) {
    clearTimeout(backupDebounceTimer);
    backupDebounceTimer = null;
  }
  const timer: (cb: () => void, ms: number) => unknown =
    typeof window !== 'undefined'
      ? (window.setTimeout as (cb: () => void, ms: number) => unknown)
      : (globalThis.setTimeout as (cb: () => void, ms: number) => unknown);
  backupDebounceTimer = timer(() => {
    backupDebounceTimer = null;
    const data = pendingBackupPayload;
    pendingBackupPayload = null;
    backupToWebDAV(data).then((r) => {
      if (!r.success) console.error('[WebDAV] 自动备份失败:', r.message);
    });
  }, delayMs) as number;
}

/**
 * 测试专用：重置模块级上传锁与冷却状态（不应在生产调用）。
 */
export function __resetWebDAVAutoBackup(): void {
  activeUploadPromise = null;
  lastUploadSuccessTime = 0;
  if (backupDebounceTimer !== null) {
    clearTimeout(backupDebounceTimer);
    backupDebounceTimer = null;
  }
  pendingBackupPayload = null;
}