/**
 * @file OversellGuideModal.tsx
 * @description 做T录入超额引导弹窗组件：当用户在正T模式下录入卖出数量 > 当前待对冲数量
 *              （或倒T模式下录入买入数量 > 待回补数量）时弹出，提供三个明确选项——
 *              【仅对冲本轮】/【结清并开启下一轮】/【返回修改】，
 *              防止静默超卖导致账目混乱。
 * @layer UI
 * @storage_impact 本组件自身不直接读写 IndexedDB；通过 props 回调通知父组件执行提交动作。
 * @author 开发团队
 */

import React from 'react';
import { X, AlertTriangle, ArrowRightLeft, RefreshCw, Pencil } from 'lucide-react';
import { type HedgeOvershootInfo } from '../../utils/tStreamEngine';

/**
 * OversellGuideModal 组件入参定义。
 *
 * @property {boolean} open - 是否显示弹窗
 * @property {HedgeOvershootInfo} info - 超额判定信息（kind / mode / hedgeQty / excessQty）
 * @property {number} inputQty - 用户原始输入数量 X
 * @property {boolean} canStartNextRound - 是否有底仓可支撑开启下一轮（正T超卖→倒T；倒T超买→正T）
 * @property {() => void} onOnlyHedge - 选项1【仅对冲本轮】：数量自动修正为 Y 股并提交结清当前 Round
 * @property {() => void} onClearAndOpenNext - 选项2【结清并开启下一轮】：Y 股结清当前 Round，超出部分 X−Y 建立新 Round
 * @property {() => void} onCancel - 选项3【返回修改】：关闭弹窗，由用户重新输入数量
 */
interface OversellGuideModalProps {
  open: boolean;
  info: HedgeOvershootInfo;
  inputQty: number;
  canStartNextRound: boolean;
  onOnlyHedge: () => void;
  onClearAndOpenNext: () => void;
  onCancel: () => void;
}

/**
 * 做T录入超额引导弹窗组件。
 *
 * @description 正T超卖（long_sell）或倒T超买（short_buy）时展示三选项引导；
 *              选项2在正T场景开启下一轮倒T，在倒T场景开启下一轮正T。
 * @param {OversellGuideModalProps} props - 见 {@link OversellGuideModalProps}
 * @returns {JSX.Element | null} 弹窗视图；open=false 或未触发时返回 null
 * @note 本组件只做引导展示，实际提交动作（修正数量/拆两笔）由父组件回调执行
 */
export default function OversellGuideModal({
  open,
  info,
  inputQty,
  canStartNextRound,
  onOnlyHedge,
  onClearAndOpenNext,
  onCancel,
}: OversellGuideModalProps) {
  if (!open || !info.isTriggered) return null;

  const isLongSell = info.kind === 'long_sell';
  const hedgeQty = info.hedgeQty;
  const excessQty = info.excessQty;
  // 选项2 开启的新 Round 名称：正T超卖->倒T；倒T超买->正T
  const nextRoundLabel = isLongSell ? '倒T' : '正T';
  const actionLabel = isLongSell ? '卖出' : '买入';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-slate-800 rounded-xl border border-slate-700 shadow-2xl max-w-md w-full p-6 animate-[fadeInUp_0.2s_ease-out]">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center gap-2 text-amber-400">
            <AlertTriangle className="w-5 h-5" />
          </span>
          <h3 className="text-base font-semibold text-slate-200">
            {isLongSell ? '卖出数量超出待对冲量' : '买入数量超出待回补量'}
          </h3>
          <button
            onClick={onCancel}
            className="ml-auto p-1 rounded-lg hover:bg-slate-700 text-slate-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 超额提示正文 */}
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg mb-4 text-sm">
          {isLongSell ? (
            <span className="text-red-300">
              卖出数量（<span className="font-bold text-red-200">{inputQty}股</span>）
              超过当前正T待对冲数量（<span className="font-bold text-red-200">{hedgeQty}股</span>）
            </span>
          ) : (
            <span className="text-red-300">
              买入数量（<span className="font-bold text-red-200">{inputQty}股</span>）
              超过当前倒T待回补数量（<span className="font-bold text-red-200">{hedgeQty}股</span>）
            </span>
          )}
          <div className="mt-2 text-xs text-red-400">
            直接提交将产生超卖/超买，请选择处理方式：
          </div>
        </div>

        {/* 三个明确选项 */}
        <div className="space-y-2.5">
          {/* 选项1：仅对冲本轮 */}
          <button
            onClick={onOnlyHedge}
            className="w-full flex items-start gap-3 p-3 rounded-xl bg-slate-900 border border-slate-700 hover:border-blue-500 hover:bg-slate-800 text-left transition-colors"
          >
            <ArrowRightLeft className="w-4 h-4 mt-0.5 text-blue-400 shrink-0" />
            <div>
              <div className="text-sm font-medium text-slate-200">仅对冲本轮</div>
              <div className="text-xs text-slate-400 mt-0.5">
                将本次{actionLabel}数量自动修正为 {hedgeQty} 股，提交并结清当前 Round
              </div>
            </div>
          </button>

          {/* 选项2：结清并开启下一轮 */}
          <button
            onClick={onClearAndOpenNext}
            disabled={!canStartNextRound}
            className={`w-full flex items-start gap-3 p-3 rounded-xl bg-slate-900 border text-left transition-colors ${
              canStartNextRound
                ? 'border-slate-700 hover:border-amber-500 hover:bg-slate-800'
                : 'border-slate-800 opacity-50 cursor-not-allowed'
            }`}
          >
            <RefreshCw className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
            <div>
              <div className="text-sm font-medium text-slate-200">
                结清并开启下一轮{nextRoundLabel}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                {hedgeQty} 股用于结清当前 Round，超出部分（{excessQty} 股）自动建立新的 Round（{nextRoundLabel}模式）
              </div>
              {!canStartNextRound && (
                <div className="text-xs text-red-400 mt-1">
                  ⚠️ 无可卖底仓持仓，无法开启下一轮{nextRoundLabel}
                </div>
              )}
            </div>
          </button>

          {/* 选项3：返回修改 */}
          <button
            onClick={onCancel}
            className="w-full flex items-start gap-3 p-3 rounded-xl bg-slate-900 border border-slate-700 hover:border-slate-500 hover:bg-slate-800 text-left transition-colors"
          >
            <Pencil className="w-4 h-4 mt-0.5 text-slate-400 shrink-0" />
            <div>
              <div className="text-sm font-medium text-slate-200">返回修改</div>
              <div className="text-xs text-slate-400 mt-0.5">
                关闭弹窗，由您重新输入数量
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}