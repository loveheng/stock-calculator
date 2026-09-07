/**
 * @file customStatsSlice.test.ts
 * @description 自定义统计切片回归测试：
 *              - 草稿生命周期：startCustomStatDraft（执行成功入草稿）/ 执行失败入错误态
 *              - attempt 计数（第 N 版）与单槽位覆盖规则（旧草稿未保存被替换，FR3）
 *              - saveCustomStatDraft 另存（写库 + 清草稿）/ 替换（需 originDefId）
 *              - 画廊加载 / 钉选切换 / 软删 / markSeen 基准
 *              - run_custom_stat 动作管线：copilotActionSlice auto 分发 → startCustomStatDraft
 *              沙箱执行经 client（浏览器 Worker 不可用 → 夹具预跑报「沙箱不可用」错误态，
 *              用以验证错误路径；纯执行器行为见 customStatRunner.test.ts）。
 * @layer 测试
 * @storage_impact 使用 fake-indexeddb 内存数据库，不触达真实存储。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import { db } from '../db/index';
import type { CopilotRunStatPayload, CustomStatDefinition } from '../types/domain';
import { CUSTOM_STAT_SCHEMA_VERSION } from '../types/domain';
import { buildSampleDefinition } from '../utils/customStats/fixtures';
import { saveCustomStatDef } from '../services/customStatsService';
import {
  deleteServerCustomStat,
  fetchServerCustomStats,
  putServerCustomStat,
} from '../services/customStatsSyncService';
import { loadStoredAuthSession, type StoredAuthSession } from '../services/authSession';

// 同步通道全部 mock：不触网；默认未登录（token 为空 → 同步静默跳过，存量用例不受影响）
vi.mock(import('../services/customStatsSyncService'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchServerCustomStats: vi.fn(),
  putServerCustomStat: vi.fn(),
  deleteServerCustomStat: vi.fn(),
}));
vi.mock(import('../services/authSession'), async (importOriginal) => ({
  ...(await importOriginal()),
  loadStoredAuthSession: vi.fn(() => null),
}));

const PAYLOAD: CopilotRunStatPayload = {
  name: '各股做T净收益排行',
  description: '统计已归档轮净收益按股票求和',
  prompt: '统计各股做T净收益排行，柱状图降序',
  code: "(ctx) => ({ kind: 'card', title: 'T', kpis: [] })",
};

beforeEach(async () => {
  // 测试间隔离：清空 fake-indexeddb 全部表 + store 状态复位
  await Promise.all(db.tables.map((t) => t.clear()));
  vi.mocked(fetchServerCustomStats).mockReset();
  vi.mocked(putServerCustomStat).mockReset();
  vi.mocked(deleteServerCustomStat).mockReset();
  vi.mocked(loadStoredAuthSession).mockReturnValue(null);
  useAppStore.setState({
    customStatDraft: null,
    customStatsGallery: [],
    customStatsRefreshing: false,
    customStatsSyncing: false,
    customStatsLastSeenAt: '',
    copilotNotice: null,
  });
});

describe('customStatsSlice 草稿生命周期', () => {
  it('startCustomStatDraft：jsdom 无 Worker → 夹具预跑失败入错误态（不崩溃）', async () => {
    await useAppStore.getState().startCustomStatDraft(PAYLOAD);
    const draft = useAppStore.getState().customStatDraft;
    expect(draft).not.toBeNull();
    expect(draft?.running).toBe(false);
    expect(draft?.attempt).toBe(1);
    // 无 Worker 环境 client 返回「沙箱不可用」类错误
    expect(draft?.error).toBeTruthy();
  });

  it('attempt 计数递增（第 N 版）', async () => {
    await useAppStore.getState().startCustomStatDraft(PAYLOAD);
    await useAppStore.getState().startCustomStatDraft(PAYLOAD);
    expect(useAppStore.getState().customStatDraft?.attempt).toBe(2);
  });

  it('clearCustomStatDraft 丢弃草稿', async () => {
    await useAppStore.getState().startCustomStatDraft(PAYLOAD);
    useAppStore.getState().clearCustomStatDraft();
    expect(useAppStore.getState().customStatDraft).toBeNull();
  });
});

describe('customStatsSlice 保存与画廊', () => {
  it('saveCustomStatDraft：另存新定义（写库 + 清草稿 + 画廊刷新）', async () => {
    useAppStore.setState({
      customStatDraft: {
        code: PAYLOAD.code,
        name: PAYLOAD.name,
        description: PAYLOAD.description,
        prompt: PAYLOAD.prompt,
        attempt: 1,
        running: false,
        lastResult: { kind: 'card', title: 'T', kpis: [{ label: 'a', value: '1' }] },
      },
    });
    await useAppStore.getState().saveCustomStatDraft('new');
    expect(useAppStore.getState().customStatDraft).toBeNull();
    const gallery = useAppStore.getState().customStatsGallery;
    expect(gallery.length).toBe(1);
    expect(gallery[0].kind).toBe('card');
    expect(gallery[0].schemaVersion).toBe(CUSTOM_STAT_SCHEMA_VERSION);
    expect(gallery[0].prompt).toBe(PAYLOAD.prompt);
    expect(gallery[0].runCount).toBe(1);
  });

  it('saveCustomStatDraft(replace)：无 originDefId 时兜底拒绝（不写库）', async () => {
    useAppStore.setState({
      customStatDraft: {
        code: PAYLOAD.code,
        name: PAYLOAD.name,
        description: PAYLOAD.description,
        prompt: PAYLOAD.prompt,
        attempt: 1,
        running: false,
        lastResult: { kind: 'card', title: 'T', kpis: [] },
      },
    });
    await useAppStore.getState().saveCustomStatDraft('replace');
    expect(useAppStore.getState().customStatsGallery.length).toBe(0);
  });

  it('saveCustomStatDraft(replace)：有 originDefId → 旧行软删 + 新行入库（钉选迁移在 service 层验证）', async () => {
    await saveCustomStatDef(buildSampleDefinition({ id: 'origin-1', pinned: true, pinnedAt: '2026-09-01T00:00:00.000Z' }));
    useAppStore.setState({
      customStatDraft: {
        code: PAYLOAD.code,
        name: '新版统计',
        description: PAYLOAD.description,
        prompt: PAYLOAD.prompt,
        originDefId: 'origin-1',
        attempt: 2,
        running: false,
        lastResult: { kind: 'chart', title: 'T', chart: { type: 'bar', data: [] } },
      },
    });
    await useAppStore.getState().saveCustomStatDraft('replace');
    const gallery = useAppStore.getState().customStatsGallery;
    expect(gallery.map((d) => d.id)).not.toContain('origin-1');
    expect(gallery.length).toBe(1);
    expect(gallery[0].name).toBe('新版统计');
    // 钉选状态按定义迁移（kind 变更即落图表区）
    expect(gallery[0].pinned).toBe(true);
    expect(gallery[0].pinnedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('toggleCustomStatPin / deleteCustomStatDef / markCustomStatsSeen', async () => {
    await saveCustomStatDef(buildSampleDefinition({ id: 'def-1' }));
    await useAppStore.getState().loadCustomStatsGallery();
    expect(useAppStore.getState().customStatsGallery[0].pinned).toBeFalsy();

    await useAppStore.getState().toggleCustomStatPin('def-1', true);
    expect(useAppStore.getState().customStatsGallery[0].pinned).toBe(true);

    await useAppStore.getState().deleteCustomStatDef('def-1');
    expect(useAppStore.getState().customStatsGallery.length).toBe(0);

    useAppStore.getState().markCustomStatsSeen();
    expect(useAppStore.getState().customStatsLastSeenAt).not.toBe('');
  });
});

describe('run_custom_stat 动作管线（copilotActionSlice auto 分发）', () => {
  it('handleCopilotActions → run_custom_stat 载荷入草稿', async () => {
    useAppStore.getState().handleCopilotActions([
      { type: 'run_custom_stat', payload: { ...PAYLOAD } },
    ]);
    // startCustomStatDraft 为异步编排，轮询等待草稿落位
    for (let i = 0; i < 20 && !useAppStore.getState().customStatDraft; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(useAppStore.getState().customStatDraft).not.toBeNull();
  });

  it('非法载荷（缺 prompt）静默丢弃', () => {
    useAppStore.getState().handleCopilotActions([
      { type: 'run_custom_stat', payload: { name: 'x', description: 'y', code: 'z' } },
    ]);
    expect(useAppStore.getState().customStatDraft).toBeNull();
  });
});

describe('syncCustomStatsFromServer 服务端同步', () => {
  const TOKEN = 'tok-1';
  const T_OLD = '2026-09-01T00:00:00.000Z';
  const T_NEW = '2026-09-02T00:00:00.000Z';

  function login(): void {
    vi.mocked(loadStoredAuthSession).mockReturnValue({
      token: TOKEN,
      userId: 'u-1',
      email: 'u-1@test.local',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
  }

  it('未登录静默跳过：不触网、同步位复位', async () => {
    const counts = await useAppStore.getState().syncCustomStatsFromServer();
    expect(counts).toEqual({ pulled: 0, pushed: 0, deleted: 0 });
    expect(fetchServerCustomStats).not.toHaveBeenCalled();
    expect(useAppStore.getState().customStatsSyncing).toBe(false);
  });

  it('服务端较新 → 覆盖本地（LWW 拉取合并，保留远端 updatedAt）', async () => {
    login();
    const local = buildSampleDefinition({ id: 'd1', updatedAt: T_OLD, name: '旧名' });
    await saveCustomStatDef(local);
    vi.mocked(fetchServerCustomStats).mockResolvedValue([
      buildSampleDefinition({ id: 'd1', updatedAt: T_NEW, name: '新名' }),
    ]);

    const counts = await useAppStore.getState().syncCustomStatsFromServer();

    expect(counts.pulled).toBe(1);
    const row = useAppStore.getState().customStatsGallery.find((d) => d.id === 'd1');
    expect(row?.name).toBe('新名');
    expect(row?.updatedAt).toBe(T_NEW);
    expect(putServerCustomStat).not.toHaveBeenCalled();
  });

  it('服务端缺失/较旧的本地定义 → 推送 upsert', async () => {
    login();
    const local = buildSampleDefinition({ id: 'd1', updatedAt: T_NEW });
    await saveCustomStatDef(local);
    const older = buildSampleDefinition({ id: 'd1', updatedAt: T_OLD });
    vi.mocked(fetchServerCustomStats).mockResolvedValue([older]);

    const counts = await useAppStore.getState().syncCustomStatsFromServer();

    expect(counts.pushed).toBe(1);
    expect(putServerCustomStat).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ id: 'd1', updatedAt: T_NEW }));
  });

  it('本地独有定义（服务端空列表）→ 推送 upsert', async () => {
    login();
    await saveCustomStatDef(buildSampleDefinition({ id: 'd1', updatedAt: T_NEW }));
    vi.mocked(fetchServerCustomStats).mockResolvedValue([]);

    const counts = await useAppStore.getState().syncCustomStatsFromServer();

    expect(counts.pushed).toBe(1);
    expect(putServerCustomStat).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ id: 'd1' }));
  });

  it('未知 schemaVersion 的服务端定义跳过不落库', async () => {
    login();
    vi.mocked(fetchServerCustomStats).mockResolvedValue([
      buildSampleDefinition({ id: 'd9', updatedAt: T_NEW, schemaVersion: 99 }),
    ]);

    const counts = await useAppStore.getState().syncCustomStatsFromServer();

    expect(counts.pulled).toBe(0);
    expect(useAppStore.getState().customStatsGallery.find((d) => d.id === 'd9')).toBeUndefined();
  });

  it('本地墓碑 → 服务端幂等删除 + 本地墓碑物理清理', async () => {
    login();
    await saveCustomStatDef(buildSampleDefinition({ id: 'd1', updatedAt: T_NEW, isDeleted: 1 }));
    vi.mocked(fetchServerCustomStats).mockResolvedValue([]);

    const counts = await useAppStore.getState().syncCustomStatsFromServer();

    expect(counts.deleted).toBe(1);
    expect(deleteServerCustomStat).toHaveBeenCalledWith(TOKEN, 'd1');
    const all = await db.customStats.toArray();
    expect(all.find((d) => d.id === 'd1')).toBeUndefined();
  });

  it('拉取失败静默降级：本地数据与同步位不受影响', async () => {
    login();
    await saveCustomStatDef(buildSampleDefinition({ id: 'd1', updatedAt: T_NEW }));
    vi.mocked(fetchServerCustomStats).mockRejectedValue(new Error('网络不可用'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const counts = await useAppStore.getState().syncCustomStatsFromServer();

    expect(counts).toEqual({ pulled: 0, pushed: 0, deleted: 0 });
    expect(useAppStore.getState().customStatsSyncing).toBe(false);
    expect(useAppStore.getState().customStatsGallery).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('相等 updatedAt 双向跳过（幂等对账）', async () => {
    login();
    await saveCustomStatDef(buildSampleDefinition({ id: 'd1', updatedAt: T_NEW }));
    vi.mocked(fetchServerCustomStats).mockResolvedValue([
      buildSampleDefinition({ id: 'd1', updatedAt: T_NEW }),
    ]);

    const counts = await useAppStore.getState().syncCustomStatsFromServer();

    expect(counts).toEqual({ pulled: 0, pushed: 0, deleted: 0 });
    expect(putServerCustomStat).not.toHaveBeenCalled();
  });

  it('单条推送失败不阻断其他条目（如后端 40001 超限：旧字符口径的存量定义）', async () => {
    login();
    await saveCustomStatDef(buildSampleDefinition({ id: 'd1', updatedAt: T_NEW }));
    await saveCustomStatDef(buildSampleDefinition({ id: 'd2', updatedAt: T_NEW }));
    await saveCustomStatDef(buildSampleDefinition({ id: 'd3', updatedAt: T_NEW, isDeleted: 1 }));
    vi.mocked(fetchServerCustomStats).mockResolvedValue([]);
    // 第一条 PUT 被拒（超限），第二条成功；墓碑 DELETE 也被拒 → 保留墓碑不误清
    vi.mocked(putServerCustomStat).mockRejectedValueOnce(new Error('40001 超限'));
    vi.mocked(putServerCustomStat).mockResolvedValueOnce(undefined);
    vi.mocked(deleteServerCustomStat).mockRejectedValue(new Error('40001 超限'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const counts = await useAppStore.getState().syncCustomStatsFromServer();

    expect(counts.pushed).toBe(1); // d1 失败，d2 成功
    expect(counts.deleted).toBe(0); // d3 墓碑删除失败，保留
    expect(putServerCustomStat).toHaveBeenCalledTimes(2); // d1 与 d2 都尝试过
    const all = await db.customStats.toArray();
    expect(all.find((d) => d.id === 'd3')).toBeDefined(); // 墓碑仍在，下次对账重试
    warnSpy.mockRestore();
  });
});
