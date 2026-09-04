/**
 * @file copilotActions.test.ts
 * @description Copilot 动作后处理纯函数单测：白名单过滤（未注册类型丢弃）、
 *              载荷形状守卫（缺字段/非法枚举/空串丢弃、超长裁剪、severity 默认值）、
 *              数量截断（LIMIT 上限）。LLM 输出按不可信输入处理的防御性验证。
 * @layer 测试
 * @author 开发团队
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeCopilotActions,
  COPILOT_ACTION_LIMIT,
  asNotifyPayload,
} from '../utils/copilotActions';
import type { CopilotAction } from '../types/domain';

describe('sanitizeCopilotActions（白名单 + 守卫 + 截断）', () => {
  it('undefined/null/空数组 → 空结果（旧后端/mock 零开销）', () => {
    expect(sanitizeCopilotActions(undefined)).toEqual([]);
    expect(sanitizeCopilotActions(null)).toEqual([]);
    expect(sanitizeCopilotActions([])).toEqual([]);
  });

  it('未注册类型与畸形条目一律静默丢弃', () => {
    const raw = [
      { type: 'create_order', payload: {} }, // 白名单外
      null, // 非对象
      'notify', // 非对象
      { payload: {} }, // 缺 type
      { type: 123, payload: {} }, // type 非字符串
    ] as unknown as CopilotAction[];
    expect(sanitizeCopilotActions(raw)).toEqual([]);
  });

  it('notify 合法载荷通过，severity 缺省补 info', () => {
    const out = sanitizeCopilotActions([
      { type: 'notify', payload: { title: '风险提醒', message: '倒T待回补 100 股' } },
    ]);
    expect(out).toEqual([
      { type: 'notify', tier: 'auto', payload: { title: '风险提醒', message: '倒T待回补 100 股', severity: 'info' } },
    ]);
  });

  it('notify 缺 message / 空串 title / 非法 severity → 整条丢弃', () => {
    const raw: CopilotAction[] = [
      { type: 'notify', payload: { title: 't' } },
      { type: 'notify', payload: { title: 't', message: '   ' } },
      { type: 'notify', payload: { title: '', message: 'm' } },
      { type: 'notify', payload: { title: 't', message: 'm', severity: 'critical' } },
    ];
    expect(sanitizeCopilotActions(raw)).toEqual([]);
  });

  it('notify 超长文案裁剪到上限（防弹窗刷屏）', () => {
    const p = asNotifyPayload({
      title: '标'.repeat(60),
      message: '描'.repeat(500),
      severity: 'danger',
    });
    expect(p).not.toBeNull();
    expect(p!.title.length).toBe(40);
    expect(p!.message.length).toBe(300);
    expect(p!.severity).toBe('danger');
  });

  it('focus_block 合法通过，缺 blockId 丢弃', () => {
    const ok = sanitizeCopilotActions([
      { type: 'focus_block', payload: { scopeId: 'home', blockId: 'home:short_term' } },
    ]);
    expect(ok).toEqual([
      { type: 'focus_block', tier: 'auto', payload: { scopeId: 'home', blockId: 'home:short_term' } },
    ]);
    const bad = sanitizeCopilotActions([
      { type: 'focus_block', payload: { scopeId: 'home' } },
      { type: 'focus_block', payload: { scopeId: '', blockId: 'home:short_term' } },
    ]);
    expect(bad).toEqual([]);
  });

  it('apply_filter 键值均为白名单：合法通过，非法 value / 未知 filter 丢弃', () => {
    const ok = sanitizeCopilotActions([
      { type: 'apply_filter', payload: { filter: 'homeTimeRange', value: '30d' } },
    ]);
    expect(ok).toEqual([
      { type: 'apply_filter', tier: 'auto', payload: { filter: 'homeTimeRange', value: '30d' } },
    ]);
    const bad = sanitizeCopilotActions([
      { type: 'apply_filter', payload: { filter: 'homeTimeRange', value: '2d' } },
      { type: 'apply_filter', payload: { filter: 'positionSort', value: '7d' } },
    ]);
    expect(bad).toEqual([]);
  });

  it('数量截断：超出 LIMIT 的部分不执行（防 LLM 输出放大）', () => {
    const raw: CopilotAction[] = Array.from({ length: COPILOT_ACTION_LIMIT + 2 }, () => ({
      type: 'notify',
      payload: { title: 't', message: 'm' },
    }));
    const out = sanitizeCopilotActions(raw);
    expect(out.length).toBe(COPILOT_ACTION_LIMIT);
  });

  it('混合合法与非法条目：合法的逐条保留，非法的不影响后续', () => {
    const out = sanitizeCopilotActions([
      { type: 'unknown_x', payload: {} },
      { type: 'notify', payload: { title: 'a', message: 'b', severity: 'warning' } },
      { type: 'notify', payload: { title: 'c' } }, // 非法
      { type: 'apply_filter', payload: { filter: 'homeTimeRange', value: '1d' } },
    ]);
    expect(out.map((a) => a.type)).toEqual(['notify', 'apply_filter']);
  });
});
