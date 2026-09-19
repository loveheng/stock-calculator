/**
 * @file kgText.test.ts
 * @description 图谱展示层纯函数单测：事件时间兜底（eventDate 优先 → eventTimeText → 时间待定）、
 *              日头日期兜底（正常日期含星期 / 空串回退标题「x月x日」/ 双缺省）、
 *              高亮词集构建（keyword 分词去重 / entityId 实体名 / 词数截断）、
 *              高亮分段（命中段交替 / 正则特殊字符转义 / 空词原样）。
 * @layer 测试
 * @author 开发团队
 */

import { describe, expect, it } from 'vitest';
import {
  buildKgHighlightTerms,
  kgDayHeaderText,
  kgEventTimeText,
  kgEntityTypeLabel,
  splitKgHighlight,
} from '../utils/kgText';

describe('kgEventTimeText：事件时间兜底', () => {
  it('eventDate 优先', () => {
    expect(kgEventTimeText({ eventDate: '2023-09-10', eventTimeText: '今天' })).toBe('2023-09-10');
  });
  it('eventDate 为 null 时用 eventTimeText 兜底', () => {
    expect(kgEventTimeText({ eventDate: null, eventTimeText: '上月' })).toBe('上月');
  });
  it('两者皆缺 = 时间待定', () => {
    expect(kgEventTimeText({ eventDate: null, eventTimeText: null })).toBe('时间待定');
  });
});

describe('kgDayHeaderText：日头日期兜底', () => {
  it('正常日期附星期（2023-09-10 为周日）', () => {
    expect(kgDayHeaderText('2023-09-10', '9月10日周日《新闻联播》要闻22条')).toBe('2023-09-10 日');
  });
  it('date 空串时从原标题提取 x月x日（弱一致场景防御）', () => {
    expect(kgDayHeaderText('', '9月10日周日《新闻联播》要闻22条')).toBe('9月10日');
  });
  it('双缺省 = 日期缺失', () => {
    expect(kgDayHeaderText('', '《新闻联播》要闻汇编')).toBe('日期缺失');
  });
});

describe('kgEntityTypeLabel', () => {
  it('八类中文标签映射', () => {
    expect(kgEntityTypeLabel('STOCK')).toBe('股票');
    expect(kgEntityTypeLabel('CLS_SUBJECT' as never)).toBe('其他'); // 契约外值兜底
  });
});

describe('buildKgHighlightTerms', () => {
  it('keyword 按空白分词取 ≥2 字符片段并去重', () => {
    expect(
      buildKgHighlightTerms({ keyword: '杭州 亚运会  亚运会 一带', entityName: null, matchedNames: [] }),
    ).toEqual(['杭州', '亚运会', '一带']);
  });
  it('entityId 态并入实体名与 matched 实体名', () => {
    expect(
      buildKgHighlightTerms({
        keyword: null,
        entityName: '杭州第19届亚洲运动会',
        matchedNames: ['杭州第19届亚洲运动会', '习近平'],
      }),
    ).toEqual(['杭州第19届亚洲运动会', '习近平']);
  });
  it('单字符词与空输入不高亮', () => {
    expect(buildKgHighlightTerms({ keyword: 'a b 杭', entityName: null, matchedNames: [] })).toEqual([]);
  });
  it('词数截断上限 8（正则复杂度防御）', () => {
    const terms = buildKgHighlightTerms({
      keyword: '甲一 乙二 丙三 丁四 戊五 己六 庚七 辛八 壬九 癸十',
      entityName: null,
      matchedNames: [],
    });
    expect(terms).toHaveLength(8);
  });
});

describe('splitKgHighlight', () => {
  it('命中段与普通段交替（偶数下标 = 普通文本）', () => {
    expect(splitKgHighlight('杭州亚运会开幕', ['亚运会'])).toEqual(['杭州', '亚运会', '开幕']);
  });
  it('正则特殊字符安全转义', () => {
    expect(splitKgHighlight('涨幅100%以上', ['100%'])).toEqual(['涨幅', '100%', '以上']);
  });
  it('无命中返回 null（调用方原样渲染）', () => {
    expect(splitKgHighlight('无命中文本', ['不存在'])).toBeNull();
  });
  it('空词集返回 null', () => {
    expect(splitKgHighlight('任意文本', [])).toBeNull();
  });
});
