/**
 * @file StrategyOverviewCard.tsx
 * @description 策略运行总体概览卡：当操作时间线为 0 笔交易时，展示对应策略的
 *              画像（策略名 / 描述 / 参数 / 预算硬上限）与「为何空仓」的决策说明。
 *              属纯展示组件。
 * @layer UI
 */

/** 策略运行总体概览数据（由父级从方案分支构建） */
export interface StrategyOverviewData {
  /** 策略名 */
  name: string;
  /** 一行描述 */
  description?: string;
  /** 参数键值对（label / 已格式化 value） */
  params?: { label: string; value: string }[];
  /** 模拟资金（元） */
  simulatedCash: number;
  /** 历史资金占用峰值 = 预算硬上限（元） */
  peakCapitalLock: number;
}

interface StrategyOverviewCardProps {
  overview: StrategyOverviewData;
  /** 空仓决策说明（策略自身零成交原因） */
  inactivityReason?: string;
  /** 策略生成的订单数（表头角标；默认 0） */
  tradeCount?: number;
}

/**
 * 策略运行总体概览卡。
 *
 * @param {StrategyOverviewCardProps} props - 见接口定义
 * @returns {JSX.Element} 概览卡
 */
export default function StrategyOverviewCard({ overview, inactivityReason, tradeCount = 0 }: StrategyOverviewCardProps) {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
      <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-700/50 pb-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-200">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />策略运行总体概览
        </span>
        <span className="text-[10px] text-slate-500">{tradeCount} 笔交易</span>
      </div>
      <div className="text-[13px] font-semibold text-slate-100">{overview.name}</div>
      {overview.description && <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{overview.description}</p>}
      {overview.params && overview.params.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {overview.params.map((o) => (
            <span key={o.label} className="inline-flex items-center gap-1 rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] text-slate-300"><span className="text-slate-500">{o.label}</span><span className="font-mono">{o.value}</span></span>
          ))}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded bg-slate-800/60 border border-slate-700/40 px-2 py-1.5">
          <div className="text-[9px] text-slate-500">模拟资金</div>
          <div className="font-mono text-slate-100">¥{overview.simulatedCash.toLocaleString('zh-CN')}</div>
        </div>
        <div className="rounded bg-slate-800/60 border border-slate-700/40 px-2 py-1.5">
          <div className="text-[9px] text-slate-500">预算硬上限</div>
          <div className="font-mono text-slate-100">¥{overview.peakCapitalLock.toLocaleString('zh-CN')}</div>
        </div>
      </div>
      {inactivityReason && (
        <div className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2">
          <div className="mb-0.5 text-[9px] font-medium text-blue-400">策略决策说明 · 为何空仓</div>
          <p className="text-[11px] leading-relaxed text-slate-300">{inactivityReason}</p>
        </div>
      )}
    </div>
  );
}
