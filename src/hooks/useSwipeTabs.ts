/**
 * @file useSwipeTabs.ts
 * @description 移动端 Tab 左右滑动切换手势（Windows Phone Pivot 风格）：内容区跟手位移 +
 *              方向锁定（横滑才接管，纵滑让位页面滚动）+ 位移/速度双判切换 + 首尾边界阻尼。
 *              仅绑 touch 事件 —— 桌面无 touch 自然不生效，无需 UA 嗅探；
 *              `[data-swipe-ignore]` 子树与输入控件内不接管（画布 RGL 拖拽 / 横向滚动表格 /
 *              文本选择优先），方向锁定阈值内不动声色，避免误触。
 * @layer Hook
 * @storage_impact 无。
 * @author 开发团队
 */

import { useRef, useState } from 'react';
import type { RefObject, TouchEvent as ReactTouchEvent } from 'react';

export interface UseSwipeTabsOptions<T extends string> {
  /** 有序 tab id（左右邻项依据，顺序 = 视觉从左到右） */
  order: readonly T[];
  /** 当前选中 tab */
  value: T;
  /** 切换回调（只回传相邻合法项，越界不回调） */
  onChange: (id: T) => void;
  /** 总开关（默认 true） */
  enabled?: boolean;
}

export interface SwipeTabsBinding {
  /** 绑定到手势容器（阈值按容器宽度计算） */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 事件绑定集合（展开到容器上） */
  handlers: {
    onTouchStart: (e: ReactTouchEvent) => void;
    onTouchMove: (e: ReactTouchEvent) => void;
    onTouchEnd: (e: ReactTouchEvent) => void;
    onTouchCancel: () => void;
  };
  /** 跟手位移 px（松手归零，配合 transition 回弹） */
  offset: number;
  /** 拖动中（需禁用 transition 才能跟手） */
  dragging: boolean;
}

/** 方向锁定阈值：超过该位移才判定主轴，避免与纵向滚动/点击抢事件 */
const AXIS_LOCK_PX = 10;
/** 切换位移阈值为容器宽的 22%，夹在 [48, 96] px */
const COMMIT_RATIO = 0.22;
const MIN_COMMIT_PX = 48;
const MAX_COMMIT_PX = 96;
/** 快速轻扫速度阈值（px/ms）：短距离高速度也能切换 */
const FLICK_VELOCITY = 0.35;
/** 首尾边界阻尼系数（首项右滑/末项左滑手感"拉不动"） */
const EDGE_DAMP = 0.28;
/** 不接管手势的选择器：内部横向滚动 / 拖拽 / 输入控件优先 */
const IGNORE_SELECTOR = '[data-swipe-ignore], input, textarea, select, [contenteditable="true"]';

/**
 * Tab 左右滑动切换手势（Pivot 风格）。
 *
 * @param options.order 有序 tab id
 * @param options.value 当前 tab
 * @param options.onChange 切换回调
 * @returns {SwipeTabsBinding} 容器 ref / 事件集合 / 跟手位移 / 拖动态
 */
export function useSwipeTabs<T extends string>({
  order,
  value,
  onChange,
  enabled = true,
}: UseSwipeTabsOptions<T>): SwipeTabsBinding {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** 起点（null = 本次触摸不接管） */
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  /** 主轴判定：unknown 未定 / x 横滑接管 / y 纵滑让位 */
  const axis = useRef<'unknown' | 'x' | 'y'>('unknown');

  const reset = () => {
    start.current = null;
    axis.current = 'unknown';
    setDragging(false);
    setOffset(0);
  };

  const onTouchStart = (e: ReactTouchEvent) => {
    reset();
    if (!enabled || order.length < 2) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(IGNORE_SELECTOR)) return;
    const p = e.touches[0];
    if (!p) return;
    start.current = { x: p.clientX, y: p.clientY, t: Date.now() };
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    const s = start.current;
    if (!s) return;
    const p = e.touches[0];
    if (!p) return;
    const dx = p.clientX - s.x;
    const dy = p.clientY - s.y;

    // 方向锁定：先定主轴，纵滑让位页面滚动（此后不再接管本次触摸）
    if (axis.current === 'unknown') {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis.current === 'y') {
        start.current = null;
        setDragging(false);
        setOffset(0);
        return;
      }
    }

    // 边界阻尼：首项右滑 / 末项左滑无邻项，位移打折
    const idx = order.indexOf(value);
    const atEdge = (dx > 0 && idx <= 0) || (dx < 0 && idx >= order.length - 1);
    setDragging(true);
    setOffset(atEdge ? dx * EDGE_DAMP : dx);
  };

  const onTouchEnd = (e: ReactTouchEvent) => {
    const s = start.current;
    if (!s || axis.current !== 'x') {
      reset();
      return;
    }
    const p = e.changedTouches[0];
    const dx = p ? p.clientX - s.x : 0;
    const dt = Math.max(1, Date.now() - s.t);
    const width = containerRef.current?.offsetWidth ?? window.innerWidth;
    const threshold = Math.min(Math.max(width * COMMIT_RATIO, MIN_COMMIT_PX), MAX_COMMIT_PX);
    const commit = Math.abs(dx) >= threshold || Math.abs(dx) / dt > FLICK_VELOCITY;

    reset();
    if (!commit) return;

    const idx = order.indexOf(value);
    const next = dx < 0 ? idx + 1 : idx - 1;
    if (next >= 0 && next < order.length) onChange(order[next]);
  };

  return {
    containerRef,
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset },
    offset,
    dragging,
  };
}
