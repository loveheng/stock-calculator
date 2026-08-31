/**
 * @file ResetPasswordModal.tsx
 * @description 助记词找回主密码弹窗（两步流）：
 *              Step1 输入邮箱请求验证码（requestRecoveryCode，60s 冷却；未知邮箱后端恒 200 防枚举）；
 *              Step2 输入验证码 + 12 词助记词（单个多行文本框支持一键粘贴，实时解析 + BIP-39 校验）
 *              + 新主密码二次确认。
 *              提交经 resetPasswordWithMnemonic：本机先用助记词解封 recovery 缓存（错误助记词
 *              不消耗验证码）→ verify 换 recovery 会话 → confirm 原子改密；
 *              成功后 store 落全量新会话并关闭本弹窗，MEK 无损恢复直接解锁。
 *              前提：本设备需曾登录过该账号（本地存有 recovery_payload 缓存，后端 recovery
 *              会话无档案读权限），UI 底部明示。
 * @layer UI
 * @storage_impact 经 useAuthStore 间接读写 AuthDB_v1.auth_meta（payload 缓存）与 localStorage（新会话）。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, KeyRound, Loader2, MailCheck } from 'lucide-react';
import { validateMnemonic } from '../../services/mnemonicService';
import { useAuthStore } from '../../store/useAuthStore';

type Step = 'email' | 'verify';

const RESEND_COOLDOWN_S = 60;

function showToast(msg: string): void {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));
}

export default function ResetPasswordModal() {
  const requestRecoveryCode = useAuthStore((s) => s.requestRecoveryCode);
  const resetPasswordWithMnemonic = useAuthStore((s) => s.resetPasswordWithMnemonic);
  const setResetModalOpen = useAuthStore((s) => s.setResetModalOpen);

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [mnemonicText, setMnemonicText] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // 重发冷却倒计时：cooldown 归零后自动停表
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown > 0]);

  // 助记词实时解析：任意空白（空格/换行/Tab）分隔
  const words = useMemo(
    () => mnemonicText.trim().split(/\s+/).filter(Boolean),
    [mnemonicText],
  );
  const mnemonicChecked = words.length > 0;
  const mnemonicValid = words.length === 12 && validateMnemonic(mnemonicText);

  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : '操作失败，请稍后重试';
    setError(msg);
    showToast('❌ ' + msg);
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await requestRecoveryCode(email);
      setCooldown(RESEND_COOLDOWN_S);
      setStep('verify');
      showToast('📧 若该邮箱已注册，验证码已发送（10 分钟内有效）');
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (submitting || cooldown > 0) return;
    setSubmitting(true);
    setError('');
    try {
      await requestRecoveryCode(email);
      setCooldown(RESEND_COOLDOWN_S);
      showToast('📧 验证码已重新发送');
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!code.trim()) {
      setError('请输入邮箱验证码');
      return;
    }
    if (!mnemonicValid) {
      setError('助记词无效：需 12 个合法 BIP-39 英文单词');
      return;
    }
    if (newPass.length < 8) {
      setError('新主密码至少 8 位');
      return;
    }
    if (newPass !== confirmPass) {
      setError('两次输入的新主密码不一致');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      // 成功后 store 置全量新会话并关闭本弹窗（resetModalOpen=false → AuthGate 卸载）
      await resetPasswordWithMnemonic(email, code, mnemonicText, newPass);
      showToast('✅ 主密码已重置，密钥无损恢复');
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  const canClose = !submitting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && canClose) setResetModalOpen(false);
      }}
    >
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 max-w-md w-full shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-white">找回主密码</h3>
          {canClose && (
            <button
              onClick={() => setResetModalOpen(false)}
              className="text-slate-400 hover:text-white transition-colors"
              aria-label="关闭"
            >
              ✕
            </button>
          )}
        </div>

        {step === 'email' ? (
          <form onSubmit={handleSendCode} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">注册邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
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
                <MailCheck className="w-4 h-4" />
              )}
              {submitting ? '发送中…' : '发送验证码'}
            </button>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              验证码 10 分钟内有效。为防止邮箱枚举，无论邮箱是否注册，系统均不会明确提示结果。
            </p>
          </form>
        ) : (
          <form onSubmit={handleReset} className="space-y-4">
            <div className="text-xs text-slate-400 flex items-center justify-between gap-2">
              <span className="truncate">
                验证码已发送至 <span className="text-slate-200 break-all">{email}</span>
              </span>
              <span className="flex items-center gap-2 flex-shrink-0">
                {cooldown > 0 ? (
                  <span className="text-slate-500">重发({cooldown}s)</span>
                ) : (
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={submitting}
                    className="text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    重新发送
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setStep('email');
                    setError('');
                  }}
                  disabled={submitting}
                  className="text-slate-400 hover:text-slate-200 transition-colors"
                >
                  更换邮箱
                </button>
              </span>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">邮箱验证码</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                inputMode="numeric"
                maxLength={6}
                placeholder="6 位数字"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-600 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 tracking-widest"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-slate-400">
                  12 词助记词（支持一键粘贴）
                </label>
                <span
                  className={`text-[11px] ${
                    mnemonicValid ? 'text-emerald-400' : mnemonicChecked ? 'text-amber-400' : 'text-slate-500'
                  }`}
                >
                  {mnemonicChecked
                    ? mnemonicValid
                      ? '✅ 助记词有效'
                      : '已识别 ' + words.length + '/12 词'
                    : '等待输入'}
                </span>
              </div>
              <textarea
                value={mnemonicText}
                onChange={(e) => setMnemonicText(e.target.value)}
                required
                rows={3}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="apple basket cabin ...（空格或换行分隔，粘贴后自动解析）"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-600 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">新主密码</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="至少 8 位，用于本机重新派生密钥"
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

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">确认新主密码</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)}
                required
                autoComplete="new-password"
                placeholder="再次输入新主密码"
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
                <KeyRound className="w-4 h-4" />
              )}
              {submitting ? '重置中…' : '重置主密码'}
            </button>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              安全设计：验证码验证前先在本机用助记词解封密钥，助记词错误不会消耗验证码。
              本设备需曾登录过该账号（本地存有恢复凭证缓存）方可完成校验。
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
