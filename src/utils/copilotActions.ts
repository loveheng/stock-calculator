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
  HomeTimeRange,
} from '../types/domain';

/** 单轮响应允许执行的动作上限（防 LLM 输出放大） */
export const COPILOT_ACTION_LIMIT = 5;

/** notify 文案长度上限（弹窗内可完整展示） */
const NOTICE_TITLE_MAX = 40;
const NOTICE_MESSAGE_MAX = 300;

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
  // 业务写操作登记处（示例）：create_plan_order: 'confirm' —— 执行器须在 copilotActionSlice 同步登记
};

/** 校验通过后的动作（payload 已按对应守卫整形，slice 侧用 asXxxPayload 收窄后消费） */
export interface SanitizedCopilotAction {
  type: string;
  tier: 'auto' | 'confirm';
  payload: CopilotNotifyPayload | CopilotFocusBlockPayload | CopilotApplyFilterPayload | Record<string, unknown>;
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
