/**
 * @file SessionLockModal.tsx
 * @description 锁屏解锁弹窗：isAuthenticated && isLocked 时由 AuthGate 全屏覆盖渲染。
 *              展示只读邮箱 + 主密码输入；unlockWithPassword 返回 false →
 *              摇晃动画 + 内联错误（三级兜底后仍失败即判定主密码错误，store 不落地错误 MEK）；
 *              throw（网络/服务异常）→ 仅 toast（内联区保留给密码错误语义）。
 *              提供"切换账号 / 退出登录"：logout 仅销毁会话与密钥缓存，本地账本数据保留。
 * @layer UI
 * @storage_impact 经 useAuthStore 间接读 AuthDB_v1.auth_meta（payload 缓存）与 localStorage（会话）。
 */

import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, LockKeyhole, LogOut } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';

function showToast(msg: string): void {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));
}

export default function SessionLockModal() {
  const email = useAuthStore((s) => s.user?.email ?? '');
  const unlockWithPassword = useAuthStore((s) => s.unlockWithPassword);
  const logout = useAuthStore((s) => s.logout);

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [shaking, setShaking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !password) return;
    setSubmitting(true);
    setError('');
    try {
      const ok = await unlockWithPassword(password);
      if (ok) {
        setPassword('');
        showToast('✅ 解锁成功，欢迎回来');
      } else {
        // 密码错误：摇晃 + 内联文案；保留输入便于重试
        setError('主密码错误，请重试');
        setShaking(true);
        window.setTimeout(() => setShaking(false), 550);
        showToast('❌ 主密码错误');
      }
    } catch (err) {
      // 网络 / 服务异常：不占用内联错误区（那是密码错误语义），交由 toast 展示
      const msg = err instanceof Error ? err.message : '解锁失败，请稍后重试';
      showToast('❌ ' + msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // logout 内部幂等，理论不抛
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur p-4">
      <div
        className={`bg-slate-800 border border-slate-600 rounded-2xl p-6 max-w-sm w-full shadow-2xl ${
          shaking ? 'animate-shake' : ''
        }`}
      >
        <div className="flex flex-col items-center mb-5">
          <div className="w-12 h-12 rounded-full bg-slate-900 border border-slate-600 flex items-center justify-center mb-3">
            <LockKeyhole className="w-5 h-5 text-blue-400" />
          </div>
          <h3 className="text-lg font-bold text-white">已锁定</h3>
          <p className="text-xs text-slate-400 mt-1 truncate max-w-full" title={email}>
            {email}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">主密码</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError('');
                }}
                required
                autoFocus
                autoComplete="current-password"
                placeholder="输入主密码解锁"
                className="w-full px-3.5 py-2.5 pr-11 bg-slate-900 border border-slate-600 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-red-400 leading-relaxed">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <LockKeyhole className="w-4 h-4" />
            )}
            {submitting ? '解锁中…' : '解锁'}
          </button>

          <button
            type="button"
            onClick={handleLogout}
            disabled={submitting}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-red-400 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" /> 切换账号 / 退出登录
          </button>
        </form>
      </div>
    </div>
  );
}
