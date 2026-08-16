/**
 * @file SyncModal.tsx
 * @description WebDAV 多端同步与云端备份 UI 组件。
 * @layer UI (Component)
 * @author 开发团队
 */

import React, { useState, useCallback } from 'react';
import {
  Cloud, CloudOff, CheckCircle, XCircle, Loader2,
  Upload, Download, RefreshCw, Link, Trash2, History, Eye, EyeOff,
} from 'lucide-react';
import {
  getWebDAVConfig, saveWebDAVConfig, clearWebDAVConfig,
  getLastSyncTime, getSyncHistory,
  testWebDAVConnection, backupToCloud, restoreFromCloud, mergeSync,
  formatRelativeTime, serializeSnapshot,
  type WebDAVConfig, type SyncHistoryEntry,
} from '../services/webdavSync';
import { useAppStore } from '../store';
import type { AppStoreExport } from '../store/types';

type ConnectionStatus = 'unknown' | 'connected' | 'disconnected' | 'testing';
type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

interface SyncModalProps {
  open: boolean;
  onClose: () => void;
}

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

export default function SyncModal({ open, onClose }: SyncModalProps) {
  const [config, setConfig] = useState<WebDAVConfig>(getWebDAVConfig());
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(getLastSyncTime());
  const [syncHistory, setSyncHistory] = useState<SyncHistoryEntry[]>(getSyncHistory());
  const [showHistory, setShowHistory] = useState(false);
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
  };

  const handleTestConnection = async () => {
    if (!hasConfig) { setStatusMessage('请先填写 WebDAV 配置'); return; }
    setConnectionStatus('testing');
    setStatusMessage('正在测试连接...');
    const result = await testWebDAVConnection(config);
    setConnectionStatus(result.ok ? 'connected' : 'disconnected');
    setStatusMessage(result.message);
    refresh();
  };

  const handleBackup = async () => {
    if (!hasConfig) { setStatusMessage('请先配置 WebDAV'); return; }
    setSyncStatus('syncing');
    setStatusMessage('正在备份到云端...');
    try {
      const snapshot = exportData();
      const json = serializeSnapshot(snapshot);
      const result = await backupToCloud(config, json);
      setSyncStatus(result.ok ? 'success' : 'error');
      setStatusMessage(result.message);
    } catch (err) {
      setSyncStatus('error');
      setStatusMessage(`备份失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    refresh();
  };

  const handleRestore = async () => {
    if (!hasConfig) { setStatusMessage('请先配置 WebDAV'); return; }
    if (!confirm('从云端恢复将覆盖本地数据，确定继续？')) return;
    setSyncStatus('syncing');
    setStatusMessage('正在从云端恢复...');
    try {
      const result = await restoreFromCloud(config);
      if (result.ok && result.data) {
        importData(result.data, true); // silent: 来自远端拉取，不触发自动上传
        setSyncStatus('success');
        setStatusMessage('恢复成功，本地数据已更新');
      } else {
        setSyncStatus('error');
        setStatusMessage(result.message);
      }
    } catch (err) {
      setSyncStatus('error');
      setStatusMessage(`恢复失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    refresh();
  };

  const handleMerge = async () => {
    if (!hasConfig) { setStatusMessage('请先配置 WebDAV'); return; }
    setSyncStatus('syncing');
    setStatusMessage('正在执行智能合并同步...');
    try {
      const snapshot = exportData();
      const result = await mergeSync(config, snapshot);
      if (result.ok && result.mergeResult) {
        const merged: AppStoreExport = {
          version: result.mergeResult.feeConfig ? 1 : snapshot.version,
          feeConfig: result.mergeResult.feeConfig,
          tRounds: result.mergeResult.tRounds,
          positions: result.mergeResult.positions,
          stocks: result.mergeResult.stocks,
          longTermRecords: result.mergeResult.longTermRecords,
        };
        importData(merged, true); // silent: 来自远端拉取合并，不触发自动上传
        setSyncStatus('success');
      } else if (result.ok) {
        setSyncStatus('success');
      } else {
        setSyncStatus('error');
      }
      setStatusMessage(result.message);
    } catch (err) {
      setSyncStatus('error');
      setStatusMessage(`合并同步失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    refresh();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 md:pt-20">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg mx-4 bg-slate-800/95 backdrop-blur-xl border border-slate-700 rounded-2xl shadow-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <div className="flex items-center gap-2.5">
            <Cloud className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-semibold text-slate-200">WebDAV 同步</h2>
            <StatusBadge status={connectionStatus} hasConfig={hasConfig} />
          </div>
          <button onClick={onClose} className="tap-target p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="space-y-3">
            <div className="form-group">
              <label className="text-xs text-slate-400 mb-1 block">服务器地址</label>
              <input type="url" placeholder="https://dav.jianguoyun.com/dav/" value={config.webdavUrl}
                onChange={(e) => updateConfig('webdavUrl', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="form-group">
              <label className="text-xs text-slate-400 mb-1 block">账号/邮箱</label>
              <input type="text" placeholder="your@email.com" value={config.username}
                onChange={(e) => updateConfig('username', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="form-group">
              <label className="text-xs text-slate-400 mb-1 block">应用授权密码</label>
              <div className="relative">
                <input type={showPassword ? 'text' : 'password'} placeholder="App Password" value={config.password}
                  onChange={(e) => updateConfig('password', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 pr-9 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500" />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 tap-target p-1 text-slate-400 hover:text-slate-200">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="form-group">
              <label className="text-xs text-slate-400 mb-1 block">远程路径</label>
              <input type="text" value={config.remotePath}
                onChange={(e) => updateConfig('remotePath', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="flex items-center gap-2">
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" checked={config.autoSync}
                  onChange={(e) => updateConfig('autoSync', e.target.checked)} className="sr-only peer" />
                <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
              </label>
              <span className="text-xs text-slate-400">自动同步（数据变更时自动上传）</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleTestConnection} disabled={connectionStatus === 'testing'}
              className="btn btn-outline tap-target text-sm flex items-center justify-center gap-1.5 py-2.5">
              <Link className="w-4 h-4" />测试连接
            </button>
            <button onClick={handleClearConfig}
              className="btn btn-outline tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 text-red-400 border-red-400/30 hover:bg-red-400/10">
              <Trash2 className="w-4 h-4" />清除配置
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button onClick={handleBackup} disabled={syncStatus === 'syncing' || !hasConfig}
              className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/30 disabled:opacity-40">
              {syncStatus === 'syncing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              备份
            </button>
            <button onClick={handleRestore} disabled={syncStatus === 'syncing' || !hasConfig}
              className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 disabled:opacity-40">
              <Download className="w-4 h-4" />恢复
            </button>
            <button onClick={handleMerge} disabled={syncStatus === 'syncing' || !hasConfig}
              className="btn tap-target text-sm flex items-center justify-center gap-1.5 py-2.5 bg-green-600/20 text-green-400 border border-green-600/30 hover:bg-green-600/30 disabled:opacity-40">
              <RefreshCw className={`w-4 h-4 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
              合并
            </button>
          </div>

          {statusMessage && (
            <div className={`text-xs px-3 py-2 rounded-lg ${
              syncStatus === 'error' || connectionStatus === 'disconnected'
                ? 'bg-red-400/10 text-red-300'
                : syncStatus === 'success' || connectionStatus === 'connected'
                ? 'bg-green-400/10 text-green-300'
                : 'bg-slate-700/50 text-slate-300'
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

          {syncHistory.length > 0 && (
            <div>
              <button onClick={() => setShowHistory(!showHistory)}
                className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
                <History className="w-3 h-3" />
                {showHistory ? '收起同步历史' : `同步历史（${syncHistory.length}）`}
              </button>
              {showHistory && (
                <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                  {syncHistory.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                      <span className={entry.success ? 'text-green-400' : 'text-red-400'}>{entry.success ? '✓' : '✗'}</span>
                      <span className="shrink-0 w-10">{entry.type === 'backup' ? '备份' : entry.type === 'restore' ? '恢复' : entry.type === 'merge' ? '合并' : '测试'}</span>
                      <span className="text-slate-600">{formatRelativeTime(entry.timestamp)}</span>
                      {entry.message && <span className="text-slate-600 truncate">{entry.message}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
