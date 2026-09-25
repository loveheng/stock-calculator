/**
 * @file canvasPrompts.test.ts
 * @description 画布能力提示组装单测（copilot-spec D33 条件携带）：注册表 aiPrompt/aiTriggers
 *              + CANVAS_PROMPT_COMMON + buildCanvasPromptHints 组装口径，含 widget 段体积守护。
 * @author 开发团队
 */
import { describe, it, expect } from 'vitest';
import { CANVAS_TEMPLATES, buildCanvasPromptHints } from '../utils/canvasTemplates';

describe('CANVAS_PROMPT 注册表承载（模板专属段）', () => {
  it('widget 专属段 ≤8192 UTF-8 字节（后端按不可信输入 8KB 截断，超限截坏 schema 说明）', () => {
    const p = CANVAS_TEMPLATES.widget.aiPrompt!;
    expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(8192);
  });

  it('有写操作的模板都登记了专属段与触发词；无写操作模板（chart/image/file）不设', () => {
    for (const t of Object.values(CANVAS_TEMPLATES)) {
      if (t.operationsMeta.length > 0 || t.aiOnly) {
        expect(t.aiPrompt, `${t.type} 有写操作但缺 aiPrompt`).toBeTruthy();
        expect(t.aiTriggers?.length, `${t.type} 有写操作但缺 aiTriggers`).toBeGreaterThan(0);
      } else {
        expect(t.aiPrompt, `${t.type} 无写操作不应设 aiPrompt`).toBeUndefined();
      }
    }
  });
});

describe('buildCanvasPromptHints（公共段 + 命中触发词的专属段）', () => {
  it('未命中任何触发词 → undefined（常规画布对话零 token 开销）', () => {
    expect(buildCanvasPromptHints('总结画布上所有区块的分析结论')).toBeUndefined();
  });

  it('命中 widget 触发词 → 公共段 + widget 专属段', () => {
    const hints = buildCanvasPromptHints('自定义面板：帮我做腾讯速览卡');
    expect(hints).toContain('## 画布操作能力');
    expect(hints).toContain('canvas_add_widget');
    expect(hints).toContain('canvas_remove_block');
  });

  it('命中 kline 触发词 → 携带 kline 专属段（划线格式约束）', () => {
    const hints = buildCanvasPromptHints('给 A1 加一条支撑位水平线');
    expect(hints).toContain('canvas_add_hline');
    expect(hints).toContain('YYYY-MM-DD');
  });

  it('跨模板多命中逐段拼接；触发词为 includes 宽匹配（宁多带勿静默失败）', () => {
    const hints = buildCanvasPromptHints('给 A1 加支撑位，再写表格对比');
    expect(hints).toContain('canvas_add_hline');
    expect(hints).toContain('canvas_update_table');
  });

  it('权责边界（钉死）：promptHints 永不包含动作外壳标签 <copilot-actions>——外壳协议归后端系统提示宣讲', () => {
    for (const q of ['自定义面板：速览卡', '给 A1 加支撑位水平线', '写表格对比', '设指标']) {
      const hints = buildCanvasPromptHints(q);
      if (hints) expect(hints).not.toContain('<copilot-actions');
    }
    expect(buildCanvasPromptHints('自定义面板：速览卡')).not.toContain('actions 数组');
  });
});
