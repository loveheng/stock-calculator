/**
 * @file webdavSync.test.ts
 * @description WebDAV 同步服务单元测试：序列化/反序列化、冲突合并算法。
 * @layer Test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  serializeSnapshot,
  deserializeSnapshot,
  mergeData,
  formatRelativeTime,
  getWebDAVConfig,
  saveWebDAVConfig,
  clearWebDAVConfig,
  getLastSyncTime,
  setLastSyncTime,
  addSyncHistory,
  getSyncHistory,
  ensureParentDir,
  DEFAULT_WEBDAV_CONFIG,
  // 新增：锁机制相关
  backupToCloud,
  restoreFromCloud,
  testWebDAVConnection,
  mergeSync,
  // 新增：全局唯一执行锁 + 10s 冷却
  backupToWebDAV,
  scheduleBackup,
  __resetWebDAVAutoBackup,
} from '../services/webdavSync';
import type { AppStoreExport, TRoundArchive, Position } from '../store/types';
import type { FeeConfig } from '../utils/mathUtils';

const mockFeeConfig: FeeConfig = {
  commissionRate: 0.00025,
  isFreeFive: true,
  minCommission: 5,
  transferRate: 0.00001,
  stampRate: 0.001,
};

function createMockSnapshot(overrides?: Partial<AppStoreExport>): AppStoreExport {
  return {
    version: 1,
    feeConfig: { ...mockFeeConfig },
    tRounds: [],
    positions: [],
    stocks: [],
    longTermRecords: [],
    ...overrides,
  };
}

function createRound(id: string, lastTouched?: string, closedAt?: string): TRoundArchive {
  return {
    id,
    fullCode: 'sh600000',
    stockName: '测试股票',
    mode: 'long',
    roundCode: '#20260813-' + id.slice(0, 4),
    settleType: 'clear',
    netProfit: 100,
    openedAt: '2026-08-13T10:00:00.000Z',
    closedAt,
    lastTouched,
    transactions: [],
  };
}

function createPosition(id: string, lastTouched?: string): Position {
  return {
    id,
    stockName: '测试股票',
    fullCode: 'sh600000',
    currentCost: 10,
    currentAmount: 1000,
    batches: [],
    isClosed: false,
    createdAt: '2026-08-13T10:00:00.000Z',
    lastTouched,
  };
}

// ============================================================
// 1. 序列化 / 反序列化
// ============================================================

describe('serializeSnapshot / deserializeSnapshot', () => {
  it('应正确序列化并反序列化完整快照', () => {
    const snapshot = createMockSnapshot({
      tRounds: [createRound('r1', '2026-08-13T12:00:00.000Z')],
      positions: [createPosition('p1', '2026-08-13T12:00:00.000Z')],
    });
    const json = serializeSnapshot(snapshot);
    expect(json).toBeTypeOf('string');
    const result = deserializeSnapshot(json);
    expect(result).not.toBeNull();
    expect(result!.data.version).toBe(1);
    expect(result!.data.tRounds).toHaveLength(1);
    expect(result!.data.tRounds[0].id).toBe('r1');
    expect(result!.data.positions).toHaveLength(1);
    expect(result!.data.positions[0].id).toBe('p1');
    expect(result!.timestamp).toBeGreaterThan(0);
  });

  it('序列化输出应为格式化 JSON（含缩进）', () => {
    const snapshot = createMockSnapshot();
    const json = serializeSnapshot(snapshot);
    expect(json).toContain('\n  ');
    expect(json).toContain('"version"');
  });

  it('应能反序列化带包裹层的 JSON', () => {
    const inner = createMockSnapshot();
    const wrapped = JSON.stringify({ timestamp: 1720000000000, data: inner });
    const result = deserializeSnapshot(wrapped);
    expect(result).not.toBeNull();
    expect(result!.data.version).toBe(1);
    expect(result!.timestamp).toBe(1720000000000);
  });

  it('反序列化无效 JSON 应返回 null', () => {
    expect(deserializeSnapshot('not json')).toBeNull();
    expect(deserializeSnapshot('{"version":1}')).toBeNull();
    expect(deserializeSnapshot('{"version":1,"tRounds":"not array"}')).toBeNull();
  });

  it('反序列化空对象应返回 null', () => {
    expect(deserializeSnapshot('{}')).toBeNull();
  });
});

// ============================================================
// 2. 冲突合并算法
// ============================================================

describe('mergeData', () => {
  it('相同数据应无新增或更新', () => {
    const local = createMockSnapshot({
      tRounds: [createRound('r1', '2026-08-13T12:00:00.000Z')],
      positions: [createPosition('p1', '2026-08-13T12:00:00.000Z')],
    });
    const remote = createMockSnapshot({
      tRounds: [createRound('r1', '2026-08-13T12:00:00.000Z')],
      positions: [createPosition('p1', '2026-08-13T12:00:00.000Z')],
    });
    const result = mergeData(local, remote);
    expect(result.tRounds).toHaveLength(1);
    expect(result.positions).toHaveLength(1);
    expect(result.mergeStats.roundsAdded).toBe(0);
    expect(result.mergeStats.roundsUpdated).toBe(0);
    expect(result.mergeStats.positionsAdded).toBe(0);
  });

  it('云端有新增记录应添加到合并结果', () => {
    const local = createMockSnapshot({ tRounds: [createRound('r1')] });
    const remote = createMockSnapshot({
      tRounds: [createRound('r1'), createRound('r2', '2026-08-14T12:00:00.000Z')],
    });
    const result = mergeData(local, remote);
    expect(result.tRounds).toHaveLength(2);
    expect(result.mergeStats.roundsAdded).toBe(1);
  });

  it('云端有更新记录（时间戳较新）应更新本地', () => {
    const local = createMockSnapshot({
      tRounds: [createRound('r1', '2026-08-13T12:00:00.000Z')],
    });
    const remote = createMockSnapshot({
      tRounds: [createRound('r1', '2026-08-14T12:00:00.000Z')],
    });
    const result = mergeData(local, remote);
    expect(result.tRounds).toHaveLength(1);
    expect(result.mergeStats.roundsUpdated).toBe(1);
    expect(result.tRounds[0].lastTouched).toBe('2026-08-14T12:00:00.000Z');
  });

  it('本地有更新记录（时间戳较新）应保留本地版本', () => {
    const local = createMockSnapshot({
      tRounds: [createRound('r1', '2026-08-14T12:00:00.000Z')],
    });
    const remote = createMockSnapshot({
      tRounds: [createRound('r1', '2026-08-13T12:00:00.000Z')],
    });
    const result = mergeData(local, remote);
    expect(result.tRounds).toHaveLength(1);
    expect(result.mergeStats.roundsUpdated).toBe(0);
    expect(result.tRounds[0].lastTouched).toBe('2026-08-14T12:00:00.000Z');
  });

  it('合并 transactions 时应保留版本较长的明细', () => {
    const localRound = createRound('r1', '2026-08-13T12:00:00.000Z');
    localRound.transactions = [
      { id: 't1', timestamp: '2026-08-13T10:00:00.000Z', direction: 'buy', price: 10, amount: 100, fee: 5 },
      { id: 't2', timestamp: '2026-08-13T11:00:00.000Z', direction: 'sell', price: 11, amount: 100, fee: 5 },
    ];
    const remoteRound = createRound('r1', '2026-08-14T12:00:00.000Z');
    remoteRound.transactions = [
      { id: 't1', timestamp: '2026-08-13T10:00:00.000Z', direction: 'buy', price: 10, amount: 100, fee: 5 },
    ];
    const local = createMockSnapshot({ tRounds: [localRound] });
    const remote = createMockSnapshot({ tRounds: [remoteRound] });
    const result = mergeData(local, remote);
    expect(result.tRounds[0].lastTouched).toBe('2026-08-14T12:00:00.000Z');
    expect(result.tRounds[0].transactions).toHaveLength(2);
  });

  it('positions 合并应按 lastTouched 时间戳', () => {
    const local = createMockSnapshot({
      positions: [createPosition('p1', '2026-08-13T12:00:00.000Z')],
    });
    const remote = createMockSnapshot({
      positions: [createPosition('p1', '2026-08-14T12:00:00.000Z')],
    });
    const result = mergeData(local, remote);
    expect(result.positions).toHaveLength(1);
    expect(result.mergeStats.positionsUpdated).toBe(1);
    expect(result.positions[0].lastTouched).toBe('2026-08-14T12:00:00.000Z');
  });

  it('stocks 合并应按 fullCode 作为键', () => {
    const local = createMockSnapshot({
      stocks: [{ fullCode: 'sh600000', code: '600000', stockName: '浦发银行', pinYin: 'pfyh', marketType: 'SH', securityType: '股票', kind: 'stock' as const }],
    });
    const remote = createMockSnapshot({
      stocks: [
        { fullCode: 'sh600000', code: '600000', stockName: '浦发银行', pinYin: 'pfyh', marketType: 'SH', securityType: '股票', kind: 'stock' as const },
        { fullCode: 'sz000001', code: '000001', stockName: '平安银行', pinYin: 'payh', marketType: 'SZ', securityType: '股票', kind: 'stock' as const },
      ],
    });
    const result = mergeData(local, remote);
    expect(result.stocks).toHaveLength(2);
    expect(result.mergeStats.stocksAdded).toBe(1);
  });

  it('longTermRecords 合并应按 ID', () => {
    const local = createMockSnapshot({
      longTermRecords: [{ id: 'l1', fullCode: 'sh600000', stockName: '测试', timestamp: '2026-08-13T10:00:00.000Z', type: 'buy' as const, price: 10, amount: 100, fee: 5 }],
    });
    const remote = createMockSnapshot({
      longTermRecords: [
        { id: 'l1', fullCode: 'sh600000', stockName: '测试', timestamp: '2026-08-13T10:00:00.000Z', type: 'buy' as const, price: 10, amount: 100, fee: 5 },
        { id: 'l2', fullCode: 'sh600000', stockName: '测试2', timestamp: '2026-08-14T10:00:00.000Z', type: 'sell' as const, price: 11, amount: 100, fee: 5 },
      ],
    });
    const result = mergeData(local, remote);
    expect(result.longTermRecords).toHaveLength(2);
    expect(result.mergeStats.longTermRecordsAdded).toBe(1);
  });

  it('应合并本地与云端的独特记录（无 ID 冲突）', () => {
    const local = createMockSnapshot({
      tRounds: [createRound('r1', '2026-08-13T12:00:00.000Z')],
      positions: [createPosition('p1', '2026-08-13T12:00:00.000Z')],
    });
    const remote = createMockSnapshot({
      tRounds: [createRound('r2', '2026-08-14T12:00:00.000Z')],
      positions: [createPosition('p2', '2026-08-14T12:00:00.000Z')],
    });
    const result = mergeData(local, remote);
    expect(result.tRounds).toHaveLength(2);
    expect(result.positions).toHaveLength(2);
    expect(result.mergeStats.roundsAdded).toBe(1);
    expect(result.mergeStats.positionsAdded).toBe(1);
  });

  it('合并后 feeConfig 应选择时间戳较新的版本', () => {
    const local = createMockSnapshot({ feeConfig: { ...mockFeeConfig, commissionRate: 0.0003 } });
    (local as any).exportedAt = '2026-08-13T12:00:00.000Z';
    const remote = createMockSnapshot({ feeConfig: { ...mockFeeConfig, commissionRate: 0.0002 } });
    (remote as any).exportedAt = '2026-08-14T12:00:00.000Z';
    const result = mergeData(local, remote);
    expect(result.feeConfig.commissionRate).toBe(0.0002);
  });
});

// ============================================================
// 3. ensureParentDir（自动父目录创建）
// ============================================================

describe('ensureParentDir', () => {
  const mockConfig = {
    webdavUrl: 'https://dav.example.com/dav/',
    username: 'user',
    password: 'pass',
    remotePath: '/test/backup.json',
    autoSync: false,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('根目录无需创建应返回 true', async () => {
    const result = await ensureParentDir(mockConfig, '/file.json');
    expect(result).toBe(true);
  });

  it('MKCOL 返回 201 应视为成功', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 201 }),
    );
    const result = await ensureParentDir(mockConfig, '/dir/backup.json');
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const reqUrl = mockFetch.mock.calls[0][0] as string;
    expect(reqUrl).toContain('/api/webdav?url=');
    expect(reqUrl).toContain(encodeURIComponent('/dir'));
  });

  it('MKCOL 返回 405 应视为已存在（成功）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 405 }),
    );
    const result = await ensureParentDir(mockConfig, '/exist/backup.json');
    expect(result).toBe(true);
  });

  it('MKCOL 返回 409 应递归创建上级目录', async () => {
    // 第一次调用（/a/b）返回 409 → 递归创建 /a → 成功（201）
    // 第二次调用（/a/b）重试 → 成功（201）
    const mockFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 409 })) // /a/b → 409
      .mockResolvedValueOnce(new Response(null, { status: 201 })) // /a → 201
      .mockResolvedValueOnce(new Response(null, { status: 201 })); // /a/b 重试 → 201
    const result = await ensureParentDir(mockConfig, '/a/b/backup.json');
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('网络错误应静默返回 false', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
    const result = await ensureParentDir(mockConfig, '/error/backup.json');
    expect(result).toBe(false);
  });
});

// ============================================================
// 4. formatRelativeTime
// ============================================================

describe('formatRelativeTime', () => {
  it('刚刚（小于 60 秒）', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('刚刚');
  });

  it('X 分钟前', () => {
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(past)).toBe('5 分钟前');
  });

  it('X 小时前', () => {
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(past)).toBe('3 小时前');
  });

  it('X 天前', () => {
    const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(past)).toBe('7 天前');
  });

  it('X 个月前', () => {
    const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(past)).toBe('2 个月前');
  });

  it('未来时间应返回刚刚', () => {
    const future = new Date(Date.now() + 10000).toISOString();
    expect(formatRelativeTime(future)).toBe('刚刚');
  });
});

// ============================================================
// 5. localStorage 配置管理
// ============================================================

describe('localStorage 配置管理', () => {
  beforeEach(() => { localStorage.clear(); });

  it('未配置时应返回默认值', () => {
    const config = getWebDAVConfig();
    expect(config.webdavUrl).toBe('');
    expect(config.remotePath).toBe(DEFAULT_WEBDAV_CONFIG.remotePath);
    expect(config.autoSync).toBe(false);
  });

  it('保存后应能正确读取', () => {
    saveWebDAVConfig({
      webdavUrl: 'https://dav.jianguoyun.com/dav/',
      username: 'test@test.com',
      password: 'app_password',
      remotePath: '/test/backup.json',
      autoSync: true,
    });
    const config = getWebDAVConfig();
    expect(config.webdavUrl).toBe('https://dav.jianguoyun.com/dav/');
    expect(config.username).toBe('test@test.com');
    expect(config.password).toBe('app_password');
    expect(config.remotePath).toBe('/test/backup.json');
    expect(config.autoSync).toBe(true);
  });

  it('清除配置后应恢复默认值', () => {
    saveWebDAVConfig({ webdavUrl: 'https://example.com/dav/', username: 'u', password: 'p', remotePath: '/backup.json', autoSync: true });
    clearWebDAVConfig();
    const config = getWebDAVConfig();
    expect(config.webdavUrl).toBe('');
    expect(config.remotePath).toBe(DEFAULT_WEBDAV_CONFIG.remotePath);
  });

  it('getLastSyncTime 未设置时应返回 null', () => {
    expect(getLastSyncTime()).toBeNull();
  });

  it('setLastSyncTime 应保存时间戳', () => {
    const time = '2026-08-13T12:00:00.000Z';
    setLastSyncTime(time);
    expect(getLastSyncTime()).toBe(time);
  });

  it('不传参调用 setLastSyncTime 应使用当前时间', () => {
    const before = Date.now();
    setLastSyncTime();
    const stored = getLastSyncTime();
    expect(stored).not.toBeNull();
    const after = Date.now();
    const storedTime = new Date(stored!).getTime();
    expect(storedTime).toBeGreaterThanOrEqual(before);
    expect(storedTime).toBeLessThanOrEqual(after);
  });
});

describe('syncHistory', () => {
  beforeEach(() => { localStorage.clear(); });

  it('初始历史应为空', () => {
    expect(getSyncHistory()).toEqual([]);
  });

  it('追加记录后应能读取', () => {
    addSyncHistory({ timestamp: '2026-08-13T12:00:00.000Z', type: 'test', success: true });
    const history = getSyncHistory();
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('test');
    expect(history[0].success).toBe(true);
  });

  it('最多保留 50 条记录', () => {
    for (let i = 0; i < 60; i++) {
      addSyncHistory({ timestamp: new Date().toISOString(), type: 'backup', success: true });
    }
    expect(getSyncHistory()).toHaveLength(50);
  });

  it('新记录应插入到最前面', () => {
    addSyncHistory({ timestamp: '2026-08-13T12:00:00.000Z', type: 'backup', success: true });
    addSyncHistory({ timestamp: '2026-08-14T12:00:00.000Z', type: 'merge', success: true });
    const history = getSyncHistory();
    expect(history[0].type).toBe('merge');
    expect(history[1].type).toBe('backup');
  });
});

// ============================================================
// 6. 同步元数据独立存储（webdav_meta_v1）
// ============================================================

describe('同步元数据独立存储', () => {
  beforeEach(() => { localStorage.clear(); });

  it('应使用 webdav_meta_v1 键名存储', () => {
    setLastSyncTime('2026-08-13T12:00:00.000Z');
    addSyncHistory({ timestamp: '2026-08-13T12:00:00.000Z', type: 'backup', success: true });
    const raw = localStorage.getItem('webdav_meta_v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveProperty('lastSyncTime');
    expect(parsed).toHaveProperty('syncHistory');
    expect(parsed.lastSyncTime).toBe('2026-08-13T12:00:00.000Z');
    expect(parsed.syncHistory).toHaveLength(1);
  });

  it('不应使用旧的独立键名存储', () => {
    setLastSyncTime('2026-08-13T12:00:00.000Z');
    addSyncHistory({ timestamp: '2026-08-13T12:00:00.000Z', type: 'backup', success: true });
    expect(localStorage.getItem('webdav_last_sync')).toBeNull();
    expect(localStorage.getItem('webdav_sync_history')).toBeNull();
  });

  it('clearWebDAVConfig 应清除 webdav_meta_v1', () => {
    setLastSyncTime('2026-08-13T12:00:00.000Z');
    addSyncHistory({ timestamp: '2026-08-13T12:00:00.000Z', type: 'backup', success: true });
    clearWebDAVConfig();
    expect(localStorage.getItem('webdav_meta_v1')).toBeNull();
    expect(getLastSyncTime()).toBeNull();
    expect(getSyncHistory()).toEqual([]);
  });
});

// ============================================================
// 7. 同步互斥锁（Sync Lock）防重入
// ============================================================

describe('同步互斥锁 syncLockCount', () => {
  beforeEach(() => {
    localStorage.clear();
    // 必须使用真实的 fetch，由测试控制
  });

  it('metadata 读写使用 webdav_meta_v1 不与旧键名冲突', () => {
    // 模拟旧数据仍在 localStorage 中
    localStorage.setItem('webdav_last_sync', '2026-01-01T00:00:00.000Z');
    localStorage.setItem('webdav_sync_history', JSON.stringify([{ timestamp: '2026-01-01T00:00:00.000Z', type: 'backup', success: true }]));

    // 新接口应读取 webdav_meta_v1（为空），而非旧键名
    expect(getLastSyncTime()).toBeNull();
    expect(getSyncHistory()).toEqual([]);

    // 写入新数据后应使用新键名
    setLastSyncTime('2026-08-13T12:00:00.000Z');
    expect(localStorage.getItem('webdav_meta_v1')).not.toBeNull();
    expect(getLastSyncTime()).toBe('2026-08-13T12:00:00.000Z');
  });
});
// ============================================================
// 8. 上传互斥锁（isUploading）防并发 PUT —— 阻断死循环上传的关键
// ============================================================

describe('上传互斥锁 isUploading', () => {
  const buildConfig = () => ({
    webdavUrl: 'https://dav.example.com/dav/',
    username: 'test',
    password: 'app_pass',
    remotePath: '/stock-calculator/data-backup.json',
    autoSync: false,
  });

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('并发调用 backupToCloud 时仅发出 1 次 PUT，第二个请求被立即拦截', async () => {
    // 第一个 PUT 挂起（fetch 返回未 resolve 的 Promise），制造"上传在途"的并发窗口
    let resolveFetch!: (r: Response) => void;
    const pendingFetch = new Promise<Response>((res) => { resolveFetch = res; });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(pendingFetch) // 第一个 backupToCloud 的 PUT 在途
      .mockResolvedValue(new Response(null, { status: 201 })); // 兜底

    const json = serializeSnapshot(createMockSnapshot());

    const first = backupToCloud(buildConfig(), json);
    const second = backupToCloud(buildConfig(), json);

    // 第二个调用应被 isUploading 互斥锁立即拦截，网络层面不发任何请求
    const r2 = await second;
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('上传正在进行中');

    // 放行第一个 PUT
    resolveFetch(new Response(null, { status: 201 }));
    const r1 = await first;
    expect(r1.ok).toBe(true);

    // 全程只发出 1 个网络请求（第二个在锁内被拦截，未触达 fetch）
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('上传完成后互斥锁释放，可再次正常上传', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    const json = serializeSnapshot(createMockSnapshot());

    const r1 = await backupToCloud(buildConfig(), json, false, true);
    expect(r1.ok).toBe(true);

    // force=true：跳过冷却时间；若 isUploading 未释放则会被拦截，此处应成功
    const r2 = await backupToCloud(buildConfig(), json, false, true);
    expect(r2.ok).toBe(true);

    // 两次上传均真正发起了网络请求（说明锁已被正确释放）
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
// ============================================================
// 9. 跨标签页写入互斥（Web Locks API）—— 防止多标签页重叠 PUT 导致文件大小跳变
// ============================================================

describe('跨标签页写入互斥（Web Locks API）', () => {
  const buildConfig = () => ({
    webdavUrl: 'https://dav.example.com/dav/',
    username: 'test',
    password: 'app_pass',
    remotePath: '/stock-calculator/data-backup.json',
    autoSync: false,
  });
  const LOCK_NAME = 'stock-calculator-webdav-write';

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('写方法 PUT（backupToCloud）会请求全局 Web Locks 写锁', async () => {
    const lockNames: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, fn: () => Promise<unknown>) => {
          lockNames.push(name);
          return fn();
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const json = serializeSnapshot(createMockSnapshot());
    const r = await backupToCloud(buildConfig(), json, false, true);
    expect(r.ok).toBe(true);
    expect(lockNames).toEqual([LOCK_NAME]);
  });

  it('写方法 MKCOL（ensureParentDir 自动建目录）也请求全局写锁', async () => {
    const lockNames: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, fn: () => Promise<unknown>) => {
          lockNames.push(name);
          return fn();
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const ok = await ensureParentDir(buildConfig(), '/stock-calculator/data-backup.json');
    expect(ok).toBe(true);
    expect(lockNames).toContain(LOCK_NAME);
  });

  it('只读 GET（restoreFromCloud）不请求写锁', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, _fn: () => Promise<unknown>) => {
          throw new Error('只读请求不应请求写锁');
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(createMockSnapshot()), { status: 200 }),
    );
    const rr = await restoreFromCloud(buildConfig(), true); // _skipLock=true：跳过冷却时间，专注验证 GET 不请求写锁
    expect(rr.ok).toBe(true);
  });

  it('并发写操作在 Web Locks 下被串行化，同一时刻仅 1 个写请求在途',
    async () => {
      // 模拟浏览器 Web Locks 的同名互斥队列语义：后到者在前者完成后才执行
      let chain: Promise<void> = Promise.resolve();
      const inFlight: number[] = [];
      let maxInFlight = 0;
      vi.stubGlobal('navigator', {
        locks: {
          request: async (name: string, fn: () => Promise<unknown>) => {
            const run = chain.then(async () => {
              inFlight.push(1);
              maxInFlight = Math.max(maxInFlight, inFlight.length);
              try {
                return await fn();
              } finally {
                inFlight.pop();
              }
            });
            chain = run.then(() => undefined, () => undefined);
            return run;
          },
        },
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20)); // 制造重叠窗口
        return new Response(null, { status: 201 });
      });

      // ensureParentDir 不受模块级 isUploading 守卫，可真实并发；
      // 用它证明底层写锁能把原本会重叠的写请求串行化到 1 个在途。
      const config = buildConfig();
      const [a, b] = await Promise.all([
        ensureParentDir(config, '/stock-calculator/data-backup.json'),
        ensureParentDir(config, '/stock-calculator/data-backup.json'),
      ]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(maxInFlight).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );
});

// ============================================================
// 10. backupToWebDAV 全局唯一执行锁 + 10s 绝对冷却
// ============================================================

describe('backupToWebDAV 全局唯一执行锁 + 10s 绝对冷却', () => {
  const buildConfig = () => ({
    webdavUrl: 'https://dav.example.com/dav/',
    username: 'test',
    password: 'app_pass',
    remotePath: '/stock-calculator/data-backup.json',
    autoSync: false,
  });

  beforeEach(() => {
    localStorage.clear();
    saveWebDAVConfig(buildConfig());
    vi.restoreAllMocks();
    __resetWebDAVAutoBackup();
  });

  it('成功上传：返回 success 并写入独立同步元数据', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const r = await backupToWebDAV({ version: 1 }, true);
    expect(r.success).toBe(true);
    expect(getLastSyncTime()).not.toBeNull();
    expect(getSyncHistory()[0].type).toBe('backup');
    expect(getSyncHistory()[0].success).toBe(true);
  });

  it('冷却期内再次触发（非 force）被静默合并，不产生新的网络请求', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await backupToWebDAV({ v: 1 }, true); // 成功 → 进入 10s 绝对冷却
    const second = await backupToWebDAV({ v: 2 }); // 非 force → 冷却合并
    expect(second.success).toBe(true);
    expect(second.message).toContain('冷却');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('并发调用：在途时第二个调用复用同一 Promise，PUT 仅发出 1 次', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((res) => { resolveFetch = res; });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(pending)
      .mockResolvedValue(new Response(null, { status: 201 }));

    const first = backupToWebDAV({ v: 1 }, true);
    const second = backupToWebDAV({ v: 2 }, true);

    resolveFetch(new Response(null, { status: 201 }));
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('force 可绕过冷却期并发出新的上传', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await backupToWebDAV({ v: 1 }, true); // 进入冷却
    const second = await backupToWebDAV({ v: 2 }, true); // force 绕过
    expect(second.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('未配置时返回失败且不发请求', async () => {
    localStorage.clear(); // 清空配置
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await backupToWebDAV({ v: 1 }, true);
    expect(r.success).toBe(false);
    expect(r.message).toContain('未配置');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('scheduleBackup 防抖：多个连续触发合并为最后一次并仅执行一次备份', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 201 }));

      scheduleBackup({ v: 1 }, 800);
      scheduleBackup({ v: 2 }, 800);
      scheduleBackup({ v: 3 }, 800);
      // 防抖窗口内定时器尚未触发，应无请求
      expect(fetchSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(810);
      await Promise.resolve(); // 等待内部 async 完成
      await Promise.resolve();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      __resetWebDAVAutoBackup();
    }
  });
});
