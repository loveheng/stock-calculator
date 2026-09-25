/**
 * @file Toast.tsx
 * @description 全局 Toast 宿主：监听 window 上的 app-toast CustomEvent（detail 为消息字符串，
 *              前缀 ✅/❌/⚠️/📧 决定配色），栈式展示、自动消退。挂载于 App 根部一次，
 *              画布页等所有视图/服务（含 store 内 dispatch）无需自建监听器即可弹出提示，
 *              替代 BatchImport/TCalculator 等页面各自监听的历史模式。
 * @layer UI
 * @storage_impact 纯内存展示，不读写任何存储。
 * @author 开发团队
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, AlertTriangle, Mail, Info } from 'lucide-react';

interface ToastItem {
  id: number;
  message: string;
  /** 按前缀推导的展示类型 */
  kind: 'success' | 'error' | 'warning' | 'mail' | 'info';
}

const KIND_STYLE: Record<ToastItem['kind'], { icon: React.ElementType; cls: string }> = {
  success: { icon: CheckCircle2, cls: 'border-emerald-500/40 text-emerald-300' },
  error: { icon: XCircle, cls: 'border-red-500/40 text-red-300' },
  warning: { icon: AlertTriangle, cls: 'border-amber-500/40 text-amber-300' },
  mail: { icon: Mail, cls: 'border-sky-500/40 text-sky-300' },
  info: { icon: Info, cls: 'border-slate-500/40 text-slate-300' },
};

/** 消息前缀 → 展示类型（沿用项目 ✅/❌/⚠️/📧 约定，无前缀归 info） */
function kindOf(message: string): ToastItem['kind'] {
  if (message.startsWith('✅')) return 'success';
  if (message.startsWith('❌')) return 'error';
  if (message.startsWith('⚠️')) return 'warning';
  if (message.startsWith('📧')) return 'mail';
  return 'info';
}

/** 单条停留时长（与既有页面 4000ms 对齐） */
const TOAST_DURATION = 4000;
/** 栈内最多同时展示条数（防事件风暴刷屏） */
const MAX_VISIBLE = 4;

export default function Toast() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<string>).detail;
      if (!message) return;
      const id = ++seqRef.current;
      setItems((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, message, kind: kindOf(message) }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_DURATION);
    };
    window.addEventListener('app-toast', handler);
    return () => window.removeEventListener('app-toast', handler);
  }, []);

  if (!items.length) return null;
  return createPortal(
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[10000] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => {
        const { icon: Icon, cls } = KIND_STYLE[t.kind];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex max-w-md items-center gap-2 rounded-lg border bg-slate-900/95 px-4 py-2.5 shadow-lg backdrop-blur ${cls}`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="text-sm text-slate-200">{t.message}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
