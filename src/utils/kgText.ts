/**
 * @file kgText.ts
 * @description 新闻联播图谱展示层纯函数（utils 引擎）：实体类型中文标签、
 *              事件时间兜底展示（eventDate 缺失时用 eventTimeText）、日头日期兜底、
 *              高亮词集合构建（keyword 分词 / 实体名+别名）与文本高亮分段。
 *              全部显式入参显式返回，不碰 store/db（R2）。
 * @layer Utils
 * @storage_impact 纯计算，无副作用。
 * @author 开发团队
 */

import type { KgEntityType, KgEntitySuggest, KgTimelineEvent } from '../types/kg';

/** 实体类型中文标签（八类枚举；契约外值由调用方归一为 OTHER） */
const ENTITY_TYPE_LABEL: Record<KgEntityType, string> = {
  STOCK: '股票',
  SUBJECT: '题材',
  ORG: '机构',
  PERSON: '人物',
  PLACE: '地区',
  POLICY: '政策',
  EVENT: '事件',
  OTHER: '其他',
};

export function kgEntityTypeLabel(type: KgEntityType): string {
  return ENTITY_TYPE_LABEL[type] ?? '其他';
}

/**
 * 事件时间展示（接口文档 §二语义注记）：归一化 eventDate 优先；
 * 缺失时用原文时间表述 eventTimeText（如「今天」「上月」）；两者皆缺 = 「时间待定」。
 */
export function kgEventTimeText(event: Pick<KgTimelineEvent, 'eventDate' | 'eventTimeText'>): string {
  return event.eventDate ?? event.eventTimeText ?? '时间待定';
}

/**
 * 日头日期展示：date 空串（源站撤稿等弱一致场景）时从原标题提取「x月x日」兜底；
 * 原标题也没有则返回「日期缺失」。date 正常时附星期（同月的汇编稿固定周日播发前置摘要，
 * 星期由日期推算而非标题文案，避免标题差一天的误导）。
 */
export function kgDayHeaderText(date: string, articleTitle: string): string {
  if (date) {
    const d = new Date(date + 'T00:00:00');
    if (!Number.isNaN(d.getTime())) {
      return date + ' ' + '日一二三四五六'.charAt(d.getDay());
    }
    return date;
  }
  const m = articleTitle.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return m[1] + '月' + m[2] + '日';
  return '日期缺失';
}

/**
 * 高亮词集合（接口文档 §六）：keyword 搜索态按空白分词取 ≥2 字符片段；
 * entityId 搜索态用实体名 + matched 实体名（别名高亮过度发散，不并入）。
 * 两态皆无有效词 → 空数组（不高亮）。
 */
export function buildKgHighlightTerms(input: {
  keyword: string | null;
  entityName: string | null;
  matchedNames: string[];
}): string[] {
  const terms: string[] = [];
  const kw = input.keyword?.trim();
  if (kw) {
    for (const t of kw.split(/\s+/)) {
      if (t.length >= 2 && !terms.includes(t)) terms.push(t);
    }
  }
  if (input.entityName && input.entityName.length >= 2 && !terms.includes(input.entityName)) {
    terms.push(input.entityName);
  }
  for (const name of input.matchedNames) {
    if (name.length >= 2 && !terms.includes(name)) terms.push(name);
  }
  return terms.slice(0, 8); // 防御：词数失控时限制正则复杂度
}

/**
 * 文本按高亮词集切段：命中段与普通段交替返回（偶数下标 = 普通文本，奇数 = 命中片段）。
 * 不区分大小写；正则特殊字符转义；词集为空返回 null（调用方原样渲染，不切段）。
 */
export function splitKgHighlight(text: string, terms: string[]): Array<string> | null {
  if (terms.length === 0 || !text) return null;
  const escaped = terms.map((t) => t.replace(/[.*+?^'"{}()|[\]\\]/g, '\\$&'));
  let regex: RegExp;
  try {
    regex = new RegExp('(' + escaped.join('|') + ')', 'gi');
  } catch {
    return null;
  }
  const parts = text.split(regex);
  return parts.length > 1 ? parts : null;
}
