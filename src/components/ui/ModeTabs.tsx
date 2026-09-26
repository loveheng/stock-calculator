/**
 * @file ModeTabs.tsx
 * @description 通用模式切换条（页级 / 区块级 Tab）：泛型 tab id + 三种视觉变体
 *              —— outline（描边胶囊，资讯页/AI 选股台页级切换）、solid（实心胶囊，
 *              检索范围等过滤切换）、segmented（等宽分段，复用 .tab-bar/.tab-btn 语义类，
 *              保持与 .tab-content 及移动端字号媒体查询一致）。
 *              统一 role="tablist" + aria-selected 无障碍契约；tab 数据由调用方以常量数组提供。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import type { ElementType } from 'react';

/** 单个 Tab 项：id 为泛型键（编译期约束 onChange 只能回传合法 id） */
export interface ModeTabItem<T extends string> {
  id: T;
  label: string;
  /** 可选图标（lucide 组件引用，尺寸由组件内部控制） */
  icon?: ElementType;
}

export interface ModeTabsProps<T extends string> {
  /** Tab 定义（建议调用方以模块级常量声明，避免每渲染重建数组） */
  tabs: ReadonlyArray<ModeTabItem<T>>;
  /** 当前选中 id */
  value: T;
  /** 切换回调 */
  onChange: (id: T) => void;
  /** 无障碍标签（tablist 的 aria-label） */
  ariaLabel: string;
  /** 视觉变体，默认 outline */
  variant?: 'outline' | 'solid' | 'segmented';
  /** 追加到容器的类名（默认容器为横向可滚动条，segmented 变体下由语义类接管间距） */
  className?: string;
}

/** 胶囊按钮基础样式（outline / solid 共用） */
const PILL_BASE = 'tap-target flex flex-shrink-0 items-center gap-1.5 rounded-full transition-colors';

const PILL_VARIANT: Record<'outline' | 'solid', { base: string; active: string; idle: string }> = {
  outline: {
    base: `${PILL_BASE} border px-3.5 py-2 text-xs font-semibold`,
    active: 'border-blue-500/40 bg-blue-600/20 text-blue-200',
    idle: 'border-slate-800 bg-slate-900/60 text-slate-500 hover:text-slate-300',
  },
  solid: {
    base: `${PILL_BASE} px-3 py-1.5 text-xs font-medium`,
    active: 'bg-blue-600 text-white shadow-lg shadow-blue-600/20',
    idle: 'bg-slate-800/70 text-slate-400 hover:text-slate-200 hover:bg-slate-800',
  },
};

/**
 * 通用模式切换条组件。
 *
 * @description 受控组件：value/onChange 由调用方持有（内存态或 store 态均可），
 *              组件自身不持有选中状态；切换不卸载内容区，数据态由调用方决定保留与否。
 * @returns {JSX.Element} 切换条视图
 */
export default function ModeTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  variant = 'outline',
  className = '',
}: ModeTabsProps<T>) {
  // 等宽分段变体：复用全局 .tab-bar/.tab-btn 语义类（含移动端字号媒体查询），视觉等价旧内联写法
  if (variant === 'segmented') {
    // data-swipe-ignore：Tab 条自身可横向滚动，横滑此处不触发页级 Tab 切换
    return (
      <div data-swipe-ignore className={`tab-bar ${className}`} role="tablist" aria-label={ariaLabel}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === value}
            onClick={() => onChange(id)}
            className={`tab-btn ${id === value ? 'active' : ''}`}
          >
            {Icon ? (
              <span className="inline-flex items-center justify-center gap-1.5">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
            ) : (
              label
            )}
          </button>
        ))}
      </div>
    );
  }

  const style = PILL_VARIANT[variant];

  return (
    <div
      data-swipe-ignore
      className={`flex gap-2 overflow-x-auto ${variant === 'solid' ? 'py-1' : 'py-0.5'} ${className}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map(({ id, label, icon: Icon }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={`${style.base} ${active ? style.active : style.idle}`}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}
