/**
 * @file searchPrompts.ts
 * @description 资讯搜索纯函数工具：确定性查询形态检测（6 位码 → 档案卡模式）、
 *              Smartbox 名称消歧判定（严格全等防宽泛词误判）、日期预设换算、
 *              预置提问模板静态清单（spec F3）。
 *              纯函数层：显式入参/显式返回值，持仓集合由调用方（view/slice）注入，
 *              严禁 import store/db（R2）。
 * @layer Utils
 * @storage_impact 纯计算，无存储。
 * @author 开发团队
 */

import type {
  DatePreset,
  DateRange,
  SearchPromptTemplate,
  SearchScope,
} from '../types/search';
import { toStockId } from './dedup';

/** YYYY-MM-DD（本地时区） */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  return y + '-' + M + '-' + D;
}

function addDays(d: Date, days: number): Date {
  const n = new Date(d);
  n.setDate(n.getDate() + days);
  return n;
}

/** 日期预设 → 闭区间（'all' 返回 undefined = 请求不带 dateRange，后端不限） */
export function presetDateRange(preset: DatePreset, today: Date): DateRange | undefined {
  if (preset === 'all') return undefined;
  return {
    start: formatDate(addDays(today, preset === '7d' ? -6 : -29)),
    end: formatDate(today),
  };
}

/** 查询形态：6 位数字码 → 股票档案卡模式；其余 → 关键词模式 */
export type QueryIntent = { kind: 'stock'; stockId: string } | { kind: 'keyword' };

export function detectQueryIntent(query: string): QueryIntent {
  const q = String(query ?? '').trim();
  return /^\d{6}$/.test(q) ? { kind: 'stock', stockId: q } : { kind: 'keyword' };
}

/**
 * 名称消歧判定：Smartbox 首条结果与输入**严格全等**（6 位 Code 或证券 Name）才认作股票，
 * 避免「银行」「平安」这类宽泛词被首条命中误判为档案卡模式。返回 6 位股票码或 null。
 */
export function matchStockDisambiguation(
  query: string,
  candidates: Array<{ Code: string; Name: string; fullCode: string }>,
): string | null {
  const q = String(query ?? '').trim();
  const top = candidates[0];
  if (!q || !top) return null;
  if (top.Code === q || top.Name === q) return toStockId(top.fullCode);
  return null;
}

/** 模板分组展示名 */
export function templateGroupLabel(group: 'holding-risk' | 'market-flash'): string {
  return group === 'holding-risk' ? '持仓风险类' : '宏观与快讯类';
}

/**
 * 预置提问模板静态清单（spec F3；后端热榜下发为 P2 后评估项）。
 * 注意：查询词传给后端做向量/关键词检索，「减持 质押」空格分词由检索侧处理。
 */
export const SEARCH_PROMPT_TEMPLATES: SearchPromptTemplate[] = [
  {
    id: 'holding-risk-30d',
    group: 'holding-risk',
    label: '近 30 天有哪些持仓股票发布了减持或质押公告？',
    requiresHoldings: true,
    buildRequest: ({ today }) => ({
      query: '减持 质押',
      scope: 'announcement' as SearchScope,
      dateRange: presetDateRange('30d', today),
    }),
  },
  {
    id: 'holding-risk-duige',
    group: 'holding-risk',
    label: '查一下我的持仓里有没有涉及「对赌协议」的风险公告？',
    requiresHoldings: true,
    buildRequest: () => ({
      query: '对赌协议',
      scope: 'announcement' as SearchScope,
    }),
  },
  {
    id: 'flash-today-morning',
    group: 'market-flash',
    label: '搜索今天的财联社早报核心提炼',
    requiresHoldings: false,
    // 语料为财联社电报（无早报版面），检索词用「电报」保证召回；label 保留用户口径
    buildRequest: ({ today }) => ({
      query: '电报 核心提炼',
      scope: 'cls' as SearchScope,
      dateRange: { start: formatDate(today), end: formatDate(today) },
    }),
  },
  {
    id: 'flash-week-sectors',
    group: 'market-flash',
    label: '本周财联社电报里提及最多的板块是什么？',
    requiresHoldings: false,
    buildRequest: ({ today }) => ({
      query: '板块 提及 统计',
      scope: 'composite' as SearchScope,
      dateRange: presetDateRange('7d', today),
    }),
  },
];
