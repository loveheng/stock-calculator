/**
 * @file ScenarioList.tsx
 * @description 沙盘方案列表（规格书 §9.1 左侧 280px 面板）：按三态分组渲染
 *              「⚡ 真实操作（只读）→ ✨ 预设方案 → 我的方案」，组头提供
 *              「✨ 生成预设方案」与「＋ 新建演练」（从真实操作复制）入口；
 *              每张卡片由 ScenarioCard 渲染，对比勾选/选中态由父级传入。
 *
 * 【非响应式取值说明】computed / stale 来自 store 的 getComputed / staleFlagsFor
 *   （非响应式 getter），依赖父级在 branches / selectedBranchId / comparedBranchIds
 *   等响应式变化时触发的重渲染来取到新鲜值——store 的 action 总是先算 memo 再 set
 *   响应式状态，因此渲染期读取即为最新（规格书 §6.3）。
 * @layer UI
 * @storage_impact 纯展示组件；动作全部回调父级（父级调用 sandboxStore 对应 action）。
 * @author 开发团队
 */

import React from 'react';
import { Sparkles, Plus, Zap } from 'lucide-react';
import type { Position } from '../../store/types';
import type { SandboxBranch } from '../../types/sandbox';
import { useSandboxStore } from '../../store/sandboxStore';
import ScenarioCard from './ScenarioCard';

interface ScenarioListProps {
  branches: SandboxBranch[];
  selectedBranchId: string | null;
  comparedBranchIds: string[];
  /** 真实持仓（用于基线卡「持仓中/已平仓」标记） */
  positions: Position[];
  onSelect: (branchId: string) => void;
  onToggleCompare: (branchId: string) => void;
  onGeneratePreset: () => void;
  onCopy: (branchId: string) => void;
  onRun: (branchId: string) => void;
  onDelete: (branchId: string) => void;
  onRescale: (branchId: string) => void;
  onRebuild: (branchId: string) => void;
  onRefreshKline: () => void;
  /** 更新预设方案 */
  onUpdate?: (branchId: string) => void;
}

/** 分组标题 */
function GroupHeader({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1 pt-4 pb-1.5">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
        {icon}
        {title}
      </span>
      {action}
    </div>
  );
}

/**
 * 方案列表组件。
 *
 * @param {ScenarioListProps} props - 见接口定义
 * @returns {JSX.Element} 分组列表视图
 */
export default function ScenarioList({
  branches,
  selectedBranchId,
  comparedBranchIds,
  positions,
  onSelect,
  onToggleCompare,
  onGeneratePreset,
  onCopy,
  onRun,
  onDelete,
  onRescale,
  onRebuild,
  onRefreshKline,
  onUpdate,
}: ScenarioListProps) {
  const getComputed = useSandboxStore((s) => s.getComputed);
  const staleFlagsFor = useSandboxStore((s) => s.staleFlagsFor);

  const baseline = branches.filter((b) => b.branchType === 'baseline');
  const presets = branches
    .filter((b) => b.branchType === 'preset')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const users = branches
    .filter((b) => b.branchType === 'user')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const renderCard = (branch: SandboxBranch) => {
    const pos = branch.baselinePositionId ? positions.find((p) => p.id === branch.baselinePositionId) : undefined;
    return (
      <ScenarioCard
        key={branch.id}
        branch={branch}
        computed={getComputed(branch.id)}
        stale={staleFlagsFor(branch.id)}
        selected={selectedBranchId === branch.id}
        compared={comparedBranchIds.includes(branch.id)}
        baselinePositionOpen={pos ? !pos.isClosed : false}
        onSelect={() => onSelect(branch.id)}
        onToggleCompare={() => onToggleCompare(branch.id)}
        onCopy={() => onCopy(branch.id)}
        onRun={() => onRun(branch.id)}
        onDelete={() => onDelete(branch.id)}
        onRescale={() => onRescale(branch.id)}
        onRebuild={() => onRebuild(branch.id)}
        onRefreshKline={onRefreshKline}
        onUpdate={onUpdate ? () => onUpdate(branch.id) : undefined}
      />
    );
  };

  const empty = branches.length === 0;

  return (
    <aside className="w-full md:w-[280px] shrink-0 flex flex-col max-h-[calc(100vh-120px)]">
      <div className="flex items-center justify-between px-1 pt-1 pb-2">
        <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-1.5">
          <Zap className="w-4 h-4 text-amber-400" />
          方案列表
        </h3>
        {!empty && (
          <button
            onClick={onGeneratePreset}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-violet-600/20 text-violet-300 hover:bg-violet-600/35 border border-violet-500/30 transition-colors"
            title="根据当前资金与 K 线形态，一键生成 5 套标准策略方案"
          >
            <Sparkles className="w-3.5 h-3.5" />
            生成预设方案
          </button>
        )}
      </div>

      <div className="overflow-y-auto pr-1 space-y-1 flex-1">
        {empty && (
          <div className="px-1 py-8 text-center text-xs text-slate-500 leading-relaxed">
            还没有方案。
            <br />
            选择一只股票后，系统会
            <br />
            自动生成你的真实操作基线。
          </div>
        )}

        {baseline.length > 0 && (
          <>
            <GroupHeader icon={<Zap className="w-3 h-3 text-amber-400" />} title="真实操作（只读）" />
            {baseline.map(renderCard)}
          </>
        )}

        {presets.length > 0 && (
          <>
            <GroupHeader
              icon={<Sparkles className="w-3 h-3 text-violet-400" />}
              title="预设方案"
              action={
                <button
                  onClick={onGeneratePreset}
                  className="inline-flex items-center gap-0.5 text-[10px] text-violet-400 hover:text-violet-300 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  生成
                </button>
              }
            />
            {presets.map(renderCard)}
          </>
        )}

        {users.length > 0 && (
          <>
            <GroupHeader
              icon={<Plus className="w-3 h-3 text-blue-400" />}
              title="我的方案"
              action={
                baseline.length > 0 ? (
                  <button
                    onClick={() => onCopy(baseline[0].id)}
                    className="inline-flex items-center gap-0.5 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                    title="从真实操作复制一份，作为新的演练起点"
                  >
                    <Plus className="w-3 h-3" />
                    新建演练
                  </button>
                ) : undefined
              }
            />
            {users.map(renderCard)}
          </>
        )}
      </div>
    </aside>
  );
}
