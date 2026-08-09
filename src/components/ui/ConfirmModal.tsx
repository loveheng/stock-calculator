/**
 * @file ConfirmModal.tsx
 * @description 通用确认对话框组件：支持自定义标题/消息/按钮文案，
 *              提供 danger 危险操作样式（红色警告图标与按钮），
 *              点击遮罩或取消按钮均触发 onCancel。
 * @layer UI
 * @storage_impact 本组件为纯展示层，不直接读写 IndexedDB；写操作由
 *                 onConfirm 回调（父组件传入）完成。
 * @author 开发团队
 */

import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * ConfirmModal 组件入参定义。
 *
 * @property {boolean} open - 是否显示弹窗
 * @property {string} title - 弹窗标题
 * @property {string} message - 提示正文（支持多行）
 * @property {string} [confirmText] - 确认按钮文案，默认「确认」
 * @property {string} [cancelText] - 取消按钮文案，默认「取消」
 * @property {boolean} [danger] - 危险操作模式（红色图标/按钮），默认 false
 * @property {() => void} onConfirm - 点击确认按钮回调
 * @property {() => void} onCancel - 点击取消/遮罩/关闭按钮回调
 */
interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用确认对话框组件。
 *
 * @description 模态确认弹窗：显示标题与消息正文，提供确认/取消两个动作；
 *              danger=true 时使用红色警示样式，用于删除类不可恢复操作。
 * @param {ConfirmModalProps} props - 见 {@link ConfirmModalProps}
 * @returns {JSX.Element | null} 弹窗视图；open=false 时返回 null
 * @note 纯展示组件，不产生任何数据写入
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-slate-800 rounded-xl border border-slate-700 shadow-2xl max-w-sm w-full p-6 animate-[fadeInUp_0.2s_ease-out]">
        <div className="flex items-center gap-3 mb-4">
          <div className={`p-2 rounded-full ${danger ? 'bg-red-500/20' : 'bg-blue-500/20'}`}>
            <AlertTriangle className={`w-5 h-5 ${danger ? 'text-red-400' : 'text-blue-400'}`} />
          </div>
          <h3 className="text-base font-semibold text-slate-200">{title}</h3>
          <button
            onClick={onCancel}
            className="ml-auto p-1 rounded-lg hover:bg-slate-700 text-slate-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-slate-400 mb-6 leading-relaxed">{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="btn btn-outline btn-sm">
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}