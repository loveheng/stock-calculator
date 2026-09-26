/**
 * @file SwipeTabPanel.tsx
 * @description 可左右滑动切换 Tab 的内容容器（Windows Phone Pivot 风格）：包住 Tab 内容区，
 *              横滑时内容跟手位移，松手按位移/速度阈值切到相邻 Tab（回弹动画 200ms）。
 *              手势细节（方向锁定 / 边界阻尼 / 忽略子树）见 hooks/useSwipeTabs；
 *              仅 touch 事件生效，桌面端零影响；子树内标 `data-swipe-ignore` 可让位给
 *              内部横向滚动与拖拽交互（如画布 RGL 拖块、宽表格横滚）。
 * @layer UI
 * @storage_impact 纯展示容器，无存储读写。
 * @author 开发团队
 */

import type { ReactNode } from 'react';
import { useSwipeTabs } from '../../hooks/useSwipeTabs';

export interface SwipeTabPanelProps<T extends string> {
  /** 有序 tab id（与 ModeTabs 的 tabs 顺序一致） */
  order: readonly T[];
  /** 当前 tab（受控） */
  value: T;
  /** 切换回调 */
  onChange: (id: T) => void;
  /** 追加类名 */
  className?: string;
  children: ReactNode;
}

/** 回弹/吸附动画曲线（WP 风格：快出慢入） */
const TRANSITION = 'transform 200ms cubic-bezier(0.22, 0.61, 0.36, 1)';

/** 容器默认类：overflow-x-hidden 让跟手位移在容器内裁剪（内容不溢出、文档不被撑宽出横向滚动条） */
const BASE_CLASS = 'overflow-x-hidden';

/**
 * 可左右滑动切换 Tab 的内容容器。
 *
 * @returns {JSX.Element} 带手势的内容容器
 */
export default function SwipeTabPanel<T extends string>({
  order,
  value,
  onChange,
  className = '',
  children,
}: SwipeTabPanelProps<T>) {
  const { containerRef, handlers, offset, dragging } = useSwipeTabs({ order, value, onChange });

  return (
    <div
      ref={containerRef}
      {...handlers}
      className={className ? `${BASE_CLASS} ${className}` : BASE_CLASS}
      style={{
        transform: offset !== 0 ? `translateX(${offset}px)` : undefined,
        transition: dragging ? 'none' : TRANSITION,
        willChange: dragging ? 'transform' : undefined,
      }}
    >
      {children}
    </div>
  );
}
