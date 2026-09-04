/**
 * @file serverSync.test.ts
 * @description 服务端密文同步服务层单元测试：信封 build/parse/校验和、pushBackup 错误码映射
 *              （含 413/E6 与 401 透传）、meta/pull 封装、encryptText 回环、
 *              设备 meta 读写、防抖推送管线（防抖合并/门控/冷却/互斥/跨标签页锁）。
 *              运行环境：Node（WebCrypto 由全局 crypto 提供，Node 18+）；
 *              时序类用例沿用 webdavSync.test.ts 模式：真实定时器 + vi.waitFor。
 * @layer Test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock localStorage for Node.js test environment
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

import {
  SYNC_API_BASE_URL,
  buildBackupEnvelope,
  envelopeToString,
  parseBackupEnvelope,
  sha256Hex,
  fetchSyncMeta,
  pullBackupEnvelope,
  pushBackup,
  readServerSyncMeta,
  writeServerSyncMeta,
  scheduleServerBackup,
  cancelServerBackup,
  __resetServerSync,
  isEmptySnapshot,
} from '../services/serverSync';
import type { BackupEnvelopeV1 } from '../services/serverSync';
import {
  encryptText,
  decryptText,
  generateRandomMEK,
  base64ToBytes,
  bytesToBase64,
} from '../services/cryptoService';
import { AuthApiError, SessionExpiredError } from '../services/apiClient';
import type { AppStoreExport } from '../store/types';

/** 12 字节 IV 的 base64 长度 */
const IV_B64_LEN = 16;

/** 构造 JSON 信封响应（后端契约：HTTP 恒 200 + code 分支） */
function envelopeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 构造成功的 PUT 响应 */
function okPush(version: number, deduped = false): Response {
  return envelopeResponse({ code: 200, message: 'ok', data: { version, deduped } });
}

/** 构造结构合法的 v1 信封 */
function buildEnv(): BackupEnvelopeV1 {
  return buildBackupEnvelope('aXZfMTIzNDU2Nzg', 'Y2lwaGVydGV4dA');
}

/** 构造全空快照（isEmptySnapshot 用） */
function emptySnapshot(): AppStoreExport {
  return {
    version: 1,
    feeConfig: {} as AppStoreExport['feeConfig'],
    tRounds: [],
    positions: [],
    stocks: [],
    longTermRecords: [],
    plannedOrders: [],
  };
}

// ============================================================
// 1. 信封 build / parse / envelopeToString
// ============================================================

describe('信封 build/parse/envelopeToString', () => {
  it('build → envelopeToString → parse 往返一致', () => {
    const env = buildEnv();
    const parsed = parseBackupEnvelope(envelopeToString(env));
    expect(parsed).toEqual(env);
  });

  it('SYNC_API_BASE_URL 恒为同源相对路径 /api/sync（契约冻结）', () => {
    expect(SYNC_API_BASE_URL).toBe('/api/sync');
  });

  it('畸形 JSON / 非对象 → null', () => {
    expect(parseBackupEnvelope('not json')).toBeNull();
    expect(parseBackupEnvelope('null')).toBeNull();
    expect(parseBackupEnvelope('123')).toBeNull();
    expect(parseBackupEnvelope('"str"')).toBeNull();
    expect(parseBackupEnvelope('')).toBeNull();
  });

  it('结构非法 → null：缺字段 / v!=1 / alg 不符 / iv 或 ct 空串', () => {
    expect(parseBackupEnvelope('{}')).toBeNull();
    expect(parseBackupEnvelope('{"v":1,"alg":"A256GCM"}')).toBeNull();
    expect(parseBackupEnvelope('{"v":2,"alg":"A256GCM","iv":"x","ct":"y"}')).toBeNull();
    expect(parseBackupEnvelope('{"v":1,"alg":"AES-128","iv":"x","ct":"y"}')).toBeNull();
    expect(parseBackupEnvelope('{"v":1,"alg":"A256GCM","iv":"","ct":"y"}')).toBeNull();
    expect(parseBackupEnvelope('{"v":1,"alg":"A256GCM","iv":"x","ct":""}')).toBeNull();
  });
});

// ============================================================
// 2. sha256Hex 已知向量
// ============================================================

describe('sha256Hex', () => {
  it('已知向量（FIPS 180-4 "abc"）', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('空串向量', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

// ============================================================
// 3. pushBackup 错误码映射（spec §6.3 + E5/E6）
// ============================================================

describe('pushBackup 错误码映射', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUT 请求体与头：Bearer、baseVersion、envelope、payloadHash、payloadBytes（spec §4.2）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okPush(7));
    vi.stubGlobal('fetch', fetchMock);

    const env = buildEnv();
    const result = await pushBackup('tok-123', 6, env);
    expect(result).toEqual({ ok: true, version: 7, deduped: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sync/backup');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const raw = envelopeToString(env);
    expect(body.baseVersion).toBe(6);
    expect(body.envelope).toBe(raw);
    expect(body.payloadHash).toBe(await sha256Hex(raw));
    expect(body.payloadBytes).toBe(new TextEncoder().encode(raw).length);
  });

  it('200 + deduped=true → ok deduped（响应丢失重试幂等豁免，D7）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okPush(6, true)));
    const result = await pushBackup('tok', 6, buildEnv());
    expect(result).toEqual({ ok: true, version: 6, deduped: true });
  });

  it('40901 → conflict 且 latest 为服务端 meta', async () => {
    const latest = {
      hasData: true,
      version: 7,
      updatedAt: '2026-09-04T03:10:37Z',
      payloadHash: 'a'.repeat(64),
      payloadBytes: 287431,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelopeResponse({ code: 40901, message: '版本冲突', data: latest })),
    );
    const result = await pushBackup('tok', 6, buildEnv());
    expect(result).toEqual({ ok: false, reason: 'conflict', latest });
  });

  it('40902 → empty-conflict（baseVersion=0 但云端已有数据）', async () => {
    const latest = { hasData: true, version: 3 };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelopeResponse({ code: 40902, message: '首传冲突', data: latest })),
    );
    const result = await pushBackup('tok', 0, buildEnv());
    expect(result).toEqual({ ok: false, reason: 'empty-conflict', latest });
  });

  it('42901 → rate + retryAfterSeconds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        envelopeResponse({ code: 42901, message: '操作过于频繁', data: { retryAfterSeconds: 4 } }),
      ),
    );
    const result = await pushBackup('tok', 6, buildEnv());
    expect(result).toEqual({ ok: false, reason: 'rate', retryAfterSeconds: 4 });
  });

  it('40001 → invalid（信封结构非法/baseVersion 非法）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelopeResponse({ code: 40001, message: '请求格式非法' })),
    );
    const result = await pushBackup('tok', 6, buildEnv());
    expect(result).toEqual({ ok: false, reason: 'invalid', message: '请求格式非法' });
  });

  it('fetch reject → network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await pushBackup('tok', 6, buildEnv());
    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('HTTP 413（非信封响应）→ network + 反代配置文案（E6）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('413 Request Entity Too Large', { status: 413 })),
    );
    const result = await pushBackup('tok', 6, buildEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('network');
      expect(result.message).toContain('client_max_body_size');
    }
  });

  it('非 JSON 响应（网关 HTML 错误页）→ network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 })),
    );
    const result = await pushBackup('tok', 6, buildEnv());
    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('信封 code 401 → SessionExpiredError 透传', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelopeResponse({ code: 401, message: '会话已失效，请重新登录' })),
    );
    await expect(pushBackup('tok', 6, buildEnv())).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('非信封 HTTP 401（拦截器直写）→ SessionExpiredError 透传', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })));
    await expect(pushBackup('tok', 6, buildEnv())).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

// ============================================================
// 4. fetchSyncMeta / pullBackupEnvelope
// ============================================================

describe('fetchSyncMeta', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('云端空 → {hasData:false, version:0}（GET meta + Bearer）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelopeResponse({ code: 200, message: 'ok', data: { hasData: false, version: 0 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const meta = await fetchSyncMeta('tok');
    expect(meta).toEqual({ hasData: false, version: 0 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sync/backup/meta');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('有数据 → 完整 meta（updatedAt/payloadHash/payloadBytes）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        envelopeResponse({
          code: 200,
          message: 'ok',
          data: {
            hasData: true,
            version: 7,
            updatedAt: '2026-09-04T03:10:37Z',
            payloadHash: 'ab'.repeat(32),
            payloadBytes: 287431,
          },
        }),
      ),
    );
    const meta = await fetchSyncMeta('tok');
    expect(meta).toEqual({
      hasData: true,
      version: 7,
      updatedAt: '2026-09-04T03:10:37Z',
      payloadHash: 'ab'.repeat(32),
      payloadBytes: 287431,
    });
  });

  it('非 200 业务码 → AuthApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelopeResponse({ code: 50000, message: '内部错误' })),
    );
    await expect(fetchSyncMeta('tok')).rejects.toBeInstanceOf(AuthApiError);
  });
});

describe('pullBackupEnvelope', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('200 → {version, envelope} 原样透传', async () => {
    const rawEnv = envelopeToString(buildEnv());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        envelopeResponse({
          code: 200,
          message: 'ok',
          data: { version: 7, updatedAt: 'x', payloadHash: 'y', envelope: rawEnv },
        }),
      ),
    );
    const pulled = await pullBackupEnvelope('tok');
    expect(pulled).toEqual({ version: 7, envelope: rawEnv });
  });

  it('40401 云端无备份 → AuthApiError 且 code=40401（调用方走首传分支）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelopeResponse({ code: 40401, message: '云端暂无备份' })),
    );
    const err = await pullBackupEnvelope('tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthApiError);
    expect((err as AuthApiError).code).toBe(40401);
  });

  it('data.envelope 缺失 → Error（响应格式异常）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelopeResponse({ code: 200, message: 'ok', data: { version: 7 } })),
    );
    await expect(pullBackupEnvelope('tok')).rejects.toThrow('格式异常');
  });
});

// ============================================================
// 5. encryptText / decryptText 回环
// ============================================================

describe('encryptText / decryptText 回环', () => {
  it('往返一致且 IV 为 12 字节 base64（16 字符）', async () => {
    const mek = await generateRandomMEK();
    const plaintext = JSON.stringify({ hello: '世界', n: 42 });
    const { iv, ct } = await encryptText(plaintext, mek);
    expect(iv).toHaveLength(IV_B64_LEN);
    await expect(decryptText(iv, ct, mek)).resolves.toBe(plaintext);
  });

  it('错 MEK 拒绝（GCM 认证失败）', async () => {
    const mek = await generateRandomMEK();
    const other = await generateRandomMEK();
    const { iv, ct } = await encryptText('secret', mek);
    await expect(decryptText(iv, ct, other)).rejects.toThrow();
  });

  it('篡改 ct 拒绝（GCM Tag 校验）', async () => {
    const mek = await generateRandomMEK();
    const { iv, ct } = await encryptText('secret', mek);
    const bytes = base64ToBytes(ct);
    bytes[0] ^= 0xff;
    await expect(decryptText(iv, bytesToBase64(bytes), mek)).rejects.toThrow();
  });

  it('同明文两次加密密文不同（随机 IV，规范强制禁止复用）', async () => {
    const mek = await generateRandomMEK();
    const a = await encryptText('same-plaintext', mek);
    const b = await encryptText('same-plaintext', mek);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

// ============================================================
// 6. 设备 meta（localStorage 'server_sync_meta_v1'）
// ============================================================

describe('设备 meta 读写', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('默认值 {lastSeenCloudVersion:0, enabled:true}', () => {
    expect(readServerSyncMeta()).toEqual({ lastSeenCloudVersion: 0, enabled: true });
  });

  it('patch 写入 + 回读回环（独立键名 server_sync_meta_v1）', () => {
    writeServerSyncMeta({ lastSeenCloudVersion: 7 });
    writeServerSyncMeta({ enabled: false });
    expect(readServerSyncMeta()).toEqual({ lastSeenCloudVersion: 7, enabled: false });
    expect(JSON.parse(localStorage.getItem('server_sync_meta_v1')!)).toEqual({
      lastSeenCloudVersion: 7,
      enabled: false,
    });
  });

  it('损坏 JSON → 回退默认值', () => {
    localStorage.setItem('server_sync_meta_v1', '{broken json');
    expect(readServerSyncMeta()).toEqual({ lastSeenCloudVersion: 0, enabled: true });
  });

  it('字段类型非法 → 回退默认值', () => {
    localStorage.setItem(
      'server_sync_meta_v1',
      JSON.stringify({ lastSeenCloudVersion: 'abc', enabled: 'yes' }),
    );
    expect(readServerSyncMeta()).toEqual({ lastSeenCloudVersion: 0, enabled: true });
  });
});

// ============================================================
// 7. isEmptySnapshot（D9 空快照守卫工具）
// ============================================================

describe('isEmptySnapshot', () => {
  it('四类核心数据全空 → true（plannedOrders 不参与判定）', () => {
    expect(isEmptySnapshot(emptySnapshot())).toBe(true);
    expect(
      isEmptySnapshot({ ...emptySnapshot(), plannedOrders: [{}] as unknown as AppStoreExport['plannedOrders'] }),
    ).toBe(true);
  });

  it('任一核心数据非空 → false', () => {
    expect(
      isEmptySnapshot({ ...emptySnapshot(), tRounds: [{ id: 'r1' }] as unknown as AppStoreExport['tRounds'] }),
    ).toBe(false);
    expect(
      isEmptySnapshot({ ...emptySnapshot(), positions: [{ id: 'p1' }] as unknown as AppStoreExport['positions'] }),
    ).toBe(false);
    expect(
      isEmptySnapshot({ ...emptySnapshot(), stocks: [{ code: 'sh600000' }] as unknown as AppStoreExport['stocks'] }),
    ).toBe(false);
    expect(
      isEmptySnapshot(
        { ...emptySnapshot(), longTermRecords: [{ id: 'l1' }] as unknown as AppStoreExport['longTermRecords'] },
      ),
    ).toBe(false);
  });
});

// ============================================================
// 8. scheduleServerBackup 防抖推送管线
// ============================================================

describe('scheduleServerBackup 防抖管线', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetServerSync();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetServerSync();
  });

  it('防抖窗口内连续调用合并为一次 doPush', async () => {
    const doPush = vi.fn().mockResolvedValue(undefined);
    const gate = { canPush: () => true, doPush };

    scheduleServerBackup({}, gate, 50);
    scheduleServerBackup({}, gate, 50);
    scheduleServerBackup({}, gate, 50);

    await vi.waitFor(() => expect(doPush).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(doPush).toHaveBeenCalledTimes(1);
  });

  it('门控 canPush=false → doPush 不执行（未登录/MEK 不可用/开关关闭）', async () => {
    const canPush = vi.fn(() => false);
    const doPush = vi.fn().mockResolvedValue(undefined);

    scheduleServerBackup({}, { canPush, doPush }, 20);
    await new Promise((r) => setTimeout(r, 80));

    expect(canPush).toHaveBeenCalled();
    expect(doPush).not.toHaveBeenCalled();
  });

  it('成功推送后 10s 冷却期内再次调度被拦截', async () => {
    const doPush = vi.fn().mockResolvedValue(undefined);
    const gate = { canPush: () => true, doPush };

    scheduleServerBackup({}, gate, 20);
    await vi.waitFor(() => expect(doPush).toHaveBeenCalledTimes(1), { timeout: 2000 });

    scheduleServerBackup({}, gate, 20);
    await new Promise((r) => setTimeout(r, 80));
    expect(doPush).toHaveBeenCalledTimes(1);
  });

  it('doPush 失败不进入冷却，下次调度可立即重试', async () => {
    const doPush = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const gate = { canPush: () => true, doPush };

    scheduleServerBackup({}, gate, 20);
    await vi.waitFor(() => expect(doPush).toHaveBeenCalledTimes(1), { timeout: 2000 });

    scheduleServerBackup({}, gate, 20);
    await vi.waitFor(() => expect(doPush).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it('doPush 在途时新调度不并发（Promise 互斥，不排队）', async () => {
    let resolveFirst!: () => void;
    const doPush = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((res) => { resolveFirst = res; }))
      .mockResolvedValue(undefined);
    const gate = { canPush: () => true, doPush };

    scheduleServerBackup({}, gate, 20);
    await vi.waitFor(() => expect(doPush).toHaveBeenCalledTimes(1), { timeout: 2000 });

    scheduleServerBackup({}, gate, 20);
    await new Promise((r) => setTimeout(r, 80));
    expect(doPush).toHaveBeenCalledTimes(1);

    resolveFirst();
    await new Promise((r) => setTimeout(r, 40));
    expect(doPush).toHaveBeenCalledTimes(1);
  });

  it('跨标签页写锁使用 stock-calculator-server-sync-push 锁名', async () => {
    const lockNames: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, fn: () => Promise<unknown>) => {
          lockNames.push(name);
          return fn();
        },
      },
    });
    const doPush = vi.fn().mockResolvedValue(undefined);

    scheduleServerBackup({}, { canPush: () => true, doPush }, 20);
    await vi.waitFor(() => expect(doPush).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(lockNames).toEqual(['stock-calculator-server-sync-push']);
  });

  it('cancelServerBackup 取消挂起中的防抖推送', async () => {
    const doPush = vi.fn().mockResolvedValue(undefined);

    scheduleServerBackup({}, { canPush: () => true, doPush }, 30);
    cancelServerBackup();
    await new Promise((r) => setTimeout(r, 80));
    expect(doPush).not.toHaveBeenCalled();
  });
});
