/**
 * @file BlockFocusButton.tsx
 * @description 区块聚焦入口按钮（V2 Click-to-Focus）：业务卡片右上角轻量 [✨ 问 AI]。
 *              点击触发 copilotSlice.focusBlock —— 校验区块快照已注册后展开全局浮窗
 *              并切换为区块聚焦态（胶囊显示区块名 + 快捷提问气泡）；未注册（页面未挂载/
 *              契约未接）时静默忽略，不弹空浮窗。
 *              可复用于首页其他卡片（计划单待办 / 仓位统计）与后续试点页区块。
 * @layer UI
 * @storage_impact 纯 UI 触发器，不读写任何存储。
 * @author 开发团队
 */

import { Sparkles } from 'lucide-react';
import { useAppStore } from '../../store';

interface BlockFocusButtonProps {
  /** 目标 scopeId（如 home） */
  scopeId: string;
  /** 目标区块标识（如 home:short_term） */
  blockId: string;
  /** 悬浮提示（缺省「聚焦此区块向 AI 提问」） */
  title?: string;
}

export default function BlockFocusButton({ scopeId, blockId, title }: BlockFocusButtonProps) {
  const focusBlock = useAppStore((s) => s.focusBlock);
  return (
    <button
      type="button"
      onClick={(e) => {
        // 阻断冒泡：可点击卡片头（如账本持仓行点击展开）不应被聚焦按钮误触
        e.stopPropagation();
        focusBlock(scopeId, blockId);
      }}
      title={title ?? '聚焦此区块向 AI 提问'}
      className="flex flex-shrink-0 items-center gap-1 rounded-full border border-slate-600/70 bg-slate-800/60 px-2 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:border-blue-500/60 hover:text-blue-300"
    >
      <Sparkles className="h-3 w-3" />
      问 AI
    </button>
  );
}
