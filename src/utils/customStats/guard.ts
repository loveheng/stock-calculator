/**
 * @file guard.ts
 * @description Result Guard（自定义统计结果守卫）：沙箱返回值渲染前的唯一归一化通道。
 *              原则：归一化做在 Guard 层，渲染层傻瓜化（拿到什么渲染什么，零转换）；
 *              截断优于拒绝（统计场景友好），结构非法才拒绝。
 *              防线（spec §5.1）：所有文本强制 String() 化（XSS 由 React 声明式渲染兜底，
 *              绝无 HTML 解析路径）；tone 白名单；数值 isFinite 过滤；数量截断 + caption 标注。
 * @layer Utils (Pure) —— 只依赖 types，禁碰 store/db（R2）
 * @storage_impact 纯函数，无存储。
 * @author 开发团队
 */

import type {
  CustomStatChart,
  CustomStatChartPoint,
  CustomStatKpi,
  CustomStatsResult,
} from '../../types/domain';

/** Guard 上限常量（implementation §4.4 规则表） */
export const GUARD_LIMITS = {
  /** 标题卡 KPI 上限 */
  kpis: 3,
  /** bar/line 点数上限 */
  points: 50,
  /** pie 片数上限 */
  pieSlices: 8,
  /** label/value 文本长度上限 */
  text: 40,
  /** title/caption 文本长度上限 */
  titleText: 80,
} as const;

const TONES = ['default', 'good', 'bad'] as const;
type Tone = (typeof TONES)[number];

function clampText(v: unknown, max: number): string {
  return String(v ?? '').slice(0, max);
}

/** tone 白名单，越界归 default */
function normalizeTone(v: unknown): Tone {
  return TONES.includes(v as Tone) ? (v as Tone) : 'default';
}

/** 追加截断标注（保留原口径说明，追加在最前，超长整体裁剪） */
function appendTruncateNote(caption: string | undefined, note: string): string {
  const merged = caption ? `${note}；${caption}` : note;
  return merged.slice(0, GUARD_LIMITS.titleText);
}

/**
 * 归一化沙箱返回值为合法 CustomStatsResult。
 *
 * @returns 结构非法（kind 不明 / title 缺失 / chart 缺失或类型未知 / data 非数组）返回 null；
 *          其余情况尽量归一（截断/剔除/默认值）后返回。
 */
export function normalizeCustomStatsResult(raw: unknown): CustomStatsResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'card' && kind !== 'chart') return null;

  // title 必填非空（LLM 契约必有，缺失视为异常输出）；caption 可选归一
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null;
  const safeTitle = clampText(title, GUARD_LIMITS.titleText);
  const caption =
    typeof o.caption === 'string' && o.caption.trim().length > 0
      ? clampText(o.caption, GUARD_LIMITS.titleText)
      : undefined;

  if (kind === 'card') return normalizeCard(o, safeTitle, caption);
  return normalizeChart(o, safeTitle, caption);
}

function normalizeCard(
  o: Record<string, unknown>,
  title: string,
  caption: string | undefined,
): CustomStatsResult | null {
  if (!Array.isArray(o.kpis)) return null;
  const kpis: CustomStatKpi[] = o.kpis.slice(0, GUARD_LIMITS.kpis).map((raw) => {
    const k = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    // 数值有限性：number 且非有限值归 '—'；其余强制 String 化（XSS 防线：纯文本，无 HTML 解析路径）
    let value = k.value;
    if (typeof value === 'number' && !Number.isFinite(value)) value = '—';
    return {
      label: clampText(k.label ?? '', GUARD_LIMITS.text),
      value: clampText(value ?? '', GUARD_LIMITS.text),
      tone: normalizeTone(k.tone),
    };
  });
  return { kind: 'card', title, caption, kpis };
}

function normalizeChart(
  o: Record<string, unknown>,
  title: string,
  caption: string | undefined,
): CustomStatsResult | null {
  const chartRaw = (typeof o.chart === 'object' && o.chart !== null ? o.chart : {}) as Record<string, unknown>;
  const type = chartRaw.type;
  if (type !== 'bar' && type !== 'line' && type !== 'pie') return null;
  // data 必须是数组（对象形态直接拒绝，杜绝 __proto__/constructor 原型污染面）
  if (!Array.isArray(chartRaw.data)) return null;

  const max = type === 'pie' ? GUARD_LIMITS.pieSlices : GUARD_LIMITS.points;
  const truncated = chartRaw.data.length > max;

  const data: CustomStatChartPoint[] = [];
  for (const raw of chartRaw.data.slice(0, max)) {
    const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const label = clampText(p.label ?? '', GUARD_LIMITS.text);
    const value = typeof p.value === 'number' ? p.value : Number(p.value);
    // 非有限数值：剔除该点（不整体拒绝）；label 允许为空串（图形仍可渲染）
    if (!Number.isFinite(value)) continue;
    data.push({ label, value });
  }

  const chart: CustomStatChart = { type, data } as CustomStatChart;
  const safeCaption = truncated ? appendTruncateNote(caption, `已截断至前 ${max} 条`) : caption;
  return { kind: 'chart', title, caption: safeCaption, chart };
}

/**
 * 归一化「截断后空集」的兜底：全点被剔除/截断后 data 为空的图表仍属合法结果，
 * 渲染层以空态组件呈现（FR10），此处不拒绝。
 */
export function isEmptyChartResult(r: CustomStatsResult): boolean {
  return r.kind === 'chart' && r.chart.data.length === 0;
}
