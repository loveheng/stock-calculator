/**
 * @file AuthGate.tsx
 * @description 认证 UI 挂载协调器：启动执行 initSession；按状态机渲染
 *              AuthModal / MnemonicBackupModal / SessionLockModal / ResetPasswordModal；
 *              内置全局 app-toast 宿主（鉴权提示不依赖页面级监听器）；
 *              监听 visibilitychange（滑动续期 D3）与 storage（跨标签页会话同步）。
 *              未登录不拦截任何路由（D6），本地功能零阻碍。
 * @layer UI
 * @storage_impact 间接触发 initSession 的本地清理逻辑（AuthDB_v1 / localStorage），自身不直接读写。
 */

import { useEffect, useRef, useState } from 'react';
import { AUTH_SESSION_STORAGE_KEY } from '../../services/authSession';
import { useAuthStore } from '../../store/useAuthStore';
import AuthModal from './AuthModal';
import MnemonicBackupModal from './MnemonicBackupModal';
import ResetPasswordModal from './ResetPasswordModal';
import SessionLockModal from './SessionLockModal';

/** 全局 Toast 宿主：与 BatchImport/TCalculator 的自包含 Toast 同一交互模式 */
function GlobalToast() {
  const [message, setMessage] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<string>).detail;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      setMessage(msg);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      timerRef.current = window.setTimeout(() => {
        setVisible(false);
        hideTimerRef.current = window.setTimeout(() => setMessage(null), 300);
      }, 4000);
    };
    window.addEventListener('app-toast', handler);
    return () => {
      window.removeEventListener('app-toast', handler);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  if (!message) return null;
  return (
    <div
      className={`fixed top-16 left-1/2 -translate-x-1/2 z-[70] px-4 py-2.5 rounded-xl bg-slate-800 text-white text-sm shadow-lg border border-slate-600 transition-opacity duration-300 max-w-[90vw] ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      role="status"
    >
      {message}
    </div>
  );
}

export default function AuthGate() {
  const initialized = useAuthStore((s) => s.initialized);
  const isLocked = useAuthStore((s) => s.isLocked);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const pendingBackup = useAuthStore((s) => s.pendingBackup);
  const authModalOpen = useAuthStore((s) => s.authModalOpen);
  const resetModalOpen = useAuthStore((s) => s.resetModalOpen);

  useEffect(() => {
    // 启动初始化（内部有并发去重）
    void useAuthStore.getState().initSession();

    // D3：切回前台滑动续期
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void useAuthStore.getState().touchSession();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // 跨标签页会话同步：他端登录/登出（localStorage 键变化）→ 重跑会话同步
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTH_SESSION_STORAGE_KEY) {
        void useAuthStore.getState().initSession();
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return (
    <>
      <GlobalToast />
      {/* initialized === false 时不渲染任何认证 UI，防闪烁；isLoading 不阻塞本地功能（D6） */}
      {initialized && (
        <>
          {isLocked && isAuthenticated && <SessionLockModal />}
          {authModalOpen && !isAuthenticated && <AuthModal />}
          {pendingBackup && <MnemonicBackupModal />}
          {resetModalOpen && <ResetPasswordModal />}
        </>
      )}
    </>
  );
}
