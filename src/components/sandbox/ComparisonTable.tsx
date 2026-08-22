/**
 * @file ComparisonTable.tsx
 * @description 多方案对比（规格书 §9.1 状态 3 + §1 四维对比）：对勾选的分支构建
 *              「收益表现 / 风险控制 / 持仓基准 / 交易成本」四维对比表（每行标注
 *              该维最优方案，来自 utils/metricsEngine.buildComparisonRows），
 *              并渲染收益/风险散点图（X=最大回撤，Y=累计收益率，SVG 纯手绘）。
 *              对比数据经 store.getComputed()（非响应式 getter）在 useMemo 中读取，
 *              依赖 [comparedBranchIds, branches] 响应式变化触发重算。
 * @layer UI
 * @storage_impact 纯展示组件，不读写任何存储。
 * @author 开发团队
 */

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Trophy } from 'lucide-react';
import type { SandboxBranch, SandboxResult } from '../../types/sandbox';
import type { BranchComputed } from '../../store/sandboxStore';
import { buildComparisonRows } from '../../utils/metricsEngine';

/** 分支配色盘（按序号轮换） */
const PALETTE = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee'];

/** 金额/百分比按行格式化 */
function fmtCell(key: string, v: number): string {
  if (key === 'finalProfit') return `${v >= 0 ? '+' : ''}¥${Math.abs(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
  if (key === 'totalFees') return `¥${v.toFixed(2)}`;
  if (key === 'returnRate' || key === 'excessReturn' || key === 'maxDrawdown' || key === 'volatility') {
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  }
  if (key === 'capitalOccupationDays') return `${Math.round(v)} 天`;
  return String(v);
}

interface ComparisonTableProps {
  /** 参与对比的分支（≥2） */
  branches: SandboxBranch[];
  /** 非响应式取值器（useMemo 依赖 branches 重算） */
  getComputed: (branchId: string) => BranchComputed | null;
  /** 点击某方案行 → 选中该分支查看 */
  onSelectBranch: (branchId: string) => void;
}

/**
 * 多方案对比组件。
 *
 * @param {ComparisonTableProps} props - 见接口定义
 * @returns {JSX.Element} 对比表 + 散点图
 */
export default function ComparisonTable({ branches, getComputed, onSelectBranch }: ComparisonTableProps) {
  const [collapsed, setCollapsed] = useState(false);

  const { rows, inputs, colorMap } = useMemo(() => {
    const inputs = branches
      .map((b) => ({ id: b.id, name: b.branchName, result: getComputed(b.id)?.result ?? null }))
      .filter((x): x is { id: string; name: string; result: SandboxResult } => x.result !== null);
    const rows = buildComparisonRows(inputs.map((i) => ({ id: i.id, name: i.name, result: i.result })));
    const colorMap = new Map<string, string>();
    inputs.forEach((i, idx) => colorMap.set(i.id, PALETTE[idx % PALETTE.length]));
    return { rows, inputs, colorMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches, collapsed]);

  // 散点图坐标（X=最大回撤，Y=累计收益率）
  const scatter = useMemo(() => {
    if (inputs.length === 0) return null;
    const dd = inputs.map((i) => i.result.maxDrawdown);
    const rt = inputs.map((i) => i.result.returnRate);
    const maxDd = Math.max(...dd, 0.01);
    const minRt = Math.min(...rt, 0);
    const maxRt = Math.max(...rt, 0.01);
    const pad = (maxRt - minRt) * 0.15 || 1;
    const W = 320;
    const H = 200;
    const M = { l: 8, r: 8, t: 12, b: 20 };
    return inputs.map((i, idx) => ({
      id: i.id,
      name: i.name,
      color: colorMap.get(i.id) ?? PALETTE[idx % PALETTE.length],
      x: M.l + (i.result.maxDrawdown / maxDd) * (W - M.l - M.r),
      y: M.t + (1 - (i.result.returnRate - (minRt - pad)) / (maxRt + pad - (minRt - pad))) * (H - M.t - M.b),
      dd: i.result.maxDrawdown,
      rt: i.result.returnRate,
    }));
  }, [inputs, colorMap]);

  if (branches.length < 2) return null;

  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
          <Trophy className="w-4 h-4 text-amber-400" />
          多方案对比（{inputs.length} 个方案）
        </h3>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-slate-400 hover:text-slate-200 inline-flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-slate-700/50 transition-colors"
        >
          {collapsed ? '展开对比' : '收起'}
          {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
      </div>

      {!collapsed && (
        <div className="p-4 space-y-4">
          {inputs.length === 0 ? (
            <p className="text-xs text-slate-500">所选方案均未产生推演结果，请先运行推演。</p>
          ) : (
            <>
              {/* 四维对比表 */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="text-left font-medium py-1.5 pr-3">评估维度</th>
                      {inputs.map((i) => (
                        <th key={i.id} className="text-right font-medium py-1.5 px-2">
                          <button
                            onClick={() => onSelectBranch(i.id)}
                            className={`inline-flex items-center gap-1 hover:underline ${i.name.length > 8 ? 'text-[10px]' : ''}`}
                            style={{ color: colorMap.get(i.id) }}
                          >
                            <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: colorMap.get(i.id) }} />
                            {i.name}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} className="border-t border-slate-700/40">
                        <td className="py-1.5 pr-3 text-slate-400">{row.metric}</td>
                        {inputs.map((i) => {
                          const v = row.values[i.id];
                          const isBest = row.bestBranchId === i.id;
                          const best = row.direction === 'higher' ? v >= 0 : v <= 0;
                          return (
                            <td key={i.id} className="text-right py-1.5 px-2">
                              <span
                                className={`font-mono tabular-nums ${isBest ? 'font-bold' : 'text-slate-300'} ${
                                  isBest ? (best ? 'text-amber-400' : 'text-amber-400') : ''
                                }`}
                              >
                                {fmtCell(row.key, v)}
                                {isBest && <Trophy className="inline w-2.5 h-2.5 ml-1 text-amber-400" />}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 收益/风险散点图 */}
              {scatter && scatter.length > 0 && (
                <div className="border-t border-slate-700/50 pt-3">
                  <div className="text-[11px] text-slate-500 mb-1">
                    收益/风险散点图：X 轴 = 最大回撤（风险，越小越好）· Y 轴 = 累计收益率（越高越好）· 左上角越优
                  </div>
                  <div className="flex flex-col md:flex-row items-start gap-4">
                    <svg viewBox="0 0 336 212" className="w-full max-w-[420px] bg-slate-900/50 border border-slate-700/50 rounded-lg">
                      {/* 网格线 */}
                      {[0.25, 0.5, 0.75].map((f) => (
                        <line key={`h${f}`} x1={8} x2={328} y1={12 + f * 168} y2={12 + f * 168} stroke="rgba(148,163,184,0.08)" strokeDasharray="3 3" />
                      ))}
                      {[0.25, 0.5, 0.75].map((f) => (
                        <line key={`v${f}`} x1={8 + f * 320} x2={8 + f * 320} y1={12} y2={180} stroke="rgba(148,163,184,0.08)" strokeDasharray="3 3" />
                      ))}
                      {/* 轴标签 */}
                      <text x={12} y={196} fill="#64748b" fontSize={9}>0% 回撤</text>
                      <text x={250} y={196} fill="#64748b" fontSize={9}>回撤 →</text>
                      {/* 点 */}
                      {scatter.map((p) => (
                        <g key={p.id}>
                          <circle cx={p.x} cy={p.y} r={7} fill={p.color} fillOpacity={0.15} />
                          <circle cx={p.x} cy={p.y} r={4} fill={p.color} />
                          <text x={p.x + 8} y={p.y + 3} fill={p.color} fontSize={9}>
                            {p.name.length > 6 ? `${p.name.slice(0, 6)}…` : p.name}
                          </text>
                          <text x={p.x + 8} y={p.y + 14} fill="#64748b" fontSize={8} fontFamily="monospace">
                            {p.rt >= 0 ? '+' : ''}{p.rt.toFixed(1)}% / 回撤 {p.dd.toFixed(1)}%
                          </text>
                        </g>
                      ))}
                    </svg>
                    <div className="text-[11px] text-slate-500 leading-relaxed md:pt-6">
                      {(() => {
                        const best = scatter.reduce((a, b) => (b.rt - b.dd / 2 > a.rt - a.dd / 2 ? b : a), scatter[0]);
                        const worst = scatter.reduce((a, b) => (a.rt - a.dd / 2 <= b.rt - b.dd / 2 ? a : b), scatter[0]);
                        return (
                          <>
                            <p>🥇 综合最优（收益−回撤/2）：<span style={{ color: best.color }}>{best.name}</span></p>
                            <p>⚠️ 需要谨慎：<span style={{ color: worst.color }}>{worst.name}</span></p>
                            <p className="text-slate-600">（粗略打分仅供快速筛选，完整结论看上方四维表）</p>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
