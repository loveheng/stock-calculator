/**
 * @file EmptyStateGuide.tsx
 * @description 空状态三步引导卡（规格书 §9.5）：用户刚进入沙盘页（尚未选择标的）时，
 *              不展示空荡的工作台，直接渲染「🎯 三步看懂这套沙盘」引导卡：
 *              ① 看左侧系统生成的标准策略 → ② 点「复制」创建演练版本 → ③ 调整买卖点
 *              看能否跑赢实盘；底部提供 [进入沙盘]（选择标的）与 [看帮助文档]
 *              （展开白话术语对照表，规格书 §1.5）。
 * @layer UI
 * @storage_impact 纯展示组件；「极简/专业」切换读写 localStorage（见 SandboxPlayback）。
 * @author 开发团队
 */

import React, { useState } from 'react';
import { Target, BookOpen, MousePointerClick, Copy, Sliders } from 'lucide-react';

interface EmptyStateGuideProps {
  /** [进入沙盘] 点击：打开标的选择 */
  onEnter: () => void;
}

/** 白话术语对照表（规格书 §1.5，全站文案契约；供空状态卡与沙盘页帮助弹窗共用） */
export const TERMS: Array<[string, string]> = [
  ['历史最高占用资金', '这套推演的总预算上限 = 你历史上投入过该股票的最大资金量，不能超'],
  ['模拟实盘滑点误差', '成交价不完全等于你输入的价格，会在当天 K 线高低点范围内抖动'],
  ['你的演练版本', '复制系统方案后产生的可随意修改副本，改乱了删掉重来即可'],
  ['死拿不动对照组', '假设从第一笔买入后一直拿着不卖，到今天的收益（Buy & Hold）'],
  ['已扣掉分红除权影响的历史价格', '前复权价格，保证过去与今天的价格处于同一基准'],
];

/**
 * 空状态引导卡组件。
 *
 * @param {EmptyStateGuideProps} props - onEnter：进入沙盘
 * @returns {JSX.Element} 引导卡视图
 */
export default function EmptyStateGuide({ onEnter }: EmptyStateGuideProps) {
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div className="flex items-center justify-center min-h-[420px]">
      <div className="max-w-md w-full bg-slate-800/60 border border-slate-700/60 rounded-2xl p-6 text-center shadow-xl">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center mb-4">
          <Target className="w-7 h-7 text-blue-400" />
        </div>
        <h2 className="text-lg font-bold text-slate-100 mb-1">🎯 三步看懂这套沙盘</h2>
        <p className="text-xs text-slate-500 mb-6">用历史真实走势，验证"如果当初换个打法"会怎样</p>

        <div className="space-y-3 text-left">
          <div className="flex gap-3 items-start bg-slate-900/50 border border-slate-700/40 rounded-xl p-3">
            <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs font-bold flex items-center justify-center shrink-0">1</span>
            <div className="text-xs text-slate-300 leading-relaxed">
              看左侧：系统根据你当年的<b className="text-slate-200">真实操作</b>和 K 线，
              自动生成 <b className="text-violet-300">5 套标准策略</b>（网格/金字塔/止损…）
            </div>
          </div>
          <div className="flex gap-3 items-start bg-slate-900/50 border border-slate-700/40 rounded-xl p-3">
            <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs font-bold flex items-center justify-center shrink-0">2</span>
            <div className="text-xs text-slate-300 leading-relaxed">
              点「<b className="text-violet-300">复制并微调</b>」：创建<b className="text-slate-200">你的演练版本</b>
              （随便改，改乱了删掉重新复制一份即可）
            </div>
          </div>
          <div className="flex gap-3 items-start bg-slate-900/50 border border-slate-700/40 rounded-xl p-3">
            <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs font-bold flex items-center justify-center shrink-0">3</span>
            <div className="text-xs text-slate-300 leading-relaxed">
              点 K 线拖买卖点、改数量，点<b className="text-emerald-300">【运行推演】</b>，
              看能不能跑赢你当年的实盘
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button onClick={onEnter} className="btn btn-primary btn-sm flex-1">
            <MousePointerClick className="w-3.5 h-3.5" />
            进入沙盘（选择标的）
          </button>
          <button
            onClick={() => setShowHelp(!showHelp)}
            className="btn btn-outline btn-sm"
          >
            <BookOpen className="w-3.5 h-3.5" />
            看帮助文档
          </button>
        </div>

        {showHelp && (
          <div className="mt-4 text-left bg-slate-900/60 border border-slate-700/50 rounded-xl p-3 space-y-1.5">
            <div className="text-[11px] font-semibold text-slate-400 flex items-center gap-1">
              <Sliders className="w-3 h-3" />
              白话术语对照
            </div>
            {TERMS.map(([term, desc]) => (
              <p key={term} className="text-[11px] text-slate-500 leading-relaxed">
                <b className="text-slate-300">{term}</b>：{desc}
              </p>
            ))}
            <p className="text-[10px] text-slate-600 mt-1.5">
              <Copy className="inline w-2.5 h-2.5 mr-0.5" />
              提示：系统方案只读，复制后才能改——这是为了让你随时有一个"官方标准答案"对照。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
