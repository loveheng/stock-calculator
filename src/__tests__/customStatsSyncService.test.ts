/**
 * @file customStatsSyncService.test.ts
 * @description 自定义统计服务端同步通道（HTTP 客户端）单测：
 *              - GET list：ApiResponse 信封解析 + 服务端定义防御性收窄（非法条目跳过）
 *              - PUT upsert：请求路径/方法/Bearer 头 + 上传载荷剥离 isDeleted（墓碑只走 DELETE）
 *              - DELETE：幂等删除（服务端约定不存在也 200）
 *              - 错误路径：HTTP 非 2xx / 业务码非 200 → 抛错（由切片统一静默降级）
 * @layer 测试
 * @storage_impact 无本地持久化；fetch 全局 stub，不触网。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteServerCustomStat,
  fetchServerCustomStats,
  putServerCustomStat,
} from '../services/customStatsSyncService';
import type { CustomStatDefinition } from '../types/domain';
import { CUSTOM_STAT_SCHEMA_VERSION } from '../types/domain';

const TOKEN = 'tok-1';

function def(over: Partial<CustomStatDefinition> = {}): CustomStatDefinition {
  return {
    id: 'd1',
    name: '统计A',
    code: "(ctx) => ({ kind: 'card', title: 'T', kpis: [] })",
    schemaVersion: CUSTOM_STAT_SCHEMA_VERSION,
    kind: 'card',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const fetchMock = vi.fn();

function mockJsonResponse(status: number, body: unknown): void {
  fetchMock.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
}

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('fetchServerCustomStats', () => {
  it('200 信封：解析 list 并逐字段收窄，附 Bearer 头', async () => {
    vi.stubGlobal('fetch', fetchMock);
    mockJsonResponse(200, {
      code: 200,
      message: 'ok',
      data: { list: [def({ favorite: true, pinned: true, pinnedAt: '2026-09-01T01:00:00.000Z' })] },
    });

    const list = await fetchServerCustomStats(TOKEN);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'd1', favorite: true, pinned: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/custom-stats');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('非法条目跳过：缺 code/kind 非法/updatedAt 不可解析均不进结果', async () => {
    vi.stubGlobal('fetch', fetchMock);
    mockJsonResponse(200, {
      code: 200,
      message: 'ok',
      data: {
        list: [
          'junk-string',
          null,
          def({ id: '' }),
          def({ kind: 'table' as unknown as CustomStatDefinition['kind'] }),
          def({ updatedAt: 'not-a-date' }),
          def({ schemaVersion: '1' as unknown as number }),
          def({ id: 'd-ok' }),
        ],
      },
    });

    const list = await fetchServerCustomStats(TOKEN);

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('d-ok');
  });

  it('data 缺 list → 空数组兜底；业务码非 200 → 抛错', async () => {
    vi.stubGlobal('fetch', fetchMock);
    mockJsonResponse(200, { code: 200, message: 'ok', data: null });
    await expect(fetchServerCustomStats(TOKEN)).resolves.toEqual([]);

    mockJsonResponse(200, { code: 50001, message: '服务器内部错误', data: null });
    await expect(fetchServerCustomStats(TOKEN)).rejects.toThrow('服务器内部错误');
  });

  it('HTTP 非 2xx → 抛错（带状态码文案）', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchServerCustomStats(TOKEN)).rejects.toThrow('HTTP 500');
  });
});

describe('putServerCustomStat', () => {
  it('PUT /:id：载荷剥离 isDeleted，路径与 Bearer 头正确', async () => {
    vi.stubGlobal('fetch', fetchMock);
    mockJsonResponse(200, { code: 200, message: 'ok', data: null });

    await putServerCustomStat(TOKEN, def({ isDeleted: 0 }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/custom-stats/d1');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.id).toBe('d1');
    expect('isDeleted' in body).toBe(false);
  });

  it('业务码非 200 → 抛错', async () => {
    vi.stubGlobal('fetch', fetchMock);
    mockJsonResponse(200, { code: 40001, message: '参数非法', data: null });
    await expect(putServerCustomStat(TOKEN, def())).rejects.toThrow('参数非法');
  });
});

describe('deleteServerCustomStat', () => {
  it('DELETE /:id：200 即成功（幂等）', async () => {
    vi.stubGlobal('fetch', fetchMock);
    mockJsonResponse(200, { code: 200, message: 'ok', data: null });

    await expect(deleteServerCustomStat(TOKEN, 'd1')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/custom-stats/d1');
    expect(init.method).toBe('DELETE');
  });
});
