import React, { useState } from 'react';
import { Plus, X, Archive, ChevronDown, ChevronUp, CheckCircle } from 'lucide-react';
import { useAppStore } from '../store';
import { calcTargetCostAveraging, isValidLotSize } from '../utils/mathUtils';
import type { Position, PositionBatch } from '../store';
import ConfirmModal from '../components/ui/ConfirmModal';

// ---- Tab 1: 多批次建仓实盘账本 ----
function PositionLedger() {
  const { positions, addPosition, addBatch, closePosition, updatePosition } = useAppStore();

  const [stockName, setStockName] = useState('');
  const [openPrice, setOpenPrice] = useState('');
  const [openAmount, setOpenAmount] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);

  // 新建建仓
  const handleOpenPosition = () => {
    if (!stockName.trim()) return;
    const price = Number(openPrice);
    const amount = Number(openAmount);
    if (!price || !amount || !isValidLotSize(amount)) return;

    const now = new Date().toISOString();
    const batch: PositionBatch = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: now,
      type: 'open',
      price,
      amount,
      costAfter: price,
      amountAfter: amount,
    };

    const pos: Position = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      stockName: stockName.trim(),
      currentCost: price,
      currentAmount: amount,
      batches: [batch],
      isClosed: false,
      createdAt: now,
    };

    addPosition(pos);
    setStockName('');
    setOpenPrice('');
    setOpenAmount('');
  };

  // 加仓/减仓
  const handleBatch = (positionId: string, type: 'add' | 'reduce') => {
    const pos = positions.find((p) => p.id === positionId);
    if (!pos) return;

    const batchPrice = prompt(`输入${type === 'add' ? '加仓' : '减仓'}单价（元）:`);
    if (!batchPrice) return;
    const price = Number(batchPrice);
    if (!price || price <= 0) return;

    const batchAmount = prompt(`输入${type === 'add' ? '加仓' : '减仓'}数量（100整数倍）:`);
    if (!batchAmount) return;
    const amount = Number(batchAmount);
    if (!amount || amount <= 0) return;
    if (type === 'add' && !isValidLotSize(amount)) return;
    if (type === 'reduce') {
      if (amount > pos.currentAmount) return;
      if (amount % 100 !== 0) return;
    }

    // 使用总资金抽回法计算新成本
    const totalInvested = pos.currentCost * pos.currentAmount;
    let newCost: number;
    let newAmount: number;

    if (type === 'add') {
      const addInvested = price * amount;
      newAmount = pos.currentAmount + amount;
      newCost = (totalInvested + addInvested) / newAmount;
    } else {
      // 减仓：总资金抽回法
      newAmount = pos.currentAmount - amount;
      if (newAmount === 0) return;
      // 减仓不改变剩余持仓成本价
      newCost = pos.currentCost;
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
    };

    addBatch(positionId, batch);
    updatePosition(positionId, {
      currentCost: newCost,
      currentAmount: newAmount,
    });
  };

  // 完结建仓
  const handleClose = (id: string) => {
    closePosition(id);
    setCloseConfirmId(null);
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
          <div className="form-group flex items-end">
            <button onClick={handleOpenPosition} className="btn btn-primary btn-block">
              <Plus className="w-4 h-4" />
              建仓
            </button>
          </div>
        </div>
      </div>

      {/* 进行中持仓 */}
      {activePositions.length === 0 && closedPositions.length === 0 && (
        <p className="text-center text-slate-500 py-8 text-sm">暂无持仓记录，请先建仓</p>
      )}

      {activePositions.map((pos) => (
        <div key={pos.id} className="p-4 bg-slate-900 rounded-lg border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-semibold text-slate-200">{pos.stockName}</h4>
            <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">进行中</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm mb-3">
            <div>
              <span className="text-slate-500">成本价</span>
              <p className="text-slate-200 font-medium">¥{pos.currentCost.toFixed(3)}</p>
            </div>
            <div>
              <span className="text-slate-500">持仓数量</span>
              <p className="text-slate-200 font-medium">{pos.currentAmount.toLocaleString()}股</p>
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
              {pos.batches.map((batch) => (
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
                  </div>
                  <span className="text-slate-500">
                    {new Date(batch.timestamp).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* 已结案 */}
      {closedPositions.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-slate-500 mb-2">已结案</h4>
          {closedPositions.map((pos) => (
            <div key={pos.id} className="p-4 bg-slate-900/50 rounded-lg border border-slate-800 mb-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-slate-400">{pos.stockName}</span>
                  <span className="ml-2 text-xs text-slate-600">
                    ¥{pos.currentCost.toFixed(3)} × {pos.currentAmount.toLocaleString()}股
                  </span>
                </div>
                <span className="text-xs text-slate-500">
                  {pos.closedAt ? new Date(pos.closedAt).toLocaleDateString() : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
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
    // 将当前持仓更新为"当前持仓 + 向下整手补仓数量"，反映建仓后的新总持仓
    const newAmount = Number(currentAmount) + result.downLot.amount;
    setCurrentAmount(String(newAmount));
    // 自动重新推算
    const cc = Number(currentCost);
    const pp = Number(plannedPrice);
    const tc = Number(targetCost);
    if (cc && pp && tc && newAmount > 0) {
      setResult(calcTargetCostAveraging(cc, newAmount, pp, tc));
    }
  };

  const handleFillUp = () => {
    if (!result?.upLot) return;
    // 将当前持仓更新为"当前持仓 + 向上整手补仓数量"，反映建仓后的新总持仓
    const newAmount = Number(currentAmount) + result.upLot.amount;
    setCurrentAmount(String(newAmount));
    // 自动重新推算
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
          {/* 理论结果 */}
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

          {/* 整手对比 */}
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

          {/* 建议 */}
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