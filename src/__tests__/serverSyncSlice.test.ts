/**
 * @file serverSyncSlice.test.ts
 * @description 服务端密文同步编排层（M3 ioSlice）单测：推送结果分流（成功 / 409 合并重推 /
 *              42901 限频 / network 退避 / invalid）、空快照守卫（D9）、防回环与 UI 态互斥、
 *              restoreFromServer 拉取合并、resolveServerConflict 两分支、§7.3 启动对账
 *              决策树、buildServerSyncGate 门控三条件与退避 gate 复用。
 *              运行环境：Node。与 serverSync.test.ts（服务层 HTTP/信封单测）互补，
 *              本文件只测编排：HTTP 三端点 mock 掉，meta 读写保持真实直落 localStorage。
 * @layer 测试
 * @author 开发团队
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted 先于全部 import 执行：store/index 模块体在 import 阶段就读
// loadCopilotTombstones()，localStorage mock 必须在此时已就位。
const lsStore = vi.hoisted(() => {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => { store[key] = String(value); },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (index: number) => Object.keys(store)[index] ?? null,
    },
    configurable: true,
  });
  return store;
});

// base64 编解码（Node/DOM 类型安全；快照含中文，须走 UTF-8 字节路径）
const { utf8ToBase64, base64ToUtf8 } = vi.hoisted(() => ({
  utf8ToBase64: (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  },
  base64ToUtf8: (b64: string): string => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  },
}));

// useAuthStore mock：可变状态对象（getServerCredential 每次现读，测试直接改字段）
const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  mek: null as unknown as CryptoKey,
}));

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => authState,
    subscribe: vi.fn(() => () => {}),
    setState: vi.fn(),
  },
}));

// serverSync：仅 mock HTTP 三端点 + 调度器；meta 读写/信封工具保持真实实现
vi.mock('../services/serverSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/serverSync')>();
  return {
    ...actual,
    fetchSyncMeta: vi.fn(),
    pullBackupEnvelope: vi.fn(),
    pushBackup: vi.fn(),
    scheduleServerBackup: vi.fn(),
  };
});

// cryptoService：仅 mock 文本加解密；ct 用 b64: 前缀约定，与云端信封 fixture 闭环
vi.mock('../services/cryptoService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/cryptoService')>();
  return {
    ...actual,
    encryptText: vi.fn(async (pt: string) => ({
      iv: 'bW9ja2l2MTIzNA',
      ct: 'b64:' + utf8ToBase64(pt),
    })),
    decryptText: vi.fn(async (_iv: string, ct: string) => {
      if (!ct.startsWith('b64:')) throw new Error('GCM 认证失败（mock）');
      return base64ToUtf8(ct.slice(4));
    }),
  };
});

import { useAppStore } from '../store';
import {
  fetchSyncMeta,
  pullBackupEnvelope,
  pushBackup,
  readServerSyncMeta,
  scheduleServerBackup,
  writeServerSyncMeta,
  __resetServerSync,
} from '../services/serverSync';
import type { ServerPushResult } from '../services/serverSync';
import {
  buildServerSyncGate,
  markServerPushPending,
  __resetServerSyncSlice,
} from '../store/slices/ioSlice';
import { setIsSyncingFromRemote } from '../store/persistence';
import { AUTH_SESSION_STORAGE_KEY } from '../services/authSession';
import { serializeSnapshot } from '../services/snapshotService';
import { EXPORT_VERSION } from '../store/types';
import type { AppStoreExport, Position, TRoundArchive } from '../store/types';
import type { FeeConfig } from '../utils/mathUtils';

// ---- fixtures ----

const MOCK_MEK = {} as unknown as CryptoKey;

const mockFeeConfig: FeeConfig = {
  commissionRate: 0.00025,
  isFreeFive: true,
  minCommission: 5,
  transferRate: 0.00001,
  stampRate: 0.001,
};

function createRound(id: string): TRoundArchive {
  return {
    id,
    fullCode: 'sh600000',
    stockName: '测试股票',
    mode: 'long',
    roundCode: '#20260813-' + id.slice(0, 4),
    settleType: 'clear',
    netProfit: 100,
    openedAt: '2026-08-13T10:00:00.000Z',
    transactions: [],
  };
}

function createPosition(id: string): Position {
  return {
    id,
    stockName: '测试股票',
    fullCode: 'sh600000',
    currentCost: 10,
    currentAmount: 1000,
    batches: [],
    isClosed: false,
    createdAt: '2026-08-13T10:00:00.000Z',
  };
}

/** 云端信封 fixture：iv/ct 与 decryptText mock 的 b64: 前缀约定闭环 */
function buildCloudEnvelope(rounds: TRoundArchive[], positions: Position[] = []): string {
  const snap: AppStoreExport = {
    version: EXPORT_VERSION,
    feeConfig: { ...mockFeeConfig },
    tRounds: rounds,
    positions,
    stocks: [],
    longTermRecords: [],
    plannedOrders: [],
  };
  return JSON.stringify({
    v: 1,
    alg: 'A256GCM',
    iv: 'bW9ja2l2MTIzNA',
    ct: 'b64:' + utf8ToBase64(serializeSnapshot(snap)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pushBackup).mockReset();
  vi.mocked(fetchSyncMeta).mockReset();
  vi.mocked(pullBackupEnvelope).mockReset();
  vi.mocked(scheduleServerBackup).mockReset();

  for (const k of Object.keys(lsStore)) delete lsStore[k];
  lsStore[AUTH_SESSION_STORAGE_KEY] = JSON.stringify({
    token: 'tok-1',
    userId: 'u-1',
    email: 'a@b.c',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });

  authState.isAuthenticated = true;
  authState.mek = MOCK_MEK;
  setIsSyncingFromRemote(false);
  __resetServerSyncSlice();
  __resetServerSync();

  // 默认行为（各用例按需覆盖）：推送成功 v1、云端空
  vi.mocked(pushBackup).mockResolvedValue({ ok: true, version: 1, deduped: false });
  vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: false, version: 0 });

  useAppStore.setState({
    coreDataLoaded: true,
    feeConfig: { ...mockFeeConfig },
    tRounds: [],
    positions: [],
    stocks: [],
    longTermRecords: [],
    plannedOrders: [],
    serverSyncing: false,
    serverLastVersion: null,
    serverLastError: null,
  });
});

// ============================================================
// 1. pushServerSnapshot：推送结果分流
// ============================================================

describe('pushServerSnapshot', () => {
  it('空快照非 force 跳过（D9），force 例外照常推送', async () => {
    await useAppStore.getState().pushServerSnapshot();
    expect(pushBackup).not.toHaveBeenCalled();
    expect(useAppStore.getState().serverLastVersion).toBeNull();

    await useAppStore.getState().pushServerSnapshot({ force: true });
    expect(pushBackup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushBackup).mock.calls[0][1]).toBe(0); // baseVersion = lastSeen 初值
    expect(useAppStore.getState().serverLastVersion).toBe(1);
  });

  it('未登录或无 MEK 不推送（D15 通道禁用）', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });

    authState.isAuthenticated = false;
    await useAppStore.getState().pushServerSnapshot();
    expect(pushBackup).not.toHaveBeenCalled();

    authState.isAuthenticated = true;
    authState.mek = null as unknown as CryptoKey;
    await useAppStore.getState().pushServerSnapshot();
    expect(pushBackup).not.toHaveBeenCalled();
  });

  it('成功推送：lastSeen 用响应返回版本（E2），状态收敛', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    vi.mocked(pushBackup).mockResolvedValue({ ok: true, version: 7, deduped: false });

    await useAppStore.getState().pushServerSnapshot();

    expect(pushBackup).toHaveBeenCalledTimes(1);
    const [token, baseVersion, env] = vi.mocked(pushBackup).mock.calls[0];
    expect(token).toBe('tok-1');
    expect(baseVersion).toBe(0);
    expect(env.v).toBe(1);
    expect(env.alg).toBe('A256GCM');
    expect(env.iv.length).toBeGreaterThan(0);
    expect(env.ct.length).toBeGreaterThan(0);
    expect(useAppStore.getState().serverLastVersion).toBe(7);
    expect(useAppStore.getState().serverLastError).toBeNull();
    expect(useAppStore.getState().serverSyncing).toBe(false);
    expect(readServerSyncMeta().lastSeenCloudVersion).toBe(7);
  });

  it('409 冲突：拉取合并后重推一轮，baseVersion 收敛为云端版本', async () => {
    useAppStore.setState({ tRounds: [createRound('r1-local')] });
    vi.mocked(pushBackup)
      .mockResolvedValueOnce({ ok: false, reason: 'conflict', latest: { hasData: true, version: 7 } })
      .mockResolvedValue({ ok: true, version: 8, deduped: false });
    vi.mocked(pullBackupEnvelope).mockResolvedValue({
      version: 7,
      envelope: buildCloudEnvelope([createRound('r2-cloud')]),
    });

    await useAppStore.getState().pushServerSnapshot();

    expect(pushBackup).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushBackup).mock.calls[1][1]).toBe(7);
    const ids = useAppStore.getState().tRounds.map((r) => r.id);
    expect(ids).toContain('r1-local');
    expect(ids).toContain('r2-cloud');
    expect(useAppStore.getState().serverLastVersion).toBe(8);
    expect(readServerSyncMeta().lastSeenCloudVersion).toBe(8);
    expect(useAppStore.getState().serverLastError).toBeNull();
  });

  it('重推仍冲突：置「持续冲突」错误交 UI（单轮自动处理），不再二次拉取', async () => {
    useAppStore.setState({ tRounds: [createRound('r1-local')] });
    vi.mocked(pushBackup).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      latest: { hasData: true, version: 7 },
    });
    vi.mocked(pullBackupEnvelope).mockResolvedValue({
      version: 7,
      envelope: buildCloudEnvelope([createRound('r2-cloud')]),
    });

    await useAppStore.getState().pushServerSnapshot();

    expect(pushBackup).toHaveBeenCalledTimes(2);
    expect(pullBackupEnvelope).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().serverLastError).toContain('冲突');
  });

  it('42901：按 retryAfter 重调度（E9：不计失败退避、不报 UI 错）', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    vi.mocked(pushBackup).mockResolvedValue({ ok: false, reason: 'rate', retryAfterSeconds: 4 });

    await useAppStore.getState().pushServerSnapshot();

    expect(pushBackup).toHaveBeenCalledTimes(1);
    expect(scheduleServerBackup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleServerBackup).mock.calls[0][2]).toBe(4000);
    expect(useAppStore.getState().serverLastError).toBeNull();
  });

  it('连续两次 42901：第二次进入失败退避（10s）', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    vi.mocked(pushBackup).mockResolvedValue({ ok: false, reason: 'rate', retryAfterSeconds: 4 });

    await useAppStore.getState().pushServerSnapshot();
    await useAppStore.getState().pushServerSnapshot();

    expect(scheduleServerBackup).toHaveBeenCalledTimes(2);
    expect(vi.mocked(scheduleServerBackup).mock.calls[1][2]).toBe(10_000);
    expect(useAppStore.getState().serverLastError).toBeNull();
  });

  it('network：静默指数退避 10s → 20s，不报 UI 错', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    vi.mocked(pushBackup).mockResolvedValue({ ok: false, reason: 'network' });

    await useAppStore.getState().pushServerSnapshot();
    await useAppStore.getState().pushServerSnapshot();

    expect(pushBackup).toHaveBeenCalledTimes(2);
    expect(vi.mocked(scheduleServerBackup).mock.calls[0][2]).toBe(10_000);
    expect(vi.mocked(scheduleServerBackup).mock.calls[1][2]).toBe(20_000);
    expect(useAppStore.getState().serverLastError).toBeNull();
  });

  it('invalid：置 UI 错误且不重试', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    vi.mocked(pushBackup).mockResolvedValue({
      ok: false,
      reason: 'invalid',
      message: '快照格式非法',
    });

    await useAppStore.getState().pushServerSnapshot();

    expect(pushBackup).toHaveBeenCalledTimes(1);
    expect(scheduleServerBackup).not.toHaveBeenCalled();
    expect(useAppStore.getState().serverLastError).toContain('拒绝');
  });

  it('远端导入期间不推送（防回环），force 例外', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    setIsSyncingFromRemote(true);

    await useAppStore.getState().pushServerSnapshot();
    expect(pushBackup).not.toHaveBeenCalled();

    await useAppStore.getState().pushServerSnapshot({ force: true });
    expect(pushBackup).toHaveBeenCalledTimes(1);
  });

  it('serverSyncing UI 态互斥：并发第二次调用被拦，finally 复位', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    let resolvePush!: (value: ServerPushResult) => void;
    vi.mocked(pushBackup).mockImplementationOnce(
      () => new Promise<ServerPushResult>((resolve) => { resolvePush = resolve; }),
    );

    const p1 = useAppStore.getState().pushServerSnapshot();
    await vi.waitFor(() => expect(useAppStore.getState().serverSyncing).toBe(true));
    const p2 = useAppStore.getState().pushServerSnapshot(); // 被互斥拦截

    resolvePush({ ok: true, version: 7, deduped: false });
    await Promise.all([p1, p2]);

    expect(pushBackup).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().serverSyncing).toBe(false);
    expect(useAppStore.getState().serverLastVersion).toBe(7);
  });
});

// ============================================================
// 2. restoreFromServer：拉取 → 解密 → 合并
// ============================================================

describe('restoreFromServer', () => {
  it('云端合并进本地：双方独有数据都保留，lastSeen 收敛云端版本', async () => {
    useAppStore.setState({ tRounds: [createRound('r1-local')] });
    vi.mocked(pullBackupEnvelope).mockResolvedValue({
      version: 7,
      envelope: buildCloudEnvelope([createRound('r2-cloud')]),
    });

    await useAppStore.getState().restoreFromServer();

    const ids = useAppStore.getState().tRounds.map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('r1-local');
    expect(ids).toContain('r2-cloud');
    expect(useAppStore.getState().serverLastVersion).toBe(7);
    expect(readServerSyncMeta().lastSeenCloudVersion).toBe(7);
    expect(useAppStore.getState().serverLastError).toBeNull();
    expect(pushBackup).not.toHaveBeenCalled();
  });

  it('GCM 解密失败（密钥不匹配）：置 serverLastError，本地数据不动', async () => {
    useAppStore.setState({ tRounds: [createRound('r1-local')] });
    vi.mocked(pullBackupEnvelope).mockResolvedValue({
      version: 7,
      envelope: JSON.stringify({ v: 1, alg: 'A256GCM', iv: 'aXZhbnk=', ct: 'not-b64-prefix' }),
    });

    await useAppStore.getState().restoreFromServer();

    expect(useAppStore.getState().serverLastError).toContain('解密失败');
    expect(useAppStore.getState().tRounds.map((r) => r.id)).toEqual(['r1-local']);
  });

  it('信封结构非法：置 serverLastError（解析失败）', async () => {
    vi.mocked(pullBackupEnvelope).mockResolvedValue({ version: 7, envelope: 'not-json' });

    await useAppStore.getState().restoreFromServer();

    expect(useAppStore.getState().serverLastError).toContain('信封格式异常');
    expect(useAppStore.getState().serverLastVersion).toBeNull();
  });
});

// ============================================================
// 3. resolveServerConflict：冲突两分支
// ============================================================

describe('resolveServerConflict', () => {
  it('merge-cloud：仅合并不推送，错误清空', async () => {
    useAppStore.setState({ tRounds: [createRound('r1-local')] });
    markServerPushPending(); // 即使有待传修改，merge-cloud 也不推送
    vi.mocked(pullBackupEnvelope).mockResolvedValue({
      version: 7,
      envelope: buildCloudEnvelope([createRound('r2-cloud')]),
    });

    await useAppStore.getState().resolveServerConflict('merge-cloud');

    expect(pushBackup).not.toHaveBeenCalled();
    expect(useAppStore.getState().tRounds).toHaveLength(2);
    expect(useAppStore.getState().serverLastVersion).toBe(7);
    expect(useAppStore.getState().serverLastError).toBeNull();
  });

  it('overwrite-cloud：合并后 force 重推（baseVersion=云端版本）', async () => {
    useAppStore.setState({ tRounds: [createRound('r1-local')] });
    vi.mocked(pullBackupEnvelope).mockResolvedValue({
      version: 7,
      envelope: buildCloudEnvelope([createRound('r2-cloud')]),
    });
    vi.mocked(pushBackup).mockResolvedValue({ ok: true, version: 8, deduped: false });

    await useAppStore.getState().resolveServerConflict('overwrite-cloud');

    expect(pushBackup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushBackup).mock.calls[0][1]).toBe(7);
    expect(useAppStore.getState().tRounds).toHaveLength(2);
    expect(useAppStore.getState().serverLastVersion).toBe(8);
    expect(readServerSyncMeta().lastSeenCloudVersion).toBe(8);
  });
});

// ============================================================
// 4. startupServerSyncCheck：§7.3 决策树
// ============================================================

describe('startupServerSyncCheck（§7.3 决策树）', () => {
  it('未登录：通道禁用，不做 meta 对账（D15）', async () => {
    authState.isAuthenticated = false;

    await useAppStore.getState().startupServerSyncCheck();

    expect(fetchSyncMeta).not.toHaveBeenCalled();
  });

  it('云端空 + 本地有数据：首传（baseVersion=0）', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: false, version: 0 });

    await useAppStore.getState().startupServerSyncCheck();

    expect(fetchSyncMeta).toHaveBeenCalledWith('tok-1');
    expect(pushBackup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushBackup).mock.calls[0][1]).toBe(0);
    expect(useAppStore.getState().serverLastVersion).toBe(1);
  });

  it('云端空 + 本地空：无动作', async () => {
    vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: false, version: 0 });

    await useAppStore.getState().startupServerSyncCheck();

    expect(pushBackup).not.toHaveBeenCalled();
  });

  it('v==lastSeen 且无待传修改：无动作', async () => {
    writeServerSyncMeta({ lastSeenCloudVersion: 7 });
    vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: true, version: 7 });

    await useAppStore.getState().startupServerSyncCheck();

    expect(pushBackup).not.toHaveBeenCalled();
    expect(pullBackupEnvelope).not.toHaveBeenCalled();
  });

  it('v==lastSeen 且有待传修改：推送并更新 lastSeen', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    writeServerSyncMeta({ lastSeenCloudVersion: 7 });
    vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: true, version: 7 });
    vi.mocked(pushBackup).mockResolvedValue({ ok: true, version: 7, deduped: true });
    markServerPushPending();

    await useAppStore.getState().startupServerSyncCheck();

    expect(pushBackup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushBackup).mock.calls[0][1]).toBe(7);
    expect(useAppStore.getState().serverLastVersion).toBe(7);
  });

  it('v>lastSeen 且无待传修改：仅拉取合并，不重推', async () => {
    writeServerSyncMeta({ lastSeenCloudVersion: 5 });
    vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: true, version: 7 });
    vi.mocked(pullBackupEnvelope).mockResolvedValue({
      version: 7,
      envelope: buildCloudEnvelope([createRound('r2-cloud')]),
    });

    await useAppStore.getState().startupServerSyncCheck();

    expect(pullBackupEnvelope).toHaveBeenCalledTimes(1);
    expect(pushBackup).not.toHaveBeenCalled();
    expect(useAppStore.getState().serverLastVersion).toBe(7);
    expect(readServerSyncMeta().lastSeenCloudVersion).toBe(7);
  });

  it('v>lastSeen 且有待传修改：拉取合并后重推（baseVersion=7）', async () => {
    writeServerSyncMeta({ lastSeenCloudVersion: 5 });
    vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: true, version: 7 });
    vi.mocked(pullBackupEnvelope).mockResolvedValue({
      version: 7,
      envelope: buildCloudEnvelope([createRound('r2-cloud')]),
    });
    vi.mocked(pushBackup).mockResolvedValue({ ok: true, version: 8, deduped: false });
    markServerPushPending();

    await useAppStore.getState().startupServerSyncCheck();

    expect(pullBackupEnvelope).toHaveBeenCalledTimes(1);
    expect(pushBackup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushBackup).mock.calls[0][1]).toBe(7);
    expect(useAppStore.getState().serverLastVersion).toBe(8);
    expect(readServerSyncMeta().lastSeenCloudVersion).toBe(8);
  });

  it('v<lastSeen：回退告警（D14），不拉取不推送', async () => {
    writeServerSyncMeta({ lastSeenCloudVersion: 7 });
    vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: true, version: 3 });

    await useAppStore.getState().startupServerSyncCheck();

    expect(useAppStore.getState().serverLastError).toContain('回退');
    expect(pullBackupEnvelope).not.toHaveBeenCalled();
    expect(pushBackup).not.toHaveBeenCalled();
  });

  it('回退告警可经 dismissServerError 手动清除（仅清 UI 态）', async () => {
    writeServerSyncMeta({ lastSeenCloudVersion: 7 });
    vi.mocked(fetchSyncMeta).mockResolvedValue({ hasData: true, version: 3 });
    await useAppStore.getState().startupServerSyncCheck();
    expect(useAppStore.getState().serverLastError).toContain('回退');

    useAppStore.getState().dismissServerError();

    expect(useAppStore.getState().serverLastError).toBeNull();
    expect(readServerSyncMeta().lastSeenCloudVersion).toBe(7); // lastSeen 不动
  });

  it('meta 对账网络失败：静默中断，不置 UI 错', async () => {
    vi.mocked(fetchSyncMeta).mockRejectedValue(new Error('网络不可达'));

    await useAppStore.getState().startupServerSyncCheck();

    expect(fetchSyncMeta).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().serverLastError).toBeNull();
  });
});

// ============================================================
// 5. buildServerSyncGate：门控三条件 + 退避 gate 复用
// ============================================================

describe('buildServerSyncGate', () => {
  it('canPush 三条件：登录 + MEK + enabled 开关', () => {
    const gate = buildServerSyncGate(() => Promise.resolve());
    expect(gate.canPush()).toBe(true);

    writeServerSyncMeta({ enabled: false });
    expect(gate.canPush()).toBe(false);
    writeServerSyncMeta({ enabled: true });

    authState.isAuthenticated = false;
    expect(gate.canPush()).toBe(false);
    authState.isAuthenticated = true;

    authState.mek = null as unknown as CryptoKey;
    expect(gate.canPush()).toBe(false);
  });

  it('退避重调度携带的 gate.doPush 可直接完成推送（E9 时序：锁已释放）', async () => {
    useAppStore.setState({ tRounds: [createRound('r1')] });
    vi.mocked(pushBackup).mockResolvedValueOnce({ ok: false, reason: 'network' });

    await useAppStore.getState().pushServerSnapshot();
    expect(scheduleServerBackup).toHaveBeenCalledTimes(1);

    const gate = vi.mocked(scheduleServerBackup).mock.calls[0][1];
    vi.mocked(pushBackup).mockResolvedValue({ ok: true, version: 9, deduped: false });

    await gate.doPush();

    expect(useAppStore.getState().serverLastVersion).toBe(9);
    expect(readServerSyncMeta().lastSeenCloudVersion).toBe(9);
    expect(useAppStore.getState().serverSyncing).toBe(false);
  });
});
