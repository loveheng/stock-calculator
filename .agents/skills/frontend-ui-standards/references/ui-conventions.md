# UI Conventions — Code Reference

Concrete snippets for the rules in `SKILL.md`. Copy these patterns when building new pages.

---

## 1. Button shapes

Shared `问AI` button (`src/components/copilot/BlockFocusButton.tsx`). Keep `rounded-lg`, never `rounded-full`:

```tsx
className={`flex flex-shrink-0 items-center gap-1 rounded-lg border border-slate-600/70 bg-slate-800/60 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-blue-500/60 hover:text-blue-300 ${className ?? ''}`}
```

- 订阅公告 / 删除 icon buttons: `rounded-lg`.
- 加仓 / 减仓 / 结仓: use the global `.btn` / `.btn-primary` / `.btn-outline` classes (already `rounded-lg`).
- Do not mix `rounded-full` and `rounded-lg` within the same action group.

---

## 2. Mobile tap targets

Add `tap-target` to any clickable control; global CSS grows it to a 44px hit area on small screens:

```tsx
<button className="btn btn-primary flex-1 tap-target">加仓</button>
<button className="btn btn-outline flex-1 tap-target">减仓</button>
```

In a grouped action bar, every button should carry `tap-target`.

---

## 3. Card expand/collapse & responsive height

### State (per trading page that lists position cards)

```tsx
const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

const toggleExpand = (id: string) => {
  setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
};
const expandAll = () => setExpandedIds(new Set(activePositions.map((p) => p.id)));
const collapseAll = () => setExpandedIds(new Set());
```

### Section header with 展开全部 / 收起全部

```tsx
<div className="flex items-center justify-between px-1">
  <span className="text-xs text-slate-500">进行中持仓（{activePositions.length}）</span>
  <div className="flex items-center gap-2">
    <button onClick={expandAll} className="tap-target text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-slate-800">展开全部</button>
    <span className="text-slate-700">|</span>
    <button onClick={collapseAll} className="tap-target text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-slate-800">收起全部</button>
  </div>
</div>
```

### Card header (clickable, shows rotating chevron)

```tsx
const isExpanded = expandedIds.has(pos.id);

// header row
<div
  className="tap-target flex flex-wrap items-center gap-x-2 gap-y-1 p-3 cursor-pointer select-none"
  onClick={() => toggleExpand(pos.id)}
>
  {/* ...summary content... */}
  <div className="flex items-center shrink-0 ml-auto gap-1">
    {/* action group — see section 4 */}
    <div className="tap-target flex items-center justify-center w-11 h-11">
      <ChevronRight
        className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
      />
    </div>
  </div>
</div>
```

### Expanded detail panel — responsive height (the key rule)

```tsx
{isExpanded && (
  <div className="p-3 pt-0 space-y-3 max-h-[60vh] overflow-y-auto md:h-[60vh]">
    {/* detail content */}
  </div>
)}
```

- Mobile (`<md`): `max-h-[60vh] overflow-y-auto` → scrolls on overflow, shrinks when content is short (no wasted space).
- Wide (`md+`): `md:h-[60vh]` → fixed to the max height; even short content occupies the full 60vh, long content scrolls inside.
- If a different breakpoint is desired (e.g. `lg:`), change `md:` accordingly. Adjust `60vh` to taste.

---

## 4. Header action group container

Wrap unrelated header actions (订阅公告 / 问AI / 删除) in one group and stop propagation so they don't toggle the card:

```tsx
<div className="flex items-center shrink-0 ml-auto gap-1">
  <div
    className="flex items-center gap-1 rounded-lg bg-slate-800/60 p-1"
    onClick={(e) => e.stopPropagation()}
  >
    <AnnouncementSubscribeButton fullCode={pos.fullCode} />
    {pos.fullCode && (
      <BlockFocusButton
        scopeId={`cost_averaging:${pos.fullCode}`}
        blockId={`cost_averaging:${pos.fullCode}:position`}
        className="tap-target"
      />
    )}
    <button
      onClick={(e) => { e.stopPropagation(); setDeleteTickerConfirm(pos.id); }}
      className="tap-target flex items-center justify-center w-10 h-10 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10"
      title="删除整个标的"
    >
      <Trash2 className="w-4 h-4" />
    </button>
  </div>
  {/* chevron lives OUTSIDE this group so header-click still toggles */}
</div>
```

---

## 5. Reuse-first: shared building blocks

Look these up (via `stock-calculator-index`) before writing anything new. Reuse, don't re-derive.
Names below are component names; resolve the exact file path with the index skill.

| Need | Use | Notes |
|------|-----|-------|
| Page/section tab switcher | `ModeTabs` | `variant`: `outline` (page-level, e.g. 资讯/AI 选股台) · `solid` (filter scope) · `segmented` (equal-width, reuses `.tab-bar`/`.tab-btn`) |
| Page-level swipe container | `SwipeTabPanel` | wraps the active submenu panel; `order` (ids in visual order) + `value` + `onChange` mirror `ModeTabs`; inner horizontal-scroll/drag children tag `data-swipe-ignore` |
| Empty list / no data | `EmptyState` | `variant`: `card` · `dashed` · `panel`; `icon` / `title` / `description` / `action` |
| Confirm dialog | `ConfirmModal` | `confirmLabel` or `confirmText`, `danger` |
| Plan order cards | `PlanOrderList` (wraps `PlanOrderCard`) | own domain `components/plan/`; inject `quotes` if the page already polls |
| Plan execution | hook `usePlanExecutor` | options: `silent` (page has its own toast) · `requirePosition` · `onExecuted` (page-specific side effects, e.g. 履约审计) |
| Plan filter predicate | `filterDisplayablePlans` / `filterActivePlans` (`utils`) | single source of the 3-day display window; views and Copilot snapshots must share it |
| Toast | `showToast` (`utils`) | never inline `window.dispatchEvent(new CustomEvent('app-toast', …))` |

### ModeTabs (the only `rounded-full` allowed)

```tsx
// module-level constant: keeps the array identity stable
const MODE_TABS: Array<{ id: PageMode; label: string; icon: typeof LayoutGrid }> = [
  { id: 'plans', label: '计划单', icon: ClipboardList },
  { id: 'boards', label: '画布列表', icon: Layers },
  { id: 'canvas', label: '画布', icon: LayoutGrid },
];

<ModeTabs tabs={MODE_TABS} value={mode} onChange={setMode} ariaLabel="AI 选股台模式" />
<ModeTabs tabs={TABS} value={scope} onChange={onChange} ariaLabel="检索范围" variant="solid" />
<ModeTabs tabs={LEDGER_TABS} value={tab} onChange={setTab} ariaLabel="仓位管理模式" variant="segmented" />
```

- Mode is a **memory-state** switch (`useState`), not a route and not a store slice — switching tabs must not unmount-and-lose the underlying data (that state lives in its own slice).
- 3 variants is the ceiling; a 4th tab shape = new component.
- For **page-level peer sections** (multiple switchable blocks on one page), pair `ModeTabs` with
  `SwipeTabPanel` so mobile users swipe between sections — see §6.

---

## 6. Page-level submenu + swipe (ModeTabs + SwipeTabPanel)

When a page has multiple **peer** sections the user switches between, render them as a page-level
submenu, NOT a hand-written `<div className="flex ...">` button row:

```tsx
import type { ElementType } from 'react';
import { Wallet, Target } from 'lucide-react';
import ModeTabs from '../components/ui/ModeTabs';
import SwipeTabPanel from '../components/ui/SwipeTabPanel';

type CostTab = 'ledger' | 'target';

// module-level constant: stable array identity across renders
const COST_TABS: ReadonlyArray<{ id: CostTab; label: string; icon: ElementType }> = [
  { id: 'ledger', label: '仓位管理', icon: Wallet },
  { id: 'target', label: '目标成本推算', icon: Target },
];
// swipe order MUST match the visual order of ModeTabs tabs
const COST_TAB_ORDER: readonly CostTab[] = COST_TABS.map((t) => t.id);

export default function CostAveraging() {
  const [tab, setTab] = useState<CostTab>('ledger');

  return (
    <div className="page-container space-y-5 pb-[env(safe-area-inset-bottom)]">
      {/* page-level submenu (mobile: swipe to switch) */}
      <ModeTabs tabs={COST_TABS} value={tab} onChange={setTab} ariaLabel="中长期交易子菜单" />

      <SwipeTabPanel order={COST_TAB_ORDER} value={tab} onChange={setTab} className="space-y-5">
        {tab === 'ledger' ? <PositionLedger /> : <TargetCostCalculator />}
      </SwipeTabPanel>
    </div>
  );
}
```

- Render **only the active panel** inside `SwipeTabPanel` (single child, a ternary on `tab`); each
  panel component renders its own `space-y-4` container — do not also wrap them in an outer `.card`
  with a redundant `<h3>` title.
- Inner children that need their own horizontal scroll/drag (wide tables, canvas RGL blocks) must
  be tagged `data-swipe-ignore` so the gesture hands off to inner scrolling (see `SwipeTabPanel` doc).
- Exact component paths resolve via the `stock-calculator-index` skill; do not hardcode volatile paths.

### EmptyState

```tsx
<EmptyState icon={ClipboardList} title="暂无计划单" description="在交易页创建计划后，会在这里统一跟进" />
<EmptyState variant="dashed" title="暂无计划单，创建后可在执行前看到价格对比变化" />
<EmptyState variant="panel" title="暂无仓位数据" />
```

### Duplication markers (Rule of Three)

- 2nd occurrence of a **structural** twin → leave `// TODO-REUSE: <candidate name>`.
- A **verbatim copy** is extracted immediately at the 2nd occurrence — no marker needed.
- After extracting: `npx tsc --noEmit` + `npx vitest run` + `node scripts/check-layers.mjs`.
