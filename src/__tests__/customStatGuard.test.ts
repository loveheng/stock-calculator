/**
 * @file customStatGuard.test.ts
 * @description Result Guard 回归测试（implementation §4.4 规则表）：
 *              kind 收窄 / kpis 截断 / 点数截断 + caption 标注 / isFinite 归一 / tone 白名单 /
 *              文本强制 String 化（恶意载荷以纯文本留存，绝无 HTML 解析路径）/ data 非数组拒绝 /
 *              title 缺失拒绝。截断优于拒绝，结构非法才拒绝。
 * @layer 测试
 * @author 开发团队
 */

import { describe, expect, it } from 'vitest';
import { GUARD_LIMITS, isEmptyChartResult, normalizeCustomStatsResult } from '../utils/customStats/guard';

describe('normalizeCustomStatsResult（结构收窄与拒绝）', () => {
  it('非对象 / kind 非法 / title 缺失 / chart 缺失或未知类型 / data 非数组 → 拒绝', () => {
    expect(normalizeCustomStatsResult(null)).toBeNull();
    expect(normalizeCustomStatsResult('str')).toBeNull();
    expect(normalizeCustomStatsResult([])).toBeNull();
    expect(normalizeCustomStatsResult({ kind: 'table', title: 't' })).toBeNull();
    expect(normalizeCustomStatsResult({ kind: 'card' })).toBeNull();
    expect(normalizeCustomStatsResult({ kind: 'card', title: '  ' })).toBeNull();
    expect(normalizeCustomStatsResult({ kind: 'chart', title: 't' })).toBeNull();
    expect(normalizeCustomStatsResult({ kind: 'chart', title: 't', chart: { type: 'radar', data: [] } })).toBeNull();
    // 对象形态 data 直接拒绝（杜绝 __proto__/constructor 原型污染面）
    expect(
      normalizeCustomStatsResult({
        kind: 'chart', title: 't',
        chart: { type: 'bar', data: { __proto__: { x: 1 }, a: 1 } },
      }),
    ).toBeNull();
  });

  it('caption 可选：缺失允许，存在则裁剪至 80', () => {
    const r = normalizeCustomStatsResult({ kind: 'card', title: 't', kpis: [] });
    expect(r).not.toBeNull();
    const r2 = normalizeCustomStatsResult({
      kind: 'card', title: 't', caption: 'c'.repeat(120), kpis: [],
    });
    expect(r2?.kind === 'card' && r2.caption?.length).toBe(80);
  });

  it('kpis 超 3 截断；kpi 文本超 40 裁剪；tone 越界归 default', () => {
    const r = normalizeCustomStatsResult({
      kind: 'card',
      title: 't',
      kpis: [
        { label: 'l'.repeat(50), value: 'v'.repeat(50), tone: 'good' },
        { label: 'a', value: '1' },
        { label: 'b', value: '2', tone: 'nope' },
        { label: 'c', value: '3', tone: 'bad' },
      ],
    });
    expect(r?.kind).toBe('card');
    if (r?.kind !== 'card') return;
    expect(r.kpis.length).toBe(GUARD_LIMITS.kpis);
    expect(r.kpis[0].label.length).toBe(40);
    expect(r.kpis[0].tone).toBe('good');
    expect(r.kpis[2].tone).toBe('default');
  });

  it('kpi 数值非有限归 "—"，其余值强制 String 化（数字/布尔/对象）', () => {
    const r = normalizeCustomStatsResult({
      kind: 'card',
      title: 't',
      kpis: [
        { label: 'a', value: Infinity },
        { label: 'b', value: 1234.5 },
        { label: 'c', value: true },
      ],
    });
    expect(r?.kind).toBe('card');
    if (r?.kind !== 'card') return;
    expect(r.kpis[0].value).toBe('—');
    expect(r.kpis[1].value).toBe('1234.5');
    expect(r.kpis[2].value).toBe('true');
  });

  it('bar/line 超 50 点截断 + caption 标注；pie 超 8 片截断', () => {
    const mk = (type: 'bar' | 'line' | 'pie', n: number) => ({
      kind: 'chart',
      title: 't',
      caption: '口径说明',
      chart: { type, data: Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: i + 1 })) },
    });
    const bar = normalizeCustomStatsResult(mk('bar', 60));
    expect(bar?.kind).toBe('chart');
    if (bar?.kind === 'chart') {
      expect(bar.chart.data.length).toBe(GUARD_LIMITS.points);
      expect(bar.caption).toContain('已截断至前 50 条');
      expect(bar.caption).toContain('口径说明');
    }
    const line = normalizeCustomStatsResult(mk('line', 51));
    expect(line?.kind === 'chart' && line.chart.data.length).toBe(GUARD_LIMITS.points);
    const pie = normalizeCustomStatsResult(mk('pie', 12));
    expect(pie?.kind).toBe('chart');
    if (pie?.kind === 'chart') {
      expect(pie.chart.data.length).toBe(GUARD_LIMITS.pieSlices);
      expect(pie.caption).toContain('已截断至前 8 条');
    }
  });

  it('图表点 value 非有限被剔除；全剔除后为合法空图（渲染层空态）', () => {
    const r = normalizeCustomStatsResult({
      kind: 'chart',
      title: 't',
      chart: {
        type: 'bar',
        data: [
          { label: 'a', value: 1 },
          { label: 'b', value: NaN },
          { label: 'c', value: Infinity },
          { label: 'd', value: '12.5' },
        ],
      },
    });
    expect(r?.kind).toBe('chart');
    if (r?.kind === 'chart') {
      expect(r.chart.data).toEqual([{ label: 'a', value: 1 }, { label: 'd', value: 12.5 }]);
      expect(isEmptyChartResult(r)).toBe(false);
    }
    const empty = normalizeCustomStatsResult({
      kind: 'chart', title: 't', chart: { type: 'pie', data: [{ label: 'x', value: NaN }] },
    });
    expect(empty?.kind).toBe('chart');
    if (empty?.kind === 'chart') expect(isEmptyChartResult(empty)).toBe(true);
  });

  it('恶意文本载荷原样以纯文本留存（不做 HTML 解析/反转义，React 声明式渲染天然转义）', () => {
    const evil = '<script>alert(1)</script>';
    const r = normalizeCustomStatsResult({
      kind: 'card',
      title: evil,
      kpis: [{ label: `<img src=x onerror=alert(1)>`, value: evil }],
    });
    expect(r?.kind).toBe('card');
    if (r?.kind !== 'card') return;
    expect(r.title).toBe(evil.slice(0, GUARD_LIMITS.titleText));
    expect(r.kpis[0].label).toBe('<img src=x onerror=alert(1)>');
    expect(r.kpis[0].value).toBe(evil);
  });

  it('title 超 80 裁剪（缺失拒绝，超长归一）', () => {
    const r = normalizeCustomStatsResult({ kind: 'card', title: 't'.repeat(120), kpis: [] });
    expect(r?.kind === 'card' && r.title.length).toBe(80);
  });
});
