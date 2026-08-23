/**
 * @file PresetDialog.tsx
 * @description 预设方案生成对话框（规格书 §5.3 + §9.1）：列出 5 套系统标准策略
 *              （均线回踩低吸 / 金字塔摊薄 / 箱体网格 / 止损止盈风控 / 环境自适应混合），
 *              可勾选多套一键生成；全局参数含「模拟资金」（默认 = 历史最高占用资金）
 *              与「滑点大小」（抖动系数，默认 0.25）；每套策略可展开微调其专属参数
 *              （周期/档数/份数等，来自 STRATEGY_GENERATORS 的 paramLabels）。
 *              生成动作直接调用 store.generatePreset（确定性派生，订单不落库）。
 * @layer UI
 * @storage_impact 通过 store.generatePreset 写 sandboxBranches 表（预设分支元数据）。
 * @author 开发团队
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useSandboxStore, suggestPresetCash } from '../../store/sandboxStore';
import { STRATEGY_GENERATORS } from '../../utils/strategyGenerators';
import type { PresetStrategyId, SandboxBranch } from '../../types/sandbox';

interface PresetDialogProps {
  open: boolean;
  /** 基线分支（提供 peakCapitalLock 作为模拟资金默认值） */
  baseline: SandboxBranch | null;
  /** 若提供，为「更新已有预设方案」模式（锁定策略，预填当前参数）；否则为「新建预设」模式 */
  preset?: SandboxBranch | null;
  onClose: () => void;
}

/**
 * 预设生成对话框组件。
 *
 * @param {PresetDialogProps} props - 见接口定义
 * @returns {JSX.Element | null} 对话框视图
 */
export default function PresetDialog({ open, baseline, preset, onClose }: PresetDialogProps) {
  const generatePreset = useSandboxStore((s) => s.generatePreset);
  const updatePreset = useSandboxStore((s) => s.updatePreset);
  const branches = useSandboxStore((s) => s.branches);
  const isUpdate = !!preset; // 更新模式
  const lockedStrategyId = preset?.presetStrategyId;
  // 已被生成的预设策略（新建设模式时置空不可再次生成；更新模式时针对锁定策略不限制）
  // 用 useMemo 稳定引用：其值仅随 branches/isUpdate/preset 变化，避免因每次渲染生成新数组
  // 而反复触发下方重置效果的依赖比对，造成 setState → 重渲染 → 新引用 → 循环的无限重渲染。
  const existingGenerated = useMemo(
    () =>
      branches
        .filter((b) => b.branchType === 'preset' && (isUpdate ? b.id !== preset!.id : true))
        .map((b) => b.presetStrategyId)
        .filter((id): id is PresetStrategyId => !!id),
    [branches, isUpdate, preset],
  );
  const [selected, setSelected] = useState<PresetStrategyId[]>(['ma20-bounce', 'pyramid', 'grid', 'stop-profit']);
  const [simulatedCash, setSimulatedCash] = useState('');
  const [jitterFactor, setJitterFactor] = useState('0.25');
  const [expanded, setExpanded] = useState<PresetStrategyId | null>(null);
  const [params, setParams] = useState<Record<string, Record<string, number>>>({});
  const [generating, setGenerating] = useState(false);

  // 每次打开时重置：新建模式默认勾选未生成策略；更新模式锁定该策略并预填当前参数
  useEffect(() => {
    if (open) {
      if (preset && preset.presetStrategyId) {
        const sid = preset.presetStrategyId;
        setSelected([sid]);
        setSimulatedCash(String(Math.round(preset.simulatedCash)));
        setJitterFactor(String(preset.jitterFactor ?? 0.25));
        setParams({ [sid]: { ...preset.presetParams } });
        setExpanded(sid);
      } else {
        setSelected(
          (['ma20-bounce', 'pyramid', 'grid', 'stop-profit'] as PresetStrategyId[]).filter(
            (id) => !existingGenerated.includes(id),
          ),
        );
        setSimulatedCash(baseline ? String(Math.round(suggestPresetCash(baseline.peakCapitalLock))) : '');
        setJitterFactor('0.25');
        setParams({});
        setExpanded(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingGenerated]);

  const defaultCash = baseline ? suggestPresetCash(baseline.peakCapitalLock) : 0;

  const toggle = (id: PresetStrategyId) => {
    if (isUpdate) return;
    // 已生成的策略允许重新勾选：勾选后再次「生成」会就地更新（覆盖）而非新建，见 handleGenerate
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const setParam = (id: PresetStrategyId, key: string, value: number) => {
    setParams((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: value } }));
  };

  const handleGenerate = async () => {
    if (selected.length === 0) return;
    setGenerating(true);
    try {
      const cash = Number(simulatedCash) > 0 ? Number(simulatedCash) : defaultCash;
      const jitter = Math.max(0, Number(jitterFactor) || 0);
      if (isUpdate && preset && preset.presetStrategyId) {
        await updatePreset(preset.id, params[preset.presetStrategyId] ?? {}, { simulatedCash: cash, jitterFactor: jitter });
      } else {
        for (const id of selected) {
          // 已存在该策略 → 就地更新（覆盖）；否则新建。使得「一键生成」既能首先生成、也能反复调整。
          const existing = branches.find((b) => b.branchType === 'preset' && b.presetStrategyId === id);
          if (existing) {
            await updatePreset(existing.id, params[id] ?? {}, { simulatedCash: cash, jitterFactor: jitter });
          } else {
            await generatePreset(id, params[id] ?? {}, { simulatedCash: cash, jitterFactor: jitter });
          }
        }
      }
      onClose();
    } finally {
      setGenerating(false);
    }
  };

  const strategyList = useMemo(() => Object.values(STRATEGY_GENERATORS), []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-slate-900 rounded-2xl border border-slate-700 p-5 w-full max-w-lg mx-4 shadow-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-violet-400" />
            {isUpdate ? '更新预设方案' : '一键生成预设方案'}
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="text-[11px] text-slate-500 mb-3">
          {isUpdate
            ? '修改约束条件后点击「更新方案」，将按新条件重新生成该策略（覆盖原有方案）。'
            : '系统根据「当前剩余可用资金 + 现有持仓成本/股数 + K 线技术形态」确定性生成。订单不会落库，可随时复制后自由调整。'}
        </div>

        {/* 全局参数 */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">
              模拟资金（预算上限 = <span className="text-amber-400 font-mono">¥{Math.round(defaultCash).toLocaleString('zh-CN')}</span>）
            </label>
            <input
              type="number"
              min={1000}
              step={1000}
              value={simulatedCash}
              onChange={(e) => setSimulatedCash(e.target.value)}
              placeholder={String(Math.round(defaultCash))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-violet-500"
            />
            <p className="text-[10px] text-slate-600 mt-0.5">默认=历史峰值（预算硬上限，1:1 对齐）；可再调高测“若当初资金更多”，或在输入框手动改</p>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">滑点大小（模拟实盘滑点误差）</label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={jitterFactor}
              onChange={(e) => setJitterFactor(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-violet-500"
            />
            <p className="text-[10px] text-slate-600 mt-0.5">默认 0.25（基准波动率 × 系数 = 成交价抖动范围），设为 0 关闭</p>
          </div>
        </div>

        {/* 策略列表：更新模式只显示被更新的策略，新建模式显示全部 */}
        <div className="space-y-2 overflow-y-auto flex-1 pr-1">
          {strategyList.filter((g) => (isUpdate ? g.id === lockedStrategyId : true)).map((g) => {
            const checked = selected.includes(g.id);
            const already = existingGenerated.includes(g.id);
            const isOpen = expanded === g.id;
            return (
              <div
                key={g.id}
                className={`rounded-xl border transition-colors ${
                  checked ? 'border-violet-500/40 bg-violet-500/5' : 'border-slate-700/60 bg-slate-800/30'
                }`}
              >
                <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer" onClick={() => toggle(g.id)}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(g.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-violet-500 w-4 h-4"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-200 font-medium">
                      {g.name}
                      {already && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-600/40 text-slate-300">已生成·可更新</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">{g.description}</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded(isOpen ? null : g.id);
                    }}
                    className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-700/50"
                    title="展开参数"
                  >
                    {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>
                {isOpen && (
                  <div className="px-10 pb-3 grid grid-cols-2 gap-2">
                    {Object.entries(g.paramLabels).map(([key, label]) => (
                      <div key={key}>
                        <label className="block text-[10px] text-slate-500 mb-0.5">{label}</label>
                        <input
                          type="number"
                          value={params[g.id]?.[key] ?? g.defaultParams[key] ?? 0}
                          onChange={(e) => setParam(g.id, key, Number(e.target.value) || 0)}
                          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-violet-500"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-2 mt-4 pt-3 border-t border-slate-700/50">
          <button onClick={onClose} className="btn btn-outline btn-sm flex-1">
            取消
          </button>
          <button
            onClick={handleGenerate}
            disabled={selected.length === 0 || generating}
            className="btn btn-sm flex-1 bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {generating ? '生成中…' : (isUpdate ? '更新方案' : `生成 ${selected.length} 套方案`)}
          </button>
        </div>
      </div>
    </div>
  );
}
