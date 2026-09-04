/**
 * @file WebDAVConfig.tsx
 * @description 同步设置页面：服务端密文备份区块（登录即备份：状态行/立即备份/从云端恢复/
 *              冲突卡/回退告警卡）+ WebDAV 服务器连接配置、连通性测试、一键备份/恢复、
 *              智能合并同步以及同步历史查阅。
 * @layer UI
 * @storage_impact 读写 localStorage（webdav_config / webdav_last_sync / webdav_sync_history）；
 *                 通过 useAppStore.exportData / importData 读写 IndexedDB 全量数据；
 *                 服务端备份区块仅经 store actions 交互（不直读 server_sync_meta_v1）。
 * @author 开发团队
 */

import React, { useState, useCallback } from 'react';
import {
  Cloud, CloudOff, CheckCircle, XCircle, Loader2,
  Upload, Download, RefreshCw, Link, Trash2, History, Eye, EyeOff,
  ShieldCheck, AlertTriangle, LogIn, Lock,
} from 'lucide-react';
import {
  getWebDAVConfig, saveWebDAVConfig, clearWebDAVConfig,
  getLastSyncTime, getSyncHistory,
  testWebDAVConnection, backupToWebDAV, restoreFromCloud, mergeSync,
  formatRelativeTime,
  type WebDAVConfig, type SyncHistoryEntry,
} from '../services/webdavSync';
import { useAppStore } from '../store';
import { useAuthStore } from '../store/useAuthStore';
import type { AppStoreExport } from '../store/types';

type ConnectionStatus = 'unknown' | 'connected' | 'disconnected' | 'testing';
type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

function StatusBadge({ status, hasConfig }: { status: ConnectionStatus; hasConfig: boolean }) {
  switch (status) {
    case 'connected':
      return <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full"><CheckCircle className="w-3 h-3" />已连接</span>;
    case 'disconnected':
      return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-400 bg-red-400/10 px-2 py-0.5 rounded-full"><XCircle className="w-3 h-3" />连接失败</span>;
    case 'testing':
      return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full"><Loader2 className="w-3 h-3 animate-spin" />测试中</span>;
    default:
      return hasConfig
        ? <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 bg-slate-400/10 px-2 py-0.5 rounded-full"><CloudOff className="w-3 h-3" />未测试</span>
        : <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 bg-slate-500/10 px-2 py-0.5 rounded-full"><CloudOff className="w-3 h-3" />未配置</span>;
  }
}

function ConfirmDialog({
  open, title, message, onConfirm, onCancel, loading,
}: {
  open: boolean; title: string; message: string;
  onConfirm: () => void; onCancel: () => void; loading: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-slate-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl border border-slate-700" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-slate-200 mb-2">{title}</h3>
        <p className="text-sm text-slate-400 mb-5">{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} disabled={loading}
            className="px-4 py-2 text-sm rounded-lg text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-40">
            取消
          </button>
          <button onClick={onConfirm} disabled={loading}
            className="px-4 py-2 text-sm rounded-lg bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30 transition-colors disabled:opacity-40 flex items-center gap-1.5">
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 服务端备份区块（M4）：登录即备份通道的 UI。三态：
 * - 未登录：「登录后可用」+ 登录入口（D15）
 * - 已锁定（isLocked）：密钥未解封，提示解锁后自动恢复
 * - 就绪：状态行 + 冲突卡/回退告警卡 + [立即备份]/[从云端恢复]
 * 冲突/回退的识别基于 serverLastError 文案约定（ioSlice 定义的两种终态提示），
 * 其余错误落普通错误条。D14：回退不自动动作，决策权在用户。
 */
function ServerBackupSection() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLocked = useAuthStore((s) => s.isLocked);
  const serverSyncing = useAppStore((s) => s.serverSyncing);
  const serverLastVersion = useAppStore((s) => s.serverLastVersion);
  const serverLastError = useAppStore((s) => s.serverLastError);
  const pushServerSnapshot = useAppStore((s) => s.pushServerSnapshot);
  const restoreFromServer = useAppStore((s) => s.restoreFromServer);
  const resolveServerConflict = useAppStore((s) => s.resolveServerConflict);
  const dismissServerError = useAppStore((s) => s.dismissServerError);
  const setAuthModalOpen = useAuthStore((s) => s.setAuthModalOpen);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [resolving, setResolving] = useState(false);

  const ready = isAuthenticated && !isLocked;
  const isConflict = !!serverLastError && serverLastError.includes('持续冲突');
  const isRollback = !!serverLastError && serverLastError.includes('版本回退');
  const plainError = serverLastError && !isConflict && !isRollback;
  const busy = serverSyncing || resolving;

  const runResolve = (mode: 'merge-cloud' | 'overwrite-cloud') => {
    setResolving(true);
    void resolveServerConflict(mode).finally(() => setResolving(false));
  };

  return (
    <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 p-5 space-y-4">
      <ConfirmDialog
        open={confirmRestore}
        title="从服务端恢复"
        message="将从云端拉取最新备份并与本地数据智能合并：双方独有数据都会保留，冲突记录按时间戳取较新版本，不会清空本地数据。"
        onConfirm={() => { setConfirmRestore(false); void restoreFromServer(); }}
        onCancel={() => setConfirmRestore(false)}
        loading={busy}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-emerald-400" />
          <h3 className="text-lg font-semibold text-slate-200">服务端备份</h3>
        </div>
        {ready && (
          serverSyncing
            ? <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full"><Loader2 className="w-3 h-3 animate-spin" />同步中</span>
            : <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full"><CheckCircle className="w-3 h-3" />已开启</span>
        )}
      </div>

      <p className="text-sm text-slate-500 leading-relaxed">
        登录后数据自动加密备份到服务端，多设备免配置同步。
        端到端加密，服务器仅存储密文；云端保留最近 5 个历史版本；清空本地数据不会自动清空云端。
      </p>

      {!isAuthenticated ? (
        <div className="flex items-center justify-between gap-3 bg-slate-900/40 border border-slate-700/50 rounded-lg px-4 py-3">
          <span className="text-sm text-slate-400">登录后可用（无需填写服务器配置）</span>
          <button onClick={() => setAuthModalOpen(true)}
            className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2 px-4 bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/30 rounded-lg transition-all shrink-0">
            <LogIn className="w-4 h-4" />登录 / 注册
          </button>
        </div>
      ) : isLocked ? (
        <div className="flex items-center gap-2 bg-slate-900/40 border border-slate-700/50 rounded-lg px-4 py-3 text-sm text-slate-400">
          <Lock className="w-4 h-4 text-slate-500 shrink-0" />
          数据密钥已锁定，解锁会话后自动恢复同步
        </div>
      ) : (
        <>
          {/* 状态行：云端版本对账态 */}
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <CheckCircle className="w-4 h-4 text-slate-500 shrink-0" />
            {serverLastVersion != null
              ? <span>云端版本 <span className="text-slate-200 font-medium">v{serverLastVersion}</span> · 已与云端对账</span>
              : <span>尚未与云端对账（首次推送后显示版本号）</span>}
          </div>

          {/* 冲突卡：409 自动合并重推一轮后仍冲突 → 交用户决策（§5.5） */}
          {isConflict && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-3">
              <div className="flex items-start gap-2 text-sm text-amber-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{serverLastError}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => runResolve('merge-cloud')} disabled={busy}
                  className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2 px-4 bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 rounded-lg transition-all disabled:opacity-40">
                  {resolving ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  合并云端数据
                </button>
                <button onClick={() => runResolve('overwrite-cloud')} disabled={busy}
                  className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2 px-4 bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/30 rounded-lg transition-all disabled:opacity-40">
                  <Upload className="w-4 h-4" />以本地覆盖云端
                </button>
              </div>
            </div>
          )}

          {/* 回退告警卡：云端版本 < 本机已确认（D14），不自动动作 */}
          {isRollback && (
            <div className="bg-red-400/10 border border-red-400/20 rounded-lg p-4 space-y-3">
              <div className="flex items-start gap-2 text-sm text-red-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{serverLastError}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => runResolve('overwrite-cloud')} disabled={busy}
                  className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2 px-4 bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/30 rounded-lg transition-all disabled:opacity-40">
                  <Upload className="w-4 h-4" />以本地覆盖云端
                </button>
                <button onClick={dismissServerError} disabled={busy}
                  className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2 px-4 bg-slate-700/50 text-slate-300 border border-slate-600/50 hover:bg-slate-700 rounded-lg transition-all disabled:opacity-40">
                  忽略
                </button>
              </div>
            </div>
          )}

          {/* 其他错误（拉取失败/服务端拒绝等）：普通错误条 */}
          {plainError && (
            <div className="text-xs px-3 py-2.5 rounded-lg bg-red-400/10 text-red-300 border border-red-400/20">
              {serverLastError}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button onClick={() => void pushServerSnapshot({ force: true })} disabled={busy}
              className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 px-5 bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 hover:bg-emerald-600/30 rounded-lg transition-all disabled:opacity-40">
              {serverSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              立即备份
            </button>
            <button onClick={() => setConfirmRestore(true)} disabled={busy}
              className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 px-5 bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 rounded-lg transition-all disabled:opacity-40">
              <Download className="w-4 h-4" />从云端恢复
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function WebDAVConfigPage() {
  const [config, setConfig] = useState<WebDAVConfig>(getWebDAVConfig());
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(getLastSyncTime());
  const [syncHistory, setSyncHistory] = useState<SyncHistoryEntry[]>(getSyncHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'restore' } | null>(null);
  const exportData = useAppStore((s) => s.exportData);
  const importData = useAppStore((s) => s.importData);
  const hasConfig = !!(config.webdavUrl && config.username && config.password);

  const refresh = useCallback(() => {
    setLastSync(getLastSyncTime());
    setSyncHistory(getSyncHistory());
  }, []);

  const updateConfig = (key: keyof WebDAVConfig, value: string | boolean) => {
    const next = { ...config, [key]: value };
    setConfig(next);
    saveWebDAVConfig(next);
    setConnectionStatus('unknown');
  };

  const handleClearConfig = () => {
    clearWebDAVConfig();
    setConfig(getWebDAVConfig());
    setConnectionStatus('unknown');
    setLastSync(null);
    setSyncHistory([]);
    setStatusMessage('配置已清除');
  };

  const handleTestConnection = async () => {
    if (!hasConfig) { setStatusMessage('请先填写 WebDAV 配置'); return; }
    setConnectionStatus('testing');
    setStatusMessage('正在测试连接…');
    const result = await testWebDAVConnection(config);
    setConnectionStatus(result.ok ? 'connected' : 'disconnected');
    setStatusMessage(result.message);
    if (result.ok) refresh();
  };

  const handleBackup = async () => {
    if (!hasConfig) { setStatusMessage('请先配置 WebDAV'); return; }
    setSyncStatus('syncing');
    setStatusMessage('正在备份…');
    try {
      const snapshot = exportData();
      if (!snapshot) { setStatusMessage('导出数据失败'); setSyncStatus('error'); return; }
      const result = await backupToWebDAV(snapshot, true);
      setSyncStatus(result.success ? 'success' : 'error');
      setStatusMessage(result.message);
      if (result.success) refresh();
    } catch (err) {
      setSyncStatus('error');
      setStatusMessage(err instanceof Error ? err.message : '备份失败');
    }
  };

  const handleRestore = async () => {
    if (!hasConfig) { setStatusMessage('请先配置 WebDAV'); return; }
    setConfirmAction(null);
    setSyncStatus('syncing');
    setStatusMessage('正在恢复…');
    try {
      const result = await restoreFromCloud(config);
      if (result.ok && result.data) {
        importData(result.data, true); // silent: 来自远端拉取，不触发自动上传
        setSyncStatus('success');
        setStatusMessage('数据已从云端恢复');
      } else {
        setSyncStatus('error');
        setStatusMessage(result.message);
      }
      if (result.ok) refresh();
    } catch (err) {
      setSyncStatus('error');
      setStatusMessage(err instanceof Error ? err.message : '恢复失败');
    }
  };

  const handleMerge = async () => {
    if (!hasConfig) { setStatusMessage('请先配置 WebDAV'); return; }
    setSyncStatus('syncing');
    setStatusMessage('正在智能合并同步…');
    try {
      const snapshot = exportData();
      if (!snapshot) { setStatusMessage('导出数据失败'); setSyncStatus('error'); return; }
      const result = await mergeSync(config, snapshot);
      setSyncStatus(result.ok ? 'success' : 'error');
      setStatusMessage(result.message);
      if (result.ok && result.mergeResult) {
        importData({
          version: result.mergeResult.feeConfig ? 1 : snapshot.version,
          feeConfig: result.mergeResult.feeConfig,
          tRounds: result.mergeResult.tRounds,
          positions: result.mergeResult.positions,
          stocks: result.mergeResult.stocks,
          longTermRecords: result.mergeResult.longTermRecords,
          plannedOrders: result.mergeResult.plannedOrders ?? [],
        }, true); // silent: 来自远端拉取合并，不触发自动上传
      }
      if (result.ok) refresh();
    } catch (err) {
      setSyncStatus('error');
      setStatusMessage(err instanceof Error ? err.message : '合并同步失败');
    }
  };

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirmAction?.type === 'restore'}
        title="确认恢复数据"
        message="此操作将用云端数据覆盖本地所有数据，包括战报、持仓、中长期记录等。该操作不可撤销，建议先备份当前数据。"
        onConfirm={handleRestore}
        onCancel={() => setConfirmAction(null)}
        loading={syncStatus === 'syncing'}
      />

      {/* 服务端密文备份（登录即备份，M4）：置顶展示，零配置优先于 WebDAV 手动配置 */}
      <ServerBackupSection />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Cloud className="w-6 h-6 text-blue-400" />
          <h3 className="text-lg font-semibold text-slate-200">WebDAV 同步设置</h3>
        </div>
        <StatusBadge status={connectionStatus} hasConfig={hasConfig} />
      </div>

      <p className="text-sm text-slate-500 leading-relaxed">
        通过 WebDAV 协议将数据备份到云端（如 坚果云、NextCloud），实现多端数据同步。
        配置信息仅保存在本地浏览器，不会上传到第三方服务器。
      </p>

      <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 p-5 space-y-4">
        <h4 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <Link className="w-4 h-4 text-slate-500" />
          服务器配置
        </h4>

        <div>
          <label className="block text-xs text-slate-400 mb-1.5">服务器地址</label>
          <input
            type="url"
            placeholder="https://dav.jianguoyun.com/dav/"
            value={config.webdavUrl}
            onChange={(e) => updateConfig('webdavUrl', e.target.value)}
            className="w-full px-3 py-2.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">账号 / 邮箱</label>
            <input
              type="text"
              placeholder="user@example.com"
              value={config.username}
              onChange={(e) => updateConfig('username', e.target.value)}
              className="w-full px-3 py-2.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">应用授权密码</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="App Password"
                value={config.password}
                onChange={(e) => updateConfig('password', e.target.value)}
                className="w-full px-3 py-2.5 pr-10 bg-slate-900/60 border border-slate-600/50 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
              />
              <button
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1.5">远程文件路径</label>
          <input
            type="text"
            placeholder="/stock-calculator/data-backup.json"
            value={config.remotePath}
            onChange={(e) => updateConfig('remotePath', e.target.value)}
            className="w-full px-3 py-2.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
          />
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer group">
          <input
            type="checkbox"
            checked={config.autoSync}
            onChange={(e) => updateConfig('autoSync', e.target.checked)}
            className="w-4 h-4 rounded border-slate-500 bg-slate-900/60 text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0 cursor-pointer"
          />
          <span className="text-sm text-slate-300 group-hover:text-slate-200 transition-colors">启用自动同步</span>
          <span className="text-xs text-slate-500">（数据变更后自动上传备份）</span>
        </label>
      </div>

      <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 p-5 space-y-4">
        <h4 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-slate-500" />
          同步操作
        </h4>

        <div className="flex flex-wrap gap-2">
          <button onClick={handleTestConnection} disabled={!hasConfig || connectionStatus === 'testing'}
            className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 px-4 bg-slate-700/50 text-slate-300 border border-slate-600/50 hover:bg-slate-700 rounded-lg transition-all disabled:opacity-40">
            {connectionStatus === 'testing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link className="w-4 h-4" />}
            测试连接
          </button>
          <button onClick={handleClearConfig}
            className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 px-4 text-red-400 border border-red-400/30 hover:bg-red-400/10 rounded-lg transition-all">
            <Trash2 className="w-4 h-4" />清除配置
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={handleBackup} disabled={syncStatus === 'syncing' || !hasConfig}
            className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 px-5 bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/30 rounded-lg transition-all disabled:opacity-40">
            {syncStatus === 'syncing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            备份到云端
          </button>
          <button onClick={() => setConfirmAction({ type: 'restore' })} disabled={syncStatus === 'syncing' || !hasConfig}
            className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 px-5 bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 rounded-lg transition-all disabled:opacity-40">
            <Download className="w-4 h-4" />从云端恢复
          </button>
          <button onClick={handleMerge} disabled={syncStatus === 'syncing' || !hasConfig}
            className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 px-5 bg-green-600/20 text-green-400 border border-green-600/30 hover:bg-green-600/30 rounded-lg transition-all disabled:opacity-40">
            <RefreshCw className={`w-4 h-4 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
            智能合并同步
          </button>
        </div>

        {statusMessage && (
          <div className={`text-xs px-3 py-2.5 rounded-lg ${
            syncStatus === 'error' || connectionStatus === 'disconnected'
              ? 'bg-red-400/10 text-red-300 border border-red-400/20'
              : syncStatus === 'success' || connectionStatus === 'connected'
              ? 'bg-green-400/10 text-green-300 border border-green-400/20'
              : 'bg-slate-700/50 text-slate-300 border border-slate-600/30'
          }`}>
            {statusMessage}
          </div>
        )}

        {lastSync && (
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <History className="w-3 h-3" />
            上次同步：{formatRelativeTime(lastSync)}
          </div>
        )}
      </div>

      {syncHistory.length > 0 && (
        <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 p-5 space-y-3">
          <button onClick={() => setShowHistory(!showHistory)}
            className="text-sm text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition-colors">
            <History className="w-4 h-4" />
            {showHistory ? '收起同步历史' : `同步历史（${syncHistory.length}）`}
          </button>
          {showHistory && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {syncHistory.map((entry, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-slate-500 py-1.5 px-2 rounded-lg hover:bg-slate-700/30">
                  <span className={entry.success ? 'text-green-400' : 'text-red-400'}>
                    {entry.success ? '✓' : '✗'}
                  </span>
                  <span className="shrink-0 w-10 font-medium">
                    {entry.type === 'backup' ? '备份' : entry.type === 'restore' ? '恢复' : entry.type === 'merge' ? '合并' : '测试'}
                  </span>
                  <span className="text-slate-600 shrink-0">{formatRelativeTime(entry.timestamp)}</span>
                  {entry.message && <span className="text-slate-600 truncate">{entry.message}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
