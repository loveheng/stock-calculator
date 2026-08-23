/**
 * @file MetricsPanel.tsx
 * @description 沙盘指标面板（规格书 §9.4）：极简新手模式默认只展示 4 个核心数字
 *              （最终收益额 / 累计收益率 / 持仓均价变化 / 最大回撤）；专业模式展开
 *              波动率、已实现/未实现盈亏、累计规费与印花税、资金占用周期、交易笔数、
 *              「死拿不动对照组」对比与评估日清算标注。顶部含资金进度条
 *              （峰值占用 / 预算上限 = 历史最高占用资金）。
 * @layer UI
 * @storage_impact 纯展示组件，不读写任何存储；数据全部来自 store 的 BranchComputed。
 * @author 开发团队
 */

import React from 'react';
import { AlertTriangle, Info, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { SandboxBranch, SandboxResult } from '../../types/sandbox';

/** 金额格式化（带正负号） */
function fmtMoney(v: number, digits = 2): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}¥${Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 百分比格式化 */
function fmtPct(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

/** 指标小格 */
function StatCell({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down' | 'flat';
  hint?: string;
}) {
  const color =
    tone === 'up' ? 'text-red-400' : tone === 'down' ? 'text-green-400' : tone === 'flat' ? 'text-slate-300' : 'text-slate-200';
  return (
    <div className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-3 py-2" title={hint}>
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`font-mono text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}

interface MetricsPanelProps {
  branch: SandboxBranch;
  result: SandboxResult | null;
  warnings: string[];
  /** 极简新手模式 */
  expertMode: boolean;
}

/**
 * 指标面板组件。
 *
 * @param {MetricsPanelProps} props - 见接口定义
 * @returns {JSX.Element} 指标面板视图
 */
export default function MetricsPanel({ branch, result, warnings, expertMode }: MetricsPanelProps) {
  // 持仓均价变化（快照中首末有效成本）
  let costChange: { from: number; to: number; pct: number } | null = null;
  if (result && result.snapshots.length > 0) {
    const costs = result.snapshots.filter((s) => s.position > 0 && s.cost > 0);
    if (costs.length >= 1) {
      const from = costs[0].cost;
      const to = costs[costs.length - 1].cost;
      costChange = { from, to, pct: from > 0 ? ((to - from) / from) * 100 : 0 };
    }
  }

  // 资金占用峰值（持仓成本口径）
  let peakOccupy = 0;
  if (result && result.snapshots.length > 0) {
    peakOccupy = result.snapshots.reduce((m, s) => Math.max(m, s.position * s.cost), 0);
  }
  const budget = branch.simulatedCash > 0 ? branch.simulatedCash : branch.peakCapitalLock;
  const occupyPct = budget > 0 ? Math.min(100, (peakOccupy / budget) * 100) : 0;
  // 期末总资产 = 现金 + 持仓市值（末根快照，含复利滚存增长）
  const finalTotalAsset =
    result && result.snapshots.length > 0 ? result.snapshots[result.snapshots.length - 1].totalAsset : null;

  const profitTone = (v: number) => (v > 0 ? 'up' as const : v < 0 ? 'down' as const : 'flat' as const);

  return (
    <div className="space-y-3">
      {/* 资金进度条（预算上限 = 历史最高占用资金） */}
      <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl px-4 py-3">
        <div className="flex items-center justify-between text-[11px] mb-1.5">
          <span className="text-slate-500">
            资金占用峰值{' '}
            <span className="font-mono text-slate-300">¥{Math.round(peakOccupy).toLocaleString('zh-CN')}</span>
          </span>
          <span className="text-slate-500">
            预算上限 <span className="font-mono text-amber-400">¥{Math.round(budget).toLocaleString('zh-CN')}</span>
            <span className="ml-1 text-slate-600">（历史最高占用资金）</span>
          </span>
        </div>
        <div className="h-2 rounded-full bg-slate-700/60 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${occupyPct > 95 ? 'bg-red-500' : occupyPct > 70 ? 'bg-amber-500' : 'bg-blue-500'}`}
            style={{ width: `${Math.max(2, occupyPct)}%` }}
          />
        </div>
        <div className="text-[10px] text-slate-600 mt-1">
          推演预算上限 ¥{Math.round(budget).toLocaleString('zh-CN')}（历史最高占用资金）· 模拟资金 ¥{Math.round(branch.simulatedCash).toLocaleString('zh-CN')}
          {branch.simulatedCash !== branch.peakCapitalLock && <span className="text-sky-500">（已调高，模拟场景）</span>}
        </div>
      </div>

      {/* 核心数字（极简模式：4 个） */}
      {result ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <StatCell label="最终收益额" value={fmtMoney(result.finalProfit, 0)} tone={profitTone(result.finalProfit)} hint="已实现盈亏 + 未实现浮动盈亏（统一按评估日现价清算）" />
            <StatCell label="累计收益率" value={fmtPct(result.returnRate)} tone={profitTone(result.returnRate)} hint={`最终收益 ÷ 模拟资金 ¥${Math.round(budget).toLocaleString('zh-CN')}`} />
            <StatCell
              label="持仓均价变化"
              value={costChange ? `¥${costChange.from.toFixed(2)} → ¥${costChange.to.toFixed(2)}` : '—'}
              tone={costChange ? profitTone(costChange.pct) : undefined}
              hint={costChange ? `摊薄/抬升 ${fmtPct(costChange.pct)}` : '全程无持仓'}
            />
            <StatCell label="最大回撤" value={`${result.maxDrawdown.toFixed(2)}%`} tone="down" hint="市值曲线相对历史峰值的最大跌幅（%）" />
          </div>

          {/* 评估日清算标注 */}
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 bg-slate-800/40 rounded-lg px-3 py-1.5">
            <Info className="w-3 h-3 shrink-0" />
            <span>
              📌 统一于 <span className="text-slate-300 font-mono">{result.asOfDate}</span> 按现价市价清算；剩余持仓 {result.finalPosition} 股 · 剩余现金 ¥{Math.round(result.finalCash).toLocaleString('zh-CN')}
            </span>
          </div>

          {/* 专业模式高阶指标 */}
          {expertMode && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <StatCell label="持仓波动率" value={`${result.volatility.toFixed(2)}%`} tone="down" hint="总资产日收益率标准差（%）" />
                <StatCell label="已实现盈亏" value={fmtMoney(result.realizedProfit, 0)} tone={profitTone(result.realizedProfit)} />
                <StatCell label="未实现盈亏" value={fmtMoney(result.unrealizedProfit, 0)} tone={profitTone(result.unrealizedProfit)} />
                <StatCell label="交易笔数" value={`${result.tradeCount} 笔`} />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <StatCell label="累计手续费" value={fmtMoney(result.totalFees, 2)} tone="down" hint="净佣金 + 经手费 + 证管费 + 过户费" />
                <StatCell label="累计印花税" value={fmtMoney(result.totalStampTax, 2)} tone="down" />
                <StatCell label="资金占用周期" value={`${result.capitalOccupationDays} 天`} tone="down" />
                <StatCell label="初始本金" value={`¥${Math.round(branch.simulatedCash).toLocaleString('zh-CN')}`} hint="推演初始假设本金（非真实资金），默认=历史最高占用资金" />
                <StatCell label="期末总资产" value={`¥${Math.round(finalTotalAsset ?? branch.simulatedCash).toLocaleString('zh-CN')}`} tone={finalTotalAsset != null && finalTotalAsset >= branch.simulatedCash ? 'up' : finalTotalAsset != null ? 'down' : undefined} hint="期末现金 + 持仓市值（含中途盈利再投资后的复利滚存增长）" />
              </div>

              {/* 死拿不动对照组 */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <StatCell
                  label="死拿不动 · 收益率"
                  value={fmtPct(result.buyAndHold.returnRate)}
                  tone={profitTone(result.buyAndHold.returnRate)}
                />
                <StatCell
                  label="跑赢死拿不动（超额）"
                  value={fmtPct(result.returnRate - result.buyAndHold.returnRate)}
                  tone={profitTone(result.returnRate - result.buyAndHold.returnRate)}
                  hint="本方案累计收益率 − 首笔买入持有到评估日（Buy & Hold）的收益率"
                />
                <StatCell
                  label="死拿不动 · 最大回撤"
                  value={`${result.buyAndHold.maxDrawdown.toFixed(2)}%`}
                  tone="down"
                />
                <StatCell
                  label="死拿不动 · 收益额"
                  value={fmtMoney(result.buyAndHold.finalProfit, 0)}
                  tone={profitTone(result.buyAndHold.finalProfit)}
                />
              </div>
            </>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center py-8 text-xs text-slate-500">
          <TrendingUp className="w-4 h-4 mr-1.5 text-slate-600" />
          推演被拒绝（见上方提示）或尚未运行
        </div>
      )}

      {/* 非致命警示 */}
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-amber-400/90 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* 无持仓/无操作提示 */}
      {result && result.tradeCount === 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <Minus className="w-3.5 h-3.5" />
          该方案没有任何成交操作，请复制后添加买卖点。
        </div>
      )}
      {result && result.tradeCount === 0 && result.finalPosition > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <TrendingDown className="w-3.5 h-3.5" />
          有持仓但无成交记录？请在时间线中调整买卖点。
        </div>
      )}
    </div>
  );
}
