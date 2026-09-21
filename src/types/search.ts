/**
 * @file search.ts
 * @description 资讯搜索领域类型（叶子模块）：检索请求/结果、股票档案卡、预置模板契约。
 *              字段与《news-search-api.md》§2-§5 一一对应，修改前先核对接口文档。
 * @layer Types
 * @storage_impact 纯类型定义，无运行时。
 * @author 开发团队
 */

/** 检索范围（意图分流 Filter；后端无 scope 参数——前端按范围分别调不同端点） */
export type SearchScope = 'announcement' | 'cls' | 'composite';

/** 搜索页状态机（generating = 综合摘要流式生成中） */
export type SearchStatus = 'idle' | 'loading' | 'succeeded' | 'failed' | 'generating';

/** 公告发布/快讯发布日期闭区间（YYYY-MM-DD） */
export interface DateRange {
  start: string;
  end: string;
}

/** 日期预设（预置提问模板内置区间用；搜索页 v1.5 起改为自定义时间区间，不再提供预设 chips） */
export type DatePreset = 'all' | '7d' | '30d';

/** 检索请求（接口文档 §2/§3/§4 请求体同构） */
export interface SearchRequest {
  query: string;
  /** 6 位数字码集合；announcement/composite 范围下为持仓/单票硬过滤（D4 隐私约定：仅传码不传持仓明细） */
  stockCodes?: string[];
  dateRange?: DateRange;
  /** 缺省 10，上限 50 */
  topK?: number;
  /** 分页（无限滑动续拉）：页大小；CLS 端传入时忽略 topK 兼容别名；公告端点就绪前多发字段被后端忽略 */
  pageSize?: number;
  /** 分页：页码，0 起 */
  page?: number;
}

/** runSearch action 入参（视图 dispatch 契约） */
export interface RunSearchInput {
  query: string;
  scope: SearchScope;
  dateRange?: DateRange;
}

/** 公告命中（接口文档 §2） */
export interface AnnouncementHit {
  kind: 'announcement';
  resultId: string;
  stockId: string;
  stockName: string;
  annDate: string;
  title: string;
  /** 2~3 句提炼摘要（不做长文展现，D8） */
  summary: string;
  /** 巨潮原文外链 */
  sourceUrl?: string;
}

/** CLS 快讯命中（接口文档 §3） */
export interface ClsHit {
  kind: 'cls';
  resultId: string;
  publishedAt: string;
  edition: 'morning' | 'evening' | 'telegraph';
  title?: string;
  summary: string;
  /** 电报正文全文（后端实际返回；无则前端回退 summary） */
  content?: string;
  /** 正文实体识别抽取的提及股票；点击 chip 等价于以该股票发起档案卡查询 */
  mentions: Array<{ stockId: string; stockName: string }>;
}

export type SearchResultItem = AnnouncementHit | ClsHit;

/** AI 综合摘要（接口文档 §4；SSE delta 渐进拼接 summary） */
export interface CompositeResult {
  summary: string;
  citations: Array<{
    kind: 'announcement' | 'cls';
    resultId: string;
    stockId?: string;
    date: string;
    title: string;
  }>;
}

/** 股票确定性档案卡（接口文档 §5） */
export interface StockProfile {
  stockId: string;
  stockName: string;
  latestAnnouncements: Array<{
    annId: string;
    annDate: string;
    title: string;
    summary: string;
  }>;
  /** CLS 就绪前可为 null（前端隐藏「财联社提及」区块） */
  clsMention?: {
    count7d: number;
    items: Array<{ publishedAt: string; summary: string }>;
  } | null;
}

/** 预置提问模板（F3；清单见 utils/searchPrompts.ts 静态常量） */
export interface SearchPromptTemplate {
  id: string;
  group: 'holding-risk' | 'market-flash';
  label: string;
  /**
   * 点击模板时构造查询参数。持仓代码集合由调用方（view/slice）dispatch 时注入，
   * 本函数只承载 query/scope/dateRange 静态部分（R2：utils 禁 import store）。
   */
  buildRequest: (ctx: { today: Date }) => {
    query: string;
    scope: SearchScope;
    dateRange?: DateRange;
  };
  /** 持仓为空时置灰（持仓风险类模板依赖持仓集合） */
  requiresHoldings: boolean;
}
