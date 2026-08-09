/**
 * @file InstallPrompt.tsx
 * @description PWA 安装引导组件：通过监听现代标准 `beforeinstallprompt` 事件
 *              展示「安装至桌面」横幅。
 * @layer UI
 * @author 开发团队
 */

import React, { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';

/**
 * beforeinstallprompt 事件类型扩展。
 *
 * @property {() => Promise<void>} prompt - 唤起浏览器原生安装弹窗
 * @property {Promise<{ outcome: 'accepted' | 'dismissed' }>} userChoice - 用户安装选择结果
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * PWA 安装引导组件。
 *
 * @description 在非 standalone 模式下监听 beforeinstallprompt，注入安装横幅，
 *              点击「立即安装」调用 prompt() 唤起浏览器原生安装流程。
 * @returns {JSX.Element | null} 安装引导横幅；已安装或已忽略时返回 null
 */
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // 已安装（standalone 模式）则不再提示
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener('beforeinstallprompt', handler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
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

  const handleDismiss = () => {
    setShowPrompt(false);
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <>
      {showPrompt && deferredPrompt && (
        <div className="fixed bottom-4 left-4 right-4 z-50 max-w-md mx-auto animate-fadeInUp">
          <div className="bg-slate-800 border border-blue-500/30 rounded-2xl p-4 shadow-2xl shadow-blue-500/10 backdrop-blur-xl">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-blue-500/20 rounded-xl flex-shrink-0">
                <Download className="w-5 h-5 text-blue-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200">安装至桌面 App</p>
                <p className="text-xs text-slate-400 mt-0.5">将做T账本添加至桌面，随时快捷访问</p>
              </div>
              <button
                onClick={handleDismiss}
                className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-500 hover:text-slate-300 flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleDismiss}
                className="flex-1 py-2.5 px-4 rounded-xl text-sm text-slate-400 bg-slate-700/50 hover:bg-slate-700 transition-colors"
              >
                稍后再说
              </button>
              <button
                onClick={handleInstall}
                className="flex-1 py-2.5 px-4 rounded-xl text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 transition-colors"
              >
                立即安装
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}