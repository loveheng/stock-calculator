/**
 * @file ConfirmModal.tsx
 * @description 通用确认弹窗组件：显示标题、消息和确认/取消按钮。
 * @layer UI
 * @storage_impact 纯展示组件，不读写任何存储。
 */

import React from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmText?: string;
  cancelLabel?: string;
  danger?: boolean;
  variant?: 'danger' | 'primary' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  confirmText,
  cancelLabel = '取消',
  danger = false,
  variant,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;

  const resolvedVariant = variant ?? (danger ? 'danger' : 'primary');
  const resolvedConfirmLabel = confirmLabel ?? confirmText ?? '确认';

  const variantStyles: Record<string, string> = {
    danger: 'bg-red-600 hover:bg-red-500',
    primary: 'bg-blue-600 hover:bg-blue-500',
    warning: 'bg-yellow-600 hover:bg-yellow-500',
  };

  const btnStyle = variantStyles[resolvedVariant] || variantStyles.primary;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <h3 className="text-lg font-bold text-white mb-2">{title}</h3>
        <p className="text-sm text-slate-400 mb-5 whitespace-pre-wrap">{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-xl text-sm font-medium text-white transition-colors ${btnStyle}`}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}