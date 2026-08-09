/**
 * @file CompleteTModal.tsx
 * @description 补全做T（正T卖出/倒T买入）交易参数弹窗组件：
 *              输入对手盘价格/数量后调用 calcTTrade 计算实际净收益与费用明细，
 *              确认后通过 onConfirm(id, updates) 回写 store 完成 T 落库。
 * @layer UI
 * @storage_impact 本组件自身不直接读写 IndexedDB；通过 props.onConfirm 回调
 *                 （由父组件传入 store 的 completeTTrade）间接更新 tRecords 表。
 * @author 开发团队
 */

import React, { useState } from 'react';
import { X, Save } from 'lucide-react';
import { type TRecord } from '../../store';
import { calcTTrade, type FeeConfig } from '../../utils/mathUtils';

/**
 * CompleteTModal 组件入参定义。
 *
 * @property {boolean} open - 是否显示弹窗
 * @property {TRecord} record - 待补全的做T记录（含 mode/buyPrice/buyAmount/sellPrice/sellAmount 初始值）
 * @property {FeeConfig} feeConfig - 费率配置模板（佣金/印花税/过户费）
 * @property {(id: string, updates: Partial<TRecord>) => void} onConfirm - 确认回调：传入记录 ID 与补全字段
 * @property {() => void} onCancel - 取消回调
 */
interface CompleteTModalProps {
  open: boolean;
  record: TRecord;
  feeConfig: FeeConfig;
  onConfirm: (id: string, updates: Partial<TRecord>) => void;
  onCancel: () => void;
}

/**
 * 补全做T交易参数弹窗组件。
 *
 * @description 正T模式下补全卖出价/量，倒T模式下补全买入价/量；
 *              通过 calcTTrade 预估完成交易后的净收益与费用，确认后回调 onConfirm 提交。
 * @param {CompleteTModalProps} props - 见 {@link CompleteTModalProps}
 * @returns {JSX.Element | null} 弹窗视图；open=false 时返回 null
 * @note 本组件只做计算预览，不直接改库；落库动作由父组件传入的 onConfirm 完成
 */
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