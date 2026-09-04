/**
 * @file copilotActionSlice.ts
 * @description Store Copilot 动作后处理切片（V1 Action Pipeline）：消费 LLM 响应中的
 *              actions（不可信输入，先经 utils/copilotActions 白名单 + 形状守卫），
 *              auto 级立即执行（notify 全局弹窗 / focus_block 聚焦 / apply_filter 筛选），
 *              confirm 级入队等待用户在浮窗确认卡上执行/忽略。
 *              关键约束：
 *              - 动作仅在响应返回时执行一次（dispatchAsk 挂载点），不随消息渲染/历史回放重放
 *                （actions 不落库，刷新即失，与 contextSummary 同属「在线在场态」）；
 *              - 业务写操作（confirm 级）严禁跳过确认直接执行 —— AI 只建议，用户拍板；
 *              - auto 级聚焦/筛选均为幂等 UI 效果，未注册目标静默忽略，不做跨页强跳。
 * @layer Store (Slice)
 * @storage_impact 全内存态（copilotNotice / pendingCopilotActions），不落库，刷新即失。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { AppStore, PendingCopilotAction } from '../types';
import {
  sanitizeCopilotActions,
  asNotifyPayload,
  asFocusBlockPayload,
  asApplyFilterPayload,
} from '../../utils/copilotActions';

/** 待确认动作 id 序列（内存态，无需 ulid 级别防撞） */
let pendingSeq = 0;

export type CopilotActionSlice = Pick<
  AppStore,
  | 'handleCopilotActions'
  | 'dismissCopilotNotice'
  | 'dismissPendingCopilotAction'
  | 'executePendingCopilotAction'
>;

export const createCopilotActionSlice: StateCreator<AppStore, [], [], CopilotActionSlice> = (set, get) => ({
  handleCopilotActions: (actions) => {
    const sanitized = sanitizeCopilotActions(actions);
    if (sanitized.length === 0) return;
    for (const a of sanitized) {
      if (a.tier === 'confirm') {
        // confirm 级：入队等用户拍板，绝不直接执行
        const pending: PendingCopilotAction = {
          id: `pa-${++pendingSeq}`,
          type: a.type,
          label: `AI 建议执行：${a.type}`,
          // confirm 级 payload 在 sanitize 阶段已确认为普通对象（三个强类型载荷只随 auto 级出现）
          payload: a.payload as Record<string, unknown>,
        };
        set((s) => ({ pendingCopilotActions: [...s.pendingCopilotActions, pending] }));
        continue;
      }
      // auto 级：按类型立即执行（载荷已过形状守卫，此处收窄后消费）
      switch (a.type) {
        case 'notify': {
          const p = asNotifyPayload(a.payload);
          // 后到覆盖先到（单弹窗槽位）；severity 归一化补省（store 态字段非可选）
          if (p) set({ copilotNotice: { title: p.title, message: p.message, severity: p.severity ?? 'info' } });
          break;
        }
        case 'focus_block': {
          const p = asFocusBlockPayload(a.payload);
          // focusBlock 内部校验注册态：未注册区块静默忽略，不弹空浮窗
          if (p) get().focusBlock(p.scopeId, p.blockId);
          break;
        }
        case 'apply_filter': {
          const p = asApplyFilterPayload(a.payload);
          // 白名单键值（当前仅首页时间维度），误发时不影响其他页面数据
          if (p && p.filter === 'homeTimeRange') get().setHomeTimeRange(p.value);
          break;
        }
        default:
          // 理论不可达：分级表登记了 auto 却没实现执行器 → 静默忽略
          break;
      }
    }
  },

  dismissCopilotNotice: () => set({ copilotNotice: null }),

  dismissPendingCopilotAction: (id) => {
    set((s) => ({ pendingCopilotActions: s.pendingCopilotActions.filter((a) => a.id !== id) }));
  },

  executePendingCopilotAction: (id) => {
    const action = get().pendingCopilotActions.find((a) => a.id === id);
    if (!action) return;
    // 出队先行：确认卡只消费一次，无论后续执行成败
    set((s) => ({ pendingCopilotActions: s.pendingCopilotActions.filter((a) => a.id !== id) }));
    // 执行器注册表：新增 confirm 动作在此登记（payload 已过 sanitize 白名单，落地前按类型二次校验）
    switch (action.type) {
      default:
        // 未登记类型：静默丢弃（防分级表登记了却漏写执行器）
        break;
    }
  },
});
