/**
 * @file IntentFilterTabs.tsx
 * @description 资讯搜索意图分流 Tabs（spec F1/D3）：三个语义 Filter 约束检索范围
 *              （公告库 / CLS 电报库 / 双库+LLM 综合），不猜测用户意图；股票形态由
 *              搜索词确定性检测识别并可覆盖持仓限定，故 Tab 不做置灰。
 *              注：CLS 语料即财联社电报（接口文档 Q3 终版定案：无早报/晚报）。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { Newspaper, Pin, Sparkles } from 'lucide-react';
import type { SearchScope } from '../../types/search';
import ModeTabs from '../ui/ModeTabs';

const TABS: Array<{ id: SearchScope; label: string; icon: typeof Pin }> = [
  { id: 'announcement', label: '持仓公告', icon: Pin },
  { id: 'cls', label: '财联社电报', icon: Newspaper },
  { id: 'composite', label: 'AI 智能综合', icon: Sparkles },
];

interface IntentFilterTabsProps {
  scope: SearchScope;
  onChange: (scope: SearchScope) => void;
}

/**
 * 资讯检索意图分流 Tabs：视觉为实心胶囊变体，结构与行为复用通用 ModeTabs。
 */
export default function IntentFilterTabs({ scope, onChange }: IntentFilterTabsProps) {
  return <ModeTabs tabs={TABS} value={scope} onChange={onChange} ariaLabel="检索范围" variant="solid" />;
}
