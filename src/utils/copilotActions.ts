/**
 * @file copilotActions.ts
 * @description Copilot 动作后处理纯函数（V1 Action Pipeline）：对 LLM 响应中的 actions
 *              做白名单过滤、载荷形状守卫、分级（auto/confirm）与数量截断。
 *              关键约束：LLM 输出按不可信输入处理 —— 类型未注册或任一字段形状不符
 *              即整条静默丢弃，绝不抛错、绝不带病执行；长度超限做裁剪防弹窗刷屏。
 * @layer Utils (Pure) —— 只依赖 types，禁碰 store/db（R2）
 * @author 开发团队
 */

import type {
  CopilotAction,
  CopilotNotifyPayload,
  CopilotFocusBlockPayload,
  CopilotApplyFilterPayload,
  CopilotRunStatPayload,
  CopilotAnnotateBlockPayload,
  CopilotCanvasAddBlockPayload,
  CopilotCanvasSetStockPayload,
  CopilotCanvasUpdateTextPayload,
  CopilotCanvasSetMetricPayload,
  CopilotCanvasUpdateTablePayload,
  CopilotCanvasAddHLinePayload,
  CopilotCanvasAddTrendlinePayload,
  CopilotCanvasRemoveBlockPayload,
  CopilotCanvasRefreshPayload,
  CopilotCanvasAddWidgetPayload,
  CanvasBlockType,
  HomeTimeRange,
} from '../types/domain';
import { validateWidgetDsl } from './widgetDsl';

/** 单轮响应允许执行的动作上限（防 LLM 输出放大） */
export const COPILOT_ACTION_LIMIT = 5;

/** notify 文案长度上限（弹窗内可完整展示） */
const NOTICE_TITLE_MAX = 40;
const NOTICE_MESSAGE_MAX = 300;

/** run_custom_stat 载荷上限（spec FR1）：名称/口径按**字符数**可裁剪；prompt/code 按 **UTF-8 字节**超限整条拒绝（截断会静默破坏语义/语法，且与后端存储限长口径一致） */
const RUN_STAT_NAME_MAX = 40;
const RUN_STAT_DESC_MAX = 200;
const RUN_STAT_PROMPT_MAX = 2048;
const RUN_STAT_CODE_MAX = 16384;

/** annotate_block 备注内容上限（spec §6.3：≤200 字，超长裁剪） */
const ANNOTATE_CONTENT_MAX = 200;

/** canvas 动作载荷上限（对话驱动画布，思维流场景放宽到可读可用） */
const CANVAS_BLOCK_ID_MAX = 8;
const CANVAS_TEXT_MAX = 500;
const CANVAS_LABEL_MAX = 40;
const CANVAS_TABLE_COLS_MAX = 10;
const CANVAS_TABLE_ROWS_MAX = 50;
const CANVAS_STOCK_CODE_MAX = 16;
/** 腾讯形态代码（sh600519/sz000001/bj430047） */
const STOCK_CODE_RE = /^[a-z]{2}\d{6}$/;
/** YYYY-MM-DD */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const sharedTextEncoder = new TextEncoder();

/** UTF-8 字节长度（后端 user_custom_stat 限长口径；中文注释等多字节字符按 3 字节计） */
function utf8ByteLength(s: string): number {
  return sharedTextEncoder.encode(s).length;
}

/** 首页时间维度合法值（与 domain HomeTimeRange 对齐，守卫用白名单） */
const HOME_TIME_RANGES: readonly HomeTimeRange[] = ['1d', '7d', '30d', 'all'];

/**
 * 动作分级注册表：auto = 只读/UI 效果，自动执行；confirm = 业务写操作，必须用户确认。
 * 新增动作时在此登记分级；漏登记 = 白名单外 = 丢弃。
 * 新增动作三步：① types/domain.ts 加载荷类型；② 本文件加形状守卫 + 此处登记分级；
 * ③ store/slices/copilotActionSlice.ts 执行器登记（auto 级）或确认卡消费（confirm 级）。
 */
const ACTION_TIERS: Record<string, 'auto' | 'confirm'> = {
  notify: 'auto',
  focus_block: 'auto',
  apply_filter: 'auto',
  // 沙箱内只读计算 + 本地渲染，无业务副作用，与 notify 同级；唯一写操作「保存」由用户显式点击
  run_custom_stat: 'auto',
  // AI 写入用户内容（画布区块备注）：必须用户确认；执行最后一刻由 canvasSlice.runBlockTask 校验区块存活
  annotate_block: 'confirm',
  // ---- 画布对话动作套件（思维流：写类 confirm 但会话内一次确认后同类型放行）----
  canvas_add_block: 'auto', // 只新增不覆盖，无破坏性
  canvas_add_widget: 'auto', // 只读数据可视化面板（拍板）：只新增不覆盖，无破坏性
  canvas_refresh_klines: 'auto', // 只读行情刷新
  canvas_set_stock: 'confirm', // 覆盖用户已选标的
  canvas_update_text: 'confirm',
  canvas_set_metric: 'confirm',
  canvas_update_table: 'confirm',
  canvas_add_hline: 'confirm',
  canvas_add_trendline: 'confirm',
  canvas_remove_block: 'confirm', // 破坏性删除
  // 业务写操作登记处（示例）：create_plan_order: 'confirm' —— 执行器须在 copilotActionSlice 同步登记
};

/** 校验通过后的动作（payload 已按对应守卫整形，slice 侧用 asXxxPayload 收窄后消费） */
export type SanitizedCopilotPayload =
  | CopilotNotifyPayload
  | CopilotFocusBlockPayload
  | CopilotApplyFilterPayload
  | CopilotRunStatPayload
  | CopilotAnnotateBlockPayload
  | CopilotCanvasAddBlockPayload
  | CopilotCanvasSetStockPayload
  | CopilotCanvasUpdateTextPayload
  | CopilotCanvasSetMetricPayload
  | CopilotCanvasUpdateTablePayload
  | CopilotCanvasAddHLinePayload
  | CopilotCanvasAddTrendlinePayload
  | CopilotCanvasRemoveBlockPayload
  | CopilotCanvasRefreshPayload
  | CopilotCanvasAddWidgetPayload
  | Record<string, unknown>;

export interface SanitizedCopilotAction {
  type: string;
  tier: 'auto' | 'confirm';
  payload: SanitizedCopilotPayload;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** notify 载荷守卫：title/message 必填非空，severity 可选且限枚举，超长裁剪 */
export function asNotifyPayload(p: unknown): CopilotNotifyPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const title = asNonEmptyString(o.title);
  const message = asNonEmptyString(o.message);
  if (!title || !message) return null;
  if (o.severity !== undefined && o.severity !== 'info' && o.severity !== 'warning' && o.severity !== 'danger') {
    return null;
  }
  return {
    title: clamp(title, NOTICE_TITLE_MAX),
    message: clamp(message, NOTICE_MESSAGE_MAX),
    severity: o.severity ?? 'info',
  };
}

/** focus_block 载荷守卫：scopeId/blockId 必填非空（注册态校验在执行时由 focusBlock 兜底） */
export function asFocusBlockPayload(p: unknown): CopilotFocusBlockPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const scopeId = asNonEmptyString(o.scopeId);
  const blockId = asNonEmptyString(o.blockId);
  if (!scopeId || !blockId) return null;
  return { scopeId, blockId };
}

/** apply_filter 载荷守卫：filter/value 均为白名单枚举 */
export function asApplyFilterPayload(p: unknown): CopilotApplyFilterPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (o.filter !== 'homeTimeRange') return null;
  if (typeof o.value !== 'string' || !HOME_TIME_RANGES.includes(o.value as HomeTimeRange)) return null;
  return { filter: 'homeTimeRange', value: o.value as HomeTimeRange };
}

/**
 * run_custom_stat 载荷守卫：四字段必填非空字符串；name/description 超**字符数**裁剪，
 * prompt（需求种子，截断会静默改变重建语义）与 code（截断即语法损坏）超**UTF-8 字节**整条拒绝——
 * 与后端 user_custom_stat 存储限长口径一致（AI 生成代码常带中文注释，字符数与字节数差异是真实场景）。
 */
export function asRunStatPayload(p: unknown): CopilotRunStatPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const name = asNonEmptyString(o.name);
  const description = asNonEmptyString(o.description);
  const prompt = asNonEmptyString(o.prompt);
  const code = asNonEmptyString(o.code);
  if (!name || !description || !prompt || !code) return null;
  if (utf8ByteLength(prompt) > RUN_STAT_PROMPT_MAX || utf8ByteLength(code) > RUN_STAT_CODE_MAX) return null;
  return {
    name: clamp(name, RUN_STAT_NAME_MAX),
    description: clamp(description, RUN_STAT_DESC_MAX),
    prompt,
    code,
  };
}

/**
 * annotate_block 载荷守卫（confirm 级入队时整形）：blockId 必填非空（画布标号形态），
 * content 必填非空且 ≤200 字（超长裁剪）。区块存活校验在执行最后一刻由 canvasSlice.runBlockTask 兜底
 * （AI 思考期间区块可能已被删除，守卫层不做存在性假设）。
 */
export function asAnnotateBlockPayload(p: unknown): CopilotAnnotateBlockPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const blockId = asNonEmptyString(o.blockId);
  const content = asNonEmptyString(o.content);
  if (!blockId || !content) return null;
  return { blockId: clamp(blockId, 8), content: clamp(content, ANNOTATE_CONTENT_MAX) };
}

/** 画布七类合法类型（守卫白名单） */
const CANVAS_BLOCK_TYPES: readonly CanvasBlockType[] = ['kline', 'table', 'file', 'chart', 'metric', 'image', 'text'];

/**
 * canvas_add_widget 载荷守卫（auto 级）：dsl 经 utils/widgetDsl 形状校验（单一入口，
 * 结构违规/超限整条拒绝，字符串超长裁剪）。校验通过的规范化图纸随载荷下发，执行器直接落块。
 */
export function asCanvasAddWidgetPayload(p: unknown): CopilotCanvasAddWidgetPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const dsl = validateWidgetDsl(o.dsl);
  if (!dsl) return null;
  return { dsl };
}

/**
 * canvas_add_block 载荷守卫（auto 级）：type 必须七类之一；stockCode 可选（腾讯形态校验）；
 * content 可选（text 初始内容 ≤500 字裁剪）。只新增不覆盖，无破坏性。
 */
export function asCanvasAddBlockPayload(p: unknown): CopilotCanvasAddBlockPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.type !== 'string' || !CANVAS_BLOCK_TYPES.includes(o.type as CanvasBlockType)) return null;
  const out: CopilotCanvasAddBlockPayload = { type: o.type as CanvasBlockType };
  if (o.stockCode !== undefined) {
    if (typeof o.stockCode !== 'string') return null;
    const code = o.stockCode.trim().toLowerCase();
    if (!STOCK_CODE_RE.test(code) || code.length > CANVAS_STOCK_CODE_MAX) return null;
    out.stockCode = code;
  }
  if (o.content !== undefined) {
    if (typeof o.content !== 'string') return null;
    out.content = clamp(o.content, CANVAS_TEXT_MAX);
  }
  return out;
}

/** canvas_set_stock 载荷守卫（confirm 级）：blockId + 腾讯形态 fullCode 必填，stockName 可选裁剪 */
export function asCanvasSetStockPayload(p: unknown): CopilotCanvasSetStockPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const blockId = asNonEmptyString(o.blockId);
  if (!blockId || typeof o.fullCode !== 'string') return null;
  const fullCode = o.fullCode.trim().toLowerCase();
  if (!STOCK_CODE_RE.test(fullCode)) return null;
  const out: CopilotCanvasSetStockPayload = { blockId: clamp(blockId, CANVAS_BLOCK_ID_MAX), fullCode };
  if (typeof o.stockName === 'string' && o.stockName.trim()) out.stockName = clamp(o.stockName.trim(), CANVAS_LABEL_MAX);
  return out;
}

/** canvas_update_text 载荷守卫（confirm 级）：blockId + content 必填，≤500 字裁剪 */
export function asCanvasUpdateTextPayload(p: unknown): CopilotCanvasUpdateTextPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const blockId = asNonEmptyString(o.blockId);
  const content = asNonEmptyString(o.content);
  if (!blockId || !content) return null;
  return { blockId: clamp(blockId, CANVAS_BLOCK_ID_MAX), content: clamp(content, CANVAS_TEXT_MAX) };
}

/** canvas_set_metric 载荷守卫（confirm 级）：blockId/label 必填；value（有限数）与 calc（常量四则字符白名单）至少一项 */
export function asCanvasSetMetricPayload(p: unknown): CopilotCanvasSetMetricPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const blockId = asNonEmptyString(o.blockId);
  const label = asNonEmptyString(o.label);
  if (!blockId || !label) return null;
  const out: CopilotCanvasSetMetricPayload = { blockId: clamp(blockId, CANVAS_BLOCK_ID_MAX), label: clamp(label, CANVAS_LABEL_MAX) };
  if (o.value !== undefined) {
    if (typeof o.value !== 'number' || !Number.isFinite(o.value)) return null;
    out.value = o.value;
  }
  if (o.calc !== undefined) {
    if (typeof o.calc !== 'string') return null;
    const calc = o.calc.trim();
    // 常量四则字符白名单（与 canvasExpr 解析器一致），禁字母/下划线/$（杜绝标识符注入）
    if (!/^[0-9+\-*/().\s]+$/.test(calc) || !calc) return null;
    out.calc = calc;
  }
  if (out.value === undefined && out.calc === undefined) return null;
  return out;
}

/** canvas_update_table 载荷守卫（confirm 级）：columns（≤10 列，key 唯一非空）+ rows（≤50 行）必填非空 */
export function asCanvasUpdateTablePayload(p: unknown): CopilotCanvasUpdateTablePayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const blockId = asNonEmptyString(o.blockId);
  if (!blockId || !Array.isArray(o.columns) || !Array.isArray(o.rows)) return null;
  if (o.columns.length === 0 || o.columns.length > CANVAS_TABLE_COLS_MAX) return null;
  if (o.rows.length > CANVAS_TABLE_ROWS_MAX) return null;
  const keys = new Set<string>();
  const columns: { key: string; title: string }[] = [];
  for (const c of o.columns) {
    if (typeof c !== 'object' || c === null) return null;
    const co = c as Record<string, unknown>;
    const key = asNonEmptyString(co.key);
    const title = asNonEmptyString(co.title);
    if (!key || keys.has(key)) return null;
    keys.add(key);
    columns.push({ key: clamp(key, 20), title: clamp(title ?? key, CANVAS_LABEL_MAX) });
  }
  const rows: Record<string, string>[] = [];
  for (const r of o.rows) {
    if (typeof r !== 'object' || r === null) return null;
    const ro = r as Record<string, unknown>;
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(ro)) {
      if (!keys.has(k) || typeof v !== 'string') continue; // 未知列/非字符串格静默剔除
      row[k] = clamp(v, 100);
    }
    rows.push(row);
  }
  return { blockId: clamp(blockId, CANVAS_BLOCK_ID_MAX), columns, rows };
}

/** canvas_add_hline 载荷守卫（confirm 级）：blockId + 有限 price；label 可选裁剪 */
export function asCanvasAddHLinePayload(p: unknown): CopilotCanvasAddHLinePayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const blockId = asNonEmptyString(o.blockId);
  if (!blockId || typeof o.price !== 'number' || !Number.isFinite(o.price)) return null;
  const out: CopilotCanvasAddHLinePayload = { blockId: clamp(blockId, CANVAS_BLOCK_ID_MAX), price: o.price };
  if (typeof o.label === 'string' && o.label.trim()) out.label = clamp(o.label.trim(), CANVAS_LABEL_MAX);
  return out;
}

/** canvas_add_trendline 载荷守卫（confirm 级）：blockId + 起终点（YYYY-MM-DD + 有限价格）；时间序不校验（执行端吸附兜底） */
export function asCanvasAddTrendlinePayload(p: unknown): CopilotCanvasAddTrendlinePayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const blockId = asNonEmptyString(o.blockId);
  if (!blockId) return null;
  if (typeof o.startTime !== 'string' || !DATE_RE.test(o.startTime)) return null;
  if (typeof o.endTime !== 'string' || !DATE_RE.test(o.endTime)) return null;
  if (typeof o.startPrice !== 'number' || !Number.isFinite(o.startPrice)) return null;
  if (typeof o.endPrice !== 'number' || !Number.isFinite(o.endPrice)) return null;
  return {
    blockId: clamp(blockId, CANVAS_BLOCK_ID_MAX),
    startTime: o.startTime,
    startPrice: o.startPrice,
    endTime: o.endTime,
    endPrice: o.endPrice,
  };
}

/** canvas_remove_block 载荷守卫（confirm 级）：blockId 必填 */
export function asCanvasRemoveBlockPayload(p: unknown): CopilotCanvasRemoveBlockPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const blockId = asNonEmptyString(o.blockId);
  if (!blockId) return null;
  return { blockId: clamp(blockId, CANVAS_BLOCK_ID_MAX) };
}

/** canvas_refresh_klines 载荷守卫（auto 级）：无参载荷，恒通过 */
export function asCanvasRefreshPayload(_p: unknown): CopilotCanvasRefreshPayload {
  return {};
}

/**
 * 动作后处理入口：白名单 + 守卫 + 分级 + 截断。
 * 逐条校验，达到 LIMIT 即停（防超长数组放大守卫开销）。
 */
export function sanitizeCopilotActions(
  raw: readonly CopilotAction[] | undefined | null,
): SanitizedCopilotAction[] {
  if (!raw || raw.length === 0) return [];
  const out: SanitizedCopilotAction[] = [];
  for (const a of raw) {
    if (out.length >= COPILOT_ACTION_LIMIT) break;
    if (typeof a !== 'object' || a === null || typeof a.type !== 'string') continue;
    const tier = ACTION_TIERS[a.type];
    if (!tier) continue; // 未注册类型一律丢弃：不执行、不入队、不提示
    switch (a.type) {
      case 'notify': {
        if (tier !== 'auto') break; // 分级表被改为 confirm 时走 confirm 入队，不走此分支
        const p = asNotifyPayload(a.payload);
        if (p) out.push({ type: 'notify', tier, payload: p });
        break;
      }
      case 'focus_block': {
        if (tier !== 'auto') break;
        const p = asFocusBlockPayload(a.payload);
        if (p) out.push({ type: 'focus_block', tier, payload: p });
        break;
      }
      case 'apply_filter': {
        if (tier !== 'auto') break;
        const p = asApplyFilterPayload(a.payload);
        if (p) out.push({ type: 'apply_filter', tier, payload: p });
        break;
      }
      case 'run_custom_stat': {
        if (tier !== 'auto') break;
        const p = asRunStatPayload(a.payload);
        if (p) out.push({ type: 'run_custom_stat', tier, payload: p });
        break;
      }
      case 'canvas_add_block': {
        if (tier !== 'auto') break;
        const p = asCanvasAddBlockPayload(a.payload);
        if (p) out.push({ type: 'canvas_add_block', tier, payload: p });
        break;
      }
      case 'canvas_add_widget': {
        if (tier !== 'auto') break;
        const p = asCanvasAddWidgetPayload(a.payload);
        if (p) out.push({ type: 'canvas_add_widget', tier, payload: p });
        break;
      }
      case 'canvas_refresh_klines': {
        if (tier !== 'auto') break;
        out.push({ type: 'canvas_refresh_klines', tier, payload: asCanvasRefreshPayload(a.payload) });
        break;
      }
      case 'annotate_block': {
        // confirm 级：入队前守卫整形（执行器落地前仍二次校验）
        const p = asAnnotateBlockPayload(a.payload);
        if (p) out.push({ type: 'annotate_block', tier, payload: p });
        break;
      }
      case 'canvas_set_stock': {
        const p = asCanvasSetStockPayload(a.payload);
        if (p) out.push({ type: 'canvas_set_stock', tier, payload: p });
        break;
      }
      case 'canvas_update_text': {
        const p = asCanvasUpdateTextPayload(a.payload);
        if (p) out.push({ type: 'canvas_update_text', tier, payload: p });
        break;
      }
      case 'canvas_set_metric': {
        const p = asCanvasSetMetricPayload(a.payload);
        if (p) out.push({ type: 'canvas_set_metric', tier, payload: p });
        break;
      }
      case 'canvas_update_table': {
        const p = asCanvasUpdateTablePayload(a.payload);
        if (p) out.push({ type: 'canvas_update_table', tier, payload: p });
        break;
      }
      case 'canvas_add_hline': {
        const p = asCanvasAddHLinePayload(a.payload);
        if (p) out.push({ type: 'canvas_add_hline', tier, payload: p });
        break;
      }
      case 'canvas_add_trendline': {
        const p = asCanvasAddTrendlinePayload(a.payload);
        if (p) out.push({ type: 'canvas_add_trendline', tier, payload: p });
        break;
      }
      case 'canvas_remove_block': {
        const p = asCanvasRemoveBlockPayload(a.payload);
        if (p) out.push({ type: 'canvas_remove_block', tier, payload: p });
        break;
      }
      default: {
        // confirm 级（业务写操作）：仅入队等用户确认，payload 原样保留，执行器落地前二次校验
        if (tier === 'confirm' && typeof a.payload === 'object' && a.payload !== null) {
          out.push({ type: a.type, tier, payload: a.payload });
        }
        break;
      }
    }
  }
  return out;
}

/**
 * 剥离模型正文中的动作外壳块（<copilot-actions>…</copilot-actions>，后端 CopilotStatActionExtractor
 * 的私有解析协议）。权责：外壳宣讲与剥离主责在后端编排层（谁解析谁宣讲），此处为前端渲染双保险——
 * 兜底防后端未剥时聊天窗/历史重放露出原始 JSON。完整块整段移除（正文前后保留）；
 * 流式半截块（仅起始标记，块未闭合）从标记处截断，防流式过程闪现 JSON 片段。
 */
export function stripCopilotActionBlock(content: string): string {
  const removed = content.replace(/<copilot-actions>[\s\S]*?<\/copilot-actions>/gi, '');
  const open = removed.indexOf('<copilot-actions');
  return open >= 0 ? removed.slice(0, open) : removed;
}
