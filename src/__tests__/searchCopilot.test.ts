/**
 * @file searchCopilot.test.ts
 * @description 资讯搜索 Copilot 上下文纯函数单测：整页快照（overview 标量 + 结果行收敛）、
 *              区块快照（公告/CLS 命中的摘要全文与元信息、resultId 缺失安全降级）、
 *              档案卡快照（公告数/7 日提及/clsMention=null 缺席）。
 * @layer 测试
 * @author 开发团队
 */

import { describe, it, expect } from 'vitest';
import {
  buildBlockContext,
  buildProfileContext,
  buildSearchContext,
  type SearchCopilotState,
} from '../utils/searchCopilot';
import type { SearchResultItem, StockProfile } from '../types/search';

const annHit: SearchResultItem = {
  kind: 'announcement',
  resultId: 'AN1',
  stockId: '600745',
  stockName: '闻泰科技',
  annDate: '2026-09-01',
  title: '关于控股股东签署补充协议的公告',
  summary: '控股股东与战投方签署补充对赌协议，触发条件为 2026 年度半导体业务营收不低于 180 亿元。',
  sourceUrl: 'http://www.cninfo.com.cn/new/disclosure/detail?annId=AN1',
};

const clsHit: SearchResultItem = {
  kind: 'cls',
  resultId: 'CLS1',
  publishedAt: '2026-09-05 07:32',
  edition: 'telegraph',
  title: '半导体板块获政策利好',
  summary: '半导体板块利好政策出台，涉及设备与材料环节多家公司。',
  mentions: [{ stockId: '600745', stockName: '闻泰科技' }],
};

const profile: StockProfile = {
  stockId: '600745',
  stockName: '闻泰科技',
  latestAnnouncements: [
    { annId: 'AN2', annDate: '2026-09-08', title: '拟增加半导体产能投资', summary: '拟投资 5 亿元……' },
  ],
  clsMention: {
    count7d: 3,
    items: [{ publishedAt: '2026-09-05 07:32', summary: '半导体板块利好政策出台……' }],
  },
};

const baseState: SearchCopilotState = {
  searchQuery: '对赌',
  searchScope: 'announcement',
  searchStatus: 'succeeded',
  searchResults: [annHit, clsHit],
  compositeResult: null,
  stockProfile: profile,
  searchTotal: 2,
};

describe('buildSearchContext（整页快照）', () => {
  it('overview 落库标量 + detail 结果行收敛 + 单位字典', () => {
    const ctx = buildSearchContext(baseState);
    expect(ctx.overview.query).toBe('对赌');
    expect(ctx.overview.scope).toBe('announcement');
    expect(ctx.overview.status).toBe('succeeded');
    expect(ctx.overview.resultCount).toBe(2);
    expect(ctx.overview.profileStock).toBe('600745 闻泰科技');
    const rows = ctx.detail.results as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'announcement', resultId: 'AN1', stockId: '600745' });
    expect(rows[1]).toMatchObject({ kind: 'cls', resultId: 'CLS1', edition: 'telegraph' });
    expect(ctx.units.annDate).toContain('YYYY-MM-DD');
    expect(ctx.timeAnchor.range).toBe('all');
  });

  it('composite 结果存在时输出引用数与摘要', () => {
    const ctx = buildSearchContext({
      ...baseState,
      scope: undefined,
      searchScope: 'composite',
      compositeResult: { summary: '综合摘要文本', citations: [{ kind: 'cls', resultId: 'CLS1', date: '2026-09-05', title: 't' }] },
    } as SearchCopilotState);
    expect(ctx.overview.compositeCitations).toBe(1);
    const composite = ctx.detail.composite as { summary: string; citations: unknown[] };
    expect(composite.summary).toBe('综合摘要文本');
    expect(composite.citations).toHaveLength(1);
  });

  it('空态安全（results/compositeResult/profile 均缺省）', () => {
    const ctx = buildSearchContext({
      searchQuery: '',
      searchScope: 'announcement',
      searchStatus: 'idle',
      searchResults: [],
      compositeResult: null,
      stockProfile: null,
      searchTotal: 0,
    });
    expect(ctx.overview.resultCount).toBe(0);
    expect(ctx.detail.results).toEqual([]);
    expect(ctx.detail.profile).toBeNull();
  });
});

describe('buildBlockContext（结果区块快照）', () => {
  it('公告命中：摘要全文 + 元信息（股票/日期/来源）', () => {
    const ctx = buildBlockContext(baseState, 'AN1');
    expect(ctx.overview.exists).toBe(true);
    expect(ctx.overview.kind).toBe('announcement');
    expect(ctx.overview.stock).toBe('600745 闻泰科技');
    expect(ctx.overview.date).toBe('2026-09-01');
    expect(ctx.detail.summary).toContain('对赌协议');
    expect(ctx.detail.sourceUrl).toBe(annHit.sourceUrl);
  });

  it('CLS 命中：edition + 提及股票列表', () => {
    const ctx = buildBlockContext(baseState, 'CLS1');
    expect(ctx.overview.exists).toBe(true);
    expect(ctx.overview.edition).toBe('telegraph');
    expect(ctx.detail.mentions).toEqual(['600745 闻泰科技']);
  });

  it('resultId 不存在（已随新查询被替换）→ exists=false 安全降级', () => {
    const ctx = buildBlockContext(baseState, 'GONE');
    expect(ctx.overview.exists).toBe(false);
    expect(ctx.overview.resultId).toBe('GONE');
    expect(ctx.detail).toEqual({});
  });

  it('hit kind 契约外（脏数据/后端字段缺失）→ exists=false 安全降级不抛错（线上崩溃回归）', () => {
    const weird = { ...clsHit, kind: 'telegraph' } as unknown as SearchResultItem;
    const ctx = buildBlockContext({ ...baseState, searchResults: [weird] }, 'CLS1');
    expect(ctx.overview.exists).toBe(false);
    expect(ctx.overview.resultId).toBe('CLS1');
    expect(ctx.detail).toEqual({});
  });
});

describe('buildProfileContext（档案卡区块快照）', () => {
  it('档案卡存在：公告数 + 近 7 天提及 + 明细收敛', () => {
    const ctx = buildProfileContext(baseState);
    expect(ctx.overview.exists).toBe(true);
    expect(ctx.overview.announcementCount).toBe(1);
    expect(ctx.overview.mention7d).toBe(3);
    const detail = ctx.detail as {
      latestAnnouncements: Array<{ annId: string }>;
      clsMention: { count7d: number } | null;
    };
    expect(detail.latestAnnouncements).toHaveLength(1);
    expect(detail.clsMention?.count7d).toBe(3);
  });

  it('clsMention=null（CLS 就绪前）→ mention7d=0 且明细为 null', () => {
    const ctx = buildProfileContext({ ...baseState, stockProfile: { ...profile, clsMention: null } });
    expect(ctx.overview.mention7d).toBe(0);
    expect((ctx.detail as { clsMention: unknown }).clsMention).toBeNull();
  });

  it('档案卡缺席（关键词形态/A10 降级）→ exists=false', () => {
    const ctx = buildProfileContext({ ...baseState, stockProfile: null });
    expect(ctx.overview.exists).toBe(false);
  });

  it('档案卡数组混入 null 元素（契约外脏数据）→ 降级跳过不抛错（线上崩溃回归）', () => {
    const dirty: StockProfile = {
      stockId: '600745',
      stockName: '闻泰科技',
      latestAnnouncements: [{ annId: 'AN2', annDate: '2026-09-08', title: 't', summary: 's' }],
      clsMention: { count7d: 2, items: [{ publishedAt: '2026-09-05 07:32', summary: 's1' }] },
    };
    // 模拟后端脏数据：数组内混入 null（类型层不可表达，运行时注入）
    (dirty.latestAnnouncements as unknown[]).unshift(null);
    if (dirty.clsMention) (dirty.clsMention.items as unknown[]).unshift(null);

    const ctx = buildProfileContext({ ...baseState, stockProfile: dirty });
    expect(ctx.overview.announcementCount).toBe(1);
    expect(ctx.overview.mention7d).toBe(2);
    const detail = ctx.detail as {
      latestAnnouncements: unknown[];
      clsMention: { items: unknown[] } | null;
    };
    expect(detail.latestAnnouncements).toHaveLength(1);
    expect(detail.clsMention?.items).toHaveLength(1);

    // 整页快照同路径（线上报错链：sendMessage → getData → buildSearchContext → profileDetail）
    const pageCtx = buildSearchContext({ ...baseState, stockProfile: dirty });
    const pageProfile = pageCtx.detail.profile as { clsMention: { items: unknown[] } | null };
    expect(pageProfile.clsMention?.items).toHaveLength(1);
  });
});
