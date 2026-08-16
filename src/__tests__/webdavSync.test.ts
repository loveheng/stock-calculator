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
