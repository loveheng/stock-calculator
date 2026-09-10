/**
 * @file PromptTemplates.tsx
 * @description 预置提问模板分组按钮（spec F3）：搜索冷启动引导，点击即按模板参数
 *              发起查询（用户零输入成本）。持仓风险类模板在无进行中持仓时置灰并提示。
 *              模板清单/参数构造在 utils/searchPrompts（R2：持仓集合由视图 dispatch 注入）。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { SEARCH_PROMPT_TEMPLATES, templateGroupLabel } from '../../utils/searchPrompts';
import type { SearchPromptTemplate } from '../../types/search';

const GROUPS: Array<SearchPromptTemplate['group']> = ['holding-risk', 'market-flash'];

interface PromptTemplatesProps {
  /** 是否存在进行中持仓（持仓风险类模板的可用前提） */
  hasHoldings: boolean;
  onPick: (template: SearchPromptTemplate) => void;
}

export default function PromptTemplates({ hasHoldings, onPick }: PromptTemplatesProps) {
  return (
    <div className="space-y-3">
      {GROUPS.map((group) => {
        const templates = SEARCH_PROMPT_TEMPLATES.filter((t) => t.group === group);
        if (templates.length === 0) return null;
        return (
          <div key={group} className="space-y-1.5">
            <div className="text-xs font-medium text-slate-500">{templateGroupLabel(group)}</div>
            <div className="flex flex-wrap gap-2">
              {templates.map((t) => {
                const disabled = t.requiresHoldings && !hasHoldings;
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={disabled}
                    title={disabled ? '需要先录入进行中的持仓' : t.label}
                    onClick={() => onPick(t)}
                    className={`max-w-full rounded-lg border px-3 py-2 text-left text-xs leading-relaxed transition-colors ${
                      disabled
                        ? 'cursor-not-allowed border-slate-800 text-slate-600'
                        : 'border-slate-700 bg-slate-800/50 text-slate-300 hover:border-blue-500/60 hover:text-blue-300'
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
