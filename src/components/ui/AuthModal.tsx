/**
 * @file AuthModal.tsx
 * @description 登录/注册弹窗（Tab 切换）：
 *              登录 = 邮箱 + 主密码 + 记住登录（7/30 天）；注册 = 邮箱 + 主密码 + 确认。
 *              错误经 store 抛出的用户级中文消息 → 内联红字 + app-toast。
 *              注册成功不关闭弹窗层：pendingBackup 置位后由 AuthGate 切换到备份弹窗。
 * @layer UI
 * @storage_impact 经 useAuthStore 间接写 localStorage（会话令牌）与 AuthDB_v1（免密会话）。
 */

import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, LogIn, UserPlus } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';

type Tab = 'login' | 'register';

export default function AuthModal() {
  const [tab, setTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [ttlDays, setTtlDays] = useState<7 | 30>(7);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const setAuthModalOpen = useAuthStore((s) => s.setAuthModalOpen);
  const setResetModalOpen = useAuthStore((s) => s.setResetModalOpen);

  const showToast = (msg: string) =>
    window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));

  const switchTab = (next: Tab) => {
    setTab(next);
    setError('');
  };

  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : '操作失败，请稍后重试';
    setError(msg);
    showToast(`❌ ${msg}`);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await login(email, password, remember, ttlDays);
      showToast('✅ 欢迎回来');
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (password !== confirmPassword) {
      setError('两次输入的主密码不一致');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      // 成功后 pendingBackup 置位 → AuthGate 自动切换到 MnemonicBackupModal（弹窗层不关闭）
      await register(email, password);
      showToast('✅ 注册成功，请立即备份助记词');
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  const canClose = !submitting; // 进行中阻断蒙层关闭

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && canClose) setAuthModalOpen(false);
      }}
    >
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 max-w-md w-full shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-white">
            {tab === 'login' ? '登录账号' : '注册账号'}
          </h3>
          {canClose && (
            <button
              onClick={() => setAuthModalOpen(false)}
              className="text-slate-400 hover:text-white transition-colors"
              aria-label="关闭"
            >
              ✕
            </button>
          )}
        </div>

        {/* Tab 切换 */}
        <div className="grid grid-cols-2 gap-1 bg-slate-900/60 rounded-xl p-1 mb-5">
          {(
            [
              { key: 'login', label: '登录' },
              { key: 'register', label: '注册' },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              disabled={submitting}
              className={`py-2 rounded-lg text-sm font-medium transition-all ${
                tab === t.key
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-600 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">主密码</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="派生密钥的根口令，永不上传"
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

            {/* 记住登录 + TTL 下拉 */}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-slate-300">记住登录</span>
              </label>
              <select
                value={ttlDays}
                onChange={(e) => setTtlDays(Number(e.target.value) as 7 | 30)}
                disabled={!remember}
                className="px-2.5 py-1.5 bg-slate-900 border border-slate-600 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
              </select>
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
                <LogIn className="w-4 h-4" />
              )}
              {submitting ? '登录中…' : '登录'}
            </button>

            <button
              type="button"
              onClick={() => {
                setAuthModalOpen(false);
                setResetModalOpen(true);
              }}
              disabled={submitting}
              className="w-full text-center text-xs text-slate-400 hover:text-blue-400 transition-colors"
            >
              忘记主密码？使用助记词找回
            </button>
          </form>
        ) : (
          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-600 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">主密码</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="至少 8 位，仅用于本机派生密钥"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-600 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">确认主密码</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                placeholder="再次输入主密码"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-600 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
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
                <UserPlus className="w-4 h-4" />
              )}
              {submitting ? '注册中…' : '注册并生成密钥'}
            </button>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              注册后将生成 12 词助记词，它是密钥找回的唯一凭证，请务必纸质抄写保存。
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
