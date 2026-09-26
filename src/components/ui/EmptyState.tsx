/**
 * @file EmptyState.tsx
 * @description 通用空态占位组件：列表/面板无数据时统一展示（图标 + 主文案 + 辅助说明 + 可选操作）。
 *              三种容器变体：card（.card 语义类，列表默认）、dashed（虚线卡片，区块级空态）、
 *              panel（大圆角深底，页面级空筛结果）。仓库内此前十余处各自手写，样式与文案口径不一。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import type { ElementType, ReactNode } from 'react';

export interface EmptyStateProps {
  /** 主文案（必填） */
  title: string;
  /** 辅助说明（次级灰字） */
  description?: string;
  /** 图标（lucide 组件引用） */
  icon?: ElementType;
  /** 底部操作区（按钮等） */
  action?: ReactNode;
  /** 容器变体，默认 card */
  variant?: 'card' | 'dashed' | 'panel';
  /** 追加类名 */
  className?: string;
}

const VARIANT_CLASS: Record<'card' | 'dashed' | 'panel', string> = {
  card: 'card flex flex-col items-center gap-2 py-10 text-slate-500',
  dashed:
    'flex flex-col items-center gap-1 rounded-xl border border-dashed border-slate-700 bg-slate-800 p-8 text-center text-sm text-slate-500',
  panel:
    'flex flex-col items-center gap-1 rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-8 text-center text-sm text-slate-500',
};

/**
 * 通用空态占位组件。
 *
 * @returns {JSX.Element} 空态视图
 */
export default function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  variant = 'card',
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`${VARIANT_CLASS[variant]} ${className}`}>
      {Icon && <Icon className="h-6 w-6" />}
      <p className="text-sm">{title}</p>
      {description && <p className="text-xs text-slate-600">{description}</p>}
      {action}
    </div>
  );
}
