/**
 * @file kg.ts
 * @description 新闻联播图谱领域类型（叶子模块）：时间轴卡片流、实体检索建议/热榜、
 *              实体详情摘要卡的请求与响应契约。字段与《kg 时间轴查询 API · 前端对接文档》
 *              §二~§五一一对应，修改前先核对接口文档（后端设计稿 docs/ai-pipeline/cls-news-kg.md §13）。
 * @layer Types
 * @storage_impact 纯类型定义，无运行时。
 * @author 开发团队
 */

/** 实体类型枚举（接口文档 §二：LLM 抽取的八类；展示中文标签见 utils/kgText） */
export type KgEntityType =
  | 'STOCK'
  | 'SUBJECT'
  | 'ORG'
  | 'PERSON'
  | 'PLACE'
  | 'POLICY'
  | 'EVENT'
  | 'OTHER';

/** 锚点类型：STOCK = 锚定股票字典，CLS_SUBJECT = 锚定财联社题材，null = 自由实体（未锚定字典） */
export type KgAnchorType = 'STOCK' | 'CLS_SUBJECT' | null;

/** 时间轴状态机（无流式环节，比 SearchStatus 少 generating） */
export type KgStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

/** runKgTimeline action 入参（视图 dispatch 契约）：keyword / entityId 单选下发 */
export interface KgTimelineInput {
  keyword?: string;
  /** 实体精确过滤（点实体 chips / 热榜 chips / suggest 后走这个） */
  entityId?: number;
  /** entityId 态的实体名（过滤提示与高亮展示用；keyword 态忽略） */
  entityName?: string;
}

/** 实体 chips 最小形状（事件卡实体 chips 与各类 chips 共用） */
export interface KgEntityRef {
  id: number;
  name: string;
  entityType: KgEntityType;
  anchorType: KgAnchorType;
}

/** 实体建议/热榜行（接口文档 §三/§四同构：suggest = hot + keyword 过滤） */
export interface KgEntitySuggest extends KgEntityRef {
  /** 提及次数（文章口径），倒序排序依据 */
  mentionCount: number;
}

/** 关键词搜索态命中的实体（接口文档 §二 matchedEntities：top3，仅 keyword 搜索态返回） */
export interface KgMatchedEntity extends KgEntitySuggest {
  /** 仅 keyword 态返回，默认态恒 [] */
  anchorType: KgAnchorType;
}

/** 时间轴事件（接口文档 §二 days[].events[]） */
export interface KgTimelineEvent {
  id: number;
  /** 归一化事件日期（yyyy-MM-dd）；解析失败为 null，展示兜底 eventTimeText */
  eventDate: string | null;
  /** 原文时间表述（「今天」「上月」等），eventDate 为 null 时的展示兜底 */
  eventTimeText: string | null;
  title: string;
  /** 补充细节，可能为 null（详情抽屉全文展示） */
  detail: string | null;
  /** LLM 自由值（如「其他」），一期不强制枚举 */
  eventType: string;
  /** 源汇编稿 id（溯源外键） */
  articleId: number;
  /** 事件实体 chips */
  entities: KgEntityRef[];
}

/** 时间轴日组（一篇汇编稿 = 一日） */
export interface KgTimelineDay {
  /** 源汇编稿 id（日头，亦是溯源外键） */
  articleId: number;
  /** 日头日期（汇编稿发布日，标题日期可能差一天）；源站撤稿等弱一致场景可能为空串（前端防御） */
  date: string;
  /** 原标题（自带 x月x日 无年份） */
  articleTitle: string;
  eventCount: number;
  /** 组内事件 = 汇编原文阅读序（时间升序、空值沉底） */
  events: KgTimelineEvent[];
}

/** 时间轴响应 data（接口文档 §二） */
export interface KgTimelineResult {
  page: number;
  pageSize: number;
  /** 命中条件的事件日总数（分页控制） */
  totalDays: number;
  /** 是否还有下一页 */
  hasMore: boolean;
  /** 仅 keyword 搜索态返回（top3）；默认态为 [] */
  matchedEntities: KgMatchedEntity[];
  days: KgTimelineDay[];
}

/** 时间轴查询入参（GET /api/kg/timeline，全部可选；不传过滤参数 = 默认态「最近时间轴」） */
export interface KgTimelineQuery {
  /** 关键词；三路命中：事件标题/详情文本 OR 关联实体名 OR 实体别名 */
  keyword?: string;
  /** 实体精确过滤（点实体 chips 后走这个，比 keyword 更准） */
  entityId?: number;
  /** 页码，0 起，按「日」分页 */
  page?: number;
  /** 每页天数，上限 30（前端定案 3：一屏约 20~30 事件卡，见 docs/news-kg-spec.md 待确认定案） */
  pageSize?: number;
}

/** 实体详情摘要卡（接口文档 §五；不存在 → 信封 code=404） */
export interface KgEntityDetail {
  id: number;
  name: string;
  entityType: KgEntityType;
  anchorType: KgAnchorType;
  /** 锚点业务键（subject_id / stock_id，可跳字典详情）；自由实体为 null */
  anchorId: string | null;
  aliases: string[];
  /** 提及次数（文章口径） */
  mentionCount: number;
  /** 参与事件数 */
  eventCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** 高频共现实体 top8（漫游 chips：点击以该实体 id 重新搜索） */
  relatedEntities: Array<KgEntityRef & { coMentionCount: number }>;
}
