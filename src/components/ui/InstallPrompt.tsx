/**
 * @file InstallPrompt.tsx
 * @description PWA 安装引导组件：Android/Chrome 通过监听 beforeinstallprompt 事件
 *              展示安装到桌面横幅；iOS Safari 检测 UA 后展示「添加到主屏幕」分步引导，
 *              关闭后写入 localStorage（ios-install-dismissed）避免重复打扰。
 * @layer UI
 * @storage_impact 仅读写 localStorage（ios-install-dismissed 标记），不涉及 IndexedDB。
 * @author 开发团队
 */

import React, { useEffect, useState } from 'react';
import { Download, X, Smartphone, Share2 } from 'lucide-react';

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
 * @description 在非 standalone 模式下自动判断平台：
 *  - Android/Chrome：监听 beforeinstallprompt，注入安装横幅，点击「立即安装」调用 prompt()
 *  - iOS Safari：检测到未 ignore 过时展示分步引导弹窗，关闭后持久化忽略标记
 * @returns {JSX.Element | null} 安装引导横幅/引导弹窗视图；已忽略或已安装时返回 null
 * @note 不涉及 IndexedDB；localStorage 仅用于 iOS 引导的「不再提示」记忆
 */
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // 检测是否已安装（standalone 模式）
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return;
    }

    // 检测 iOS Safari
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window);
    if (isIOS) {
      // iOS 不支持 beforeinstallprompt，检查是否已从 localStorage 忽略
      const iosDismissed = localStorage.getItem('ios-install-dismissed');
      if (!iosDismissed) {
        setShowIOSGuide(true);
      }
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

  const handleDismissIOS = () => {
    setShowIOSGuide(false);
    localStorage.setItem('ios-install-dismissed', 'true');
  };

  if (dismissed) return null;

  return (
    <>
      {/* Android / Chrome 安装引导 */}
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

      {/* iOS Safari 引导 */}
      {showIOSGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-blue-400" />
                <span className="text-base font-semibold text-slate-200">安装至桌面</span>
              </div>
              <button
                onClick={handleDismissIOS}
                className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-500 hover:text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-sm text-slate-400">
              <p className="text-slate-300 font-medium">将做T账本添加到主屏幕，获得 App 般的使用体验：</p>

              <div className="flex items-center gap-3 p-3 bg-slate-900/50 rounded-xl">
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <Share2 className="w-4 h-4 text-blue-400" />
                </div>
                <p className="text-xs">点击 Safari 底部分享按钮 <span className="text-slate-500">(分享图标)</span></p>
              </div>

              <div className="flex items-center gap-3 p-3 bg-slate-900/50 rounded-xl">
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="M12 9v6M9 12h6" />
                  </svg>
                </div>
                <p className="text-xs">向下滑动找到 <span className="text-slate-300">「添加到主屏幕」</span></p>
              </div>

              <div className="flex items-center gap-3 p-3 bg-slate-900/50 rounded-xl">
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <Download className="w-4 h-4 text-blue-400" />
                </div>
                <p className="text-xs">点击右上角 <span className="text-slate-300">「添加」</span> 即可完成</p>
              </div>
            </div>

            <button
              onClick={handleDismissIOS}
              className="w-full mt-5 py-2.5 px-4 rounded-xl text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 transition-colors"
            >
              我知道了
            </button>
          </div>
        </div>
      )}
    </>
  );
}