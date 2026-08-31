/**
 * @file sessionPersistence.ts
 * @description 设备层免密会话与认证元数据持久化：独立 Dexie 实例 AuthDB_v1，
 *              与业务库 TradingLedgerDB_v3 完全隔离（决策 D5）。
 *              - auth_device_keys：DeviceKey（非导出 CryptoKey）加密的 MEK 单记录，滑动续期；
 *              - auth_meta：password_payload_cache / recovery_payload_cache / pending_profile_upload。
 * @layer Service
 * @storage_impact 读写 IndexedDB（AuthDB_v1）；所有落盘内容均为密文或非敏感元数据，
 *                 MEK raw bytes 永不落盘（仅以 DeviceKey 封装形态存在）。
 */

import Dexie from 'dexie';
import { exportRawKey, wrapMEK, unwrapMEK } from './cryptoService';
import type { AuthMetaRecord, DeviceSessionRecord } from '../types/auth';

class AuthDB extends Dexie {
  authDeviceKeys!: Dexie.Table<DeviceSessionRecord, 'current_session'>;
  authMeta!: Dexie.Table<AuthMetaRecord, string>;

  constructor() {
    super('AuthDB_v1');
    this.version(1).stores({
      auth_device_keys: 'id',
      auth_meta: 'key',
    });
    // Dexie 仅按表名原样生成实例属性（auth_device_keys/auth_meta），
    // 必须显式绑定到 camelCase 声明，否则运行时为 undefined
    this.authDeviceKeys = this.table('auth_device_keys');
    this.authMeta = this.table('auth_meta');
  }
}

const authDb = new AuthDB();

/** auth_meta 预定义键 */
export const META_KEYS = {
  /** KEK 封装 MEK 密文缓存：登录/解锁重拉成功后写入；登出、无 Session 初始化时清除 */
  PASSWORD_PAYLOAD_CACHE: 'password_payload_cache',
  /** Recovery Key 封装 MEK 密文缓存：助记词找回密码依赖（后端 recovery 会话不可读档案） */
  RECOVERY_PAYLOAD_CACHE: 'recovery_payload_cache',
  /** 注册闭环上传失败待传队列（登出时保留——已备份助记词的唯一补传线索，决策 D7） */
  PENDING_PROFILE_UPLOAD: 'pending_profile_upload',
} as const;

function ttlMsOf(ttlDays: number): number {
  return ttlDays * 24 * 3600 * 1000;
}

/**
 * 保存设备免密会话：生成全新非导出 DeviceKey（extractable:false），
 * 加密 MEK raw bytes 后连同 CryptoKey 对象整体覆盖落库。
 * 每次调用重建（旧记录作废），"记住登录"开关与 TTL 由调用方传入。
 */
export async function saveSessionMEK(mek: CryptoKey, ttlDays: number): Promise<void> {
  try {
    // 非导出设备密钥：永不存在 raw 字节、不可导出，仅在浏览器内可用
    const deviceKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // extractable:false
      ['encrypt', 'decrypt'],
    );
    const wrapped = await wrapMEK(mek, deviceKey);
    const ttlMs = ttlMsOf(ttlDays);
    const record: DeviceSessionRecord = {
      id: 'current_session',
      encryptedMekRaw: wrapped.payload,
      deviceIv: wrapped.iv,
      deviceKey,
      expiresAt: Date.now() + ttlMs,
      ttlMs,
    };
    await authDb.authDeviceKeys.put(record);
  } catch (e) {
    throw new Error(`本地存储异常：无法保存免密会话（${e instanceof Error ? e.message : '未知错误'}）`);
  }
}

/**
 * 读取设备免密会话：
 * - 无记录 → null；
 * - 已过期 → 清除并返回 null；
 * - 有效 → 解封 MEK 并滑动续期（expiresAt = now + ttlMs 写回）。
 * 任何解封/读取失败均按"会话不可用"处理（清除后返回 null），绝不向上抛、
 * 严禁把解密失败产物当 MEK 返回。
 */
export async function loadSessionMEK(): Promise<CryptoKey | null> {
  try {
    const record = await authDb.authDeviceKeys.get('current_session');
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      await clearSessionMEK();
      return null;
    }
    const mek = await unwrapMEK(record.encryptedMekRaw, record.deviceIv, record.deviceKey);
    // 滑动续期：读取即续期（与读取同事务语义，防多标签页竞态覆盖）
    await authDb.authDeviceKeys.update('current_session', {
      expiresAt: Date.now() + record.ttlMs,
    });
    return mek;
  } catch {
    // deviceKey 缺失/损坏（含浏览器不支持 CryptoKey structured clone 的还原失败）
    await clearSessionMEK().catch(() => undefined);
    return null;
  }
}

/**
 * 滑动续期：仅刷新 expiresAt（用户核心交互/切回前台时调用）。
 * 无记录或已过期时静默清理，不抛错、不弹提示。
 */
export async function touchSession(): Promise<void> {
  try {
    const record = await authDb.authDeviceKeys.get('current_session');
    if (!record) return;
    if (Date.now() > record.expiresAt) {
      await clearSessionMEK();
      return;
    }
    await authDb.authDeviceKeys.update('current_session', {
      expiresAt: Date.now() + record.ttlMs,
    });
  } catch {
    // 静默：续期失败不影响主流程
  }
}

/** 彻底清除设备免密记录（幂等） */
export async function clearSessionMEK(): Promise<void> {
  try {
    await authDb.authDeviceKeys.delete('current_session');
  } catch {
    // 幂等：删除失败按已清除处理
  }
}

// ---- auth_meta 键值 ----

export async function getMeta<T>(key: string): Promise<T | null> {
  try {
    const record = await authDb.authMeta.get(key);
    return record ? (record.value as T) : null;
  } catch (e) {
    throw new Error(`本地存储异常：读取失败（${e instanceof Error ? e.message : '未知错误'}）`);
  }
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  try {
    await authDb.authMeta.put({ key, value });
  } catch (e) {
    throw new Error(`本地存储异常：写入失败（${e instanceof Error ? e.message : '未知错误'}）`);
  }
}

export async function removeMeta(key: string): Promise<void> {
  try {
    await authDb.authMeta.delete(key);
  } catch {
    // 幂等
  }
}
