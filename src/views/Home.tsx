import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  TrendingUp,
  BarChart3,
  PieChart,
  Settings,
  DollarSign,
  Activity,
  TrendingDown,
} from 'lucide-react';
import { useAppStore } from '../store';
import { roundTo } from '../utils/mathUtils';

export default function Home() {
  const navigate = useNavigate();
  const { tRecords } = useAppStore();

  const totalTrades = tRecords.length;
  const totalFee = tRecords.reduce((sum, r) => sum + r.totalFee, 0);
  const totalProfit = tRecords.reduce((sum, r) => sum + r.netProfit, 0);
  const winTrades = tRecords.filter((r) => r.netProfit > 0).length;
  const winRate = totalTrades > 0 ? roundTo((winTrades / totalTrades) * 100, 1).toFixed(1) : '0.0';

  const quickCards = [
    {
      label: '做T计算器',
      icon: RefreshCw,
      path: '/t-calculator',
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
    },
    {
      label: '涨跌幅计算',
      icon: TrendingUp,
      path: '/change-rate',
      color: 'text-green-400',
      bg: 'bg-green-500/10',
    },
    {
      label: '成本摊薄',
      icon: BarChart3,
      path: '/cost-averaging',
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
    },
    {
      label: '数据统计',
      icon: PieChart,
      path: '/statistics',
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
    },
    {
      label: '费率配置',
      icon: Settings,
      path: '/fee-config',
      color: 'text-slate-400',
      bg: 'bg-slate-500/10',
    },
  ];

  return (
    <div className="page-container space-y-6">
      {/* 概览卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card mb-0">
          <div className="flex items-center gap-2 text-slate-500 mb-2">
            <Activity className="w-4 h-4" />
            <span className="text-xs">累计做T笔数</span>
          </div>
          <p className="text-2xl font-bold text-white">{totalTrades}</p>
        </div>

        <div className="card mb-0">
          <div className="flex items-center gap-2 text-slate-500 mb-2">
            <DollarSign className="w-4 h-4" />
            <span className="text-xs">摩擦成本总额</span>
          </div>
          <p className="text-2xl font-bold text-red-400">¥{roundTo(totalFee, 2).toFixed(2)}</p>
        </div>

        <div className="card mb-0">
          <div className="flex items-center gap-2 text-slate-500 mb-2">
            <TrendingUp className="w-4 h-4" />
            <span className="text-xs">做T净利润</span>
          </div>
          <p
            className={`text-2xl font-bold ${
              totalProfit >= 0 ? 'text-green-400' : 'text-red-400'
            }`}
          >
            {totalProfit >= 0 ? '+' : ''}¥{roundTo(totalProfit, 2).toFixed(2)}
          </p>
        </div>

        <div className="card mb-0">
          <div className="flex items-center gap-2 text-slate-500 mb-2">
            <TrendingDown className="w-4 h-4" />
            <span className="text-xs">胜率</span>
          </div>
          <p className="text-2xl font-bold text-white">{winRate}%</p>
        </div>
      </div>

      {/* 快捷入口 */}
      <div>
        <h3 className="text-base font-semibold text-slate-300 mb-3">快捷入口</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {quickCards.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.path}
                onClick={() => navigate(card.path)}
                className="card flex items-center gap-3 p-4 hover:bg-slate-750 transition-colors cursor-pointer border-slate-700 hover:border-slate-600 mb-0"
              >
                <div className={`p-2.5 rounded-lg ${card.bg}`}>
                  <Icon className={`w-5 h-5 ${card.color}`} />
                </div>
                <span className="text-sm font-medium text-slate-300">
                  {card.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 提示信息 */}
      <div className="card">
        <h3 className="text-base font-semibold text-slate-300 mb-2">使用说明</h3>
        <ul className="space-y-2 text-sm text-slate-400">
          <li>• 做T计算器：支持正T（先买后卖）和倒T（先卖后买）两种模式</li>
          <li>• 涨跌幅计算：支持连续涨跌停阶梯推算</li>
          <li>• 成本摊薄：多批次建仓账本 + 目标成本推算工具</li>
          <li>• 数据统计：做T账本统计与建仓履历展示</li>
          <li>• 费率配置：自定义佣金率、免五开关、过户费/印花税率</li>
        </ul>
      </div>
    </div>
  );
}