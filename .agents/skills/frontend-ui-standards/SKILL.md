---
name: frontend-ui-standards
description: stock-calculator 前端 UI 视觉与交互规范：按钮形状统一 rounded-lg（胶囊 rounded-full 仅限 Tab/分段切换条）、移动端 44px 触摸热区（tap-target）、可折叠卡片展开面板响应式高度（移动端 60vh 上限滚动、宽屏固定 60vh 撑满）、头部操作组合容器与 stopPropagation、公共组件复用优先与重复抽取阈值（Rule of Three 分级）、页级子菜单 + 滑动切换（ModeTabs + SwipeTabPanel）。新增或修改页面/组件、写操作按钮、做折叠面板、新增第二种同构 UI 或第二次复制同一段逻辑、把多段平级页面区块拆成可切换子菜单时使用。
---

# Frontend UI Standards

## Overview
Encodes the UI conventions established for the stock-calculator frontend (React + Tailwind + the global `.btn` utility system). Apply these rules so every new page matches the existing look-and-feel without re-deriving design decisions.

## When To Use
- Adding or editing a page/view under `src/views/` or a shared component under `src/components/`.
- Building operation buttons (加仓/减仓/结仓, 订阅公告, 问AI, 删除, etc.) or icon buttons.
- Building collapsible / expandable cards or detail panels.
- Any UI work touching mobile / responsive layout.
- Writing the **2nd** copy of the same JSX/logic block, or a **3rd** structurally similar UI
  (empty state, tab bar, filter) — i.e. deciding reuse vs. extraction (see §5).
- Splitting a page's peer sections into switchable submenus (see §6).

## Mandatory Conventions

### 1. Button shapes — unified to rounded rectangle
- All action buttons use the global `.btn` system, which is `rounded-lg` (rounded rectangle). Do **not** use `rounded-full` (capsule) for operation buttons.
- Icon buttons (e.g. 订阅公告, 删除) are also `rounded-lg`.
- The shared `问AI` button component `BlockFocusButton` is already `rounded-lg` — keep it that way; never reintroduce `rounded-full`. Its exact path must be looked up via the project index skill `stock-calculator-index`; do not hardcode volatile file paths in this skill.
- Keep related buttons visually consistent: same radius, same padding weight.
- **Capsule exception (do not "fix" these)**: `rounded-full` is allowed **only** for tab / segmented switchers — i.e. the shared `ModeTabs` component (资讯页页级切换、AI 选股台三 Tab、检索范围过滤). Operation buttons, icon buttons and filters-with-actions stay `rounded-lg`. `ModeTabs` already ships 3 variants (`outline` / `solid` / `segmented`); that is the ceiling — a 4th tab shape must be a new component, not a new variant.

### 2. Mobile tap targets — 44px hot zone
- Add the `tap-target` class to any clickable control (button / link / icon) that must be touch-friendly on mobile. Global CSS enlarges `.tap-target` to a 44px hit area on small screens.
- In a grouped action bar, every button should carry `tap-target`.

### 3. Card expand/collapse & responsive height (critical)
Position cards (e.g. 中长期交易持仓卡片) remain collapsible:
- Maintain a `Set<string>` of expanded ids (`expandedIds`) plus `toggleExpand` / `expandAll` / `collapseAll`.
- The header row is clickable (`cursor-pointer`, `onClick={toggleExpand}`) and shows a `ChevronRight` that rotates when expanded; provide「展开全部 / 收起全部」buttons in the section header.
- The expanded detail panel height MUST follow this responsive rule:
  - Mobile (`<md`): `max-h-[60vh] overflow-y-auto` → scroll when content overflows; shrink (no wasted space) when content is short.
  - Wide (`md+`): `md:h-[60vh]` → fixed to the max height; content shorter than 60vh still occupies the full 60vh (empty space is acceptable); content longer than 60vh scrolls inside.
  - Principle: "scroll when overflowing; fill the max height even when not full."

### 4. Header action group container
When several unrelated header actions (订阅公告 / 问AI / 删除) sit together, wrap them in one group:
`flex items-center gap-1 rounded-lg bg-slate-800/60 p-1`, and call `e.stopPropagation()` on the group's `onClick` so tapping an action does not toggle the card expand.

### 5. Reuse first + graded extraction threshold (Rule of Three)

**5.1 Reuse first (mandatory, no threshold)**
- Before adding any page/component, look up existing shared assets: `src/components/ui/`
  (cross-page, no business semantics), `src/components/<domain>/` (domain-local reuse),
  `src/hooks/` (logic), `src/utils/` (pure functions). Unknown location → query the
  `stock-calculator-index` skill (feature → code landing); do not guess paths.
- If one exists, **reuse it** — never copy a component and then tweak its classes/logic.
  Absorb differences via props / `variant` instead of forking.

**5.2 Extraction threshold (graded, not a flat "3")**
- **Copy-paste duplication** (the same JSX/logic block pasted into a 2nd place): extract at the
  **2nd** occurrence — it will never converge on its own and will drift (e.g. the plan-execute
  chain that existed verbatim in both the home page and the AI 选股台 plan tab).
- **Structural duplication** (hand-written separately, details differ — empty states, tab bars,
  filter predicates): extract at the **3rd** occurrence (Rule of Three). At the 2nd occurrence you
  MUST leave a marker: `// TODO-REUSE: <candidate component name>` so the 3rd has evidence.

**5.3 Exemptions (any hit → do not extract)**
- Differences outweigh the common part; or the shared component would need >3 variants / too many
  props → stop abstracting, keep the duplication.
- Only one usage site: no "preventive" abstraction.
- Side-effect / perf-sensitive seams: e.g. quote polling (`useLiveQuotes`) allows one subscription
  per page — a shared list component must accept injected data rather than subscribe again.
- Cross-layer duplication is not a UI component: pure logic → `utils`, stateful logic → `hooks`.

**5.4 Extraction requires regression**
- After rewiring call sites always run: `npx tsc --noEmit` + `npx vitest run` + `node scripts/check-layers.mjs`.
- Layering: `utils` (pure) → `hooks` (stateful logic) → `components` (presentation) → `views`;
  `utils` must never depend on the store.

## Reference
For concrete JSX snippets (state boilerplate, panel class strings, group container, `ModeTabs` / `SwipeTabPanel` / `EmptyState` usage, and the shared-asset lookup table), see `references/ui-conventions.md`.

## Mandatory Conventions (cont.)

### 6. Page-level submenu with swipe (ModeTabs + SwipeTabPanel)
When a page exposes multiple **peer** sections the user switches between (e.g. 涨跌幅页
按涨跌幅算目标价 / 按目标价算涨跌幅 / 连续涨跌停阶梯；统计页 做T账本 / 仓位 / 自定义；
中长期页 仓位管理 / 目标成本推算), implement them as a **page-level submenu**, not a
hand-written `<div className="flex ...">` button row:

- **Tab bar** — use the shared `ModeTabs` component. Each entry is `{ id, label, icon }`
  (`icon` from `lucide-react`, typed `ElementType`). The default variant renders a pill bar
  with icons and is the page-level style; reserve `variant="segmented"` / `solid` for
  equal-width / filter-scope uses.
- **Swipe** — wrap the active panel in `SwipeTabPanel` so mobile users switch sections by
  horizontal swipe. Pass the same `order` array (ids in visual order) plus `value` / `onChange`
  as `ModeTabs`.
- **Render only the active panel** inside `SwipeTabPanel` (single child — a ternary on `tab`);
  each panel component renders its own `space-y-4` container. Do **not** additionally wrap the
  panels in an outer `.card` with a redundant `<h3>` title — the tab label already names the section.
- `order` MUST equal the visual order of `ModeTabs` tabs; swipe direction follows that array.
- Children that need their own horizontal scroll/drag (wide tables, canvas RGL blocks) must be
  tagged `data-swipe-ignore` so the gesture hands off to inner scrolling (see `SwipeTabPanel` doc).
- This supersedes the old pattern of nesting `ModeTabs variant="segmented"` inside a card:
  peer page sections belong at page level.

```tsx
type CostTab = 'ledger' | 'target';
const COST_TABS: ReadonlyArray<{ id: CostTab; label: string; icon: ElementType }> = [
  { id: 'ledger', label: '仓位管理', icon: Wallet },
  { id: 'target', label: '目标成本推算', icon: Target },
];
const COST_TAB_ORDER: readonly CostTab[] = COST_TABS.map((t) => t.id);

export default function CostAveraging() {
  const [tab, setTab] = useState<CostTab>('ledger');
  return (
    <div className="page-container space-y-5 pb-[env(safe-area-inset-bottom)]">
      <ModeTabs tabs={COST_TABS} value={tab} onChange={setTab} ariaLabel="中长期交易子菜单" />
      <SwipeTabPanel order={COST_TAB_ORDER} value={tab} onChange={setTab} className="space-y-5">
        {tab === 'ledger' ? <PositionLedger /> : <TargetCostCalculator />}
      </SwipeTabPanel>
    </div>
  );
}
```

- `tab` is a **memory-state** switch (`useState`), not a route/store slice — switching must not
  unmount-and-lose the underlying data (that lives in its own slice).
- Exact paths resolve via the `stock-calculator-index` skill: `ModeTabs` → `components/ui/ModeTabs`,
  `SwipeTabPanel` → `components/ui/SwipeTabPanel`; do not hardcode volatile paths.
