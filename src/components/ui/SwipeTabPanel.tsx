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

/**
 * 容器默认类：
 * - overflow-x-hidden：跟手位移在容器内裁剪（内容不溢出、文档不出横向滚动条）。
 * - 移动端 min-h-[100dvh]：让手势容器至少撑满一屏，使内容区下方的空白也落在容器盒内、
 *   可左右滑动切换 Tab（否则仅在内容区域内可滑，空白区滑不动会让用户误解）。
 * - md:min-h-0：桌面端复位，避免强制留白影响布局（桌面无 touch 手势，本修改无副作用）。
 * - -mx-4 md:-mx-6 + px-4 md:px-6：抵消 App 内容容器（p-4 md:p-6）的左右内边距，把命中区
 *   横向延伸到屏幕边缘，使起始触点落在原 padding 盲区（最左/最右约 16/24px）也能触发滑动；
 *   内边距同步加回，卡片视觉位置与改动前完全一致；桌面端镜像复刻外层 padding，布局零变化。
 */
const BASE_CLASS = 'overflow-x-hidden min-h-[100dvh] md:min-h-0 -mx-4 md:-mx-6 px-4 md:px-6';

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
