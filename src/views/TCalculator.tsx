import React, { useState } from 'react';
import { RefreshCw, Save, RotateCcw, ArrowUpDown } from 'lucide-react';
import { useAppStore } from '../store';
import { calcTTrade } from '../utils/mathUtils';
import type { TTradeResult } from '../utils/mathUtils';

export default function TCalculator() {
  const { feeConfig, addTRecord } = useAppStore();

  // 模式：'long' = 正T（先买后卖），'short' = 倒T（先卖后买）
  const [mode, setMode] = useState<'long' | 'short'>('long');
  const [stockName, setStockName] = useState('');
  const [buyPrice, setBuyPrice] = useState('');
  const [buyAmount, setBuyAmount] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [sellAmount, setSellAmount] = useState('');
  const [result, setResult] = useState<TTradeResult | null>(null);

  const handleCalculate = () => {
    // 严格定义 mode 变量，确保作用域安全
    const currentMode = mode;
    const bp = buyPrice ? Number(buyPrice) : 0;
    const ba = buyAmount ? Number(buyAmount) : 0;
    const sp = sellPrice ? Number(sellPrice) : 0;
    const sa = sellAmount ? Number(sellAmount) : 0;

    const res = calcTTrade(
      {
        mode: currentMode,
        buyPrice: bp,
        buyAmount: ba,
        sellPrice: sp,
        sellAmount: sa,
      },
      feeConfig
    );
    setResult(res);
  };

  const handleSave = () => {
    if (!result || !result.isClosed) return;
    if (!stockName.trim()) return;

    addTRecord({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      stockName: stockName.trim(),
      mode,
      buyPrice: Number(buyPrice),
      buyAmount: Number(buyAmount),
      sellPrice: Number(sellPrice),
      sellAmount: Number(sellAmount),
      totalFee: result.totalFee || 0,
      netProfit: result.netProfit || 0,
      profitRate: result.profitRate || 0,
    });

    // 重置表单
    setStockName('');
    setBuyPrice('');
    setBuyAmount('');
    setSellPrice('');
    setSellAmount('');
    setResult(null);
  };

  const handleReset = () => {
    setStockName('');
    setBuyPrice('');
    setBuyAmount('');
    setSellPrice('');
    setSellAmount('');
    setResult(null);
  };

  return (
    <div className="page-container space-y-5">
      <div className="card">
        <h3>做T计算器</h3>

        {/* 模式切换 */}
        <div className="tab-bar">
          <button
            className={`tab-btn ${mode === 'long' ? 'active' : ''}`}
            onClick={() => {
              setMode('long');
              setResult(null);
            }}
          >
            正T（先买后卖）
          </button>
          <button
            className={`tab-btn ${mode === 'short' ? 'active' : ''}`}
            onClick={() => {
              setMode('short');
              setResult(null);
            }}
          >
            倒T（先卖后买）
          </button>
        </div>

        {/* 模式说明 */}
        <div className="p-3 bg-slate-900 rounded-lg mb-4 text-xs text-slate-400">
          {mode === 'long' ? (
            <span>正T：<span className="text-red-400">先买入</span> → 再卖出，推算保本卖出价与资金占用</span>
          ) : (
            <span>倒T：<span className="text-green-400">先卖出</span> → 再买入，推算低位接回保本价与释放资金</span>
          )}
        </div>

        {/* 表单 */}
        <div className="space-y-3">
          <div className="form-group">
            <label>股票名称（可选）</label>
            <input
              type="text"
              placeholder="如：贵州茅台"
              value={stockName}
              onChange={(e) => setStockName(e.target.value)}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>买入价（元）</label>
              <input
                type="number"
                step="0.001"
                placeholder="买入单价"
                value={buyPrice}
                onChange={(e) => setBuyPrice(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>买入股数</label>
              <input
                type="number"
                step="100"
                placeholder="100的整数倍"
                value={buyAmount}
                onChange={(e) => setBuyAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>卖出价（元）</label>
              <input
                type="number"
                step="0.001"
                placeholder="卖出单价"
                value={sellPrice}
                onChange={(e) => setSellPrice(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>卖出股数</label>
              <input
                type="number"
                step="100"
                placeholder="100的整数倍"
                value={sellAmount}
                onChange={(e) => setSellAmount(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3 mt-4">
          <button onClick={handleCalculate} className="btn btn-primary flex-1">
            <RefreshCw className="w-4 h-4" />
            计算
          </button>
          <button onClick={handleReset} className="btn btn-outline">
            <RotateCcw className="w-4 h-4" />
            重置
          </button>
        </div>
      </div>

      {/* 计算结果 */}
      {result && (
        <div className="card">
          <h3>
            {result.isClosed ? '交易结果' : '当前估算'}
            {result.isClosed && (
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                已平仓
              </span>
            )}
          </h3>

          <div className="space-y-3">
            {/* 手续费明细 */}
            {result.buyFee && (
              <div className="p-3 bg-slate-900 rounded-lg">
                <h4 className="text-xs font-medium text-slate-500 mb-2">买入费用</h4>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-slate-500">佣金</span>
                    <p className="text-slate-300 font-medium">¥{result.buyFee.commission.toFixed(2)}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">过户费</span>
                    <p className="text-slate-300 font-medium">¥{result.buyFee.transfer.toFixed(2)}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">合计</span>
                    <p className="text-slate-300 font-medium">¥{result.buyFee.total.toFixed(2)}</p>
                  </div>
                </div>
              </div>
            )}

            {result.sellFee && (
              <div className="p-3 bg-slate-900 rounded-lg">
                <h4 className="text-xs font-medium text-slate-500 mb-2">卖出费用</h4>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-slate-500">印花税</span>
                    <p className="text-slate-300 font-medium">¥{result.sellFee.stamp.toFixed(2)}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">佣金</span>
                    <p className="text-slate-300 font-medium">¥{result.sellFee.commission.toFixed(2)}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">过户费</span>
                    <p className="text-slate-300 font-medium">¥{result.sellFee.transfer.toFixed(2)}</p>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-slate-800 flex justify-between text-xs">
                  <span className="text-slate-500">卖出总费用</span>
                  <span className="text-slate-300 font-medium">¥{result.sellFee.total.toFixed(2)}</span>
                </div>
              </div>
            )}

            {result.totalFee !== null && (
              <div className="p-3 bg-slate-900 rounded-lg flex justify-between items-center">
                <span className="text-sm text-slate-400">总摩擦成本</span>
                <span className="text-lg font-bold text-red-400">¥{result.totalFee.toFixed(2)}</span>
              </div>
            )}

            {/* 正T结果 */}
            {mode === 'long' && (
              <>
                {result.capitalRequired !== null && (
                  <div className="p-3 bg-slate-900 rounded-lg flex justify-between items-center">
                    <span className="text-sm text-slate-400">资金占用</span>
                    <span className="text-lg font-bold text-blue-400">¥{result.capitalRequired.toFixed(2)}</span>
                  </div>
                )}
                {result.breakevenPrice !== null && (
                  <div className="p-3 bg-slate-900 rounded-lg flex justify-between items-center">
                    <span className="text-sm text-slate-400">保本卖出价</span>
                    <span className="text-lg font-bold text-green-400">¥{result.breakevenPrice.toFixed(3)}</span>
                  </div>
                )}
              </>
            )}

            {/* 倒T结果 */}
            {mode === 'short' && (
              <>
                {result.capitalReleased !== null && (
                  <div className="p-3 bg-slate-900 rounded-lg flex justify-between items-center">
                    <span className="text-sm text-slate-400">盘中释放资金</span>
                    <span className="text-lg font-bold text-green-400">¥{result.capitalReleased.toFixed(2)}</span>
                  </div>
                )}
                {result.buybackPrice !== null && (
                  <div className="p-3 bg-slate-900 rounded-lg flex justify-between items-center">
                    <span className="text-sm text-slate-400">保本接回价</span>
                    <span className="text-lg font-bold text-blue-400">¥{result.buybackPrice.toFixed(3)}</span>
                  </div>
                )}
              </>
            )}

            {/* 净利润（已平仓） */}
            {result.isClosed && result.netProfit !== null && (
              <div className="p-4 bg-slate-900 rounded-lg flex justify-between items-center">
                <span className="text-sm font-medium text-slate-300">净利润</span>
                <div className="text-right">
                  <p className={`text-xl font-bold ${result.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {result.netProfit >= 0 ? '+' : ''}¥{result.netProfit.toFixed(2)}
                  </p>
                  <p className={`text-xs ${result.netProfit >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {result.profitRate !== null ? `${result.profitRate >= 0 ? '+' : ''}${result.profitRate.toFixed(2)}%` : ''}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 保存按钮 */}
          {result.isClosed && (
            <button
              onClick={handleSave}
              disabled={!stockName.trim()}
              className="btn btn-primary btn-block mt-4"
            >
              <Save className="w-4 h-4" />
              保存记录
            </button>
          )}
        </div>
      )}
    </div>
  );
}