/**
 * @file CopilotActionCards.tsx
 * @description Copilot 待确认动作卡（confirm 级动作队列）：渲染于浮窗消息列表与输入区之间，
 *              用户点「执行」才落地业务操作，「忽略」出队。AI 只建议，用户拍板。
 *              confirm 级动作当前无注册类型，组件随首批业务动作在 copilotActionSlice
 *              执行器注册表登记后自动生效。
 * @layer UI (Component) —— 只读 store + 调执行/忽略 action（R1 合规）
 * @storage_impact 纯内存态消费，不落库。
 * @author 开发团队
 */

import { ClipboardCheck } from 'lucide-react';
import { useAppStore } from '../../store';

export default function CopilotActionCards() {
  const pending = useAppStore((s) => s.pendingCopilotActions);
  const execute = useAppStore((s) => s.executePendingCopilotAction);
  const dismiss = useAppStore((s) => s.dismissPendingCopilotAction);
  if (pending.length === 0) return null;

  return (
    <div className="px-2.5 pt-2 space-y-1.5" role="list" aria-label="AI 建议的待确认操作">
      {pending.map((a) => (
        <div
          key={a.id}
          role="listitem"
          className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2"
        >
          <ClipboardCheck className="w-4 h-4 flex-shrink-0 text-amber-400" />
          <span className="text-[11px] text-amber-200 truncate" title={a.label}>
            {a.label}
          </span>
          <div className="ml-auto flex gap-1 flex-shrink-0">
            <button
              onClick={() => dismiss(a.id)}
              className="px-2 py-1 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 transition-colors"
            >
              忽略
            </button>
            <button
              onClick={() => execute(a.id)}
              className="px-2 py-1 rounded-lg text-[11px] bg-amber-500 hover:bg-amber-400 text-slate-900 font-medium transition-colors"
            >
              执行
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
