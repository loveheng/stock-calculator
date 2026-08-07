import React, { useState } from 'react';
import { X, Save } from 'lucide-react';
import { type TRecord } from '../../store';
import { calcTTrade, type FeeConfig } from '../../utils/mathUtils';

interface CompleteTModalProps {
  open: boolean;
  record: TRecord;
  feeConfig: FeeConfig;
  onConfirm: (id: string, updates: Partial<TRecord>) => void;
  onCancel: () => void;
}

export default function CompleteTModal({
  open,
  record,
  feeConfig,
  onConfirm,
  onCancel,
}: CompleteTModalProps) {
  const isLong = record.mode === 'long';
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  if (!open) return null;

  const handleSubmit = () => {
    const p = Number(price);
    const a = Number(amount);
    if (!p || p <= 0 || !a || a <= 0) return;

    // Build the complete trade params
    let buyPrice = record.buyPrice;
    let buyAmount = record.buyAmount;
    let sellPrice = record.sellPrice;
    let sellAmount = record.sellAmount;

    if (isLong) {
      // 正T: 补全卖出价/量
      sellPrice = p;
      sellAmount = a;
    } else {
      // 倒T: 补全买入价/量
      buyPrice = p;
      buyAmount = a;
    }

    const result = calcTTrade(
      {
        mode: record.mode,
        buyPrice,
        buyAmount,
        sellPrice,
        sellAmount,
      },
      feeConfig
    );

    const updates: Partial<TRecord> = {
      buyPrice,
      buyAmount,
      sellPrice,
      sellAmount,
      totalFee: result.totalFee || 0,
      netProfit: result.netProfit,
      profitRate: result.profitRate,
      status: 'CLOSED',
    };

    onConfirm(record.id, updates);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-slate-800 rounded-xl border border-slate-700 shadow-2xl max-w-md w-full p-6 animate-[fadeInUp_0.2s_ease-out]">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-base font-semibold text-slate-200">
            {isLong ? '补全卖出信息' : '补全买入信息'}
          </h3>
          <button
            onClick={onCancel}
            className="ml-auto p-1 rounded-lg hover:bg-slate-700 text-slate-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 原记录信息 */}
        <div className="p-3 bg-slate-900 rounded-lg mb-4 text-xs space-y-1">
          <div className="text-slate-500">
            股票：<span className="text-slate-300">{record.stockName || '未命名'}</span>
          </div>
          <div className="text-slate-500">
            模式：<span className={`${isLong ? 'text-red-400' : 'text-green-400'}`}>
              {isLong ? '正T（先买后卖）' : '倒T（先卖后买）'}
            </span>
          </div>
          {isLong ? (
            <div className="text-slate-500">
              已买入：<span className="text-slate-300">¥{record.buyPrice.toFixed(3)} × {record.buyAmount}股</span>
            </div>
          ) : (
            <div className="text-slate-500">
              已卖出：<span className="text-slate-300">¥{record.sellPrice.toFixed(3)} × {record.sellAmount}股</span>
            </div>
          )}
          <div className="text-slate-500">
            已产生摩擦成本：<span className="text-red-400">¥{record.totalFee.toFixed(2)}</span>
          </div>
        </div>

        {/* 补全表单 */}
        <div className="space-y-3">
          <div className="form-group">
            <label>{isLong ? '卖出价（元）' : '接回买入价（元）'}</label>
            <input
              type="number"
              step="0.001"
              placeholder={isLong ? '填写卖出单价' : '填写接回买入单价'}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{isLong ? '卖出数量（股）' : '买入数量（股）'}</label>
            <input
              type="number"
              step="100"
              placeholder={isLong ? `默认 ${record.buyAmount} 股` : `默认 ${record.sellAmount} 股`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>交易备注（可选）</label>
            <input
              type="text"
              placeholder="如：部分平仓、补充记录等"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button onClick={onCancel} className="btn btn-outline btn-sm">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!price || Number(price) <= 0 || !amount || Number(amount) <= 0}
            className="btn btn-primary btn-sm"
          >
            <Save className="w-4 h-4" />
            确认平仓
          </button>
        </div>
      </div>
    </div>
  );
}