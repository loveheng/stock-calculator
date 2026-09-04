/**
 * @file CopilotNoticeModal.tsx
 * @description AI 动作全局强制提醒弹窗：消费 notify 动作落地态（copilotNotice），
 *              全屏遮罩 + 单按钮确认，关闭即清 store 态。无提醒时不渲染。
 *              定位：AppLayout 层与 GlobalCopilot 平级挂载，覆盖一切页面内容（z-60）。
 * @layer UI (Component) —— 只读 store + 调 dismiss action（R1 合规）
 * @storage_impact 纯内存态消费，不落库。
 * @author 开发团队
 */

import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { useAppStore } from '../../store';

/** severity → 视觉映射（描边/图标色） */
const SEVERITY_STYLES = {
  info: { icon: Info, border: 'border-blue-500/40', iconClass: 'text-blue-400' },
  warning: { icon: AlertTriangle, border: 'border-amber-500/40', iconClass: 'text-amber-400' },
  danger: { icon: ShieldAlert, border: 'border-red-500/40', iconClass: 'text-red-400' },
} as const;

export default function CopilotNoticeModal() {
  const notice = useAppStore((s) => s.copilotNotice);
  const dismiss = useAppStore((s) => s.dismissCopilotNotice);
  if (!notice) return null;

  const style = SEVERITY_STYLES[notice.severity];
  const Icon = style.icon;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label={notice.title}
    >
      <div className={`w-full max-w-sm bg-slate-800 border ${style.border} rounded-2xl shadow-2xl p-5 flex flex-col gap-3`}>
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`w-5 h-5 flex-shrink-0 ${style.iconClass}`} />
          <h3 className="text-sm font-bold text-white truncate">{notice.title}</h3>
        </div>
        <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap break-words">
          {notice.message}
        </p>
        <button
          onClick={dismiss}
          className="mt-1 w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
        >
          知道了
        </button>
      </div>
    </div>
  );
}
