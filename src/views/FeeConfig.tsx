/**
 * @file FeeConfig.tsx
 * @description 费率配置页：维护全市场交易规费模板（佣金率/免五开关/过户费/印花税），
 *              实时测算买卖一手费用试算，并支持持久化保存、JSON/CSV 导入导出。
 *              保存后通过 Store 广播 setFeeConfig 触发做T流水池全局级联重算。
 * @layer UI
 * @storage_impact 写入 settings 表（feeConfig 记录）；间接影响 tStreams/positions 等
 *                 依赖费率的计算口径（由 store 级联重算触发）。
 * @author 开发团队
 */

import React, { useState, useMemo } from 'react';
import { Save, Download, Upload, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { useAppStore, FEE_TEMPLATES } from '../store';
import { useLiveQuery } from 'dexie-react-hooks';
import { getFeeConfig } from '../services/ledgerService';
import { calcFeeBreakdown } from '../utils/mathUtils';
import type { FeeConfig } from '../utils/mathUtils';

/**
 * 费率配置页面组件。
 *
 * @description 加载远程/本地费率配置到表单，支持：
 *  - 修改佣金率、过户费率、印花税率与「最低佣金 5 元」开关
 *  - 实时测算输入基准价格×数量的买卖双方费用明细
 *  - 保存配置、重置为系统模板、JSON/CSV 导入导出
 * @returns {JSX.Element} 费率配置页视图
 * @note 保存动作调用 useAppStore.setFeeConfig，最终写入 IndexedDB settings 表；
 *       导入 JSON/CSV 后需手工点保存才会持久化
 */
export default function FeeConfigPage() {
  const { setFeeConfig, exportJSON, importJSON, exportCSV } = useAppStore();
  const feeConfig = useLiveQuery(async () => await getFeeConfig(), [], undefined) as FeeConfig | null;

  const [localConfig, setLocalConfig] = useState<FeeConfig>({ ...(feeConfig ?? FEE_TEMPLATES['A股标准模板']) });
  const [hasChanges, setHasChanges] = useState(false);
  const [feeTab, setFeeTab] = useState<'stock' | 'etf'>('stock');

  // 实时测算基准
  const [benchPrice, setBenchPrice] = useState('10');
  const [benchAmount, setBenchAmount] = useState('100');

  const buyFee = useMemo(() => {
    const p = Number(benchPrice) || 10;
    const a = Number(benchAmount) || 100;
    return calcFeeBreakdown(p * a, 'buy', localConfig);
  }, [benchPrice, benchAmount, localConfig]);

  const sellFee = useMemo(() => {
    const p = Number(benchPrice) || 10;
    const a = Number(benchAmount) || 100;
    return calcFeeBreakdown(p * a, 'sell', localConfig);
  }, [benchPrice, benchAmount, localConfig]);

  const handleSave = () => {
    setFeeConfig(localConfig);
    setHasChanges(false);
  };

  const handleReset = () => {
    setLocalConfig({ ...(feeConfig ?? FEE_TEMPLATES['A股标准模板']) });
    setHasChanges(false);
  };

  const handleChange = (key: keyof FeeConfig, value: number | boolean) => {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  // 预设模板
  const applyTemplate = (template: keyof typeof FEE_TEMPLATES) => {
    setLocalConfig({ ...FEE_TEMPLATES[template] });
    setHasChanges(true);
  };

  // JSON 导入
  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          importJSON(data);
          setLocalConfig({ ...(data.feeConfig || data) });
        } catch (err) {
          alert('JSON 格式错误');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  // JSON 导出
  const handleExport = () => {
    const data = exportJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stock-calculator-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // CSV 导出
  const handleExportCSV = () => {
    const csv = exportCSV();
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `t-records-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page-container space-y-5">
      {/* 费率配置 */}
      <div className="card">
        <h3>费率配置</h3>

        {/* 预设模板 */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => applyTemplate('A股标准模板')}
            className="btn btn-outline btn-sm flex-1"
          >
            A股标准模板
          </button>
          <button
            onClick={() => applyTemplate('港股/美股免佣模板')}
            className="btn btn-outline btn-sm flex-1"
          >
            港股/美股免佣模板
          </button>
        </div>

        {/* 股票/ETF Tab */}
        <div className="flex gap-1 mb-4 bg-slate-800 rounded-lg p-1">
          <button
            onClick={() => setFeeTab('stock')}
            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
              feeTab === 'stock' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            股票费率
          </button>
          <button
            onClick={() => setFeeTab('etf')}
            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
              feeTab === 'etf' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            ETF 费率
          </button>
        </div>

        {feeTab === 'stock' && (
        <div className="space-y-3">
          <div className="form-group">
            <label>佣金率</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.00001"
                min="0"
                max="0.003"
                value={localConfig.commissionRate}
                onChange={(e) => handleChange('commissionRate', Number(e.target.value))}
              />
              <span className="text-xs text-slate-500">（当前 {(localConfig.commissionRate * 100).toFixed(3)}%）</span>
            </div>
          </div>

          <div className="flex items-center justify-between py-3 border-b border-slate-800">
            <div>
              <span className="text-sm text-slate-300">免五</span>
              <p className="text-xs text-slate-500">
                {localConfig.isFreeFive ? '开启免五，可自定义最低佣金' : '关闭免五，最低佣金强制5元'}
              </p>
            </div>
            <button
              onClick={() => handleChange('isFreeFive', !localConfig.isFreeFive)}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                localConfig.isFreeFive ? 'bg-blue-600' : 'bg-slate-700'
              }`}
            >
              <div
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  localConfig.isFreeFive ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {localConfig.isFreeFive && (
            <div className="form-group">
              <label>自定义最低佣金（元）</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={localConfig.minCommission}
                onChange={(e) => handleChange('minCommission', Number(e.target.value))}
              />
            </div>
          )}

          <div className="form-group">
            <label>过户费率</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.00001"
                min="0"
                value={localConfig.transferRate}
                onChange={(e) => handleChange('transferRate', Number(e.target.value))}
              />
              <span className="text-xs text-slate-500">（当前 {(localConfig.transferRate * 100).toFixed(3)}%）</span>
            </div>
          </div>

          <div className="form-group">
            <label>印花税率</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.00001"
                min="0"
                value={localConfig.stampRate}
                onChange={(e) => handleChange('stampRate', Number(e.target.value))}
              />
              <span className="text-xs text-slate-500">（当前 {(localConfig.stampRate * 100).toFixed(3)}%）</span>
            </div>
          </div>
        </div>
        )}

        {feeTab === 'etf' && (
        <div className="space-y-3">
          <div className="form-group">
            <label>ETF 佣金率</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.00001"
                min="0"
                max="0.003"
                value={localConfig.etfCommissionRate ?? localConfig.commissionRate}
                onChange={(e) => handleChange('etfCommissionRate', Number(e.target.value))}
              />
              <span className="text-xs text-slate-500">（当前 {((localConfig.etfCommissionRate ?? localConfig.commissionRate) * 100).toFixed(3)}%）</span>
            </div>
          </div>

          <div className="flex items-center justify-between py-3 border-b border-slate-800">
            <div>
              <span className="text-sm text-slate-300">ETF 免五</span>
              <p className="text-xs text-slate-500">
                {localConfig.etfIsFreeFive ?? localConfig.isFreeFive ? '开启免五，可自定义最低佣金' : '关闭免五'}
              </p>
            </div>
            <button
              onClick={() => handleChange('etfIsFreeFive', !(localConfig.etfIsFreeFive ?? localConfig.isFreeFive))}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                (localConfig.etfIsFreeFive ?? localConfig.isFreeFive) ? 'bg-blue-600' : 'bg-slate-700'
              }`}
            >
              <div
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  (localConfig.etfIsFreeFive ?? localConfig.isFreeFive) ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="form-group">
            <label>ETF 最低佣金（元）</label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={localConfig.etfMinCommission ?? localConfig.minCommission}
              onChange={(e) => handleChange('etfMinCommission', Number(e.target.value))}
            />
          </div>

          <div className="form-group">
            <label>ETF 过户费率</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.00001"
                min="0"
                value={localConfig.etfTransferRate ?? localConfig.transferRate}
                onChange={(e) => handleChange('etfTransferRate', Number(e.target.value))}
              />
              <span className="text-xs text-slate-500">（ETF 通常为 0）</span>
            </div>
          </div>

          <div className="form-group">
            <label>ETF 印花税率</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.00001"
                min="0"
                value={localConfig.etfStampRate ?? localConfig.stampRate}
                onChange={(e) => handleChange('etfStampRate', Number(e.target.value))}
              />
              <span className="text-xs text-slate-500">（ETF 通常为 0）</span>
            </div>
          </div>
        </div>
        )}

        {/* 保存/重置 */}
        <div className="flex gap-3 mt-4">
          <button
            onClick={handleSave}
            disabled={!hasChanges}
            className="btn btn-primary flex-1"
          >
            <Save className="w-4 h-4" />
            保存配置
          </button>
          <button
            onClick={handleReset}
            disabled={!hasChanges}
            className="btn btn-outline"
          >
            <RefreshCw className="w-4 h-4" />
            重置
          </button>
        </div>
      </div>

      {/* 实时测算表格 */}
      <div className="card">
        <h3>实时测算</h3>

        <div className="form-row">
          <div className="form-group">
            <label>基准价格（元）</label>
            <input
              type="number"
              step="0.01"
              value={benchPrice}
              onChange={(e) => setBenchPrice(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>基准数量（股）</label>
            <input
              type="number"
              step="100"
              value={benchAmount}
              onChange={(e) => setBenchAmount(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-500 text-xs border-b border-slate-700">
                <th className="text-left py-2 pr-3">费用项目</th>
                <th className="text-right py-2 px-3">买入</th>
                <th className="text-right py-2 pl-3">卖出</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-800">
                <td className="py-2.5 pr-3 text-slate-400">佣金</td>
                <td className="text-right py-2.5 px-3 text-slate-300">¥{buyFee.commission.toFixed(2)}</td>
                <td className="text-right py-2.5 pl-3 text-slate-300">¥{sellFee.commission.toFixed(2)}</td>
              </tr>
              <tr className="border-b border-slate-800">
                <td className="py-2.5 pr-3 text-slate-400">过户费</td>
                <td className="text-right py-2.5 px-3 text-slate-300">¥{buyFee.transfer.toFixed(2)}</td>
                <td className="text-right py-2.5 pl-3 text-slate-300">¥{sellFee.transfer.toFixed(2)}</td>
              </tr>
              <tr className="border-b border-slate-800">
                <td className="py-2.5 pr-3 text-slate-400">印花税</td>
                <td className="text-right py-2.5 px-3 text-slate-300">¥{buyFee.stamp.toFixed(2)}</td>
                <td className="text-right py-2.5 pl-3 text-slate-300">¥{sellFee.stamp.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-3 text-slate-300 font-medium">合计</td>
                <td className="text-right py-2.5 px-3 text-red-400 font-bold">¥{buyFee.total.toFixed(2)}</td>
                <td className="text-right py-2.5 pl-3 text-red-400 font-bold">¥{sellFee.total.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 数据管理 */}
      <div className="card">
        <h3>数据管理</h3>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={handleImport} className="btn btn-outline">
            <Upload className="w-4 h-4" />
            JSON 导入
          </button>
          <button onClick={handleExport} className="btn btn-outline">
            <Download className="w-4 h-4" />
            JSON 导出
          </button>
          <button onClick={handleExportCSV} className="btn btn-outline col-span-2">
            <FileSpreadsheet className="w-4 h-4" />
            导出 CSV 做T账本
          </button>
        </div>
      </div>
    </div>
  );
}