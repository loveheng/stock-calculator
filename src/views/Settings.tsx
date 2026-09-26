/**
 * @file Settings.tsx
 * @description 设置页：页级子菜单（费率配置 / 通知管理），与资讯页同构（ModeTabs outline 变体）。
 *              费率配置复用既有 views/FeeConfig（交易规费模板 + 费用试算）；
 *              通知管理为价格预告单监控（`/api/broker/monitor/*`）的管理入口。
 *              子菜单为内存态（useState），切换不保留表单草稿。
 * @layer UI
 * @storage_impact 本页不直接读写存储：费率配置经 store 写 feeConfigs 表，通知管理经 services/monitorService。
 * @author 开发团队
 */

import React, { useState } from 'react';
import type { ElementType } from 'react';
import { Settings as SettingsIcon, Bell } from 'lucide-react';
import ModeTabs from '../components/ui/ModeTabs';
import SwipeTabPanel from '../components/ui/SwipeTabPanel';
import FeeConfigPage from './FeeConfig';
import MonitorPanel from '../components/monitor/MonitorPanel';

/** 设置页子菜单 id */
type SettingsTab = 'fee' | 'notify';

/** 子菜单定义（模块级常量，避免每次渲染重建数组） */
const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; icon: ElementType }> = [
  { id: 'fee', label: '费率配置', icon: SettingsIcon },
  { id: 'notify', label: '通知管理', icon: Bell },
];

/** 滑动切换顺序（与 Tab 条视觉顺序一致，单一事实源派生） */
const SETTINGS_TAB_ORDER: readonly SettingsTab[] = SETTINGS_TABS.map((t) => t.id);

/**
 * 设置页面组件。
 *
 * @returns {JSX.Element} 设置页视图
 */
export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('fee');

  return (
    <div className="space-y-4">
      <ModeTabs tabs={SETTINGS_TABS} value={tab} onChange={setTab} ariaLabel="设置页子菜单" />
      {/* 内容区左右滑动切换子菜单（移动端 Pivot 手势；桌面无 touch 不生效） */}
      <SwipeTabPanel order={SETTINGS_TAB_ORDER} value={tab} onChange={setTab}>
        {tab === 'fee' ? <FeeConfigPage /> : <MonitorPanel />}
      </SwipeTabPanel>
    </div>
  );
}
