/**
 * @file CostAveraging.tsx
 * @description 成本分摊与持仓管理：Tab1 多批次建仓实盘账本 —— 建仓/加仓/减仓/结仓
 *              全生命周期、批次成本计算（含规费）、重复建仓拦截、清仓自动结仓归档；
 *              Tab2 目标成本推算 —— 输入现持仓成本/数量与目标均价，反推需补仓的数量与金额。
 *              现价展示接入腾讯实时行情：交易时段每 5 秒刷新，非交易时段打开时刷新一次。
 * @layer UI
 * @storage_impact 读写 positions、batches 表（addPosition/addBatch/closePosition/
 *                 updatePosition/deletePositionBatch/removePosition）；读取 settings 费率。
 * @author 开发团队
 */

import React, { useState } from 'react';
import { Plus, X, Archive, ChevronDown, ChevronUp, CheckCircle, Trash2 } from 'lucide-react';
import { useAppStore } from '../store';
import { calcTargetCostAveraging, isValidLotSize, calcTradeFees, matchSecurityKind } from '../utils/mathUtils';
import { recomputePositionSnapshot, getCloseBlockReason, useStreamResults } from '../store';
import { recalculatePosition } from '../utils/calculator';
import type { Position, PositionBatch } from '../store';
import type { PositionBatchEntity } from '../db/schema';
import type { StockSearchItem } from '../types/stock';
import ConfirmModal from '../components/ui/ConfirmModal';
import StockAutocomplete from '../components/ui/StockAutocomplete';
import { useLiveQuotes } from '../hooks/useLiveQuotes';

/**
 * 加/减仓表单弹窗组件。
 *
 * @description 弹出式表单：输入单价/数量/备注，内置校验
 *              （加仓需 100 整数倍；减仓不可超过当前持仓且需 100 整数倍），
 *              校验通过后回调 onConfirm(price, amount, note)。
 * @param {{ open: boolean; title: string; position: Position; onConfirm: (price, amount, note) => void; onCancel: () => void }} props
 *  - open: 是否显示弹窗
 *  - title: 弹窗标题（含「减仓」字样时启用减仓校验与文案）
 *  - position: 目标持仓（用于减仓上限校验）
 *  - onConfirm: 确认回调（参数为价格/数量/备注）
 *  - onCancel: 取消回调
 * @returns {JSX.Element | null} 弹窗视图；open=false 时返回 null
 */
function BatchFormModal({
  open,
  title,
  position,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  position: Position;
  onConfirm: (price: number, amount: number, note: string) => void;
  onCancel: () => void;
}) {
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  if (!open) return null;

  const isReduce = title.includes('减仓');
  const priceNum = Number(price);
  const amountNum = Number(amount);

  let valid = priceNum > 0 && amountNum > 0;
  if (valid && !isReduce && !isValidLotSize(amountNum)) valid = false;
  if (valid && isReduce) {
    if (amountNum > position.currentAmount) valid = false;
    if (amountNum % 100 !== 0) valid = false;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-slate-900 rounded-xl p-5 w-full max-w-sm mx-4 shadow-2xl border border-slate-700" onClick={(e) => e.stopPropagation()}>
        <h4 className="text-sm font-semibold text-slate-200 mb-4">{title}</h4>

        <div className="mb-3">
          <label className="block text-xs text-slate-500 mb-1">单价（元）</label>
          <input
            type="number"
            step="0.001"
            placeholder="交易单价"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            autoFocus
          />
        </div>

        <div className="mb-3">
          <label className="block text-xs text-slate-500 mb-1">
            {isReduce ? '减仓数量（股）' : '数量（100整数倍）'}
          </label>
          <input
            type="number"
            step="100"
            placeholder={isReduce ? '卖出股数' : '至少100股'}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          {isReduce && amountNum > 0 && amountNum > position.currentAmount && (
            <p className="text-xs text-red-400 mt-1">减仓数量不能超过当前持仓 {position.currentAmount} 股</p>
          )}
        </div>

        <div className="mb-4">
          <label className="block text-xs text-slate-500 mb-1">交易备注（选填）</label>
          <input
            type="text"
            placeholder="如：突破加仓、破位止损、左侧分批抄底"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex gap-2">
          <button onClick={onCancel} className="btn btn-outline btn-block text-sm">
            取消
          </button>
          <button
            onClick={() => valid && onConfirm(priceNum, amountNum, note)}
            disabled={!valid}
            className={`btn btn-block text-sm ${valid ? 'btn-primary' : 'bg-slate-700 text-slate-500 cursor-not-allowed'}`}
          >
            {isReduce ? '确认减仓' : '确认加仓'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 清仓自动结仓确认弹窗组件。
 *
 * @description 当建仓批次全部卖出（持股归零）时弹出，展示本次建仓周期最终
 *              已实现净盈亏与收益率，询问是否将该持仓标记为「已结仓」归档。
 * @param {{ open: boolean; stockName: string; realizedPnL: number; totalInvested: number; onConfirm: () => void; onCancel: () => void }} props
 *  - open: 是否显示弹窗
 *  - stockName: 标的名称（展示用）
 *  - realizedPnL: 已实现净盈亏
 *  - totalInvested: 原始投入总额（用于计算收益率）
 *  - onConfirm: 确认结仓回调
 *  - onCancel: 暂不归档回调
 * @returns {JSX.Element | null} 弹窗视图；open=false 时返回 null
 */
function ClearPositionModal({
  open,
  stockName,
  realizedPnL,
  totalInvested,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  stockName: string;
  realizedPnL: number;
  totalInvested: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  const totalReturn = totalInvested > 0 ? (realizedPnL / totalInvested) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-slate-900 rounded-xl p-5 w-full max-w-sm mx-4 shadow-2xl border border-slate-700" onClick={(e) => e.stopPropagation()}>
        <h4 className="text-sm font-semibold text-slate-200 mb-2">持股已清仓</h4>
        <p className="text-xs text-slate-400 mb-4">
          「{stockName}」标的持股已全部卖出！<br />
          本次建仓周期最终实现净盈亏为：
        </p>
        <p className={`text-2xl font-bold mb-1 ${realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {realizedPnL >= 0 ? '+' : ''}¥{realizedPnL.toFixed(2)}
        </p>
        <p className={`text-sm mb-4 ${realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%
        </p>
        <p className="text-xs text-slate-500 mb-4">
          是否将其标记为【已结仓】归档？
        </p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="btn btn-outline btn-block text-sm">
            暂不归档
          </button>
          <button onClick={onConfirm} className="btn btn-primary btn-block text-sm">
            确认结仓
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 将 Store 层批次（PositionBatch，timestamp 为 ISO 字符串）转换为
 * `recalculatePosition` 所需的实体批次（PositionBatchEntity，timestamp 为毫秒时间戳）。
 *
 * @description 仅做字段形状/单位对齐，不做任何计算口径转换；存量 `'close'` 类型
 *              批次按建仓账本语义防御性归并为减仓（reduce），`fee` 缺省兜底为 0。
 * @param batch Store 层批次履历
 * @param positionId 所属持仓 id
 * @returns 实体批次（recalculatePosition 只读取 type/price/amount/fee/timestamp）
 */
function toEntityBatch(batch: PositionBatch, positionId: string): PositionBatchEntity {
  return {
    id: batch.id,
    positionId,
    type: batch.type === 'close' ? 'reduce' : batch.type,
    price: batch.price,
    amount: batch.amount,
    fee: batch.fee ?? 0,
    costAfter: batch.costAfter,
    amountAfter: batch.amountAfter,
    timestamp: new Date(batch.timestamp).getTime(),
    note: batch.note,
    // recalculatePosition 不读取审计时间戳，此处仅作类型占位
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 格式化腾讯行情接口的更新时间（yyyyMMddHHmmss → MM-DD HH:mm:ss）。
 *
 * @param {string} updateTime - 行情接口返回的更新时间，如 20260812161440
 * @returns {string} 格式化后的时间文本；格式不符时原样返回
 */
function formatQuoteTime(updateTime: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(updateTime);
  if (!m) return updateTime;
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * Tab1 多批次建仓实盘账本组件。
 *
 * @description 管理持仓全生命周期：
 *  - 新建建仓（股票搜索/手工输入，含规费计入成本、重复建仓拦截）
 *  - 加仓/减仓（批次成本实时重算，减仓按先进先出销减）
 *  - 清仓自动结仓弹窗、手动结仓、删除批次/删除标的
 *  - 展开卡片查看批次履历与目标成本达成的补仓提示
 * @returns {JSX.Element} 建仓账本视图
 * @note 所有写操作委托 useAppStore（addPosition/addBatch/closePosition/
 *       updatePosition/deletePositionBatch/removePosition）落库 IndexedDB；
 *       数据源从 Store 读取（由 useLoadCoreData 按需加载）。
 */
function PositionLedger() {
  const { addPosition, addBatch, closePosition, deletePositionBatch, removePosition } = useAppStore();
  const positions = useAppStore((s) => s.positions);
  const feeConfig = useAppStore((s) => s.feeConfig);
  // 结仓资格校验所需：做T战报 + 全市场撮合结果（进行中 Round 检测）
  const tRounds = useAppStore((s) => s.tRounds);
  const streamResults = useStreamResults();

  const [selectedStock, setSelectedStock] = useState<StockSearchItem | null>(null);
  const [stockName, setStockName] = useState('');
  const [openPrice, setOpenPrice] = useState('');
  const [openAmount, setOpenAmount] = useState('');
  const [openNote, setOpenNote] = useState('');
  // 重复建仓提示（同一股票代码已存在进行中持仓）
  const [dupAlert, setDupAlert] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  // 结仓被阻止提示（仍有未卖出持仓 或 该标的存在进行中的做T轮次）
  const [closeBlockAlert, setCloseBlockAlert] = useState<string | null>(null);
  const [deleteBatchConfirm, setDeleteBatchConfirm] = useState<{ positionId: string; batchId: string } | null>(null);
  const [deleteTickerConfirm, setDeleteTickerConfirm] = useState<string | null>(null);

  // 加/减仓弹窗
  const [batchForm, setBatchForm] = useState<{ positionId: string; type: 'add' | 'reduce' } | null>(null);

  // 清仓自动结仓弹窗
  const [clearPosition, setClearPosition] = useState<{ positionId: string; realizedPnL: number; totalInvested: number } | null>(null);

  // 新建建仓
  const handleOpenPosition = () => {
    if (!stockName.trim()) return;
    const price = Number(openPrice);
    const amount = Number(openAmount);
    if (!price || !amount || !isValidLotSize(amount)) return;

    // fullCode 作为持仓唯一主键（如 sh601318）；未选择搜索结果的旧流程回退空串
    const fullCode = selectedStock?.fullCode ?? '';

    // 同一股票代码已存在进行中持仓 → 阻止重复建仓
    if (fullCode && positions.some((p) => p.fullCode === fullCode && !p.isClosed)) {
      setDupAlert(`${selectedStock?.Name ?? stockName.trim()}（${fullCode}）已存在进行中持仓，请直接在原账本上加仓。`);
      return;
    }

    // 计算买入规费
    const buyFee = calcTradeFees(price, amount, 'buy', feeConfig, matchSecurityKind(selectedStock?.SecurityType ?? '', selectedStock?.Code ?? ''));
    const totalFee = buyFee.total;
    const totalInvested = price * amount + totalFee;

    const now = new Date().toISOString();
    const batch: PositionBatch = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: now,
      type: 'open',
      price,
      amount,
      costAfter: totalInvested / amount,
      amountAfter: amount,
      note: openNote || undefined,
      fee: totalFee,
    };

    const pos: Position = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      stockName: stockName.trim(),
      fullCode,
      currentCost: totalInvested / amount,
      currentAmount: amount,
      batches: [batch],
      isClosed: false,
      createdAt: now,
      realizedPnL: 0,
      totalInvested,
    };

    addPosition(pos);
    setStockName('');
    setSelectedStock(null);
    setOpenPrice('');
    setOpenAmount('');
    setOpenNote('');
  };

  // 加仓/减仓（通过弹窗）
  const handleBatch = (positionId: string, type: 'add' | 'reduce') => {
    const pos = positions.find((p) => p.id === positionId);
    if (!pos) return;
    setBatchForm({ positionId, type });
  };

  const handleBatchConfirm = (positionId: string, type: 'add' | 'reduce', price: number, amount: number, note: string) => {
    const pos = positions.find((p) => p.id === positionId);
    if (!pos) return;

    // 计算规费
    const direction = type === 'add' ? 'buy' : 'sell';
    const tradeFee = calcTradeFees(price, amount, direction, feeConfig, matchSecurityKind('', pos.fullCode.replace(/^sh|sz|bj/, '')));
    const totalFee = tradeFee.total;

    // 用总资金抽回法重新计算（与 recomputePositionSnapshot 同口径）
    const snap = recomputePositionSnapshot(pos.batches);
    let totalInvested = snap.totalInvested;
    let totalAmount = snap.currentAmount;
    let realizedPnL = snap.realizedPnL;

    // 应用新操作
    let newCost: number;
    let newAmount: number;
    let newRealizedPnL = realizedPnL;
    let newTotalInvested = totalInvested;

    if (type === 'add') {
      newAmount = totalAmount + amount;
      newTotalInvested += price * amount + totalFee;
      newCost = newTotalInvested / newAmount;
    } else {
      if (totalAmount > 0) {
        const costBasisPerShare = totalInvested / totalAmount;
        const costBasisOfSold = costBasisPerShare * amount;
        const netProceeds = price * amount - totalFee;
        newRealizedPnL += netProceeds - costBasisOfSold;
        newTotalInvested -= costBasisOfSold;
      }
      newAmount = totalAmount - amount;
      if (newAmount <= 0) {
        newCost = 0;
        newTotalInvested = 0;
      } else {
        newCost = newTotalInvested / newAmount;
      }
    }

    const now = new Date().toISOString();
    const batch: PositionBatch = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: now,
      type,
      price,
      amount: type === 'add' ? amount : -amount,
      costAfter: newCost,
      amountAfter: newAmount,
      note: note || undefined,
      fee: totalFee,
    };

    // 批次与快照更新在同一 action 内原子合并、单次落库。
    // 旧写法（addBatch 先写旧快照 + updatePosition 再写新快照）会产生两次异步写，
    // Dexie 同 tick 内先执行隐式 put、后执行显式 db.transaction，旧快照必然最后覆盖新值 → 总是旧值。
    addBatch(positionId, batch, {
      currentCost: newCost,
      currentAmount: newAmount,
      realizedPnL: newRealizedPnL,
      totalInvested: newTotalInvested,
    });

    setBatchForm(null);

    // 清仓检测：减仓后持股变为 0
    if (type === 'reduce' && newAmount <= 0) {
      const finalPnL = newRealizedPnL;
      const finalInvested = totalInvested; // 减仓前的总投入
      // 清仓到 0 同样执行结仓资格校验：无未卖出持仓 且 该标的无进行中的做T轮次
      // → 自动完结归档；否则保留清仓弹窗，由用户自行决定是否手动结仓。
      if (!getCloseBlockReason(pos, streamResults, tRounds, newAmount)) {
        closePosition(positionId);
      } else {
        setClearPosition({
          positionId,
          realizedPnL: finalPnL,
          totalInvested: finalInvested,
        });
      }
    }
  };

  // 确认清仓结仓
  const handleClearConfirm = () => {
    if (!clearPosition) return;
    closePosition(clearPosition.positionId);
    setClearPosition(null);
  };

  // 完结建仓（确认弹窗回调）
  const handleClose = (id: string) => {
    const pos = positions.find((p) => p.id === id);
    if (!pos) return;
    // 结仓资格校验：仍有未卖出的持有数量 或 该标的存在进行中的做T轮次 → 弹框阻止结仓。
    // 按钮点击时已预检，此处兜底防止确认弹窗打开期间数据（如新增做T流水）发生变化。
    const blockReason = getCloseBlockReason(pos, streamResults, tRounds);
    if (blockReason) {
      setCloseBlockAlert(blockReason);
      setCloseConfirmId(null);
      return;
    }
    closePosition(id);
    setCloseConfirmId(null);
  };

  // 删除单笔批次
  const handleDeleteBatch = () => {
    if (!deleteBatchConfirm) return;
    // 批次删除与快照重算由 Store 的 deletePositionBatch 原子完成：
    // 按剩余批次履历重新计算 currentCost/currentAmount/realizedPnL/totalInvested 并单次落库。
    deletePositionBatch(deleteBatchConfirm.positionId, deleteBatchConfirm.batchId);
    setDeleteBatchConfirm(null);
  };

  // 删除整个标的
  const handleDeleteTicker = () => {
    if (!deleteTickerConfirm) return;
    removePosition(deleteTickerConfirm);
    setDeleteTickerConfirm(null);
  };

  const activePositions = positions.filter((p) => !p.isClosed);
  const closedPositions = positions.filter((p) => p.isClosed);

  // 实时行情：交易时段每 5 秒刷新、非交易时段打开时刷新一次、跨时段切换自动切换策略
  const { quotes, isTrading, lastUpdated } = useLiveQuotes(activePositions.map((p) => p.fullCode).filter(Boolean));

  return (
    <div className="space-y-4">
      {/* 实时行情状态 */}
      <div className="flex items-center justify-between px-1 text-xs">
        <span className={isTrading ? 'text-blue-400 font-medium' : 'text-slate-500'}>
          {isTrading ? '● 交易时段 · 行情每 5 秒自动刷新' : '○ 非交易时段 · 打开时刷新一次'}
        </span>
        {lastUpdated !== null && (
          <span className="text-slate-600">
            行情更新于 {new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        )}
      </div>

      {/* 新建建仓 */}
      <div className="p-4 bg-slate-900 rounded-lg">
        <h4 className="text-xs font-medium text-slate-400 mb-3">新建建仓</h4>
        <div className="form-row">
          <div className="form-group">
            <label>股票名称</label>
            <StockAutocomplete
              value={selectedStock}
              onChange={(item) => {
                setSelectedStock(item);
                setStockName(item ? item.Name : '');
              }}
              placeholder="搜索股票代码/名称/拼音"
            />
          </div>
          <div className="form-group">
            <label>建仓单价（元）</label>
            <input
              type="number"
              step="0.001"
              placeholder="买入单价"
              value={openPrice}
              onChange={(e) => setOpenPrice(e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>建仓数量（100整数倍）</label>
            <input
              type="number"
              step="100"
              placeholder="至少100股"
              value={openAmount}
              onChange={(e) => setOpenAmount(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>交易备注（选填）</label>
            <input
              type="text"
              placeholder="如：左侧分批抄底"
              value={openNote}
              onChange={(e) => setOpenNote(e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group flex items-end">
            <button onClick={handleOpenPosition} className="btn btn-primary btn-block">
              <Plus className="w-4 h-4" />
              建仓
            </button>
          </div>
        </div>
      </div>

      {/* 进行中持仓 */}
      {activePositions.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-slate-500 text-sm mb-3">当前无进行中持仓</p>
          
        </div>
      ) : null}

      {activePositions.map((pos) => {
        // 用 recalculatePosition 从批次履历重建权威快照：
        // 动态保本价 / 做T落袋利润 / 实际净投入现金 / 初始建仓均价
        const snap = recalculatePosition(pos.batches.map((b) => toEntityBatch(b, pos.id)));

        // 实时现价（来自腾讯行情接口，交易时段每 5 秒刷新）
        const live = quotes[pos.fullCode] ?? null;
        const cp = live?.currentPrice ?? 0;
        const hasPrice = cp > 0 && snap.currentAmount > 0;
        const floatPnL = hasPrice ? (cp - snap.currentCost) * snap.currentAmount : 0;
        const floatPnLPercent = hasPrice && snap.currentCost > 0 ? ((cp - snap.currentCost) / snap.currentCost) * 100 : 0;
        // 回本所需涨幅 = (动态保本价 - 现价) / 现价 × 100%；现价高于保本价时为负（已回本）
        const requiredRisePercent = hasPrice && snap.currentCost > 0 ? ((snap.currentCost - cp) / cp) * 100 : 0;

        return (
          <div key={pos.id} className="p-4 bg-slate-900 rounded-lg border border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-slate-200">{pos.stockName}</h4>
              <div className="flex items-center gap-2">
                <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">进行中</span>
                {pos.currentAmount === 0 && (
                  <span className="text-xs text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded-full">
                    底仓出空
                  </span>
                )}
                <button
                  onClick={() => setDeleteTickerConfirm(pos.id)}
                  className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-red-400"
                  title="删除标的"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* 实时行情（腾讯 qt.gtimg.cn，交易时段每 5 秒刷新） */}
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-xs text-slate-500">当前现价</span>
              {live ? (
                <>
                  <span className={`text-sm font-bold ${live.changePercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                    ¥{live.currentPrice.toFixed(3)}
                  </span>
                  <span className={`text-xs ${live.changePercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {live.changePercent >= 0 ? '+' : ''}{live.changePercent.toFixed(2)}%
                  </span>
                  <span className="text-[10px] text-slate-600">
                    行情 {formatQuoteTime(live.updateTime)}
                  </span>
                </>
              ) : (
                <span className="text-sm text-slate-600">— 暂无行情数据</span>
              )}
              {hasPrice && (
                <div className="flex items-center gap-3 text-xs">
                  <span className={floatPnL >= 0 ? 'text-red-400' : 'text-green-400'}>
                    浮动盈亏 {floatPnL >= 0 ? '+' : ''}¥{floatPnL.toFixed(2)}
                  </span>
                  <span className={floatPnLPercent >= 0 ? 'text-red-400' : 'text-green-400'}>
                    {floatPnLPercent >= 0 ? '+' : ''}{floatPnLPercent.toFixed(2)}%
                  </span>
                  {/* 回本所需涨幅：相对动态保本价的缺口，做T/加仓后会实时更新 */}
                  <span className="flex items-center gap-1">
                    <span className="text-slate-500">回本所需涨幅</span>
                    <span className={`font-medium ${requiredRisePercent > 0 ? 'text-amber-300' : 'text-green-400'}`}>
                      {requiredRisePercent > 0 ? `+${requiredRisePercent.toFixed(2)}%` : '已回本'}
                    </span>
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm mb-3">
              <div>
                <span className="text-slate-500">保本单价（动态成本）</span>
                <p className="text-slate-200 font-medium">¥{snap.currentCost.toFixed(3)}</p>
                <p className="text-[10px] text-slate-600 leading-tight mt-0.5">初始均价：¥{snap.initialCost.toFixed(3)}</p>
              </div>
              <div>
                <span className="text-slate-500">持仓数量</span>
                <p className="text-slate-200 font-medium">{snap.currentAmount.toLocaleString()}股</p>
              </div>
              <div>
                <span className="text-slate-500">做T / 调仓落袋利润 🔥</span>
                <p className={`font-medium ${snap.accumulatedTPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {snap.accumulatedTPnL >= 0 ? '+' : ''}¥{snap.accumulatedTPnL.toFixed(2)}
                </p>
                <p className="text-[10px] text-slate-600 leading-tight mt-0.5">已折抵本金</p>
              </div>
              <div>
                <span className="text-slate-500">实际净投入现金</span>
                <p className="text-slate-200 font-medium">¥{snap.totalInvested.toFixed(2)}</p>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => handleBatch(pos.id, 'add')} className="btn btn-primary btn-sm flex-1">
                <Plus className="w-3 h-3" />加仓
              </button>
              <button onClick={() => handleBatch(pos.id, 'reduce')} className="btn btn-outline btn-sm flex-1">
                <X className="w-3 h-3" />减仓
              </button>
              <button
                onClick={() => {
                  // 点击结仓先做资格校验：有未卖出持仓或进行中的做T轮次 → 弹框阻止，不进入确认弹窗
                  const blockReason = getCloseBlockReason(pos, streamResults, tRounds);
                  if (blockReason) {
                    setCloseBlockAlert(blockReason);
                    return;
                  }
                  setCloseConfirmId(pos.id);
                }}
                className="btn btn-outline btn-sm flex-1"
              >
                <Archive className="w-3 h-3" />结仓
              </button>
            </div>

            {/* 批次明细 */}
            <button
              onClick={() => setExpandedId(expandedId === pos.id ? null : pos.id)}
              className="mt-3 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300"
            >
              {expandedId === pos.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              操作记录（{pos.batches.length}条）
            </button>

            {expandedId === pos.id && (
              <div className="mt-2 space-y-1">
                {(() => {
                  const sortedBatches = [...pos.batches].sort(
                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                  );
                  const isFirstBatch = (batchId: string) => sortedBatches.length >= 1 && sortedBatches[0].id === batchId;
                  return sortedBatches.map((batch) => (
                    <div key={batch.id} className="flex items-center justify-between text-xs text-slate-400 py-1.5 border-b border-slate-800 last:border-0">
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          batch.type === 'open' ? 'bg-blue-500/20 text-blue-400' :
                          batch.type === 'add' ? 'bg-green-500/20 text-green-400' :
                          batch.type === 'reduce' ? 'bg-red-500/20 text-red-400' :
                          'bg-slate-500/20 text-slate-400'
                        }`}>
                          {batch.type === 'open' ? '建仓' : batch.type === 'add' ? '加仓' : batch.type === 'reduce' ? '减仓' : '结仓'}
                        </span>
                        <span>¥{batch.price.toFixed(3)}</span>
                        <span>× {Math.abs(batch.amount)}股</span>
                        {batch.fee !== undefined && batch.fee > 0 && (
                          <span className="text-slate-600">费¥{batch.fee.toFixed(2)}</span>
                        )}
                        {batch.note && (
                          <span className="text-slate-600 italic">「{batch.note}」</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">
                          {new Date(batch.timestamp).toLocaleDateString()}
                        </span>
                        <div className="relative group">
                          <button
                            onClick={() => {
                              if (isFirstBatch(batch.id)) return;
                              setDeleteBatchConfirm({ positionId: pos.id, batchId: batch.id });
                            }}
                            disabled={isFirstBatch(batch.id)}
                            className={`p-1 rounded ${
                              isFirstBatch(batch.id)
                                ? 'text-slate-700 cursor-not-allowed'
                                : 'hover:bg-slate-800 text-slate-600 hover:text-red-400'
                            }`}
                            title={isFirstBatch(batch.id) ? '已有后续加/减仓履历，无法单独删除初始建仓。如需重置，请点击右上角【删除整个标的】' : '删除该笔操作记录'}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                          {isFirstBatch(batch.id) && (
                            <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block w-60 bg-slate-800 text-slate-200 text-xs rounded-lg p-2 shadow-lg z-10">
                              已有后续加/减仓履历，无法单独删除初始建仓。如需重置，请点击右上角【删除整个标的】
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        );
      })}


      {/* 重复建仓提示 */}
      <ConfirmModal
        open={dupAlert !== null}
        title="已存在相同持仓"
        message={dupAlert ?? ''}
        confirmText="知道了"
        onConfirm={() => setDupAlert(null)}
        onCancel={() => setDupAlert(null)}
      />

      {/* 加/减仓弹窗 */}
      {batchForm && (
        <BatchFormModal
          open={true}
          title={batchForm.type === 'add' ? '加仓' : '减仓'}
          position={positions.find((p) => p.id === batchForm.positionId)!}
          onConfirm={(price, amount, note) => handleBatchConfirm(batchForm.positionId, batchForm.type, price, amount, note)}
          onCancel={() => setBatchForm(null)}
        />
      )}

      {/* 清仓自动结仓弹窗 */}
      {clearPosition && (
        <ClearPositionModal
          open={true}
          stockName={positions.find((p) => p.id === clearPosition.positionId)?.stockName || ''}
          realizedPnL={clearPosition.realizedPnL}
          totalInvested={clearPosition.totalInvested}
          onConfirm={handleClearConfirm}
          onCancel={() => setClearPosition(null)}
        />
      )}

      {/* 结仓被阻止提示 */}
      <ConfirmModal
        open={closeBlockAlert !== null}
        title="无法完结持仓"
        message={closeBlockAlert ?? ''}
        confirmText="知道了"
        onConfirm={() => setCloseBlockAlert(null)}
        onCancel={() => setCloseBlockAlert(null)}
      />

      {/* 结仓确认 */}
      <ConfirmModal
        open={closeConfirmId !== null}
        title="完结建仓"
        message="确认完结该持仓？结仓后该持仓将归档到已结仓列表。"
        confirmText="确认结仓"
        onConfirm={() => closeConfirmId && handleClose(closeConfirmId)}
        onCancel={() => setCloseConfirmId(null)}
      />

      {/* 删除单笔批次确认 */}
      <ConfirmModal
        open={deleteBatchConfirm !== null}
        title="删除建仓记录"
        message="确定要删除该笔建仓/加减仓记录吗？删除后将重新计算当前持仓成本。"
        confirmText="确认删除"
        danger
        onConfirm={handleDeleteBatch}
        onCancel={() => setDeleteBatchConfirm(null)}
      />

      {/* 删除整个标的确认 */}
      <ConfirmModal
        open={deleteTickerConfirm !== null}
        title="删除标的账本"
        message="确定要删除该标的的所有建仓记录吗？此操作不可恢复！"
        confirmText="确认删除"
        danger
        onConfirm={handleDeleteTicker}
        onCancel={() => setDeleteTickerConfirm(null)}
      />
    </div>
  );
}

/**
 * Tab2 目标成本推算组件。
 *
 * @description 输入当前持仓成本/数量与目标均价，结合费率模板，
 *              反推需补仓的数量与金额，并同步测算补仓后的总成本与规费明细。
 * @returns {JSX.Element} 目标成本推算视图
 * @note 纯计算展示，不产生任何 IndexedDB 写入
 */
function TargetCostCalculator() {
  const [currentCost, setCurrentCost] = useState('');
  const [currentAmount, setCurrentAmount] = useState('');
  const [plannedPrice, setPlannedPrice] = useState('');
  const [targetCost, setTargetCost] = useState('');
  const [result, setResult] = useState<ReturnType<typeof calcTargetCostAveraging> | null>(null);

  const handleCalculate = () => {
    const cc = Number(currentCost);
    const ca = Number(currentAmount);
    const pp = Number(plannedPrice);
    const tc = Number(targetCost);

    if (!cc || !ca || !pp || !tc) return;
    if (ca % 100 !== 0) return;

    setResult(calcTargetCostAveraging(cc, ca, pp, tc));
  };

  const handleFillDown = () => {
    if (!result?.downLot) return;
    const newAmount = Number(currentAmount) + result.downLot.amount;
    setCurrentAmount(String(newAmount));
    const cc = Number(currentCost);
    const pp = Number(plannedPrice);
    const tc = Number(targetCost);
    if (cc && pp && tc && newAmount > 0) {
      setResult(calcTargetCostAveraging(cc, newAmount, pp, tc));
    }
  };

  const handleFillUp = () => {
    if (!result?.upLot) return;
    const newAmount = Number(currentAmount) + result.upLot.amount;
    setCurrentAmount(String(newAmount));
    const cc = Number(currentCost);
    const pp = Number(plannedPrice);
    const tc = Number(targetCost);
    if (cc && pp && tc && newAmount > 0) {
      setResult(calcTargetCostAveraging(cc, newAmount, pp, tc));
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-4 bg-slate-900 rounded-lg">
        <h4 className="text-xs font-medium text-slate-400 mb-3">补仓参数</h4>
        <div className="form-row">
          <div className="form-group">
            <label>当前成本价（元）</label>
            <input
              type="number"
              step="0.001"
              placeholder="当前持仓成本"
              value={currentCost}
              onChange={(e) => setCurrentCost(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>当前持仓（股）</label>
            <input
              type="number"
              step="100"
              placeholder="100整数倍"
              value={currentAmount}
              onChange={(e) => setCurrentAmount(e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>计划补仓单价（元）</label>
            <input
              type="number"
              step="0.001"
              placeholder="补仓买入价"
              value={plannedPrice}
              onChange={(e) => setPlannedPrice(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>目标成本价（元）</label>
            <input
              type="number"
              step="0.001"
              placeholder="期望最终成本"
              value={targetCost}
              onChange={(e) => setTargetCost(e.target.value)}
            />
          </div>
        </div>
        <button onClick={handleCalculate} className="btn btn-primary btn-block mt-2">
          推算补仓数量
        </button>
      </div>

      {result && (
        <div className="space-y-3">
          {result.exact && (
            <div className="p-4 bg-slate-900 rounded-lg">
              <h4 className="text-xs font-medium text-slate-400 mb-3">理论推算结果</h4>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-slate-500">需补仓数量</span>
                  <p className="text-slate-200 font-bold text-lg">{result.needAmount.toLocaleString()}股</p>
                </div>
                <div>
                  <span className="text-slate-500">需补仓资金</span>
                  <p className="text-blue-400 font-bold text-lg">¥{result.needCapital.toFixed(2)}</p>
                </div>
              </div>
              <div className="mt-2 pt-2 border-t border-slate-800">
                <span className="text-xs text-slate-500">推算后成本价</span>
                <p className="text-green-400 font-bold">¥{result.actualCost.toFixed(3)}</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {result.downLot && (
              <div className="p-4 bg-slate-900 rounded-lg border border-slate-700">
                <h4 className="text-xs font-medium text-slate-500 mb-2">向下整手</h4>
                <p className="text-lg font-bold text-slate-200">{result.downLot.amount.toLocaleString()}股</p>
                <p className="text-sm text-slate-400 mt-1">资金 ¥{result.downLot.capital.toFixed(2)}</p>
                <p className="text-sm text-green-400">成本 ¥{result.downLot.actualCost.toFixed(3)}</p>
                <button onClick={handleFillDown} className="btn btn-outline btn-sm mt-2 w-full">
                  <CheckCircle className="w-3 h-3" /> 填充
                </button>
              </div>
            )}
            {result.upLot && (
              <div className="p-4 bg-slate-900 rounded-lg border border-slate-700">
                <h4 className="text-xs font-medium text-slate-500 mb-2">向上整手</h4>
                <p className="text-lg font-bold text-slate-200">{result.upLot.amount.toLocaleString()}股</p>
                <p className="text-sm text-slate-400 mt-1">资金 ¥{result.upLot.capital.toFixed(2)}</p>
                <p className="text-sm text-green-400">成本 ¥{result.upLot.actualCost.toFixed(3)}</p>
                <button onClick={handleFillUp} className="btn btn-outline btn-sm mt-2 w-full">
                  <CheckCircle className="w-3 h-3" /> 填充
                </button>
              </div>
            )}
          </div>

          {result.suggestions.length > 0 && (
            <div className="p-4 bg-slate-900 rounded-lg">
              <h4 className="text-xs font-medium text-slate-400 mb-2">建议</h4>
              <ul className="space-y-1">
                {result.suggestions.map((s, i) => (
                  <li key={i} className="text-xs text-slate-400 flex items-start gap-2">
                    <span className="text-blue-400 mt-0.5">•</span>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 成本分摊与持仓管理主页面组件。
 *
 * @description 提供「多批次建仓实盘账本」与「目标成本推算」双 Tab 切换容器。
 * @returns {JSX.Element} 成本分摊页面视图
 * @note 页面挂载即通过 Store 读取 positions/batches（由 useLoadCoreData 按需加载）
 */
export default function CostAveraging() {
  const [tab, setTab] = useState<'ledger' | 'target'>('ledger');

  return (
    <div className="page-container">
      <div className="card">
        <h3>仓位管理</h3>

        <div className="tab-bar">
          <button
            className={`tab-btn ${tab === 'ledger' ? 'active' : ''}`}
            onClick={() => setTab('ledger')}
          >
            建仓
          </button>
          <button
            className={`tab-btn ${tab === 'target' ? 'active' : ''}`}
            onClick={() => setTab('target')}
          >
            目标成本推算
          </button>
        </div>

        <div className="tab-content">
          {tab === 'ledger' ? <PositionLedger /> : <TargetCostCalculator />}
        </div>

      </div>
    </div>
  );
}