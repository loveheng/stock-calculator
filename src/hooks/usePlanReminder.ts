/**
 * @file usePlanReminder.ts
 * @description 计划单关联的后端价格提醒（预告单）Hook：封装 startMonitor / stopMonitor 调用、
 *              错误分类（401 → 登录失效 + 打开登录框；429/400/5xx → 人话 Toast）、
 *              并将服务端 taskId 经 store.setPlanMonitor 回写到本地计划单。
 *              供短期交易 / 中长期交易 / AI 选股台三处计划单创建与卡片「停止提醒」复用。
 * @layer Hook（状态逻辑）
 * @storage_impact 经 store.setPlanMonitor 回写 plannedOrders 表（monitorTaskId）。
 * @author 开发团队
 */

import { useCallback } from 'react';
import { useAppStore } from '../store';
import { useAuthStore } from '../store/useAuthStore';
import { showToast } from '../utils/toast';
import {
  startMonitor,
  stopMonitor,
  MonitorLimitError,
  MonitorBadRequestError,
  MonitorServiceError,
  type MonitorStartInput,
} from '../services/monitorService';
import { SessionExpiredError } from '../services/apiClient';
import type { PlannedOrder } from '../types/domain';

/** usePlanReminder 返回 */
export interface PlanReminderApi {
  /** 开启提醒：成功回写 taskId 到计划单并返回 true；失败已 Toast，返回 false */
  start: (order: PlannedOrder, input: MonitorStartInput) => Promise<boolean>;
  /** 停止提醒：调用 stop 并清除计划单上的 taskId（任务已不存在的 400 视为已停止） */
  stop: (order: PlannedOrder) => Promise<void>;
}

/**
 * 计划单价格提醒 Hook。
 *
 * @returns {PlanReminderApi} 开启 / 停止方法
 */
export function usePlanReminder(): PlanReminderApi {
  const setPlanMonitor = useAppStore((s) => s.setPlanMonitor);
  const setAuthModalOpen = useAuthStore((s) => s.setAuthModalOpen);

  const start = useCallback(
    async (order: PlannedOrder, input: MonitorStartInput): Promise<boolean> => {
      try {
        const data = await startMonitor(input);
        setPlanMonitor(order.id, data.taskId);
        showToast(`🔔 已开启价格提醒 · ${order.stockName} 目标价 ¥${order.plannedPrice.toFixed(2)}`);
        return true;
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          showToast('⚠️ 登录已失效，请重新登录');
          setAuthModalOpen(true);
        } else if (err instanceof MonitorLimitError) {
          showToast(`⚠️ ${err.message}`);
        } else if (err instanceof MonitorBadRequestError) {
          showToast(`❌ ${err.message}`);
        } else if (err instanceof MonitorServiceError) {
          showToast(`❌ ${err.message}`);
        } else {
          showToast('❌ 开启价格提醒失败，请稍后重试');
        }
        return false;
      }
    },
    [setPlanMonitor, setAuthModalOpen],
  );

  const stop = useCallback(
    async (order: PlannedOrder): Promise<void> => {
      if (order.monitorTaskId == null) return;
      try {
        await stopMonitor(order.monitorTaskId);
        setPlanMonitor(order.id, null);
        showToast('🔕 已停止价格提醒');
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          showToast('⚠️ 登录已失效，请重新登录');
        } else if (err instanceof MonitorBadRequestError) {
          // 任务已不属于当前用户（400）→ 视为已停止，清除本地关联
          setPlanMonitor(order.id, null);
          showToast('🔕 已停止价格提醒');
        } else {
          showToast('❌ 停止价格提醒失败，请稍后重试');
        }
      }
    },
    [setPlanMonitor],
  );

  return { start, stop };
}
