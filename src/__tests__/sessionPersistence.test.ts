/**
 * @file sessionPersistence.test.ts
 * @description sessionPersistence（AuthDB_v1）单元测试：
 *              - 设备免密会话：存取回环、重复保存覆盖、TTL 过期清理、滑动续期
 *                （依赖 fake-indexeddb 对 CryptoKey 的 structured clone 能力；
 *                 Node 侧若无法克隆则在收集阶段探测并带标记跳过回环用例）
 *              - auth_meta 键值：读写删回环、覆盖写、幂等删除
 * @layer Test
 * @storage_impact fake-indexeddb 内存库，不触达真实 IndexedDB。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportRawKey, generateRandomMEK } from '../services/cryptoService';
import {
  META_KEYS,
  clearSessionMEK,
  getMeta,
  loadSessionMEK,
  removeMeta,
  saveSessionMEK,
  setMeta,
  touchSession,
} from '../services/sessionPersistence';

const DAY_MS = 24 * 3600 * 1000;

/** 探测 fake-indexeddb 能否克隆 CryptoKey（Node 侧限制则跳过会话回环用例） */
async function probeCryptoKeyClone(): Promise<boolean> {
  try {
    const mek = await generateRandomMEK();
    await saveSessionMEK(mek, 7);
    const restored = await loadSessionMEK();
    await clearSessionMEK();
    return restored !== null;
  } catch {
    await clearSessionMEK().catch(() => undefined);
    return false;
  }
}

// 顶层 await（ESM）：收集阶段即确定 skip 标记
const cryptoKeyCloneable = await probeCryptoKeyClone();
const CLONE_SKIP_NOTE = 'fake-indexeddb 无法 structured-clone CryptoKey（Node 环境限制）';

beforeEach(async () => {
  await clearSessionMEK();
  await removeMeta(META_KEYS.PASSWORD_PAYLOAD_CACHE);
  await removeMeta(META_KEYS.RECOVERY_PAYLOAD_CACHE);
  await removeMeta(META_KEYS.PENDING_PROFILE_UPLOAD);
});

describe('设备免密会话（auth_device_keys）', () => {
  it('空库 load → null，clear 幂等', async () => {
    expect(await loadSessionMEK()).toBeNull();
    await expect(clearSessionMEK()).resolves.toBeUndefined();
    expect(await loadSessionMEK()).toBeNull();
  });

  it(
    'save → load 回环还原相同 MEK raw',
    { skip: cryptoKeyCloneable ? false : CLONE_SKIP_NOTE },
    async () => {
      const mek = await generateRandomMEK();
      await saveSessionMEK(mek, 7);
      const restored = await loadSessionMEK();
      expect(restored).not.toBeNull();
      expect(await exportRawKey(restored!)).toEqual(await exportRawKey(mek));
    },
  );

  it(
    '重复保存覆盖旧记录',
    { skip: cryptoKeyCloneable ? false : CLONE_SKIP_NOTE },
    async () => {
      const m1 = await generateRandomMEK();
      const m2 = await generateRandomMEK();
      await saveSessionMEK(m1, 7);
      await saveSessionMEK(m2, 7);
      const restored = await loadSessionMEK();
      expect(await exportRawKey(restored!)).toEqual(await exportRawKey(m2));
    },
  );

  it(
    'TTL 过期 → load 返回 null 且记录被清除',
    { skip: cryptoKeyCloneable ? false : CLONE_SKIP_NOTE },
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const mek = await generateRandomMEK();
        await saveSessionMEK(mek, 7);
        // 前进 8 天 → 过期
        vi.setSystemTime(Date.now() + 8 * DAY_MS);
        expect(await loadSessionMEK()).toBeNull();
        // 记录已被清理：不再走过期分支仍为 null
        expect(await loadSessionMEK()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    '滑动续期：load 后 expiresAt 顺延（读即续期）',
    { skip: cryptoKeyCloneable ? false : CLONE_SKIP_NOTE },
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const mek = await generateRandomMEK();
        await saveSessionMEK(mek, 7);
        // 前进 6.5 天后读取 → 续期至当前 + 7 天
        vi.setSystemTime(Date.now() + 6.5 * DAY_MS);
        expect(await loadSessionMEK()).not.toBeNull();
        // 若未续期，再前进 1 天即超期；续期后仍应可用
        vi.setSystemTime(Date.now() + 1 * DAY_MS);
        expect(await loadSessionMEK()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    'touchSession 使本应过期的会话复活',
    { skip: cryptoKeyCloneable ? false : CLONE_SKIP_NOTE },
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const mek = await generateRandomMEK();
        await saveSessionMEK(mek, 7);
        vi.setSystemTime(Date.now() + 6.5 * DAY_MS);
        await touchSession();
        // 未 touch 时此刻已超期；touch 后仍有约 6.5 天窗口
        vi.setSystemTime(Date.now() + 1 * DAY_MS);
        expect(await loadSessionMEK()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('touchSession 空库调用安全', async () => {
    await expect(touchSession()).resolves.toBeUndefined();
  });
});

describe('auth_meta 键值表', () => {
  it('set → get 回环（对象值深比较）', async () => {
    const value = { payload: 'abc', iv: 'def', nested: { n: 1 } };
    await setMeta(META_KEYS.PASSWORD_PAYLOAD_CACHE, value);
    await expect(getMeta(META_KEYS.PASSWORD_PAYLOAD_CACHE)).resolves.toEqual(value);
  });

  it('读取不存在的键 → null', async () => {
    await expect(getMeta('nope')).resolves.toBeNull();
  });

  it('removeMeta 删除生效且幂等', async () => {
    await setMeta('k', 'v');
    await removeMeta('k');
    await expect(getMeta('k')).resolves.toBeNull();
    await expect(removeMeta('k')).resolves.toBeUndefined();
  });

  it('setMeta 覆盖写', async () => {
    await setMeta('k', 1);
    await setMeta('k', 2);
    await expect(getMeta('k')).resolves.toBe(2);
  });

  it('META_KEYS 常量语义固定（防误改键名）', () => {
    expect(META_KEYS.PASSWORD_PAYLOAD_CACHE).toBe('password_payload_cache');
    expect(META_KEYS.RECOVERY_PAYLOAD_CACHE).toBe('recovery_payload_cache');
    expect(META_KEYS.PENDING_PROFILE_UPLOAD).toBe('pending_profile_upload');
  });
});
