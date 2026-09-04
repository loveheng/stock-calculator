/**
 * @file ioSlice.ts
 * @description Store 导入导出切片：内存导出（exportData）/ 全量导入（importData，含
 *              风控完整性校验与远端同步防回环标记）/ JSON 导出（合并 DB 归档数据）/
 *              JSON 导入 / CSV 导出；以及服务端密文同步编排（M3）：推送/恢复/冲突处理/
 *              启动对账（spec §7.3 决策树）。从 store/index.ts 拆出，index 只负责组装。
 * @layer Store (Slice)
 * @storage_impact importData 经 safePersist 全量落库；exportJSON 只读 DB 归档数据；
 *                 服务端同步读写 localStorage 'server_sync_meta_v1'（经 services/serverSync）。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import { getIsSyncingFromRemote, safePersist, setIsSyncingFromRemote } from '../persistence';
import { recordAudit } from '../../risk/auditLogger';
import { importDataIntegrityRule } from '../../risk/validator';
import { safeImportAllData } from '../../db/index';
import { runRiskValidation } from '../reconcile';
import { EXPORT_VERSION } from '../types';
import type { AppStore, AppStoreExport, TRoundArchive } from '../types';
import { useAuthStore } from '../useAuthStore';
import { loadStoredAuthSession } from '../../services/authSession';
import { decryptText, encryptText } from '../../services/cryptoService';
import { deserializeSnapshot, serializeSnapshot } from '../../services/snapshotService';
import { mergeData } from '../../services/webdavSync';
import {
  buildBackupEnvelope,
  fetchSyncMeta,
  isEmptySnapshot,
  parseBackupEnvelope,
  pullBackupEnvelope,
  pushBackup,
  readServerSyncMeta,
  scheduleServerBackup,
  writeServerSyncMeta,
} from '../../services/serverSync';
import type { ServerPushResult, ServerSyncGate, ServerSyncMeta } from '../../services/serverSync';

export type IoSlice = Pick<
  AppStore,
  | 'exportData'
  | 'importData'
  | 'exportJSON'
  | 'importJSON'
  | 'exportCSV'
  | 'pushServerSnapshot'
  | 'restoreFromServer'
  | 'resolveServerConflict'
  | 'startupServerSyncCheck'
  | 'dismissServerError'
>;

// ============================================================
// 服务端密文同步（登录即备份）——编排层（M3）
// 权威依据：docs/server-sync-spec.md §7（协议）/ §8（触发管线）；
//          docs/server-sync-implementation.md §5.3（ioSlice 增量）。
// 模块级编排状态不进 UI state；测试经 __resetServerSyncSlice 重置。
// ============================================================

/** 前台对账间隔（D13）：15 分钟 */
const RECONCILE_INTERVAL_MS = 15 * 60_000;
/** 失败退避（§8.3）：10s × 2^n，上限 10min；成功后归零 */
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** §7.3「有待传修改」：initAutoSync 引用比较触发过、尚未成功推送 */
let hasPendingLocalChanges = false;
/** 连续失败计数（成功归零） */
let serverPushFailureCount = 0;
/** 42901 单次 retryAfter 豁免（§8.3：静默等待重试一次，仍失败进退避） */
let rateRetryArmed = false;
/** 前台对账监听是否已注册（幂等） */
let reconcileRegistered = false;

type SliceGet = () => AppStore;
type SliceSet = (partial: Partial<AppStore>) => void;

/** 会话凭证：token（authSession）+ 会话 MEK（auth store 内存态）；不完整 = 通道禁用（D15） */
function getServerCredential(): { token: string; mek: CryptoKey } | null {
  const auth = useAuthStore.getState();
  const token = loadStoredAuthSession()?.token;
  if (!auth.isAuthenticated || !auth.mek || !token) return null;
  return { token, mek: auth.mek };
}

/** 推送门控（§8.2 ①②）：已登录 + MEK 可用 + 服务端同步开关开启。initAutoSync 接线与重调度共用 */
export function buildServerSyncGate(doPush: () => Promise<void>): ServerSyncGate {
  return {
    canPush: () => getServerCredential() !== null && readServerSyncMeta().enabled,
    doPush,
  };
}

/** §7.3「有待传修改」标记：initAutoSync 双通道接线时调用；成功推送（含 deduped）后清除 */
export function markServerPushPending(): void {
  hasPendingLocalChanges = true;
}

/** 测试专用：重置模块级编排状态（不应在生产调用） */
export function __resetServerSyncSlice(): void {
  hasPendingLocalChanges = false;
  serverPushFailureCount = 0;
  rateRetryArmed = false;
  reconcileRegistered = false;
}

/** 单次 CAS 上传；空快照（非 force）返回 null 表示跳过（D9 墓碑保护） */
async function pushOnce(get: SliceGet, force: boolean): Promise<ServerPushResult | null> {
  const cred = getServerCredential();
  if (!cred) return null;
  const data = get().exportData();
  if (!force && isEmptySnapshot(data)) return null;
  const snapshot = serializeSnapshot(data);
  const { iv, ct } = await encryptText(snapshot, cred.mek);
  return pushBackup(cred.token, readServerSyncMeta().lastSeenCloudVersion, buildBackupEnvelope(iv, ct));
}

/** 成功收敛：lastSeen 恒用响应返回版本（E2，不自算），失败计数全部归零 */
function applyPushSuccess(set: SliceSet, version: number): void {
  writeServerSyncMeta({ lastSeenCloudVersion: version });
  hasPendingLocalChanges = false;
  serverPushFailureCount = 0;
  rateRetryArmed = false;
  set({ serverLastVersion: version, serverLastError: null });
}

/**
 * 拉取 → 解密 → 智能合并进本地（不覆盖本地）。失败置 serverLastError 并返回 null。
 * 末尾让出一个宏任务：importData(silent) 置位的 isSyncingFromRemote 由 setTimeout(0)
 * 复位，调用方（决策树重推/覆盖重推）继续执行时标记已复位，不会被误拦。
 */
async function pullDecryptMerge(
  cred: { token: string; mek: CryptoKey },
  get: SliceGet,
  set: SliceSet,
): Promise<{ version: number } | null> {
  try {
    const pulled = await pullBackupEnvelope(cred.token);
    const env = parseBackupEnvelope(pulled.envelope);
    if (!env) {
      set({ serverLastError: '云端密文信封格式异常，无法解析' });
      return null;
    }
    // GCM 认证失败（密钥不匹配/密文被篡改）在此抛出，统一走 catch
    const plaintext = await decryptText(env.iv, env.ct, cred.mek);
    const snap = deserializeSnapshot(plaintext);
    if (!snap) {
      set({ serverLastError: '云端快照解析失败（密钥不匹配或数据已损坏）' });
      return null;
    }
    const m = mergeData(get().exportData(), snap.data);
    const mergedExport: AppStoreExport = {
      version: EXPORT_VERSION,
      feeConfig: m.feeConfig,
      tRounds: m.tRounds,
      positions: m.positions,
      stocks: m.stocks,
      longTermRecords: m.longTermRecords,
      plannedOrders: m.plannedOrders,
    };
    get().importData(mergedExport, true);   // silent：置 isSyncingFromRemote 防回环
    writeServerSyncMeta({ lastSeenCloudVersion: pulled.version });
    set({ serverLastVersion: pulled.version });
    await new Promise((r) => setTimeout(r, 0));
    return { version: pulled.version };
  } catch (e) {
    console.error('[ServerSync] 云端拉取/解密/合并失败:', e);
    set({ serverLastError: '云端数据拉取或解密失败（密钥不匹配或网络异常）' });
    return null;
  }
}

/** 失败退避（§8.3）：连续失败按 10s × 2^n（上限 10min）释放锁后重新注入调度器，静默 */
function scheduleBackoffRetry(get: SliceGet): void {
  serverPushFailureCount += 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (serverPushFailureCount - 1), BACKOFF_MAX_MS);
  scheduleServerBackup(undefined, buildServerSyncGate(() => get().pushServerSnapshot()), delay);
}

/**
 * 42901 处理：首次按 retryAfter 重新注入调度器（E9：不持锁 sleep、不计失败退避、不报 UI 错）；
 * 紧随其后再次 42901 → 进入失败退避（§8.3「重试一次，仍失败进退避」）。
 * 调度器延迟触发时本函数已返回、Web Locks 锁已释放，满足 E9 时序约束。
 */
function handleRateLimited(get: SliceGet, retryAfterSeconds: number): void {
  if (rateRetryArmed) {
    rateRetryArmed = false;
    scheduleBackoffRetry(get);
    return;
  }
  rateRetryArmed = true;
  scheduleServerBackup(
    undefined,
    buildServerSyncGate(() => get().pushServerSnapshot()),
    Math.max(1, retryAfterSeconds) * 1000,
  );
}

/**
 * 推送结果分流（直推与 409 重推共用；isRepush=true 时冲突为终态 → 交 UI）。
 * conflict 路径：拉取 → 合并 → 以合并结果重推一轮（§7.1 冲突分支）。
 */
async function handlePushOutcome(
  get: SliceGet,
  set: SliceSet,
  result: ServerPushResult,
  isRepush: boolean,
): Promise<void> {
  if (result.ok) {
    applyPushSuccess(set, result.version);
    return;
  }
  if (result.reason === 'rate') {
    handleRateLimited(get, result.retryAfterSeconds ?? 1);
    return;
  }
  if (result.reason === 'network') {
    scheduleBackoffRetry(get);            // 静默退避，不报 UI 错（§8.3）
    return;
  }
  if (result.reason === 'invalid') {
    // 本地数据/协议问题，重试无意义（spec §6.3：提示重试）
    set({ serverLastError: `推送被服务端拒绝（${result.message ?? '数据格式非法'}）` });
    return;
  }
  // conflict / empty-conflict
  if (isRepush) {
    // 仅一轮自动处理（§5.3）：重推仍冲突 → 交 UI 手动合并/覆盖
    set({ serverLastError: `云端版本持续冲突（云端 v${result.latest?.version ?? '?'}），请手动合并或覆盖` });
    return;
  }
  const cred = getServerCredential();
  if (!cred) return;
  const merged = await pullDecryptMerge(cred, get, set);
  if (!merged) {
    // pullDecryptMerge 已置更具体的错误信息；仅在缺失时兜底
    if (!get().serverLastError) {
      set({ serverLastError: '冲突处理失败：云端数据拉取或解密失败' });
    }
    return;
  }
  set({ serverLastError: null });
  const repush = await pushOnce(get, false);
  if (repush) await handlePushOutcome(get, set, repush, true);
}

/** 前台对账监听（D13）：visibilitychange 回前台 + 15min 定时。PWA 单页生命周期内常驻，无需卸载 */
function registerReconcileListeners(get: SliceGet): void {
  if (reconcileRegistered) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  reconcileRegistered = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void get().startupServerSyncCheck();
  });
  window.setInterval(() => void get().startupServerSyncCheck(), RECONCILE_INTERVAL_MS);
}

export const createIoSlice: StateCreator<AppStore, [], [], IoSlice> = (set, get) => ({

  exportData: () => { const state = get(); return { version: EXPORT_VERSION, feeConfig: state.feeConfig, tRounds: state.tRounds, positions: state.positions, stocks: state.stocks, longTermRecords: state.longTermRecords, plannedOrders: state.plannedOrders }; },

  importData: (data, silent) => {
    // 【风控 R3】导入数据完整性校验
    const riskReport = runRiskValidation([importDataIntegrityRule(data)], data, undefined);
    if (riskReport.blocked) {
      console.warn('[Risk] 导入数据校验未通过:', riskReport.summary);
      return;
    }
    const rounds = data.tRounds ?? [];
    set({ feeConfig: data.feeConfig, tRounds: rounds, positions: data.positions ?? [], stocks: data.stocks ?? [], longTermRecords: data.longTermRecords ?? [], plannedOrders: data.plannedOrders ?? [] });
    safePersist(() => safeImportAllData(data.feeConfig, data.positions ?? [], rounds, data.stocks ?? [], data.longTermRecords ?? [], data.plannedOrders ?? []));
    // silent 模式：来自远端拉取合并（Pull & Merge），跳过后续自动上传/同步逻辑
    // 设置 isSyncingFromRemote 标记，自动同步监听器必须检查此标记后跳过触发
    if (silent) {
      setIsSyncingFromRemote(true);
      // 下轮微任务中自动复位，确保不影响后续用户手动触发同步
      // 使用 setTimeout(0) 而非 Promise.resolve().then()，因为 Zustand set 同步执行，
      // 自动同步监听器若使用 store.subscribe 会同步/微任务内触发，需要在此之后才复位
      setTimeout(() => { setIsSyncingFromRemote(false); }, 0);
    }
    // 【风控审计】记录导入操作
    recordAudit('import_data', 'system', 'all', 'success', {
      tags: { silent: String(silent), version: String(data.version) },
    });
  },

  exportJSON: async () => {
    const state = get();
    const [closedPositions, completedRounds, ltRecs] = await Promise.all([
      import('../../db/index').then(m => m.fetchAllClosedPositions()),
      import('../../db/index').then(m => m.fetchAllCompletedRounds()),
      import('../../db/index').then(m => m.fetchAllLongTermRecords()),
    ]);
    // 合并 state.tRounds（OPENED 含流水 + COMPLETED 概览）与 DB 完整明细，
    // 按 id 去重并保留含 transactions 的完整版本（导入后流水不丢失）
    const roundMap = new Map<string, TRoundArchive>();
    for (const r of [...state.tRounds, ...completedRounds]) {
      const existing = roundMap.get(r.id);
      if (!existing || (r.transactions?.length ?? 0) > (existing.transactions?.length ?? 0)) {
        roundMap.set(r.id, r);
      }
    }
    return { version: EXPORT_VERSION, feeConfig: state.feeConfig, tRounds: Array.from(roundMap.values()), positions: [...state.positions, ...closedPositions], stocks: state.stocks, longTermRecords: [...state.longTermRecords, ...ltRecs], plannedOrders: state.plannedOrders };
  },

  importJSON: (data) => {
    if (data.version !== EXPORT_VERSION) console.warn(`[Store] 导入数据版本 (${data.version}) 与当前版本 (${EXPORT_VERSION}) 不一致，尝试继续导入，但部分字段可能不兼容。`);
    get().importData(data);
  },

  exportCSV: () => {
    // v8：Round 是唯一数据源，CSV 从 tRounds 导出（OPENED + COMPLETED）
    const rounds = get().tRounds;
    const headers = ['日期', '股票名称', '模式', '状态', '净收益', '买入量', '卖出量', '手续费', '成交笔数'];
    const rows = rounds.map(r => [new Date(r.closedAt ?? r.openedAt).toLocaleDateString(), r.stockName, r.mode === 'long' ? '正T' : '倒T', r.status === 'COMPLETED' ? '已结清' : '进行中', (r.netProfit ?? 0).toFixed(2), String(r.buyAmount ?? ''), String(r.sellAmount ?? ''), String(r.totalFees ?? 0), String(r.tradeCount ?? r.transactions?.length ?? 0)]);
    return [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n');
  },

  // ============================================================
  // 服务端密文同步 actions（M3，编排逻辑见文件头部模块级辅助函数区）
  // ============================================================

  pushServerSnapshot: async (opts) => {
    const force = opts?.force === true;
    // 远端导入进行中不推送（防回环）；force（显式墓碑/覆盖）例外
    if (getIsSyncingFromRemote() && !force) return;
    if (get().serverSyncing) return;   // UI 态互斥：防 UI 直触与管线并发
    set({ serverSyncing: true });
    try {
      const first = await pushOnce(get, force);
      if (first) await handlePushOutcome(get, set, first, false);
    } finally {
      set({ serverSyncing: false });
    }
  },

  restoreFromServer: async () => {
    const cred = getServerCredential();
    if (!cred) return;
    set({ serverSyncing: true });
    try {
      await pullDecryptMerge(cred, get, set);
    } finally {
      set({ serverSyncing: false });
    }
  },

  resolveServerConflict: async (mode) => {
    const cred = getServerCredential();
    if (!cred) return;
    // 云端 → 本地合并（不覆盖本地）；lastSeen 收敛为云端版本，后续推送不再 409
    const merged = await pullDecryptMerge(cred, get, set);
    if (!merged) return;
    set({ serverLastError: null });
    if (mode === 'overwrite-cloud') {
      // §5.5 定案：以本地覆盖云端 = 合并后 force 重推（云端立即收敛为合并结果）
      await get().pushServerSnapshot({ force: true });
    }
  },

  startupServerSyncCheck: async () => {
    registerReconcileListeners(get);
    const cred = getServerCredential();
    if (!cred) return;                   // D15：未登录/无 MEK 通道禁用
    try {
      const meta: ServerSyncMeta = await fetchSyncMeta(cred.token);
      set({ serverLastVersion: meta.hasData ? meta.version : null });
      const lastSeen = readServerSyncMeta().lastSeenCloudVersion;
      if (!meta.hasData) {
        // 云端空：本地有数据 → 首传（baseVersion=lastSeen）；本地空 → 无动作
        if (!isEmptySnapshot(get().exportData())) await get().pushServerSnapshot();
        return;
      }
      if (meta.version < lastSeen) {
        // 回退告警（D14）：不自动动作，交 UI 提供 [以本地覆盖云端] / [忽略]
        set({ serverLastError: `云端版本回退（云端 v${meta.version} < 本机已确认 v${lastSeen}），可能为服务端回滚，请选择覆盖或忽略` });
        return;
      }
      if (meta.version === lastSeen) {
        // 有待传修改 → 正常推送；无修改 → 无动作
        if (hasPendingLocalChanges) await get().pushServerSnapshot();
        return;
      }
      // meta.version > lastSeen：拉取 → 合并；本地有待传修改 → 合并结果重推（§7.1）
      await get().restoreFromServer();
      if (hasPendingLocalChanges) await get().pushServerSnapshot();
    } catch (e) {
      // 对账兑底：会话失效/中途失败不向调用方扩散（登录订阅处为 void 调用）
      console.warn('[ServerSync] 启动对账中断:', e);
    }
  },

  /** 回退告警/错误提示 [忽略]：仅清 UI 错误，不动云端与 lastSeen（D14 决策权在用户） */
  dismissServerError: () => {
    set({ serverLastError: null });
  },
});
