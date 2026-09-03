/**
 * @file usePageContext.ts
 * @description 页面上下文注册 Hook：业务页面挂载时将 PageContextSnapshot 注册进全局
 *              Copilot Registry，卸载/路由切换时自动注销。
 *
 *              防 Registry 泄漏补丁（P0 规则 1）：
 *              - 严禁向 unregisterContext 传入 ownerRef.current —— 路由切换时
 *                ownerRef.current 已被新视图的快照覆盖，cleanup 里引用比对永远失败，
 *                旧上下文将永远无法注销（Registry 泄漏 + 串页取数）；
 *              - cleanup 必须捕获本次挂载注册的 registered 对象（引用相等才注销）；
 *              - getData 经 ownerRef 间接转发，保证每次取数都是最新实现，
 *                且快照只在提问/重发时才被显式执行（命令式取数，非渲染期采集）。
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

  useEffect(() => {
    // 固化本次挂载注册的唯一对象引用，确保 cleanup 准确注销
    const registered = {
      ...snapshot,
      getData: () => ownerRef.current.getData(),
    };
    registerContext(registered);
    return () => unregisterContext(registered.scopeId, registered);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register/unregister 为 zustand 稳定引用；仅 scopeId 变化时重新注册
  }, [snapshot.scopeId]);
}
