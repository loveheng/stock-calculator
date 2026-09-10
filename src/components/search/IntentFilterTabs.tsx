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

const TABS: Array<{ scope: SearchScope; label: string; icon: typeof Pin }> = [
  { scope: 'announcement', label: '持仓公告', icon: Pin },
  { scope: 'cls', label: '财联社电报', icon: Newspaper },
  { scope: 'composite', label: 'AI 智能综合', icon: Sparkles },
];

interface IntentFilterTabsProps {
  scope: SearchScope;
  onChange: (scope: SearchScope) => void;
}

export default function IntentFilterTabs({ scope, onChange }: IntentFilterTabsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto py-1" role="tablist" aria-label="检索范围">
      {TABS.map(({ scope: s, label, icon: Icon }) => {
        const active = s === scope;
        return (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s)}
            className={`tap-target flex flex-shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                : 'bg-slate-800/70 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
