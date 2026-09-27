/**
 * @file BlockSwipeTabs.tsx
 * @description 区块级滑动切换 Tab（Windows Phone Pivot 风格的"轻量版"）：用于页面内某个
 *              独立卡片/区块（而非整页）的水平菜单切换。与页级 SwipeTabPanel 的区别：
 *               - 不强制 min-h-[100dvh]、不抵消外层 padding，只贴着区块自身尺寸滑动，
 *                 适合首页统计卡片、行情区等局部区块；
 *               - 渲染「当前 + 相邻」三块内容组成横向轨道（track），拖动时相邻菜单的内容
 *                 就跟手滑入（而非抬起后才切换），Tab 条指示保持固定，移动端横滑即可切换、
 *                 无需点击；桌面端无 touch 自然不生效，点击仍可用（保留无障碍与鼠标交互）。
 *              手势细节（方向锁定 / 边界阻尼 / 忽略输入框子树）复用 hooks/useSwipeTabs。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import type { ReactNode } from 'react';
import { useSwipeTabs } from '../../hooks/useSwipeTabs';

/** 单个 Tab 项：id 为泛型键（编译期约束 onChange 只能回传合法 id） */
export interface BlockSwipeTabItem<T extends string> {
  id: T;
  label: string;
}

export interface BlockSwipeTabsProps<T extends string> {
  /** Tab 定义（建议调用方以模块级常量声明，避免每渲染重建数组） */
  tabs: ReadonlyArray<BlockSwipeTabItem<T>>;
  /** 当前选中 id */
  value: T;
  /** 切换回调 */
  onChange: (id: T) => void;
  /** 无障碍标签（tablist 的 aria-label） */
  ariaLabel: string;
  /** 渲染某个 tab 的内容：会同时渲染当前/相邻 tab 以实现跟手滑动（id 即 tabs 中的任一 id） */
  renderTab: (id: T) => ReactNode;
  /** 追加到最外层容器（与 Tab 条/内容同级的布局盒，如卡片内边距由外层提供） */
  className?: string;
  /** 追加到 Tab 条容器（如内边距 / 间距微调，默认 .tab-bar 已含基础样式） */
  headerClassName?: string;
  /** 追加到滑动内容容器 */
  bodyClassName?: string;
}

/** 回弹/吸附动画曲线（WP 风格：快出慢入） */
const TRANSITION = 'transform 200ms cubic-bezier(0.22, 0.61, 0.36, 1)';

/**
 * 区块级滑动切换 Tab 容器。
 *
 * @description 受控组件：value/onChange 由调用方持有（内存态或 store 态均可）；
 *              切换不卸载内容区，数据态由 renderTab 按 id 决定。Tab 条复用全局 .tab-bar /
 *              .tab-btn 语义类（含移动端字号媒体查询），与页级 ModeTabs 视觉一致。
 * @returns {JSX.Element} 带手势的区块视图
 */
export default function BlockSwipeTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  renderTab,
  className = '',
  headerClassName = '',
  bodyClassName = '',
}: BlockSwipeTabsProps<T>) {
  const order = tabs.map((t) => t.id);
  // 手势绑定在内容滑动容器：区块内容区横滑即切换（移动端免点击）
  const { containerRef, handlers, offset, dragging } = useSwipeTabs({
    order,
    value,
    onChange,
  });
  const idx = Math.max(0, order.indexOf(value));
  // 渲染全部 Tab 内容组成横向轨道：既保证拖动时相邻菜单内容跟手滑入，
  // 也保证点击跨多步跳转时（如 1天→全部）能平滑滑过中间面板，无跳变。
  const visible = order.map((_, i) => i);

  return (
    <div className={className}>
      {/* Tab 条：固定不随滑动位移，仅作菜单指示 */}
      <div className={`tab-bar ${headerClassName}`} role="tablist" aria-label={ariaLabel}>
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === value}
            onClick={() => onChange(id)}
            className={`tab-btn ${id === value ? 'active' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 滑动容器：仅内容区跟手，相邻菜单内容随拖动滑入 */}
      <div ref={containerRef} {...handlers} className={`overflow-x-hidden ${bodyClassName}`}>
        <div
          className="flex"
          style={{
            transform: `translateX(calc(${-idx * 100}% + ${offset}px))`,
            transition: dragging ? 'none' : TRANSITION,
            willChange: dragging ? 'transform' : undefined,
          }}
        >
          {visible.map((i) => (
            <div key={order[i]} className="w-full flex-shrink-0">
              {renderTab(order[i])}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
