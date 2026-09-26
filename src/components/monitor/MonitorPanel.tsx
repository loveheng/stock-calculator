/**
 * @file MonitorPanel.tsx
 * @description 通知管理主体：预告单列表 + 剩余额度 + 新建表单 + 结束确认。
 *              数据经 services/monitorService.listMonitor 拉取（刷新即重拉，无本地缓存）；
 *              三端点需登录，未登录时展示登录引导占位而非报错。
 *              结束动作经 ConfirmModal 二次确认；满 3 次自动结束与手动结束在卡片上区分展示。
 * @layer UI
 * @storage_impact 不直接读写存储；预告单状态由服务端持有。
 * @author 开发团队
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Bell, RefreshCw } from 'lucide-react';
import ConfirmModal from '../ui/ConfirmModal';
import MonitorCreateForm from './MonitorCreateForm';
import MonitorTaskCard from './MonitorTaskCard';
import { showToast } from '../../utils/toast';
import { SessionExpiredError } from '../../services/apiClient';
import {
  MONITOR_MAX_RUNNING,
  MonitorBadRequestError,
  MonitorServiceError,
  listMonitor,
  stopMonitor,
} from '../../services/monitorService';
import type { MonitorListData, MonitorTask } from '../../services/monitorService';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * 通知管理面板。
 *
 * @returns {JSX.Element} 通知管理视图
 */
export default function MonitorPanel() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setAuthModalOpen = useAuthStore((s) => s.setAuthModalOpen);

  const [data, setData] = useState<MonitorListData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [stoppingId, setStoppingId] = useState<number | null>(null);
  const [pendingStop, setPendingStop] = useState<MonitorTask | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setData(await listMonitor());
    } catch (err) {
      setLoadFailed(true);
      if (err instanceof SessionExpiredError) showToast('⚠️ 登录已失效，请重新登录');
      else if (err instanceof MonitorServiceError) showToast(`❌ ${err.message}`);
      else showToast('❌ 预告单加载失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    void load();
  }, [isAuthenticated, load]);

  const handleConfirmStop = async () => {
    if (!pendingStop) return;
    const task = pendingStop;
    setPendingStop(null);
    setStoppingId(task.taskId);
    try {
      await stopMonitor(task.taskId);
      showToast('✅ 已结束该预告单');
      await load();
    } catch (err) {
      if (err instanceof MonitorBadRequestError) showToast(`❌ ${err.message}`);
      else if (err instanceof SessionExpiredError) showToast('⚠️ 登录已失效，请重新登录');
      else showToast('❌ 结束失败，请稍后重试');
    } finally {
      setStoppingId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-6 text-center">
        <Bell className="mx-auto h-6 w-6 text-slate-500" />
        <p className="mt-2 text-sm text-slate-300">登录后管理价格提醒</p>
        <p className="mt-1 text-xs text-slate-500">价格提醒需账号归属，推送与消息中心都依赖登录态</p>
        <button
          type="button"
          onClick={() => setAuthModalOpen(true)}
          className="tap-target mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >
          登录
        </button>
      </div>
    );
  }

  const remaining = data ? Math.max(0, MONITOR_MAX_RUNNING - data.runningCount) : MONITOR_MAX_RUNNING;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">价格提醒</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            剩余 {remaining} 条额度（上限 {MONITOR_MAX_RUNNING}）
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="tap-target inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-blue-500/60 hover:text-blue-300 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      <MonitorCreateForm remaining={remaining} onCreated={() => void load()} />

      {loadFailed && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-center">
          <p className="text-sm text-slate-300">预告单加载失败</p>
          <button
            type="button"
            onClick={() => void load()}
            className="tap-target mt-2 rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500/60 hover:text-blue-300"
          >
            重试
          </button>
        </div>
      )}

      {!loadFailed && loading && !data && (
        <p className="py-6 text-center text-sm text-slate-500">加载中…</p>
      )}

      {!loadFailed && data && data.tasks.length === 0 && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-6 text-center">
          <p className="text-sm text-slate-300">还没有价格提醒</p>
          <p className="mt-1 text-xs text-slate-500">设定目标价与容差，交易时段到价即提醒</p>
        </div>
      )}

      {data && data.tasks.length > 0 && (
        <div className="space-y-3">
          {data.tasks.map((task) => (
            <MonitorTaskCard
              key={task.taskId}
              task={task}
              stopping={stoppingId === task.taskId}
              onStop={setPendingStop}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={pendingStop !== null}
        title="结束这条预告单？"
        message={
          pendingStop
            ? `${pendingStop.stockCode} ${pendingStop.direction === 'BUY' ? '低吸' : '高抛'} 目标价 ${pendingStop.threshold.toFixed(2)}，已提醒 ${pendingStop.alertCount}/3 次。结束后不再追踪，如需继续可重新创建。`
            : ''
        }
        confirmLabel="结束"
        variant="danger"
        onConfirm={() => void handleConfirmStop()}
        onCancel={() => setPendingStop(null)}
      />
    </div>
  );
}
