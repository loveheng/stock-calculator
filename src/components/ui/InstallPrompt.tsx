/**
 * @file InstallPrompt.tsx
 * @description PWA 安装提示组件：检测 beforeinstallprompt 事件并展示自定义安装 Banner。
 * @layer UI
 * @storage_impact 纯展示，不读写任何存储。
 */

import { useState, useEffect } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShowPrompt(false);
    }
    setDeferredPrompt(null);
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md">
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-4 shadow-2xl flex items-center justify-between gap-3">
        <div className="text-sm text-slate-200">
          将此应用安装到主屏幕，快速访问
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setShowPrompt(false)}
            className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 text-slate-400 hover:bg-slate-600"
          >
            以后再说
          </button>
          <button
            onClick={handleInstall}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500"
          >
            安装
          </button>
        </div>
      </div>
    </div>
  );
}