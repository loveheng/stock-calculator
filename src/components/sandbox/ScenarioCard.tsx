/**
 * @file ScenarioCard.tsx
 * @description 沙盘方案卡片（三态区分，规格书 §9.3）：baseline 徽章「⚡ 真实操作·只读·
 *              📌 持仓中/已平仓」仅【查看】；preset 徽章「[预设]」+ 📅 时效戳 + ⚠️/⚡/🔄
 *              过期提示，操作【预览】【📋 复制并微调】；user 徽章「[我的方案]/[预设副本]」
 *              操作【编辑】【▶ 运行】【删除】。卡片下方展示该分支的关键数字（基线：已实现/
 *              未实现盈亏；其他：最终收益/累计收益率）与评估日。
 * @layer UI
 * @storage_impact 纯展示组件；动作全部回调父级（父级调用 sandboxStore 对应 action）。
 * @author 开发团队
 */

import React from 'react';
import {
  Copy,
  Eye,
  Play,
  Trash2,
  Zap,
  RefreshCw,
  AlertTriangle,
  Clock,
  CheckSquare,
  Square,
  Lock,
  CircleDot,
} from 'lucide-react';
import type { SandboxBranch } from '../../types/sandbox';
import type { BranchComputed, StaleFlags } from '../../store/sandboxStore';
import { STRATEGY_GENERATORS } from '../../utils/strategyGenerators';

/** 金额格式化（带正负号，千分位） */
function fmtMoney(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}¥${Math.abs(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}

/** 百分比格式化 */
function fmtPct(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

/** epoch ms → 'MM-DD HH:mm' */
function fmtTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface ScenarioCardProps {
  branch: SandboxBranch;
  /** 分支计算结果（null = 尚未运行/无法计算） */
  computed: BranchComputed | null;
  /** 过期检测标记 */
  stale: StaleFlags;
  selected: boolean;
  compared: boolean;
  /** 基线分支是否仍持仓（📌 持仓中/已平仓） */
  baselinePositionOpen?: boolean;
  onSelect: () => void;
  onToggleCompare: () => void;
  onCopy: () => void;
  onRun: () => void;
  onDelete: () => void;
  onRescale: () => void;
  onRebuild: () => void;
  onRefreshKline: () => void;
  /** 更新预设方案（按新约束条件重新生成） */
  onUpdate?: () => void;
}

/**
 * 方案卡片组件。
 *
 * @param {ScenarioCardProps} props - 见接口定义
 * @returns {JSX.Element} 卡片视图
 */
export default function ScenarioCard({
  branch,
  computed,
  stale,
  selected,
  compared,
  baselinePositionOpen = false,
  onSelect,
  onToggleCompare,
  onCopy,
  onRun,
  onDelete,
  onRescale,
  onRebuild,
  onRefreshKline,
  onUpdate,
}: ScenarioCardProps) {
  const result = computed?.result ?? null;
  const isBaseline = branch.branchType === 'baseline';
  const isPreset = branch.branchType === 'preset';
  const hasResult = !!result;

  // 策略名（preset）
  const strategyName = branch.presetStrategyId ? STRATEGY_GENERATORS[branch.presetStrategyId]?.name ?? '预设策略' : null;

  // 初始本金 = simulatedCash（默认对齐 peakCapitalLock）；期末总资产 = 现金 + 持仓市值（末根快照，含复利滚存增长）
  const initialCash = branch.simulatedCash;
  const finalTotalAsset =
    result && result.snapshots.length > 0 ? result.snapshots[result.snapshots.length - 1].totalAsset : null;

  // 关键数字
  let headline: React.ReactNode = null;
  if (isBaseline) {
    headline = result ? (
      <div className="grid grid-cols-2 gap-1 text-[11px] mt-2">
        <div className="bg-slate-900/60 rounded-lg px-2 py-1">
          <div className="text-slate-500">已实现盈亏</div>
          <div className={`font-mono font-semibold ${result.realizedProfit >= 0 ? 'text-red-400' : 'text-green-400'}`}>
            {fmtMoney(result.realizedProfit)}
          </div>
        </div>
        <div className="bg-slate-900/60 rounded-lg px-2 py-1">
          <div className="text-slate-500">未实现（{result.finalPosition} 股）</div>
          <div className={`font-mono font-semibold ${result.unrealizedProfit >= 0 ? 'text-red-400' : 'text-green-400'}`}>
            {fmtMoney(result.unrealizedProfit)}
          </div>
        </div>
      </div>
    ) : null;
  } else if (result && finalTotalAsset != null) {
    headline = (
      <div className="grid grid-cols-2 gap-1 text-[11px] mt-2">
        <div className="bg-slate-900/60 rounded-lg px-2 py-1">
          <div className="text-slate-500">初始本金</div>
          <div className="font-mono font-semibold text-slate-200">¥{Math.round(initialCash).toLocaleString('zh-CN')}</div>
          <div className="text-slate-600 mt-0.5">收益率 {fmtPct(result.returnRate)}</div>
        </div>
        <div className="bg-slate-900/60 rounded-lg px-2 py-1">
          <div className="text-slate-500">期末总资产</div>
          <div className={`font-mono font-semibold ${finalTotalAsset >= initialCash ? 'text-red-400' : 'text-green-400'}`}>¥{Math.round(finalTotalAsset).toLocaleString('zh-CN')}</div>
          <div className="text-slate-600 mt-0.5">现金+持仓市值</div>
        </div>
      </div>
    );
  }

  // 徽章
  const badge = isBaseline ? (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
      <Zap className="w-2.5 h-2.5" />
      真实操作 · 只读
    </span>
  ) : isPreset ? (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-400 border border-violet-500/30">
      <span>预设</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30">
      {branch.parentPresetId ? <span>预设副本</span> : <span>我的方案</span>}
    </span>
  );

  // 过期提示条（⚠️/⚡/🔄）
  const staleButtons: React.ReactNode[] = [];
  if (stale.kline) {
    staleButtons.push(
      <button
        key="kline"
        onClick={(e) => { e.stopPropagation(); onRefreshKline(); }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors"
        title="行情已更新至新日期，点击用最新 K 线重新推演"
      >
        <AlertTriangle className="w-2.5 h-2.5" /> K线有更新·点击刷新
      </button>,
    );
  }
  if (stale.cash && isPreset) {
    staleButtons.push(
      <button
        key="cash"
        onClick={(e) => { e.stopPropagation(); onRescale(); }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 transition-colors"
        title="可用资金已变动，点击按最新资金重算买入股数（价格点位不变）"
      >
        <Zap className="w-2.5 h-2.5" /> 资金已变·点击重配
      </button>,
    );
  }
  if (stale.baseline) {
    staleButtons.push(
      <button
        key="baseline"
        onClick={(e) => { e.stopPropagation(); onRebuild(); }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-orange-500/15 text-orange-400 hover:bg-orange-500/25 transition-colors"
        title="真实持仓批次已变化，点击重建基线并重跑推演"
      >
        <RefreshCw className="w-2.5 h-2.5" /> 基线已变·点击重建
      </button>,
    );
  }

  // 底部操作按钮
  const actions: React.ReactNode[] = [];
  if (isBaseline) {
    actions.push(
      <button
        key="view"
        onClick={onSelect}
        className={`flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs transition-colors ${
          selected ? 'bg-blue-600 text-white' : 'bg-slate-700/60 text-slate-300 hover:bg-slate-700'
        }`}
      >
        <Eye className="w-3 h-3" />
        {selected ? '查看中' : '查看'}
      </button>,
    );
  } else {
    actions.push(
      <button
        key="select"
        onClick={onSelect}
        className={`flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs transition-colors ${
          selected ? 'bg-blue-600 text-white' : 'bg-slate-700/60 text-slate-300 hover:bg-slate-700'
        }`}
      >
        <Eye className="w-3 h-3" />
        {selected ? '查看中' : (isPreset ? '预览' : '编辑')}
      </button>,
    );
  }
  if (isPreset) {
    actions.push(
      <button
        key="copy"
        onClick={onCopy}
        className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs bg-violet-600/20 text-violet-300 hover:bg-violet-600/30 transition-colors"
        title="复制为你的演练版本（随便改，改乱了删掉重来）"
      >
        <Copy className="w-3 h-3" />
        复制并微调
      </button>,
    );
    actions.push(
      <button
        key="update"
        onClick={onUpdate}
        className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs bg-sky-600/20 text-sky-300 hover:bg-sky-600/30 transition-colors"
        title="修改约束条件（资金/参数/滑点）后重新生成此方案"
      >
        <RefreshCw className="w-3 h-3" />
      </button>,
    );
  }
  if (!isBaseline) {
    if (branch.branchType === 'user' && (branch.status !== 'completed' || hasResult)) {
      actions.push(
        <button
          key="run"
          onClick={onRun}
          className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 transition-colors"
          title="运行推演并保存结果"
        >
          <Play className="w-3 h-3" />
          运行
        </button>,
      );
    }
    actions.push(
      <button
        key="delete"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="inline-flex items-center justify-center px-2 py-1.5 rounded-lg text-xs bg-transparent text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        title="删除该方案（不会影响真实数据）"
      >
        <Trash2 className="w-3 h-3" />
      </button>,
    );
  }

  return (
    <div
      onClick={onSelect}
      className={`group rounded-xl border p-3 cursor-pointer transition-all duration-150 ${
        selected
          ? 'border-blue-500/60 bg-blue-500/5 shadow-lg shadow-blue-500/10'
          : 'border-slate-700/60 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/70'
      }`}
    >
      {/* 首行：对比勾选 + 徽章 + 锁定 */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleCompare(); }}
          disabled={!hasResult}
          className={`shrink-0 ${hasResult ? 'text-slate-400 hover:text-blue-400' : 'text-slate-700 cursor-not-allowed'}`}
          title={hasResult ? '勾选参与对比' : '运行推演后才可参与对比'}
        >
          {compared ? <CheckSquare className="w-4 h-4 text-blue-400" /> : <Square className="w-4 h-4" />}
        </button>
        {badge}
        {isBaseline && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-slate-500/15 text-slate-400 border border-slate-500/30">
            <CircleDot className="w-2.5 h-2.5" />
            {baselinePositionOpen ? '持仓中' : '已平仓'}
          </span>
        )}
        {!isBaseline && !isPreset && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-slate-500/15 text-slate-400 border border-slate-500/30">
            <Lock className="w-2.5 h-2.5" />
            {branch.status === 'completed' ? '已保存' : '草稿'}
          </span>
        )}
      </div>

      {/* 名称 + 时效戳 */}
      <div className="mt-2">
        <div className="text-sm font-medium text-slate-200 truncate">
          {branch.branchName}
          {strategyName && <span className="text-slate-500 font-normal ml-1">（{strategyName}）</span>}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-slate-500 mt-0.5">
          <Clock className="w-2.5 h-2.5" />
          <span>
            截至 {branch.dataAsOfDate || '—'} · 运行于 {fmtTime(branch.lastRunAt)}
          </span>
        </div>
      </div>

      {headline}

      {/* 过期提示 */}
      {staleButtons.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">{staleButtons}</div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-1.5 mt-2.5">{actions}</div>
    </div>
  );
}
