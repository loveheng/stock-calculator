/**
 * @file searchPrompts.test.ts
 * @description 资讯搜索纯函数单测：日期格式化与预设换算边界（7d=今日-6、30d=今日-29、
 *              跨月回退）、确定性形态检测（6 位码直判、trim 容忍、边界拒绝）、
 *              名称消歧严格全等（防宽泛词误判）、预置模板 buildRequest 参数与分组。
 * @layer 测试
 * @author 开发团队
 */

import { describe, it, expect } from 'vitest';
import {
  SEARCH_PROMPT_TEMPLATES,
  detectQueryIntent,
  formatDate,
  matchStockDisambiguation,
  presetDateRange,
  templateGroupLabel,
} from '../utils/searchPrompts';

describe('formatDate / presetDateRange', () => {
  const today = new Date(2026, 8, 10); // 2026-09-10（本地时区）

  it('formatDate 输出本地时区 YYYY-MM-DD（补零）', () => {
    expect(formatDate(new Date(2026, 8, 5))).toBe('2026-09-05');
  });

  it("presetDateRange('all') 返回 undefined（请求不带 dateRange，后端不限）", () => {
    expect(presetDateRange('all', today)).toBeUndefined();
  });

  it("presetDateRange('7d') 为近 7 天闭区间（today-6 ~ today）", () => {
    expect(presetDateRange('7d', today)).toEqual({ start: '2026-09-04', end: '2026-09-10' });
  });

  it("presetDateRange('30d') 为近 30 天闭区间（today-29 ~ today）", () => {
    expect(presetDateRange('30d', today)).toEqual({ start: '2026-08-12', end: '2026-09-10' });
  });

  it('跨月/跨年边界正确回退', () => {
    expect(presetDateRange('7d', new Date(2026, 8, 2))?.start).toBe('2026-08-27');
    expect(presetDateRange('7d', new Date(2026, 0, 3))?.start).toBe('2025-12-28');
  });
});

describe('detectQueryIntent', () => {
  it('6 位数字码 → stock 形态', () => {
    expect(detectQueryIntent('600745')).toEqual({ kind: 'stock', stockId: '600745' });
  });

  it('前后空白容忍（trim 后判定）', () => {
    expect(detectQueryIntent('  600745 ')).toEqual({ kind: 'stock', stockId: '600745' });
  });

  it('5 位 / 7 位 / 带市场前缀 / 中文 → keyword', () => {
    expect(detectQueryIntent('60074')).toEqual({ kind: 'keyword' });
    expect(detectQueryIntent('6007451')).toEqual({ kind: 'keyword' });
    expect(detectQueryIntent('sh600745')).toEqual({ kind: 'keyword' });
    expect(detectQueryIntent('对赌协议')).toEqual({ kind: 'keyword' });
  });
});

describe('matchStockDisambiguation（严格全等消歧）', () => {
  const candidates = [
    { Code: '600745', Name: '闻泰科技', fullCode: 'sh600745' },
    { Code: '601318', Name: '中国平安', fullCode: 'sh601318' },
  ];

  it('输入与首条 Code 严格全等 → 该股 6 位码', () => {
    expect(matchStockDisambiguation('600745', candidates)).toBe('600745');
  });

  it('输入与首条 Name 严格全等 → 该股 6 位码', () => {
    expect(matchStockDisambiguation('闻泰科技', candidates)).toBe('600745');
  });

  it('部分匹配（宽泛词/前缀）不误判 → null', () => {
    expect(matchStockDisambiguation('闻泰', candidates)).toBeNull();
    expect(matchStockDisambiguation('6007', candidates)).toBeNull();
  });

  it('仅认首条消歧：次条全等不命中', () => {
    expect(matchStockDisambiguation('中国平安', candidates)).toBeNull();
  });

  it('空输入 / 空候选 → null', () => {
    expect(matchStockDisambiguation('', candidates)).toBeNull();
    expect(matchStockDisambiguation('闻泰科技', [])).toBeNull();
  });

  it('fullCode 带市场前缀时经 toStockId 归一化为 6 位码', () => {
    expect(
      matchStockDisambiguation('600745', [{ Code: '600745', Name: '闻泰科技', fullCode: 'SZ600745' }]),
    ).toBe('600745');
  });
});

describe('SEARCH_PROMPT_TEMPLATES（F3 预置模板）', () => {
  const today = new Date(2026, 8, 10);

  it('清单含两分组共 4 个模板；持仓类 requiresHoldings=true', () => {
    expect(SEARCH_PROMPT_TEMPLATES).toHaveLength(4);
    expect(SEARCH_PROMPT_TEMPLATES.filter((t) => t.group === 'holding-risk')).toHaveLength(2);
    expect(SEARCH_PROMPT_TEMPLATES.filter((t) => t.group === 'market-flash')).toHaveLength(2);
    for (const t of SEARCH_PROMPT_TEMPLATES) {
      expect(t.requiresHoldings).toBe(t.group === 'holding-risk');
    }
  });

  it('近 30 天减持/质押模板：公告库 + 持仓 + 近 30 天闭区间', () => {
    const t = SEARCH_PROMPT_TEMPLATES.find((x) => x.id === 'holding-risk-30d');
    expect(t?.buildRequest({ today })).toEqual({
      query: '减持 质押',
      scope: 'announcement',
      dateRange: { start: '2026-08-12', end: '2026-09-10' },
    });
  });

  it('对赌协议模板：公告库、无日期范围', () => {
    const t = SEARCH_PROMPT_TEMPLATES.find((x) => x.id === 'holding-risk-duige');
    expect(t?.buildRequest({ today })).toEqual({ query: '对赌协议', scope: 'announcement' });
  });

  it('今日早报模板：CLS 库 + 当日闭区间', () => {
    const t = SEARCH_PROMPT_TEMPLATES.find((x) => x.id === 'flash-today-morning');
    expect(t?.buildRequest({ today })).toEqual({
      query: '电报 核心提炼',
      scope: 'cls',
      dateRange: { start: '2026-09-10', end: '2026-09-10' },
    });
  });

  it('板块统计模板：综合库 + 近 7 天', () => {
    const t = SEARCH_PROMPT_TEMPLATES.find((x) => x.id === 'flash-week-sectors');
    expect(t?.buildRequest({ today })).toEqual({
      query: '板块 提及 统计',
      scope: 'composite',
      dateRange: { start: '2026-09-04', end: '2026-09-10' },
    });
  });

  it('templateGroupLabel 分组展示名', () => {
    expect(templateGroupLabel('holding-risk')).toBe('持仓风险类');
    expect(templateGroupLabel('market-flash')).toBe('宏观与快讯类');
  });
});
