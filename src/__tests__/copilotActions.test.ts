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
  asRunStatPayload,
  asCanvasAddBlockPayload,
  asCanvasAddWidgetPayload,
  asCanvasSetMetricPayload,
  asCanvasUpdateTablePayload,
  asCanvasAddHLinePayload,
  asCanvasAddTrendlinePayload,
  asCanvasRemoveBlockPayload,
  stripCopilotActionBlock,
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

describe('asRunStatPayload（run_custom_stat 载荷守卫）', () => {
  const VALID = {
    name: '各股做T净收益排行',
    description: '统计已归档轮净收益按股票求和，柱状降序',
    prompt: '统计各股做T净收益排行，柱状图降序',
    code: '(ctx) => ({ kind: "card", title: "t", kpis: [] })',
  };

  it('登记为 auto 级，合法载荷通过', () => {
    const out = sanitizeCopilotActions([{ type: 'run_custom_stat', payload: { ...VALID } }]);
    expect(out).toEqual([{ type: 'run_custom_stat', tier: 'auto', payload: { ...VALID } }]);
  });

  it('缺任一字段 / 空串 / 非对象 / 非字符串 → 整条丢弃', () => {
    const bads: unknown[] = [
      null,
      'str',
      {},
      { ...VALID, name: '' },
      { ...VALID, description: '   ' },
      { ...VALID, prompt: undefined },
      { ...VALID, code: 123 },
    ];
    for (const bad of bads) {
      expect(asRunStatPayload(bad)).toBeNull();
    }
    expect(sanitizeCopilotActions([{ type: 'run_custom_stat', payload: { ...VALID, prompt: null } as never }])).toEqual([]);
  });

  it('name/description 超长裁剪到 40/200', () => {
    const p = asRunStatPayload({
      ...VALID,
      name: '标'.repeat(60),
      description: '描'.repeat(300),
    });
    expect(p).not.toBeNull();
    expect(p!.name.length).toBe(40);
    expect(p!.description.length).toBe(200);
  });

  it('prompt 超 2KB / code 超 16KB 整条拒绝（截断会静默破坏语义/语法）', () => {
    expect(asRunStatPayload({ ...VALID, prompt: 'x'.repeat(2049) })).toBeNull();
    expect(asRunStatPayload({ ...VALID, code: 'x'.repeat(16385) })).toBeNull();
    expect(asRunStatPayload({ ...VALID, prompt: 'x'.repeat(2048) })).not.toBeNull();
    expect(asRunStatPayload({ ...VALID, code: 'x'.repeat(16384) })).not.toBeNull();
  });

  it('prompt/code 按 UTF-8 字节限长（与后端 user_custom_stat 存储口径一致）：多字节字符按 3 字节计', () => {
    // 700 个中文字符 = 2100 字节 > 2048：字符数远未超限，但字节超限必须拒绝（旧字符口径会放行）
    expect(asRunStatPayload({ ...VALID, prompt: '释'.repeat(700) })).toBeNull();
    // 682 个中文字符 = 2046 字节 ≤ 2048：字节口径下放行
    expect(asRunStatPayload({ ...VALID, prompt: '释'.repeat(682) })).not.toBeNull();
    // 5462 个中文字符 = 16386 字节 > 16384：拒绝
    expect(asRunStatPayload({ ...VALID, code: '注'.repeat(5462) })).toBeNull();
    // 5461 个中文字符 = 16383 字节 ≤ 16384：放行
    expect(asRunStatPayload({ ...VALID, code: '注'.repeat(5461) })).not.toBeNull();
  });
});

describe('asCanvasAddBlockPayload（canvas_add_block 载荷守卫，auto 级）', () => {
  const VALID = { type: 'kline', stockCode: 'sh600519' };

  it('合法载荷通过，类型白名单外整条拒绝', () => {
    expect(asCanvasAddBlockPayload(VALID)).toEqual(VALID);
    expect(asCanvasAddBlockPayload({ type: 'kline', stockCode: 'SH600519' })).toEqual({ type: 'kline', stockCode: 'sh600519' });
    expect(asCanvasAddBlockPayload({ type: 'malware' })).toBeNull();
    expect(asCanvasAddBlockPayload({ type: 123 })).toBeNull();
    expect(asCanvasAddBlockPayload(null)).toBeNull();
  });

  it('stockCode 必须腾讯形态（2字母+6数字），非法拒绝', () => {
    expect(asCanvasAddBlockPayload({ type: 'kline', stockCode: '600519' })).toBeNull();
    expect(asCanvasAddBlockPayload({ type: 'kline', stockCode: 'sh60-19' })).toBeNull();
    expect(asCanvasAddBlockPayload({ type: 'kline', stockCode: 'SH600519X' })).toBeNull();
  });

  it('text 初始内容超长裁剪到 500', () => {
    const p = asCanvasAddBlockPayload({ type: 'text', content: '字'.repeat(600) });
    expect(p).not.toBeNull();
    expect(p!.content!.length).toBe(500);
  });
});

describe('asCanvasSetMetricPayload（canvas_set_metric 载荷守卫，confirm 级）', () => {
  it('value 与 calc 至少一项，否则拒绝', () => {
    expect(asCanvasSetMetricPayload({ blockId: 'A1', label: '目标价' })).toBeNull();
    expect(asCanvasSetMetricPayload({ blockId: 'A1', label: '目标价', value: 12.5 })).not.toBeNull();
    expect(asCanvasSetMetricPayload({ blockId: 'A1', label: '目标价', calc: '(12.5+3)*2' })).not.toBeNull();
  });

  it('calc 字符白名单（禁字母/标识符注入），非有限 value 拒绝', () => {
    expect(asCanvasSetMetricPayload({ blockId: 'A1', label: 'x', calc: 'alert(1)' })).toBeNull();
    expect(asCanvasSetMetricPayload({ blockId: 'A1', label: 'x', calc: '12.5+__proto__' })).toBeNull();
    expect(asCanvasSetMetricPayload({ blockId: 'A1', label: 'x', value: Infinity })).toBeNull();
    expect(asCanvasSetMetricPayload({ blockId: 'A1', label: 'x', calc: ' 1 + 2 * (3-1) ' })).not.toBeNull();
  });
});

describe('asCanvasUpdateTablePayload（canvas_update_table 载荷守卫，confirm 级）', () => {
  const COLS = [{ key: 'name', title: '名称' }, { key: 'px', title: '价格' }];

  it('合法载荷通过；未知列/非字符串格静默剔除', () => {
    const p = asCanvasUpdateTablePayload({ blockId: 'B2', columns: COLS, rows: [{ name: '茅台', px: '1700', hack: 'x', px2: 9 }] });
    expect(p).not.toBeNull();
    expect(p!.rows[0]).toEqual({ name: '茅台', px: '1700' });
  });

  it('列数超 10 / key 重复 / 空列 / 缺 rows 数组整条拒绝', () => {
    expect(asCanvasUpdateTablePayload({ blockId: 'B2', columns: COLS, rows: [] })).not.toBeNull();
    expect(asCanvasUpdateTablePayload({ blockId: 'B2', columns: [], rows: [] })).toBeNull();
    expect(asCanvasUpdateTablePayload({
      blockId: 'B2',
      columns: Array.from({ length: 11 }, (_, i) => ({ key: `c${i}`, title: `列${i}` })),
      rows: [],
    })).toBeNull();
    expect(asCanvasUpdateTablePayload({ blockId: 'B2', columns: [{ key: 'a', title: 'A' }, { key: 'a', title: 'A2' }], rows: [] })).toBeNull();
    expect(asCanvasUpdateTablePayload({ blockId: 'B2', columns: COLS, rows: 'nope' })).toBeNull();
  });

  it('行数超 50 整条拒绝', () => {
    const rows = Array.from({ length: 51 }, () => ({ name: 'x' }));
    expect(asCanvasUpdateTablePayload({ blockId: 'B2', columns: COLS, rows })).toBeNull();
  });
});

describe('canvas 划线/删除守卫（confirm 级）', () => {
  it('asCanvasAddHLinePayload：price 必须有限数，label 可选裁剪', () => {
    expect(asCanvasAddHLinePayload({ blockId: 'A1', price: 12.5 })).toEqual({ blockId: 'A1', price: 12.5 });
    expect(asCanvasAddHLinePayload({ blockId: 'A1', price: '12.5' })).toBeNull();
    expect(asCanvasAddHLinePayload({ blockId: 'A1', price: NaN })).toBeNull();
    const p = asCanvasAddHLinePayload({ blockId: 'A1', price: 1, label: '标'.repeat(60) });
    expect(p!.label!.length).toBe(40);
  });

  it('asCanvasAddTrendlinePayload：日期必须 YYYY-MM-DD，价格必须有限数', () => {
    const ok = { blockId: 'A1', startTime: '2026-01-05', startPrice: 10, endTime: '2026-02-01', endPrice: 12 };
    expect(asCanvasAddTrendlinePayload(ok)).toEqual(ok);
    expect(asCanvasAddTrendlinePayload({ ...ok, startTime: '20260105' })).toBeNull();
    expect(asCanvasAddTrendlinePayload({ ...ok, endPrice: Infinity })).toBeNull();
  });

  it('asCanvasRemoveBlockPayload：blockId 必填', () => {
    expect(asCanvasRemoveBlockPayload({ blockId: 'C3' })).toEqual({ blockId: 'C3' });
    expect(asCanvasRemoveBlockPayload({})).toBeNull();
  });
});

describe('sanitizeCopilotActions 对 canvas 动作的路由', () => {
  it('canvas_add_block 走 auto 分支（守卫整形后直出）', () => {
    const out = sanitizeCopilotActions([{ type: 'canvas_add_block', payload: { type: 'kline', stockCode: 'sh600519' } }]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('auto');
    expect(out[0].payload).toEqual({ type: 'kline', stockCode: 'sh600519' });
  });

  it('canvas_set_stock 走 confirm 入队（守卫整形），非法载荷静默丢弃', () => {
    const out = sanitizeCopilotActions([
      { type: 'canvas_set_stock', payload: { blockId: 'A1', fullCode: 'sh600519' } },
      { type: 'canvas_set_stock', payload: { blockId: 'A1', fullCode: '600519' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('confirm');
  });

  it('canvas_refresh_klines 无参载荷恒通过（auto）', () => {
    const out = sanitizeCopilotActions([{ type: 'canvas_refresh_klines', payload: {} }]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('auto');
  });
});

describe('asCanvasAddWidgetPayload（canvas_add_widget 载荷守卫，auto 级）', () => {
  const VALID = { kind: 'stack', title: '面板', nodes: [{ c: 'divider' }] };

  it('合法图纸通过且返回规范化 DSL；结构违规整条拒绝（单一入口 validateWidgetDsl）', () => {
    expect(asCanvasAddWidgetPayload({ dsl: VALID })).toEqual({ dsl: VALID });
    expect(asCanvasAddWidgetPayload({ dsl: { ...VALID, kind: 'flex' } })).toBeNull();
    expect(asCanvasAddWidgetPayload({ dsl: { ...VALID, nodes: [{ c: 'iframe' }] } })).toBeNull();
    expect(asCanvasAddWidgetPayload({})).toBeNull();
    expect(asCanvasAddWidgetPayload(null)).toBeNull();
  });

  it('title/文本超长由校验器裁剪（非拒绝）', () => {
    const p = asCanvasAddWidgetPayload({ dsl: { ...VALID, title: '标'.repeat(60) } });
    expect(p).not.toBeNull();
    expect(p!.dsl.title.length).toBe(40);
  });

  it('sanitize 路由：canvas_add_widget 走 auto 直出，非法 DSL 静默丢弃', () => {
    const out = sanitizeCopilotActions([{ type: 'canvas_add_widget', payload: { dsl: VALID } }]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('auto');
    expect(sanitizeCopilotActions([{ type: 'canvas_add_widget', payload: { dsl: { junk: 1 } } }])).toHaveLength(0);
  });
});

describe('stripCopilotActionBlock（动作外壳剥离，前端渲染双保险）', () => {
  it('完整块整段移除，正文前后保留', () => {
    const src = '已创建速览卡。\n\n<copilot-actions>\n{"actions":[{"type":"canvas_add_widget","payload":{"dsl":{}}}]}\n</copilot-actions>\n\n需要进一步分析吗？';
    const out = stripCopilotActionBlock(src);
    expect(out).not.toContain('copilot-actions');
    expect(out).toContain('已创建速览卡。');
    expect(out).toContain('需要进一步分析吗？');
  });

  it('流式半截块（未闭合）从起始标记截断，防 JSON 片段闪现', () => {
    const out = stripCopilotActionBlock('正文开头<copilot-actions>\n{"actions":[{"type":"canvas_add');
    expect(out).toBe('正文开头');
  });

  it('大小写变体容错；无块文本原样返回', () => {
    expect(stripCopilotActionBlock('a<Copilot-Actions>x</Copilot-Actions>b')).toBe('ab');
    expect(stripCopilotActionBlock('普通正文，无任何标签')).toBe('普通正文，无任何标签');
  });
});
