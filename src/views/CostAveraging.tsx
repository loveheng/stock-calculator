import React, { useState } from 'react';
import { Plus, X, Archive, ChevronDown, ChevronUp, CheckCircle, Trash2 } from 'lucide-react';
import { useAppStore } from '../store';
import { calcTargetCostAveraging, isValidLotSize, calcTradeFees } from '../utils/mathUtils';
import type { Position, PositionBatch } from '../store';
import ConfirmModal from '../components/ui/ConfirmModal';

// ---- 加/减仓表单弹窗 ----
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

// ---- 清仓自动结案弹窗 ----
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
          是否将其标记为【已结案】归档？
        </p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="btn btn-outline btn-block text-sm">
            暂不归档
          </button>
          <button onClick={onConfirm} className="btn btn-primary btn-block text-sm">
            确认结案
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Tab 1: 多批次建仓实盘账本 ----
function PositionLedger() {
  const { positions, addPosition, addBatch, closePosition, updatePosition, deletePositionBatch, removePosition, feeConfig } = useAppStore();

  const [stockName, setStockName] = useState('');
  const [openPrice, setOpenPrice] = useState('');
  const [openAmount, setOpenAmount] = useState('');
  const [openNote, setOpenNote] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  const [deleteBatchConfirm, setDeleteBatchConfirm] = useState<{ positionId: string; batchId: string } | null>(null);
  const [deleteTickerConfirm, setDeleteTickerConfirm] = useState<string | null>(null);

  // 加/减仓弹窗
  const [batchForm, setBatchForm] = useState<{ positionId: string; type: 'add' | 'reduce' } | null>(null);

  // 清仓自动结案弹窗
  const [clearPosition, setClearPosition] = useState<{ positionId: string; realizedPnL: number; totalInvested: number } | null>(null);

  // 现价模拟（每个持仓ID -> 当前输入现价）
  const [currentPrices, setCurrentPrices] = useState<Record<string, string>>({});

  // 新建建仓
  const handleOpenPosition = () => {
    if (!stockName.trim()) return;
    const price = Number(openPrice);
    const amount = Number(openAmount);
    if (!price || !amount || !isValidLotSize(amount)) return;

    // 计算买入规费
    const buyFee = calcTradeFees(price, amount, 'buy', feeConfig);
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
    setOpenPrice('');
    setOpenAmount('');
    setOpenNote('');
  };

  // 计算真实成本（含规费）
  const calcRealCost = (pos: Position): number => {
    let totalInvested = 0;
    let totalAmount = 0;
    const sorted = [...pos.batches].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    for (const batch of sorted) {
      const qty = Math.abs(batch.amount);
      const batchFee = batch.fee || 0;
      if (batch.amount > 0) {
        const cost = batch.price * qty + batchFee;
        totalInvested += cost;
        totalAmount += qty;
      } else {
        if (totalAmount > 0) {
          const costBasisPerShare = totalInvested / totalAmount;
          totalInvested -= costBasisPerShare * qty;
        }
        totalAmount -= qty;
        if (totalAmount <= 0) {
          totalInvested = 0;
          totalAmount = 0;
        }
      }
    }
    return totalAmount > 0 ? totalInvested / totalAmount : 0;
  };

  // 计算累计已实现盈亏
  const calcRealizedPnL = (pos: Position): number => {
    let totalInvested = 0;
    let totalAmount = 0;
    let realizedPnL = 0;
    const sorted = [...pos.batches].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    for (const batch of sorted) {
      const qty = Math.abs(batch.amount);
      const batchFee = batch.fee || 0;
      if (batch.amount > 0) {
        const cost = batch.price * qty + batchFee;
        totalInvested += cost;
        totalAmount += qty;
      } else {
        if (totalAmount > 0) {
          const costBasisPerShare = totalInvested / totalAmount;
          const costBasisOfSold = costBasisPerShare * qty;
          const netProceeds = batch.price * qty - batchFee;
          realizedPnL += netProceeds - costBasisOfSold;
          totalInvested -= costBasisOfSold;
        }
        totalAmount -= qty;
        if (totalAmount <= 0) {
          totalInvested = 0;
          totalAmount = 0;
        }
      }
    }
    return realizedPnL;
  };

  // 计算累计投入总资金（含规费）
  const calcTotalInvested = (pos: Position): number => {
    let totalInvested = 0;
    let totalAmount = 0;
    const sorted = [...pos.batches].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    for (const batch of sorted) {
      const qty = Math.abs(batch.amount);
      const batchFee = batch.fee || 0;
      if (batch.amount > 0) {
        const cost = batch.price * qty + batchFee;
        totalInvested += cost;
        totalAmount += qty;
      } else {
        if (totalAmount > 0) {
          const costBasisPerShare = totalInvested / totalAmount;
          totalInvested -= costBasisPerShare * qty;
        }
        totalAmount -= qty;
        if (totalAmount <= 0) {
          totalInvested = 0;
          totalAmount = 0;
        }
      }
    }
    return totalInvested;
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
    const tradeFee = calcTradeFees(price, amount, direction, feeConfig);
    const totalFee = tradeFee.total;

    // 用总资金抽回法重新计算
    const sorted = [...pos.batches].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    let totalInvested = 0;
    let totalAmount = 0;
    let realizedPnL = 0;

    for (const batch of sorted) {
      const qty = Math.abs(batch.amount);
      const batchFee = batch.fee || 0;
      if (batch.amount > 0) {
        const cost = batch.price * qty + batchFee;
        totalInvested += cost;
        totalAmount += qty;
      } else {
        if (totalAmount > 0) {
          const costBasisPerShare = totalInvested / totalAmount;
          const costBasisOfSold = costBasisPerShare * qty;
          const netProceeds = batch.price * qty - batchFee;
          realizedPnL += netProceeds - costBasisOfSold;
          totalInvested -= costBasisOfSold;
        }
        totalAmount -= qty;
        if (totalAmount <= 0) {
          totalInvested = 0;
          totalAmount = 0;
        }
      }
    }

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

    addBatch(positionId, batch);
    updatePosition(positionId, {
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
      setClearPosition({
        positionId,
        realizedPnL: finalPnL,
        totalInvested: finalInvested,
      });
    }
  };

  // 确认清仓结案
  const handleClearConfirm = () => {
    if (!clearPosition) return;
    closePosition(clearPosition.positionId);
    setClearPosition(null);
  };

  // 完结建仓
  const handleClose = (id: string) => {
    closePosition(id);
    setCloseConfirmId(null);
  };

  // 删除单笔批次
  const handleDeleteBatch = () => {
    if (!deleteBatchConfirm) return;
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

  return (
    <div className="space-y-4">
      {/* 新建建仓 */}
      <div className="p-4 bg-slate-900 rounded-lg">
        <h4 className="text-xs font-medium text-slate-400 mb-3">新建建仓</h4>
        <div className="form-row">
          <div className="form-group">
            <label>股票名称</label>
            <input
              id="new-position-input"
              type="text"
              placeholder="如：贵州茅台"
              value={stockName}
              onChange={(e) => setStockName(e.target.value)}
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
          <button onClick={() => {
            document.getElementById('new-position-input')?.focus();
          }} className="btn btn-primary btn-sm">
            <Plus className="w-4 h-4" />
            新建建仓
          </button>
        </div>
      ) : null}

      {activePositions.map((pos) => {
        const realCost = calcRealCost(pos);
        const realPnL = calcRealizedPnL(pos);
        const totalInv = calcTotalInvested(pos);

        // 现价模拟
        const cpStr = currentPrices[pos.id] || '';
        const cp = Number(cpStr);
        const hasPrice = cp > 0 && pos.currentAmount > 0;
        const floatPnL = hasPrice ? (cp - pos.currentCost) * pos.currentAmount : 0;
        const floatPnLPercent = hasPrice && pos.currentCost > 0 ? ((cp - pos.currentCost) / pos.currentCost) * 100 : 0;
        const breakevenPercent = hasPrice && pos.currentCost > 0 ? ((pos.currentCost / cp - 1) * 100) : 0;

        return (
          <div key={pos.id} className="p-4 bg-slate-900 rounded-lg border border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-slate-200">{pos.stockName}</h4>
              <div className="flex items-center gap-2">
                <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">进行中</span>
                <button
                  onClick={() => setDeleteTickerConfirm(pos.id)}
                  className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-red-400"
                  title="删除标的"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* 现价模拟输入 */}
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs text-slate-500">当前现价</span>
              <input
                type="number"
                step="0.001"
                placeholder="输入模拟现价..."
                value={currentPrices[pos.id] || ''}
                onChange={(e) => setCurrentPrices({ ...currentPrices, [pos.id]: e.target.value })}
                className="w-28 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
              />
              {hasPrice && (
                <div className="flex items-center gap-3 text-xs">
                  <span className={floatPnL >= 0 ? 'text-red-400' : 'text-green-400'}>
                    浮动盈亏 {floatPnL >= 0 ? '+' : ''}¥{floatPnL.toFixed(2)}
                  </span>
                  <span className={floatPnLPercent >= 0 ? 'text-red-400' : 'text-green-400'}>
                    {floatPnLPercent >= 0 ? '+' : ''}{floatPnLPercent.toFixed(2)}%
                  </span>
                  <span className="text-slate-500">
                    解套需涨 {breakevenPercent >= 0 ? '+' : ''}{breakevenPercent.toFixed(2)}%
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm mb-3">
              <div>
                <span className="text-slate-500">成本价（含规费）</span>
                <p className="text-slate-200 font-medium">¥{pos.currentCost.toFixed(3)}</p>
              </div>
              <div>
                <span className="text-slate-500">持仓数量</span>
                <p className="text-slate-200 font-medium">{pos.currentAmount.toLocaleString()}股</p>
              </div>
              <div>
                <span className="text-slate-500">已实现盈亏</span>
                <p className={`font-medium ${realPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {realPnL >= 0 ? '+' : ''}¥{realPnL.toFixed(2)}
                </p>
              </div>
              <div>
                <span className="text-slate-500">累计投入</span>
                <p className="text-slate-200 font-medium">¥{totalInv.toFixed(2)}</p>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => handleBatch(pos.id, 'add')} className="btn btn-primary btn-sm flex-1">
                <Plus className="w-3 h-3" />加仓
              </button>
              <button onClick={() => handleBatch(pos.id, 'reduce')} className="btn btn-outline btn-sm flex-1">
                <X className="w-3 h-3" />减仓
              </button>
              <button onClick={() => setCloseConfirmId(pos.id)} className="btn btn-outline btn-sm flex-1">
                <Archive className="w-3 h-3" />结案
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
                  const isFirstBatch = (batchId: string) => sortedBatches.length > 1 && sortedBatches[0].id === batchId;
                  return sortedBatches.map((batch) => (
                    <div key={batch.id} className="flex items-center justify-between text-xs text-slate-400 py-1.5 border-b border-slate-800 last:border-0">
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          batch.type === 'open' ? 'bg-blue-500/20 text-blue-400' :
                          batch.type === 'add' ? 'bg-green-500/20 text-green-400' :
                          batch.type === 'reduce' ? 'bg-red-500/20 text-red-400' :
                          'bg-slate-500/20 text-slate-400'
                        }`}>
                          {batch.type === 'open' ? '建仓' : batch.type === 'add' ? '加仓' : batch.type === 'reduce' ? '减仓' : '结案'}
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

      {/* 清仓自动结案弹窗 */}
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

      {/* 结案确认 */}
      <ConfirmModal
        open={closeConfirmId !== null}
        title="完结建仓"
        message="确认完结该持仓？结案后该持仓将归档到已结案列表。"
        confirmText="确认结案"
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

// ---- Tab 2: 目标成本推算 ----
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

// ---- 主组件 ----
export default function CostAveraging() {
  const [tab, setTab] = useState<'ledger' | 'target'>('ledger');

  return (
    <div className="page-container">
      <div className="card">
        <h3>成本摊薄计算器</h3>

        <div className="tab-bar">
          <button
            className={`tab-btn ${tab === 'ledger' ? 'active' : ''}`}
            onClick={() => setTab('ledger')}
          >
            多批次建仓账本
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