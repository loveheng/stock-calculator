import React, { useState } from 'react';
import { TrendingUp, TrendingDown, Calculator } from 'lucide-react';
import { calcChangeRate, calcTargetPrice, calcContinuousLimits } from '../utils/mathUtils';
import type { ContinuousLimitResult } from '../utils/mathUtils';

export default function ChangeRate() {
  const [basePrice, setBasePrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [percent, setPercent] = useState('');
  const [days, setDays] = useState('1');
  const [limits, setLimits] = useState<ContinuousLimitResult[]>([]);

  const result = basePrice && targetPrice
    ? calcChangeRate(Number(basePrice), Number(targetPrice))
    : null;

  const targetResult = basePrice && percent
    ? calcTargetPrice(Number(basePrice), Number(percent))
    : null;

  const handleCalcLimits = () => {
    if (!basePrice) return;
    const d = Math.max(1, Math.min(30, Number(days) || 1));
    setLimits(calcContinuousLimits(Number(basePrice), d, 10));
  };

  return (
    <div className="page-container space-y-5">
      <div className="card">
        <h3>涨跌幅计算</h3>
        <div className="form-group">
          <label>基准价格（元）</label>
          <input
            type="number"
            step="0.001"
            placeholder="输入基准价格"
            value={basePrice}
            onChange={(e) => setBasePrice(e.target.value)}
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>目标价格（元）</label>
            <input
              type="number"
              step="0.001"
              placeholder="输入目标价格"
              value={targetPrice}
              onChange={(e) => setTargetPrice(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>涨跌幅百分比（%）</label>
            <input
              type="number"
              step="0.1"
              placeholder="如 10 表示 +10%"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </div>
        </div>

        {result && (
          <div className="mt-4 p-4 bg-slate-900 rounded-lg">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs text-slate-500">涨跌值</span>
                <p className={`text-lg font-bold ${result.diff >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {result.diff >= 0 ? '+' : ''}{result.diff.toFixed(3)}
                </p>
              </div>
              <div>
                <span className="text-xs text-slate-500">涨跌幅</span>
                <p className={`text-lg font-bold ${result.percent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {result.percent >= 0 ? '+' : ''}{result.percent.toFixed(2)}%
                </p>
              </div>
            </div>
          </div>
        )}

        {targetResult && (
          <div className="mt-4 p-4 bg-slate-900 rounded-lg">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs text-slate-500">目标价格</span>
                <p className="text-lg font-bold text-blue-400">
                  ¥{targetResult.target.toFixed(3)}
                </p>
              </div>
              <div>
                <span className="text-xs text-slate-500">涨跌值</span>
                <p className={`text-lg font-bold ${targetResult.diff >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {targetResult.diff >= 0 ? '+' : ''}{targetResult.diff.toFixed(3)}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 连续涨跌停阶梯 */}
      <div className="card">
        <h3>连续涨跌停阶梯</h3>
        <div className="form-row">
          <div className="form-group">
            <label>连续天数（最大30天）</label>
            <input
              type="number"
              min="1"
              max="30"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <div className="form-group flex items-end">
            <button onClick={handleCalcLimits} className="btn btn-primary btn-block">
              <Calculator className="w-4 h-4" />
              计算阶梯
            </button>
          </div>
        </div>

        {limits.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs border-b border-slate-700">
                  <th className="text-left py-2 pr-3">天数</th>
                  <th className="text-right py-2 px-3">涨停价</th>
                  <th className="text-right py-2 px-3">累计涨幅</th>
                  <th className="text-right py-2 px-3">跌停价</th>
                  <th className="text-right py-2 pl-3">累计跌幅</th>
                </tr>
              </thead>
              <tbody>
                {limits.map((limit) => (
                  <tr key={limit.day} className="border-b border-slate-800">
                    <td className="py-2.5 pr-3 text-slate-400">第{limit.day}天</td>
                    <td className="text-right py-2.5 px-3 text-red-400 font-medium">
                      {limit.upPrice.toFixed(2)}
                    </td>
                    <td className="text-right py-2.5 px-3 text-red-400">
                      +{limit.upPercent.toFixed(2)}%
                    </td>
                    <td className="text-right py-2.5 px-3 text-green-400 font-medium">
                      {limit.downPrice.toFixed(2)}
                    </td>
                    <td className="text-right py-2.5 pl-3 text-green-400">
                      {limit.downPercent.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}