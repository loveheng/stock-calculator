/**
 * @file SandboxPlayback.tsx
 * @description 沙盘复盘主页面（规格书 §9，路由 /sandbox）：单页三态工作台。
 *  - 状态 1 未选择标的 → 空状态三步引导卡（§9.5）+ 标的选择器（搜索 + 账本快捷列表）；
 *  - 状态 2 选中单方案 → 编辑器视图：K 线图（蜡烛+成本线+买卖标记，user 分支可点线下单）
 *    + 操作时间线（可编辑/批量变换）+ 指标面板（极简 4 数字 / 专业全量，§9.4）；
 *  - 状态 3 勾选 2+ 方案 → 底部四维对比表 + 收益/风险散点图（§9.1）。
 *  另有：预设生成对话框（一键生成 5 套标准策略）、结构化拒绝行动指引对话框、
 *  未保存修改浮动栏（▶ 运行并保存 / 撤销修改，§9.6）、离开页面未保存确认、
 *  退出时 clearSandboxState。
 * @layer UI
 * @storage_impact 经 sandboxStore 读写 sandboxBranches / sandboxOrders / klineCache；
 *                 「极简/专业」模式记忆在 localStorage（key: sandbox-expert-mode）。
 * @author 开发团队
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Target,
  Sparkles,
  Play,
  Copy,
  Zap,
  RefreshCw,
  RotateCcw,
  X,
  HelpCircle,
  Lock,
  Loader,
  AlertTriangle,
  Search,
  Layers,
  History,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useSandboxStore } from '../store/sandboxStore';
import { fetchAllPositionsIncludingClosed } from '../services/ledgerService';
import { generateId } from '../store/utils';
import type { Position } from '../store/types';
import type { EngineRejection } from '../utils/sandboxEngine';
import type { KlineItem, SandboxBranch, SandboxOrder } from '../types/sandbox';
import StockAutocomplete from '../components/ui/StockAutocomplete';
import type { StockSearchItem } from '../types/stock';
import ScenarioList from '../components/sandbox/ScenarioList';
import KlineChart, { type BarClickInfo } from '../components/sandbox/KlineChart';
import OrderTimeline from '../components/sandbox/OrderTimeline';
import StrategyOverviewCard from '../components/sandbox/StrategyOverviewCard';
import MetricsPanel from '../components/sandbox/MetricsPanel';
import ComparisonTable from '../components/sandbox/ComparisonTable';
import PresetDialog from '../components/sandbox/PresetDialog';
import EmptyStateGuide, { TERMS } from '../components/sandbox/EmptyStateGuide';
import { STRATEGY_GENERATORS } from '../utils/strategyGenerators';
import { roundPrice, toLot } from '../components/sandbox/OrderTimeline';

/** 金额缩写（千分位整数） */
function fmtAmt(v: number): string {
  return Math.round(v).toLocaleString('zh-CN');
}

/**
 * 标的选择弹窗：搜索（StockAutocomplete）+ 账本持仓快捷列表（持仓中 / 已平仓）。
 */
function StockPickerModal({
  open,
  positions,
  onPick,
  onClose,
}: {
  open: boolean;
  positions: Position[];
  onPick: (fullCode: string, name: string) => void;
  onClose: () => void;
}) {
  const [keyword, setKeyword] = useState('');
  if (!open) return null;

  const filtered = keyword.trim()
    ? positions.filter(
        (p) => p.stockName.includes(keyword.trim()) || p.fullCode.includes(keyword.trim()),
      )
    : positions;
  const openList = filtered.filter((p) => !p.isClosed);
  const closedList = filtered.filter((p) => p.isClosed);

  const pick = (p: Position) => onPick(p.fullCode, p.stockName);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-slate-900 rounded-2xl border border-slate-700 p-5 w-full max-w-md mx-4 shadow-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <Target className="w-4 h-4 text-blue-400" />
            选择复盘标的
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 网络搜索 */}
        <StockAutocomplete
          value={null}
          onChange={(stock: StockSearchItem | null) => {
            if (stock) onPick(stock.fullCode, stock.Name);
          }}
          placeholder="搜索任意股票（代码/名称/拼音）..."
        />

        {/* 账本快捷列表 */}
        <div className="mt-4 flex-1 overflow-y-auto">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mb-1.5">
            <Search className="w-3 h-3" />
            从账本选择
          </div>
          <div className="relative mb-2">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="筛选账本中的股票..."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          {openList.length > 0 && (
            <>
              <div className="text-[10px] text-slate-600 mb-1">持仓中</div>
              {openList.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pick(p)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-800 text-left transition-colors"
                >
                  <span className="text-sm text-slate-200">
                    {p.stockName} <span className="text-slate-500 text-xs ml-1">{p.fullCode}</span>
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    成本 ¥{p.currentCost.toFixed(2)} × {p.currentAmount}股
                  </span>
                </button>
              ))}
            </>
          )}
          {closedList.length > 0 && (
            <>
              <div className="text-[10px] text-slate-600 mb-1 mt-2">已平仓（可复盘历史操作）</div>
              {closedList.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pick(p)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-800 text-left transition-colors"
                >
                  <span className="text-sm text-slate-200">
                    {p.stockName} <span className="text-slate-500 text-xs ml-1">{p.fullCode}</span>
                  </span>
                  <span className="text-xs text-slate-500">已平仓{p.realizedPnL !== undefined ? ` · 盈亏 ${fmtAmt(p.realizedPnL)}` : ''}</span>
                </button>
              ))}
            </>
          )}
          {filtered.length === 0 && <div className="text-center text-xs text-slate-500 py-6">账本中暂无匹配的股票</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * 点击 K 线下单面板（§9.2-①）：价格 = 当日收盘（可切 高/低/收），数量步进 100。
 */
function OrderPanelModal({
  bar,
  jitterFactor,
  onConfirm,
  onClose,
}: {
  bar: BarClickInfo;
  jitterFactor: number;
  onConfirm: (action: 'buy' | 'sell', price: number, quantity: number) => void;
  onClose: () => void;
}) {
  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [priceMode, setPriceMode] = useState<'close' | 'high' | 'low'>('close');
  const [quantity, setQuantity] = useState(100);

  const price = priceMode === 'high' ? bar.item.high : priceMode === 'low' ? bar.item.low : bar.item.close;
  const amount = price * quantity;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-slate-900 rounded-2xl border border-slate-700 p-5 w-full max-w-sm mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-100">
            在 {bar.item.date} 添加操作
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 方向 */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            onClick={() => setAction('buy')}
            className={`py-2 rounded-lg text-sm font-medium border transition-colors ${
              action === 'buy'
                ? 'bg-red-500/15 text-red-400 border-red-500/40'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
            }`}
          >
            <TrendingUp className="inline w-3.5 h-3.5 mr-1" />买入
          </button>
          <button
            onClick={() => setAction('sell')}
            className={`py-2 rounded-lg text-sm font-medium border transition-colors ${
              action === 'sell'
                ? 'bg-green-500/15 text-green-400 border-green-500/40'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
            }`}
          >
            <TrendingDown className="inline w-3.5 h-3.5 mr-1" />卖出
          </button>
        </div>

        {/* 价格 */}
        <div className="mb-3">
          <label className="block text-[11px] text-slate-500 mb-1">期望价（可在当天 K 线范围内切换）</label>
          <div className="flex gap-1.5 mb-1.5">
            {(['close', 'high', 'low'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setPriceMode(m)}
                className={`flex-1 py-1.5 rounded-lg text-xs border transition-colors ${
                  priceMode === m
                    ? 'bg-blue-500/15 text-blue-400 border-blue-500/40'
                    : 'bg-slate-800 text-slate-400 border-slate-700'
                }`}
              >
                {m === 'close' ? '收盘' : m === 'high' ? '最高' : '最低'}
              </button>
            ))}
          </div>
          <input
            type="number"
            step={0.01}
            value={price}
            onChange={() => {}}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:border-blue-500"
            readOnly
          />
        </div>

        {/* 数量 */}
        <div className="mb-3">
          <label className="block text-[11px] text-slate-500 mb-1">数量（股，100 整数倍）</label>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setQuantity(Math.max(100, quantity - 100))}
              className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700"
            >
              −
            </button>
            <input
              type="number"
              step={100}
              min={100}
              value={quantity}
              onChange={(e) => setQuantity(toLot(Number(e.target.value) || 0))}
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm font-mono text-slate-200 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => setQuantity(quantity + 100)}
              className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700"
            >
              +
            </button>
          </div>
        </div>

        {/* 预估 */}
        <div className="bg-slate-800/60 rounded-lg px-3 py-2 mb-3 flex items-center justify-between text-xs">
          <span className="text-slate-500">预估成交额</span>
          <span className="font-mono text-slate-200">¥{fmtAmt(amount)}</span>
        </div>
        {jitterFactor > 0 && (
          <p className="text-[10px] text-slate-500 mb-3">
            💡 推演时实际成交价会在当天 K 线范围内按滑点抖动（期望价 → 模拟实际滑点价），可去顶部把滑点设为 0 关闭。
          </p>
        )}

        <button
          onClick={() => onConfirm(action, price, quantity)}
          className={`w-full py-2.5 rounded-lg text-sm font-medium text-white transition-colors ${
            action === 'buy' ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'
          }`}
        >
          插入这笔{action === 'buy' ? '买入' : '卖出'}
        </button>
      </div>
    </div>
  );
}

/**
 * 结构化拒绝行动指引对话框（§4.1.1 + 认知降维四原则）：
 * 展示白话原因 + 可执行补救按钮；user 分支直接改单，preset/baseline 引导复制后调整。
 */
function RejectionDialog({
  rejections,
  branch,
  branchType,
  onAction,
  onClose,
}: {
  rejections: EngineRejection[];
  branch: SandboxBranch | null;
  branchType: 'baseline' | 'preset' | 'user';
  onAction: (rej: EngineRejection, act: EngineRejection['actions'][number]) => void;
  onClose: () => void;
}) {
  if (rejections.length === 0) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 rounded-2xl border border-slate-700 p-5 w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          <h3 className="text-base font-semibold text-slate-100">这笔操作被推演引擎拦下了</h3>
        </div>
        <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
          {rejections.map((rej, i) => (
            <div key={`${rej.orderId}-${i}`} className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-3">
              <p className="text-xs text-slate-300 leading-relaxed">{rej.message}</p>
              {branchType === 'user' ? (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {rej.actions.map((act, j) => (
                    <button
                      key={j}
                      onClick={() => onAction(rej, act)}
                      className="text-[11px] px-2.5 py-1.5 rounded-lg bg-blue-500/15 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 transition-colors"
                    >
                      {act.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <button
                    onClick={() => onAction(rej, { label: '复制并微调', kind: 'cancel' })}
                    className="text-[11px] px-2.5 py-1.5 rounded-lg bg-violet-500/15 text-violet-300 hover:bg-violet-500/30 border border-violet-500/30 transition-colors"
                  >
                    <Copy className="inline w-3 h-3 mr-1" />
                    复制并微调后再调整
                  </button>
                </div>
              )}
            </div>
          ))}
          {branch && branchType !== 'user' && (
            <p className="text-[10px] text-slate-500">
              当前方案是{branchType === 'preset' ? '系统标准策略基准' : '真实操作基线'}（只读），复制后才能调整买卖点。
            </p>
          )}
        </div>
        <button onClick={onClose} className="btn btn-outline btn-sm btn-block mt-4">
          知道了
        </button>
      </div>
    </div>
  );
}

/**
 * 沙盘复盘主页面组件。
 *
 * @returns {JSX.Element} 页面视图
 */
export default function SandboxPlayback() {
  // ---- 响应式状态 ----
  const branches = useSandboxStore((s) => s.branches);
  const selectedBranchId = useSandboxStore((s) => s.selectedBranchId);
  const comparedBranchIds = useSandboxStore((s) => s.comparedBranchIds);
  const activeComputed = useSandboxStore((s) => s.activeComputed);
  const dirtyBranchIds = useSandboxStore((s) => s.dirtyBranchIds);
  const kline = useSandboxStore((s) => s.kline);
  const klineFullCode = useSandboxStore((s) => s.klineFullCode);
  const klineLoading = useSandboxStore((s) => s.klineLoading);
  const klineError = useSandboxStore((s) => s.klineError);

  // ---- actions ----
  const selectStock = useSandboxStore((s) => s.selectStock);
  const selectBranch = useSandboxStore((s) => s.selectBranch);
  const toggleCompare = useSandboxStore((s) => s.toggleCompare);
  const setSimulatedCash = useSandboxStore((s) => s.setSimulatedCash);
  const raiseCashToRequired = useSandboxStore((s) => s.raiseCashToRequired);
  const adjustOrderQty = useSandboxStore((s) => s.adjustOrderQty);
  const scaleAllBuyOrders = useSandboxStore((s) => s.scaleAllBuyOrders);
  const copyBranch = useSandboxStore((s) => s.copyBranch);
  const deleteBranch = useSandboxStore((s) => s.deleteBranch);
  const updateUserOrders = useSandboxStore((s) => s.updateUserOrders);
  const discardChanges = useSandboxStore((s) => s.discardChanges);
  const runSimulation = useSandboxStore((s) => s.runSimulation);
  const rescalePreset = useSandboxStore((s) => s.rescalePreset);
  const rebuildBaseline = useSandboxStore((s) => s.rebuildBaseline);
  const refreshKline = useSandboxStore((s) => s.refreshKline);
  const getComputed = useSandboxStore((s) => s.getComputed);
  const staleFlagsFor = useSandboxStore((s) => s.staleFlagsFor);
  const clearSandboxState = useSandboxStore((s) => s.clearSandboxState);

  // ---- 本地状态 ----
  const [expertMode, setExpertMode] = useState(() => localStorage.getItem('sandbox-expert-mode') === '1');
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetTarget, setPresetTarget] = useState<SandboxBranch | null>(null); // 更新预设目标
  const [pickerOpen, setPickerOpen] = useState(false);
  const [orderPanel, setOrderPanel] = useState<BarClickInfo | null>(null);
  const [quickPositions, setQuickPositions] = useState<Position[]>([]);
  // 模拟资金草稿（null = 未在编辑，直接显示分支值）
  const [cashDraft, setCashDraft] = useState<string | null>(null);
  // 拒绝对话框：可手动关闭，拒绝清空后自动复位
  const [rejDismissed, setRejDismissed] = useState(false);
  // 帮助弹窗（白话术语对照）
  const [helpOpen, setHelpOpen] = useState(false);

  const appPositions = useAppStore((s) => s.positions);

  // ---- 派生 ----
  const selectedBranch = branches.find((b) => b.id === selectedBranchId) ?? null;
  const baselineBranch = branches.find((b) => b.branchType === 'baseline') ?? null;
  const baselineOrders = useMemo(() => {
    if (!baselineBranch) return [];
    return getComputed(baselineBranch.id)?.orders ?? [];
  }, [baselineBranch, branches, getComputed]);
  const stale = selectedBranch ? staleFlagsFor(selectedBranch.id) : null;
  const rejections = activeComputed?.rejections ?? [];

  // 策略运行总体概览（仅 preset 且有候选标识时组装；空时间线处展示画像）
  const strategyOverview = useMemo(() => {
    if (!selectedBranch) return null;
    const sid = selectedBranch.presetStrategyId;
    if (!sid) return null;
    const g = STRATEGY_GENERATORS[sid];
    if (!g) return null;
    const params = g.paramLabels && selectedBranch.presetParams
      ? Object.entries(g.paramLabels)
          .filter(([k]) => selectedBranch.presetParams?.[k] != null)
          .map(([k, label]) => ({ label, value: String(selectedBranch.presetParams?.[k]) }))
      : [];
    return {
      name: g.name,
      description: g.description,
      params,
      simulatedCash: selectedBranch.simulatedCash,
      peakCapitalLock: selectedBranch.peakCapitalLock,
    };
  }, [selectedBranch]);

  // ---- 挂载时加载账本持仓（快捷选择） ----
  useEffect(() => {
    (async () => {
      try {
        const all = await fetchAllPositionsIncludingClosed();
        setQuickPositions(all);
      } catch {
        setQuickPositions([]);
      }
    })();
  }, []);

  // ---- 极简/专业模式记忆 ----
  useEffect(() => {
    localStorage.setItem('sandbox-expert-mode', expertMode ? '1' : '0');
  }, [expertMode]);

  // ---- 拒绝对话框复位：换分支或拒绝清空后重新展示 ----
  useEffect(() => {
    setRejDismissed(false);
  }, [selectedBranchId]);
  useEffect(() => {
    if (rejections.length === 0) setRejDismissed(false);
  }, [rejections.length]);

  // ---- 离开页面未保存确认 + 退出清理 ----
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useSandboxStore.getState().dirtyBranchIds.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => () => clearSandboxState(), [clearSandboxState]);

  // ---- 标的选择 ----
  const handlePickStock = useCallback(
    async (fullCode: string, name: string) => {
      setPickerOpen(false);
      setOrderPanel(null);
      try {
        await selectStock(fullCode, name);
      } catch {
        // klineError 由 store 呈现
      }
    },
    [selectStock],
  );

  // ---- 分支操作包装 ----
  const handleCopy = useCallback((id: string) => { void copyBranch(id); }, [copyBranch]);
  const handleRun = useCallback((id: string) => { void runSimulation(id); }, [runSimulation]);
  const handleDelete = useCallback(
    (id: string) => {
      if (window.confirm('确定删除该方案？（不影响你的真实数据）')) void deleteBranch(id);
    },
    [deleteBranch],
  );
  const handleRescale = useCallback((id: string) => { void rescalePreset(id); }, [rescalePreset]);
  const handleRebuild = useCallback((id: string) => { void rebuildBaseline(id); }, [rebuildBaseline]);
  const handleRefreshKline = useCallback(() => { void refreshKline(); }, [refreshKline]);

  /** 更新预设方案：打开更新模式对话框 */
  const handleUpdatePreset = useCallback((branchId: string) => {
    const branch = branches.find((b) => b.id === branchId);
    if (branch) {
      setPresetTarget(branch);
      setPresetOpen(true);
    }
  }, [branches]);

  // ---- 模拟资金输入（失焦提交） ----
  const commitCash = () => {
    if (!selectedBranch || selectedBranch.branchType === 'baseline') return;
    const v = Number(cashDraft);
    if (v > 0) setSimulatedCash(selectedBranch.id, v);
    setCashDraft(null);
  };

  // ---- 时间线编辑（user 分支草稿） ----
  const handleOrdersChange = useCallback(
    (orders: SandboxOrder[]) => {
      if (selectedBranchId && selectedBranch?.branchType === 'user') {
        updateUserOrders(selectedBranchId, orders);
      }
    },
    [selectedBranchId, selectedBranch?.branchType, updateUserOrders],
  );

  // ---- 点击 K 线下单（user 分支） ----
  const handleBarClick = (info: BarClickInfo) => {
    if (selectedBranch?.branchType === 'user') setOrderPanel(info);
  };

  const handleAddOrder = (action: 'buy' | 'sell', price: number, quantity: number) => {
    if (!selectedBranch || !orderPanel) return;
    const orders = activeComputed?.orders ?? [];
    const newOrder: SandboxOrder = {
      id: generateId(),
      branchId: selectedBranch.id,
      seqIndex: orders.length,
      action,
      timestamp: `${orderPanel.item.date}T09:30:00+08:00`,
      price: roundPrice(price),
      quantity,
      note: '手动添加',
    };
    updateUserOrders(selectedBranch.id, [...orders, newOrder]);
    setOrderPanel(null);
  };

  // ---- 拒绝行动执行 ----
  const handleRejectionAction = async (rej: EngineRejection, act: EngineRejection['actions'][number]) => {
    if (!selectedBranch) return;
    if (selectedBranch.branchType !== 'user') {
      if (act.kind === 'cancel') await copyBranch(selectedBranch.id);
      return;
    }
    const orders = activeComputed?.orders ?? [];
    switch (act.kind) {
      case 'reduce-qty': {
        const maxQty = act.payload?.maxQty ?? 0;
        if (maxQty > 0) {
          updateUserOrders(
            selectedBranch.id,
            orders.map((o) => (o.id === rej.orderId ? { ...o, quantity: maxQty } : o)),
          );
        }
        break;
      }
      case 'move-date': {
        const ts = act.payload?.targetTimestamp;
        if (ts) {
          updateUserOrders(
            selectedBranch.id,
            orders.map((o) => (o.id === rej.orderId ? { ...o, timestamp: new Date(ts).toISOString() } : o)),
          );
        }
        break;
      }
      case 'raise-cash': {
        const shortfall = act.payload?.shortfall ?? 0;
        if (shortfall > 0) setSimulatedCash(selectedBranch.id, selectedBranch.simulatedCash + shortfall);
        break;
      }
      case 'insert-sell':
      case 'insert-buy': {
        const target = orders.find((o) => o.id === rej.orderId);
        const day = target?.timestamp.slice(0, 10);
        const bar = day ? kline.find((k) => k.date === day) : undefined;
        const date = day ?? kline[kline.length - 1]?.date ?? '';
        const price = bar ? bar.close : target?.price ?? 0;
        const newOrder: SandboxOrder = {
          id: generateId(),
          branchId: selectedBranch.id,
          seqIndex: orders.length,
          action: act.kind === 'insert-sell' ? 'sell' : 'buy',
          timestamp: `${date}T09:30:00+08:00`,
          price: roundPrice(price),
          quantity: 100,
          note: '系统建议（可调整）',
        };
        updateUserOrders(selectedBranch.id, [...orders, newOrder]);
        break;
      }
      case 'cancel':
        break;
    }
  };

  // ---- 编辑器头部 ----
  const editorHeader = selectedBranch ? (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          {selectedBranch.branchName}
          {selectedBranch.branchType === 'baseline' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">⚡ 真实操作 · 只读</span>
          )}
          {selectedBranch.branchType === 'preset' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/30">[预设]</span>
          )}
          {selectedBranch.branchType === 'user' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30">
              {selectedBranch.parentPresetId ? '[预设副本]' : '[我的方案]'}
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          数据截至 {selectedBranch.dataAsOfDate || '—'} · 滑点 {selectedBranch.jitterFactor}（模拟实盘滑点误差）
        </div>
      </div>

      {/* 模拟资金（基线锁定） */}
      <div className="ml-auto flex items-center gap-1.5" title="这是推演用的假设资金（非你的真实资金）。默认=历史最高占用资金。调高可测试“如果当初资金更多”的场景。">
        <span className="text-[11px] text-slate-500">模拟资金</span>
        {selectedBranch.branchType === 'baseline' ? (
          <span className="flex items-center gap-1 text-sm font-mono text-slate-300">
            ¥{fmtAmt(selectedBranch.peakCapitalLock)}
            <Lock className="w-3 h-3 text-slate-600" />
          </span>
        ) : (
          <input
            type="number"
            min={1000}
            step={1000}
            value={cashDraft ?? String(Math.round(selectedBranch.simulatedCash))}
            onChange={(e) => setCashDraft(e.target.value)}
            onBlur={commitCash}
            onFocus={() => setCashDraft(String(Math.round(selectedBranch.simulatedCash)))}
            className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-sm font-mono text-slate-200 focus:outline-none focus:border-blue-500"
          />
        )}
        <span className="text-[10px] text-slate-600">上限 ¥{fmtAmt(selectedBranch.peakCapitalLock)}</span>
      </div>

      {/* 过期操作 */}
      <div className="flex items-center gap-1.5">
        {stale?.kline && (
          <button onClick={handleRefreshKline} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25" title="行情已更新，点击用最新 K 线重新推演">
            <AlertTriangle className="w-3 h-3" />K线有更新·刷新
          </button>
        )}
        {stale?.cash && selectedBranch.branchType === 'preset' && (
          <button onClick={() => handleRescale(selectedBranch.id)} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-sky-500/15 text-sky-400 hover:bg-sky-500/25" title="按最新模拟资金重算股数（价格点位不变）">
            <Zap className="w-3 h-3" />资金已变·重配
          </button>
        )}
        {stale?.baseline && (
          <button onClick={() => handleRebuild(selectedBranch.id)} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-orange-500/15 text-orange-400 hover:bg-orange-500/25" title="真实持仓批次已变化，点击重建基线并重跑">
            <RefreshCw className="w-3 h-3" />基线已变·重建
          </button>
        )}
        {selectedBranch.branchType !== 'user' && (
          <button onClick={() => handleCopy(selectedBranch.id)} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-violet-500/15 text-violet-300 hover:bg-violet-500/30">
            <Copy className="w-3 h-3" />复制并微调
          </button>
        )}
        {selectedBranch.branchType === 'user' && (
          <>
            {activeComputed?.result && (
              <button onClick={() => handleRun(selectedBranch.id)} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/30">
                <Play className="w-3 h-3" />运行并保存
              </button>
            )}
            <button onClick={() => handleDelete(selectedBranch.id)} className="text-[11px] px-2 py-1 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10">
              删除
            </button>
          </>
        )}
      </div>
    </div>
  ) : null;

  // ---- 主工作区 ----
  let mainArea: React.ReactNode;
  if (!klineFullCode) {
    mainArea = (
      <EmptyStateGuide
        onEnter={() => setPickerOpen(true)}
      />
    );
  } else if (klineLoading) {
    mainArea = (
      <div className="flex items-center justify-center py-20 text-slate-500 text-sm">
        <Loader className="w-4 h-4 mr-2 animate-spin" />
        正在加载前复权 K 线…
      </div>
    );
  } else if (!selectedBranch) {
    mainArea = (
      <div className="flex flex-col items-center justify-center py-20 text-slate-500 text-sm space-y-3">
        <History className="w-8 h-8 text-slate-700" />
        <p>从左侧选择一个方案查看，或点击右上角「✨ 生成预设方案」</p>
        <button onClick={() => setPresetOpen(true)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-violet-600/20 text-violet-300 hover:bg-violet-600/35 border border-violet-500/30 text-xs">
          <Sparkles className="w-3.5 h-3.5" />生成预设方案
        </button>
      </div>
    );
  } else {
    const orders = activeComputed?.orders ?? [];
    const snapshots = activeComputed?.result?.snapshots ?? null;
    mainArea = (
      <div className="space-y-4">
        {editorHeader}
        {klineError && (
          <div className="text-[11px] text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">{klineError}</div>
        )}
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-3">
          <KlineChart
            kline={kline}
            orders={orders}
            snapshots={snapshots}
            branchType={selectedBranch.branchType}
            onBarClick={selectedBranch.branchType === 'user' ? handleBarClick : undefined}
          />
        </div>
        {selectedBranch.branchType === 'preset' && strategyOverview && (
          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-slate-300 mb-3">策略操作概览</h3>
            <StrategyOverviewCard
              overview={strategyOverview}
              inactivityReason={activeComputed?.inactivityReason}
              tradeCount={activeComputed?.generatedOrdersCount ?? 0}
            />
          </div>
        )}
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">操作时间线（{orders.length} 笔）</h3>
          <OrderTimeline
            branchType={selectedBranch.branchType}
            orders={orders}
            baselineOrders={baselineOrders}
            kline={kline}
            asOfDate={activeComputed?.asOfDate}
            inactivityReason={activeComputed?.inactivityReason}
            generatedOrdersCount={activeComputed?.generatedOrdersCount ?? 0}
            strategyBudgetExhausted={activeComputed?.strategyBudgetExhausted ?? false}
            onAddOrder={selectedBranch.branchType === 'user' ? () => {
              const last = kline[kline.length - 1];
              if (last) setOrderPanel({ barIndex: kline.length - 1, item: last });
            } : undefined}
            onChange={handleOrdersChange}
            result={activeComputed?.result ?? undefined}
          />
        </div>
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">
            推演指标
            <button
              onClick={() => setExpertMode(!expertMode)}
              className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-400 hover:bg-slate-700"
            >
              <Layers className="inline w-2.5 h-2.5 mr-0.5" />
              {expertMode ? '专业模式' : '极简模式'}
            </button>
          </h3>
          <MetricsPanel branch={selectedBranch} result={activeComputed?.result ?? null} warnings={activeComputed?.warnings ?? []} expertMode={expertMode} />
        </div>
      </div>
    );
  }

  // ---- 未保存浮动栏（§9.6） ----
  const dirtyBranches = branches.filter((b) => dirtyBranchIds.includes(b.id));
  const dirtyBar = dirtyBranches.length > 0 ? (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-slate-800 border border-amber-500/40 rounded-xl shadow-2xl px-4 py-2.5 flex items-center gap-3 max-w-[92vw] flex-wrap justify-center">
      <span className="text-xs text-amber-400 flex items-center gap-1">
        <AlertTriangle className="w-3.5 h-3.5" />
        检测到 {dirtyBranches.length} 处修改未保存
      </span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => dirtyBranches.forEach((b) => void runSimulation(b.id))}
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500"
        >
          <Play className="w-3 h-3" />▶ 运行并保存推演
        </button>
        <button
          onClick={() => dirtyBranches.forEach((b) => void discardChanges(b.id))}
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600"
        >
          <RotateCcw className="w-3 h-3" />撤销修改
        </button>
      </div>
    </div>
  ) : null;

  // ---- 对比分支（勾选 ≥2 展示底部对比） ----
  const comparedBranches = comparedBranchIds
    .map((id) => branches.find((b) => b.id === id))
    .filter((b): b is SandboxBranch => !!b);

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部操作栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 hover:border-blue-500/50 transition-colors"
        >
          <Target className="w-4 h-4 text-blue-400" />
          {klineFullCode ? (
            <span className="font-medium">{selectedBranch?.stockName ?? klineFullCode}</span>
          ) : (
            <span>选择复盘标的</span>
          )}
        </button>
        <div className="flex-1" />
        <button
          onClick={() => { setPresetTarget(null); setPresetOpen(true); }}
          disabled={!klineFullCode || !baselineBranch}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-violet-600/20 text-violet-300 hover:bg-violet-600/35 border border-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          生成预设方案
        </button>
        <button
          onClick={() => setExpertMode(!expertMode)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-slate-800 border border-slate-700 text-slate-300 hover:border-slate-600 transition-colors"
          title="切换「极简新手模式 / 专业模式」（记忆在本地）"
        >
          <Layers className="w-4 h-4" />
          {expertMode ? '专业' : '极简'}
        </button>
        <button
          onClick={() => setHelpOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-slate-800 border border-slate-700 text-slate-300 hover:border-slate-600 transition-colors"
          title="帮助：白话术语对照"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>

      {/* 主体：方案列表 + 主工作区 */}
      <div className="flex flex-col md:flex-row gap-4">
        <ScenarioList
          branches={branches}
          selectedBranchId={selectedBranchId}
          comparedBranchIds={comparedBranchIds}
          positions={[...appPositions, ...quickPositions.filter((p) => !appPositions.some((a) => a.id === p.id))]}
          onSelect={(id) => selectBranch(id)}
          onToggleCompare={(id) => toggleCompare(id)}
          onGeneratePreset={() => { setPresetTarget(null); setPresetOpen(true); }}
          onCopy={handleCopy}
          onRun={handleRun}
          onDelete={handleDelete}
          onRescale={handleRescale}
          onRebuild={handleRebuild}
          onRefreshKline={handleRefreshKline}
          onUpdate={handleUpdatePreset}
        />
        <main className="flex-1 min-w-0">{mainArea}</main>
      </div>

      {/* 底部对比表（勾选 ≥2 展示） */}
      {comparedBranches.length >= 2 && (
        <ComparisonTable
          branches={comparedBranches}
          getComputed={getComputed}
          onSelectBranch={(id) => selectBranch(id)}
        />
      )}

      {dirtyBar}

      {/* 弹窗 */}
      <PresetDialog
        open={presetOpen}
        baseline={baselineBranch}
        preset={presetTarget}
        onClose={() => { setPresetOpen(false); setPresetTarget(null); }}
      />
      <StockPickerModal
        open={pickerOpen}
        positions={quickPositions}
        onPick={(code, name) => void handlePickStock(code, name)}
        onClose={() => setPickerOpen(false)}
      />
      {orderPanel && selectedBranch && (
        <OrderPanelModal
          bar={orderPanel}
          jitterFactor={selectedBranch.jitterFactor}
          onConfirm={(action, price, qty) => handleAddOrder(action, price, qty)}
          onClose={() => setOrderPanel(null)}
        />
      )}
      <RejectionDialog
        rejections={rejDismissed ? [] : rejections}
        branch={selectedBranch}
        branchType={selectedBranch?.branchType ?? 'baseline'}
        onAction={(rej, act) => void handleRejectionAction(rej, act)}
        onClose={() => setRejDismissed(true)}
      />

      {/* 帮助弹窗（白话术语对照） */}
      {helpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setHelpOpen(false)}>
          <div
            className="bg-slate-900 rounded-2xl border border-slate-700 p-5 w-full max-w-md mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-blue-400" />
                白话术语对照
              </h3>
              <button onClick={() => setHelpOpen(false)} className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {TERMS.map(([term, desc]) => (
                <p key={term} className="text-xs text-slate-400 leading-relaxed">
                  <b className="text-slate-200">{term}</b>：{desc}
                </p>
              ))}
              <p className="text-[10px] text-slate-600 pt-2 border-t border-slate-700/50">
                💡 系统方案只读，复制后才能改——这是为了让你随时有一个「官方标准答案」对照；改乱了删掉重新复制一份即可。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
