/**
 * @file usePageContext.ts
 * @description 页面上下文注册 Hook：业务页面挂载时将 PageContextSnapshot 注册进全局
 *              Copilot Registry，卸载/路由切换时自动注销。
 *
 *             防 Registry 泄漏补丁（P0 规则 1）：
 *              - 严禁向 unregisterContext 传入 ownerRef.current —— 路由切换时
 *                ownerRef.current 已被新视图的快照覆盖，cleanup 里引用比对永远失败，
 *                旧上下文将永远无法注销（Registry 泄漏 + 串页取数）；
 *              - cleanup 必须捕获本次挂载注册的 registered 对象（引用相等才注销）；
 *              - getData 经 ownerRef 间接转发，保证每次取数都是最新实现，
 *                且快照只在提问/重发时才被显式执行（命令式取数，非渲染期采集）。
 *
 *              V2 重注册签名（Click-to-Focus）：视图每次渲染都传入新的快照对象引用
 *              （内联字面量），不能直接作 effect 依赖；以「页面标题 + 区块标题集」
 *              组成稳定字符串签名，仅当展示名真正变化（如 Home 时间 Tab 切换 →
 *              「首页 · 短线统计 (近7天)」→(近30天)）时才重注册，浮窗胶囊随之热更新。
 * @layer Hook
 * @storage_impact 纯内存注册，不读写任何存储。
 * @author 开发团队
 */

import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import type { PageContextSnapshot } from '../types/domain';

export function usePageContext(snapshot: PageContextSnapshot): void {
  const ownerRef = useRef<PageContextSnapshot>(snapshot);
  ownerRef.current = snapshot;

  const registerContext = useAppStore((s) => s.registerContext);
  const unregisterContext = useAppStore((s) => s.unregisterContext);

  // 注册签名：页面标题 + 区块标题集（\u0001 作字段分隔，避免业务文案拼接歧义）。
  // 每次渲染重算开销可忽略（纯字符串拼接），签名不变则 effect 不重跑。
  const signature = [
    snapshot.title,
    ...(snapshot.blocks ?? []).map((b) => `${b.blockId}\u0002${b.title}`),
  ].join('\u0001');

  useEffect(() => {
    // 固化本次挂载注册的唯一对象引用，确保 cleanup 准确注销
    const registered = {
      ...snapshot,
      getData: () => ownerRef.current.getData(),
    };
    registerContext(registered);
    return () => unregisterContext(registered.scopeId, registered);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register/unregister 为 zustand 稳定引用；仅 scopeId/签名变化时重新注册
  }, [snapshot.scopeId, signature, registerContext, unregisterContext]);
}
