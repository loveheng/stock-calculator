/**
 * @file MnemonicBackupModal.tsx
 * @description 助记词备份弹窗（注册闭环 D2/D9）：display 阶段 3×4 网格展示 12 词（序号 01-12）
 *              + 一键复制 / 下载 .txt；quiz 阶段随机抽 2 个挖空题校验。
 *              只有抽查通过才调用 confirmBackupMnemonic 上传四密文（D9 不变量）；
 *              上传成功 → store 清 pendingBackup → AuthGate 自动关闭本弹窗；
 *              上传网络失败 → store 落待传队列（auth_meta），同样关闭并 toast 兜底语义。
 *              蒙层点击与关闭按钮全部阻断：备份未完成不得跳过。
 * @layer UI
 * @storage_impact 经 useAuthStore 间接写 AuthDB_v1.auth_meta（payload 缓存 / 待传队列）与后端 PUT /profile。
 */

import { useMemo, useState } from 'react';
import { Copy, Download, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';

type Phase = 'display' | 'quiz';

function showToast(msg: string): void {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));
}

/** 抽 2 个不重复的挖空序号（0-11） */
function pickQuizIndices(): number[] {
  const picked = new Set<number>();
  while (picked.size < 2) picked.add(Math.floor(Math.random() * 12));
  return [...picked];
}

/** 导出助记词备份 txt（文件名含日期，正文含安全提示） */
function downloadMnemonicTxt(mnemonic: string): void {
  const now = new Date();
  const ymd =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const words = mnemonic.trim().split(/\s+/);
  const numbered = words
    .map((w, i) => String(i + 1).padStart(2, '0') + '. ' + w)
    .join('\n');
  const content = [
    '========================================',
    '股票计算助手 · 密钥恢复助记词（BIP-39）',
    '导出时间：' + now.toLocaleString(),
    '========================================',
    '',
    numbered,
    '',
    '安全提示：',
    '1. 这 12 个单词是您数据的唯一恢复凭证；',
    '2. 请离线抄写在纸上，切勿截图、存云端或发送给任何人；',
    '3. 任何人持有助记词即可解密您的全部数据；',
    '4. 丢失助记词且忘记主密码时，数据将无法恢复。',
  ].join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '股票计算助手-助记词备份-' + ymd + '.txt';
  a.click();
  URL.revokeObjectURL(url);
}

export default function MnemonicBackupModal() {
  const pendingBackup = useAuthStore((s) => s.pendingBackup);
  const confirmBackupMnemonic = useAuthStore((s) => s.confirmBackupMnemonic);

  const [phase, setPhase] = useState<Phase>('display');
  const [quizIndices, setQuizIndices] = useState<number[]>([0, 1]);
  const [answers, setAnswers] = useState<string[]>(['', '']);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const words = useMemo(
    () => (pendingBackup ? pendingBackup.mnemonic.trim().split(/\s+/) : []),
    [pendingBackup],
  );

  if (!pendingBackup) return null;

  const startQuiz = () => {
    setQuizIndices(pickQuizIndices());
    setAnswers(['', '']);
    setError('');
    setPhase('quiz');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pendingBackup.mnemonic);
      showToast('✅ 助记词已复制，请粘贴到离线笔记中保存');
    } catch {
      showToast('❌ 复制失败，请手动逐词抄写');
    }
  };

  const handleDownload = () => {
    try {
      downloadMnemonicTxt(pendingBackup.mnemonic);
      showToast('✅ 备份文件已下载，请妥善离线保存');
    } catch {
      showToast('❌ 下载失败，请手动抄写');
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    // 抽查比对：大小写 / 首尾空白归一后必须完全一致
    const wrong = quizIndices.some(
      (wordIdx, i) =>
        answers[i].trim().toLowerCase() !== (words[wordIdx] ?? '').toLowerCase(),
    );
    if (wrong) {
      setError('答案不正确，请核对抄写内容后再试（可返回重新查看）');
      showToast('❌ 抽查未通过，请重新核对助记词');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      // D9：抽查通过后，才允许把 recovery_payload 上传服务端
      const done = await confirmBackupMnemonic(pendingBackup.mnemonic);
      if (done) showToast('✅ 备份完成，账号已就绪');
      else showToast('⚠️ 暂无法连接服务，密文已入待传队列，联网后自动补传；账号可正常使用');
      // store 清除 pendingBackup → AuthGate 自动卸载本弹窗
    } catch (err) {
      const msg = err instanceof Error ? err.message : '提交失败，请稍后重试';
      setError(msg);
      showToast('❌ ' + msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      {/* 语义要求（D2）：备份未完成严禁关闭 —— 不绑定蒙层关闭、不提供 ✕ 按钮 */}
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 max-w-md w-full shadow-2xl max-h-[92vh] overflow-y-auto">
        {phase === 'display' ? (
          <>
            <div className="flex items-center gap-2 mb-1">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
              <h3 className="text-lg font-bold text-white">备份您的助记词</h3>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              这 12 个单词是恢复密钥的唯一凭证。请离线抄写并妥善保管——丢失助记词且忘记主密码时，数据将无法找回。
            </p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {words.map((w, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2"
                >
                  <span className="text-[10px] font-mono text-slate-500">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="text-sm font-medium text-slate-100 truncate">{w}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center justify-center gap-1.5 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium transition-colors"
              >
                <Copy className="w-3.5 h-3.5" /> 复制所有
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="flex items-center justify-center gap-1.5 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium transition-colors"
              >
                <Download className="w-3.5 h-3.5" /> 下载 .txt 备份
              </button>
            </div>
            <button
              type="button"
              onClick={startQuiz}
              disabled={words.length !== 12}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              <ShieldCheck className="w-4 h-4" /> 我已记录，开始抽查
            </button>
          </>
        ) : (
          <form onSubmit={handleConfirm} className="space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-blue-400" />
              <h3 className="text-lg font-bold text-white">备份抽查</h3>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              请输入刚才记录的助记词中对应位置的单词，验证您已正确备份。
            </p>
            {quizIndices.map((wordIdx, i) => (
              <div key={wordIdx}>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  请输入第 {wordIdx + 1} 个单词
                </label>
                <input
                  value={answers[i]}
                  onChange={(e) => {
                    const next = [...answers];
                    next[i] = e.target.value;
                    setAnswers(next);
                  }}
                  autoFocus={i === 0}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={'第 ' + (wordIdx + 1) + ' 个单词'}
                  className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-600 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>
            ))}
            {error && <p className="text-xs text-red-400 leading-relaxed">{error}</p>}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setPhase('display');
                  setError('');
                }}
                disabled={submitting}
                className="py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors"
              >
                返回查看
              </button>
              <button
                type="submit"
                disabled={submitting || !answers[0].trim() || !answers[1].trim()}
                className="py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                {submitting ? '提交中…' : '完成验证'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
