/**
 * @file widgetDsl.ts
 * @description 画布 DSL 动态模板（widget 区块）形状校验器（docs/free-canvas-template-registry.md「DSL 动态模板」节，"图纸"侧）：
 *              LLM 只输出受 schema 约束的 JSON 图纸，只有通过本校验器的图纸才允许落画布——单一入口，
 *              全链路零代码传输（画布域不开任何代码通道，含沙箱）。
 *              校验纪律：结构违规（未知种类/形状不符/嵌套容器/节点超限/超尺寸/未知字段）→ 整条拒绝返回 null；
 *              字符串超长 → 裁剪（对齐 copilotActions 守卫族口径）。纯函数、禁 eval，可单测全覆盖。
 * @layer Utils (Pure)
 * @storage_impact 无。
 * @author 开发团队
 */

import type { WidgetDsl, WidgetNode, WidgetNodeKind, WidgetTone } from '../types/domain';

/** 组件白名单（8 种，封闭；c 在白名单外 = 非法图纸） */
export const WIDGET_NODE_KINDS: readonly WidgetNodeKind[] = [
  'text', 'metric', 'kv', 'list', 'table', 'progress', 'tag', 'divider',
];

const WIDGET_TONES: readonly WidgetTone[] = ['info', 'warn', 'danger'];

/** 图纸硬上限：节点数 ≤8，doc ≤8KB（UTF-8 字节；超限整条拒绝） */
export const WIDGET_MAX_NODES = 8;
export const WIDGET_MAX_DOC_BYTES = 8192;

/** 各类字符串长度上限（超长裁剪，非拒绝） */
const MAX_LEN = {
  title: 40,
  text: 200,
  label: 40,
  metricValue: 60,
  kvLabel: 20,
  kvValue: 40,
  listItem: 60,
  tableCol: 20,
  tableCell: 30,
  tag: 20,
} as const;

/** 内层数组条数上限（超限整条拒绝，白名单纪律） */
const MAX_COUNT = {
  kvRows: 8,
  listItems: 8,
  tableCols: 10,
  tableRows: 10,
  tags: 8,
} as const;

/** UTF-8 字节长度（node 测试环境 TextEncoder 可用） */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 字符串整形：非字符串 → null；trim 后裁剪到 max（trim 后为空由调用方判定拒绝） */
function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  return v.trim().slice(0, max);
}

/** 对象判定（非对象 → null） */
function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** tone 可选字段校验：缺省通过；出现但不在枚举内 → 拒绝 */
function isTone(v: unknown): boolean {
  return v === undefined || (WIDGET_TONES as readonly string[]).includes(v as string);
}

/** 载荷对象字段白名单：出现集合外字段 → 拒绝（防 LLM 在载荷内夹带可疑键） */
function onlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

/** 字符串数组整形：元素逐一 trim 裁剪；非数组/含非字符串元素 → null；trim 后空元素由调用方判定 */
function clampStrArray(v: unknown, maxLen: number, maxCount: number): string[] | null {
  if (!Array.isArray(v) || v.length > maxCount) return null;
  const out: string[] = [];
  for (const item of v) {
    const s = clampStr(item, maxLen);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** 叶子节点校验入口：c 白名单 + 按种类收窄 + 未知字段拒绝（扁平单层，不允许可疑嵌套） */
function buildNode(raw: unknown): WidgetNode | null {
  const o = asObj(raw);
  if (!o) return null;
  const kind = o.c;
  if (typeof kind !== 'string' || !WIDGET_NODE_KINDS.includes(kind as WidgetNodeKind)) return null;
  // 字段白名单：仅允许 c + 本种类对应载荷键（divider 无载荷键）——未知字段一律拒绝
  const allowedKeys = ['c', ...(kind === 'divider' ? [] : [kind])];
  for (const k of Object.keys(o)) {
    if (!allowedKeys.includes(k)) return null;
  }
  switch (kind) {
    case 'text': {
      const p = asObj(o.text);
      const content = p ? clampStr(p.content, MAX_LEN.text) : null;
      if (content === null || content === '' || !isTone(p?.tone)) return null;
      if (p && !onlyKeys(p, ['content', 'tone'])) return null;
      // 先在局部构建载荷再组装节点：WidgetNode 载荷键为可选字段，先赋节点再补 tone 会破坏 TS 收窄
      const text: { content: string; tone?: WidgetTone } = { content };
      if (p?.tone !== undefined) text.tone = p.tone as WidgetTone;
      return { c: 'text', text };
    }
    case 'metric': {
      const p = asObj(o.metric);
      const label = p ? clampStr(p.label, MAX_LEN.label) : null;
      const value = p ? clampStr(p.value, MAX_LEN.metricValue) : null;
      if (label === null || label === '' || value === null || value === '' || !isTone(p?.tone)) return null;
      if (p && !onlyKeys(p, ['label', 'value', 'tone'])) return null;
      const metric: { label: string; value: string; tone?: WidgetTone } = { label, value };
      if (p?.tone !== undefined) metric.tone = p.tone as WidgetTone;
      return { c: 'metric', metric };
    }
    case 'kv': {
      const p = asObj(o.kv);
      if (!p || !onlyKeys(p, ['rows'])) return null;
      if (!Array.isArray(p.rows) || p.rows.length === 0 || p.rows.length > MAX_COUNT.kvRows) return null;
      const rows: { label: string; value: string }[] = [];
      for (const r of p.rows) {
        const ro = asObj(r);
        const label = ro ? clampStr(ro.label, MAX_LEN.kvLabel) : null;
        const value = ro ? clampStr(ro.value, MAX_LEN.kvValue) : null;
        if (label === null || label === '' || value === null) return null;
        if (ro && Object.keys(ro).some((k) => k !== 'label' && k !== 'value')) return null;
        rows.push({ label, value });
      }
      return { c: 'kv', kv: { rows } };
    }
    case 'list': {
      const p = asObj(o.list);
      if (!p || !onlyKeys(p, ['title', 'items'])) return null;
      if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > MAX_COUNT.listItems) return null;
      const title = p.title === undefined ? null : clampStr(p.title, MAX_LEN.label);
      if (p.title !== undefined && (title === null || title === '')) return null;
      const items: { text: string; tone?: WidgetTone }[] = [];
      for (const it of p.items) {
        const io = asObj(it);
        const text = io ? clampStr(io.text, MAX_LEN.listItem) : null;
        if (text === null || text === '' || !isTone(io?.tone)) return null;
        if (io && Object.keys(io).some((k) => k !== 'text' && k !== 'tone')) return null;
        const item: { text: string; tone?: WidgetTone } = { text };
        if (io?.tone !== undefined) item.tone = io.tone as WidgetTone;
        items.push(item);
      }
      const list: { title?: string; items: { text: string; tone?: WidgetTone }[] } = { items };
      if (title) list.title = title;
      return { c: 'list', list };
    }
    case 'table': {
      const p = asObj(o.table);
      if (!p || !onlyKeys(p, ['columns', 'rows'])) return null;
      const columns = clampStrArray(p.columns, MAX_LEN.tableCol, MAX_COUNT.tableCols);
      if (columns === null || columns.length === 0 || columns.some((c) => c === '')) return null;
      if (!Array.isArray(p.rows) || p.rows.length === 0 || p.rows.length > MAX_COUNT.tableRows) return null;
      const rows: string[][] = [];
      for (const r of p.rows) {
        const cells = clampStrArray(r, MAX_LEN.tableCell, columns.length);
        // 行内单元格数必须与列数一致（缺格 = 图纸错误，渲染出洞不如整条拒绝）；空单元格与全域空串纪律一致拒绝
        if (cells === null || cells.length !== columns.length || cells.some((c) => c === '')) return null;
        rows.push(cells);
      }
      return { c: 'table', table: { columns, rows } };
    }
    case 'progress': {
      const p = asObj(o.progress);
      if (!p || !onlyKeys(p, ['label', 'value'])) return null;
      const label = clampStr(p.label, MAX_LEN.label);
      const value = p.value;
      if (label === null || label === '' || typeof value !== 'number' || !Number.isFinite(value)) return null;
      return { c: 'progress', progress: { label, value: Math.min(MAX_LEN.tableCol * 5, Math.max(0, value)) } };
    }
    case 'tag': {
      const p = asObj(o.tag);
      if (!p || !onlyKeys(p, ['tags'])) return null;
      const tags = clampStrArray(p.tags, MAX_LEN.tag, MAX_COUNT.tags);
      if (tags === null || tags.length === 0 || tags.some((t) => t === '')) return null;
      return { c: 'tag', tag: { tags } };
    }
    case 'divider':
      return { c: 'divider' };
    default:
      return null; // 白名单外种类（buildNode 入口已拦截，此处为 TS 穷尽兜底）
  }
}

/**
 * widget 图纸校验入口：LLM 输出的 JSON 只有通过这里才允许落画布。
 * 返回规范化（裁剪/收敛后）的 WidgetDsl；任何结构违规 → null（调用方整条丢弃，静默口径与既有守卫一致）。
 */
export function validateWidgetDsl(raw: unknown): WidgetDsl | null {
  const o = asObj(raw);
  if (!o) return null;
  if (o.kind !== 'stack' && o.kind !== 'grid') return null;
  const title = clampStr(o.title, MAX_LEN.title);
  if (title === null || title === '') return null;
  if (!Array.isArray(o.nodes) || o.nodes.length === 0 || o.nodes.length > WIDGET_MAX_NODES) return null;
  const nodes: WidgetNode[] = [];
  for (const n of o.nodes) {
    const node = buildNode(n);
    if (node === null) return null;
    nodes.push(node);
  }
  // 未知顶层字段（kind/title/nodes 之外）→ 拒绝
  for (const k of Object.keys(o)) {
    if (k !== 'kind' && k !== 'title' && k !== 'nodes') return null;
  }
  const dsl: WidgetDsl = { kind: o.kind, title, nodes };
  if (utf8Bytes(JSON.stringify(dsl)) > WIDGET_MAX_DOC_BYTES) return null;
  return dsl;
}
