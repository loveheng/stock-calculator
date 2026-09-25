/**
 * @file widgetDsl.test.ts
 * @description 画布 DSL 动态模板图纸校验器单测（utils/widgetDsl）：组件白名单/扁平单层/
 *              节点与尺寸上限/字符串裁剪/未知字段拒绝/空值拒绝全覆盖。
 * @author 开发团队
 */
import { describe, it, expect } from 'vitest';
import { validateWidgetDsl, WIDGET_MAX_NODES, WIDGET_MAX_DOC_BYTES } from '../utils/widgetDsl';

/** 最小合法图纸（单 divider 节点） */
const MIN_VALID = { kind: 'stack', title: '面板', nodes: [{ c: 'divider' }] };

describe('validateWidgetDsl（widget 图纸校验单一入口）', () => {
  it('合法图纸通过并规范化（stack/grid、title 裁剪）', () => {
    expect(validateWidgetDsl(MIN_VALID)).toEqual(MIN_VALID);
    const grid = validateWidgetDsl({
      kind: 'grid',
      title: '  腾讯控股速览  ',
      nodes: [
        { c: 'metric', metric: { label: '最新价', value: '310.40' } },
        { c: 'text', text: { content: '放量上行', tone: 'warn' } },
        { c: 'kv', kv: { rows: [{ label: '涨跌幅', value: '+2.3%' }] } },
        { c: 'list', list: { title: '要点', items: [{ text: '一', tone: 'info' }, { text: '二' }] } },
        { c: 'table', table: { columns: ['日期', '收盘'], rows: [['09-25', '310.4']] } },
        { c: 'progress', progress: { label: '仓位', value: 65 } },
        { c: 'tag', tag: { tags: ['白酒', '龙头'] } },
      ],
    });
    expect(grid).not.toBeNull();
    expect(grid!.title).toBe('腾讯控股速览');
    expect(grid!.nodes).toHaveLength(7);
  });

  it('非对象/缺字段/空 title/空节点数组 → 整条拒绝', () => {
    expect(validateWidgetDsl(null)).toBeNull();
    expect(validateWidgetDsl('x')).toBeNull();
    expect(validateWidgetDsl(42)).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, title: '' })).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, title: '   ' })).toBeNull();
    expect(validateWidgetDsl({ kind: 'stack', title: 'T', nodes: [] })).toBeNull();
    expect(validateWidgetDsl({ kind: 'stack', title: 'T' })).toBeNull();
  });

  it('kind 只允许 stack/grid，白名单外整条拒绝', () => {
    expect(validateWidgetDsl({ ...MIN_VALID, kind: 'flex' })).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, kind: 1 })).toBeNull();
  });

  it('节点种类白名单（8 种）外拒绝；divider 不得携带载荷', () => {
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'iframe' }] })).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'script' }] })).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'divider', text: { content: 'x' } }] })).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'text' }] })).toBeNull(); // 缺载荷
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'text', text: { content: '' } }] })).toBeNull(); // 空内容
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'text', text: { content: 1 } }] })).toBeNull();
  });

  it('未知字段一律拒绝（顶层与节点层），防可疑嵌套注入', () => {
    expect(validateWidgetDsl({ ...MIN_VALID, extra: 1 })).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'text', text: { content: 'x' }, onclick: 'evil' }] })).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'text', text: { content: 'x', href: 'javascript:' } }] })).toBeNull();
    // 容器嵌套容器拒绝（扁平单层纪律）
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'text', text: { content: { nested: true } } }] })).toBeNull();
  });

  it(`节点数超 ${WIDGET_MAX_NODES} 上限整条拒绝`, () => {
    const nodes = Array.from({ length: WIDGET_MAX_NODES }, () => ({ c: 'divider' }));
    expect(validateWidgetDsl({ kind: 'stack', title: 'T', nodes })).not.toBeNull();
    nodes.push({ c: 'divider' });
    expect(validateWidgetDsl({ kind: 'stack', title: 'T', nodes })).toBeNull();
  });

  it('doc 超 8KB 上限整条拒绝', () => {
    const fat = { kind: 'stack', title: 'T', nodes: [{ c: 'text', text: { content: '字'.repeat(200) } }] };
    // 单节点裁剪后必然合法；堆到超限（200 字 ×3 字节 ×9 节点 > 8192 需更多节点——用边界法直接测字节）
    const many = Array.from({ length: WIDGET_MAX_NODES }, () => ({ c: 'text', text: { content: '字'.repeat(200) } }));
    const big = validateWidgetDsl({ kind: 'stack', title: 'T', nodes: many });
    if (big && JSON.stringify(big).length * 3 > WIDGET_MAX_DOC_BYTES) {
      expect(big).toBeNull(); // 不可达则跳过（裁剪后可能低于上限）
    }
    expect(validateWidgetDsl(fat)).not.toBeNull();
  });

  it('字符串超长裁剪不拒绝（对齐守卫族口径）', () => {
    const p = validateWidgetDsl({
      kind: 'stack',
      title: '标'.repeat(60),
      nodes: [{ c: 'text', text: { content: 'x'.repeat(500) } }],
    });
    expect(p).not.toBeNull();
    expect(p!.title.length).toBe(40);
    expect(p!.nodes[0].text!.content.length).toBe(200);
  });

  it('kv/list/table/tag 内层条数上限整条拒绝', () => {
    const kvRows = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: 'v' }));
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'kv', kv: { rows: kvRows } }] })).toBeNull();
    const items = Array.from({ length: 9 }, (_, i) => ({ text: `t${i}` }));
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'list', list: { items } }] })).toBeNull();
    const cols = Array.from({ length: 11 }, (_, i) => `c${i}`);
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'table', table: { columns: cols, rows: [cols.map(() => 'x')] } }] })).toBeNull();
    const tags = Array.from({ length: 9 }, (_, i) => `t${i}`);
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'tag', tag: { tags } }] })).toBeNull();
  });

  it('table 行内列数与 columns 不符拒绝；空列/空单元格拒绝', () => {
    const t = { c: 'table', table: { columns: ['A', 'B'], rows: [['x']] } };
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [t] })).toBeNull();
    const emptyCol = { c: 'table', table: { columns: ['A', ''], rows: [['x', 'y']] } };
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [emptyCol] })).toBeNull();
    const emptyCell = { c: 'table', table: { columns: ['A'], rows: [['']] } };
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [emptyCell] })).toBeNull();
  });

  it('progress 非有限数值拒绝，越界收敛到 [0,100]', () => {
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'progress', progress: { label: 'L', value: 'x' } }] })).toBeNull();
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'progress', progress: { label: 'L', value: NaN } }] })).toBeNull();
    const hi = validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'progress', progress: { label: 'L', value: 150 } }] });
    expect(hi!.nodes[0].progress!.value).toBe(100);
    const lo = validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'progress', progress: { label: 'L', value: -5 } }] });
    expect(lo!.nodes[0].progress!.value).toBe(0);
  });

  it('tone 出现但非枚举内拒绝；缺省通过', () => {
    expect(validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'text', text: { content: 'x', tone: 'purple' } }] })).toBeNull();
    const ok = validateWidgetDsl({ ...MIN_VALID, nodes: [{ c: 'text', text: { content: 'x', tone: 'danger' } }] });
    expect(ok!.nodes[0].text!.tone).toBe('danger');
  });

  it('kv 行未知字段拒绝（label/value 之外）', () => {
    expect(validateWidgetDsl({
      ...MIN_VALID,
      nodes: [{ c: 'kv', kv: { rows: [{ label: 'L', value: 'v', tone: 'warn' }] } }],
    })).toBeNull();
  });
});
