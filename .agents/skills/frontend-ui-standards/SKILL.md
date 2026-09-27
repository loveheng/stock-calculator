---
name: frontend-ui-standards
description: stock-calculator 前端 UI 视觉与交互规范：按钮形状统一 rounded-lg（胶囊 rounded-full 仅限 Tab/分段切换条）、移动端 44px 触摸热区（tap-target，但 tap-target 是 inline-flex，绝不可作为多行可点击卡片头容器，否则内部行被压扁成竖排）、可折叠卡片展开面板响应式高度（移动端 60vh 上限滚动、宽屏固定 60vh 撑满）、头部操作组合容器与 stopPropagation、公共组件复用优先与重复抽取阈值（Rule of Three 分级）、页级子菜单 + 滑动切换（ModeTabs + SwipeTabPanel，滑动命中区需抵消外层 padding 铺满横向边缘与屏下空白）、自由网格/画布响应式（窄屏单列堆叠、宽屏多列、展示态不回写布局）。新增或修改页面/组件、写操作按钮、做折叠面板、新增第二种同构 UI 或第二次复制同一段逻辑、把多段平级页面区块拆成可切换子菜单、做响应式自由网格/画布布局时使用。新建或改造「新增计划单」表单（有效期 / 价格阈值范围 / 价格提醒区块）时使用。
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
- Building or changing a 新增计划单 form (有效期 / 价格阈值范围 / 价格提醒区块) — it must bind the shared
  `PlanOrderForm` template instead of a page-local form; see §8.

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

### 2.1 `tap-target` is `inline-flex` — NEVER use it as a clickable card-header container
The global `.tap-target` is `inline-flex items-center justify-center` (see `src/styles.css`), not a block.
**If you put `tap-target` on the OUTER wrapper of a multi-row clickable card header, its direct
children (the name row AND the badge/metric row) become same-row flex items** and get squished
side-by-side — on mobile the badge block collapses into a narrow vertical column (错乱). This is a
recurring footgun in both `TCalculator.tsx` (短线卡) and `CostAveraging.tsx` (中长期持仓卡).

- **Card header (the clickable row that toggles expand) must be an explicit block**, never `tap-target`:
  `flex flex-col w-full min-h-[44px] p-3 cursor-pointer select-none`. `min-h-[44px]` already satisfies
  the 44px touch zone, so you lose nothing by dropping `tap-target` here.
- The header's Inner rows (name row, badge/metric row) then stack vertically and each stretches to full
  width via `flex flex-wrap` — no horizontal squish. See the pattern at `TCalculator.tsx:633` and
  `CostAveraging.tsx:898`.
- **Inner action buttons** inside the header: `tap-target` is still fine for a standard 44px hit area,
  BUT when the card header is compact you may want smaller icons. To shrink an icon button below 44px,
  either (a) omit `tap-target` and set an explicit size (`w-7 h-7 rounded-lg …`), or (b) keep `tap-target`
  and override with `!min-w-0 !min-h-0 !w-7 !h-7`. Do NOT leave `tap-target` with only `w-10 h-10` —
  its `min-w/min-h-[44px]` wins and the button renders at 44px.

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
- **Swipe hit-area must reach the screen edges.** `SwipeTabPanel` already cancels the App content
  wrapper's `p-4 md:p-6` in its `BASE_CLASS` (`-mx-4 md:-mx-6 px-4 md:px-6`) so the left/right ~16/24px
  side-padding blind strip is swipeable; `min-h-[100dvh] md:min-h-0` makes blank space below short
  content swipeable too. **Page authors must keep `<SwipeTabPanel>` a direct child of `page-container`**
  (never wrap it in another horizontally-padded container, or a residual blind strip reappears and
  content may shift). If the App wrapper padding ever changes, update `BASE_CLASS` in lockstep.
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

### 7. Responsive free-grid / canvas layout (compact single column ↔ free multi-column)
Free-form grids built on `react-grid-layout` (RGL) — e.g. the AI 选股台 画布 — store block
coordinates in a fixed N-column space (12 by default). On small screens the grid must NOT simply
shrink each column to a sliver; it must **collapse to a single stacked column** and switch back to
the free multi-column layout once the viewport is wide enough (phone → foldable closed = compact;
foldable open / tablet / desktop = free).

- **Decide mode by viewport width, not container width.** Base the breakpoint on `window.innerWidth`
  (CSS px, device-pixel-ratio independent) so a foldable differentiates closed (~narrow) vs open
  (~wide). Pick a breakpoint constant (e.g. `COMPACT_MAX_WIDTH = 640`) and a `useViewportWidth`
  hook listening to `resize`.
- **Compact (narrow) = single column:** feed RGL `cols={1}` and transform the layout so **every
  block spans the full row and stacks vertically** — `x: 0, w: 1`, `y` accumulated by each block's
  original `h`, keeping its height. Disable drag & resize in this mode.
- **Free (wide) = original grid:** pass the stored N-column layout and `cols` unchanged; keep
  drag/resize + layout persistence enabled.
- **CRITICAL guard — never write the transformed layout back.** In compact mode the displayed
  coordinates (`x:0, w:1`) are synthetic and would corrupt the persisted free-grid coordinates. Gate
  the save / `onLayoutChange` → store write behind `if (isCompact) return;` so compact mode is
  **display-only**. Switching back to wide re-renders the untouched original layout.
- Keep block heights in compact mode equal to their free-layout `h` (in row units) so content area
  is preserved; do not flatten to a fixed height.
- Reference implementation: the AI 选股台 画布 (`CanvasBoardView`) — resolve its current path via the
  `stock-calculator-index` skill; do not hardcode it.

### 8. 计划单创建表单 — 三处绑定同一模板（禁止各自手写）

「新增计划单」存在三个落点：AI 选股台 计划单 Tab、短线交易页、中长期交易页。三者**必须绑定同一个
模板组件 `PlanOrderForm`**，不得各自维护一套表单 JSX / 状态 / 校验（三套表单曾逐字复制并漂移，属 §5.2
的「逐字复制」，已在第 2 处抽取为模板）。

**绑定关系**（组件名稳定，具体文件路径经 `stock-calculator-index` 解析，勿在此硬编码）：

| 角色 | 组件 / 函数 | 职责 |
|---|---|---|
| 表单模板（唯一新增入口） | `PlanOrderForm`（`components/plan/`） | 股票 / 方向 / 计划价 / 数量 / 有效期 / 提醒区块 + 字段校验 + 提交重置 |
| 提醒区块（内嵌于模板） | `PlanReminderField`（`components/monitor/`） | 开启价格提醒开关 + 容差 + 价格阈值范围 + L1 触发边界 / L2 当前价提示 |
| 阈值范围换算 | `computeThresholdRange(center, unit, amount)`（`utils/planOrder`） | `unit: 'pct'` 比例(%) / `'value'` 绝对值(元) 双口径 → 统一落库绝对价 `{ low, high }` |
| 有效期选项 | `VALIDITY_PRESETS`（由 `PlanOrderForm` 导出） | 固定 `3 / 7 / 14 / 30` 天，分段按钮，**不允许用户自由输入天数** |
| 展示侧 | `PlanOrderList` → `PlanOrderCard` | 已有 `thresholdRange` 时自动渲染「阈值范围 ¥low ~ ¥high」，表单侧无需额外改动 |

**契约（改任一侧前先读模板签名，不要改调用方去将就）**：

- 入参：`context`（固定上下文）/ `selectableContext`（仅 AI 选股台为 `true`，短线·中长期为 `false` 由 `context` 固定）/
  `initialValues`（编辑回填）/ `onSubmit` / `onCancel` / `submitLabel`。
- 出参：`PlanOrderFormValues`（含 `thresholdRange?` / `reminderEnabled` / `reminderBand`）；
  `onSubmit` 返回 `false` 表示失败（如去重未通过）→ 表单**保持打开并保留已填内容**；其余视为成功并重置。
- 价格阈值范围：仅在 `reminderEnabled === true` 且幅度 > 0 时写入 `thresholdRange`；**单位不落库**（存的是绝对价），
  故编辑回填统一按**比例**反推展示。
- 阈值范围的「比例 | 值」切换为就地分段按钮，**不引入新的切换组件**（§1 的 `ModeTabs` 三 variant 已是上限）。
- 新增字段一律加到模板 + `PlanOrderFormValues` / `PlanOrderInitialValues`，三处同时生效；
  **禁止在某一页单独加输入框或自行 `setState`**（页内私有状态如 `planThresholdPct` 是错误做法，已清除）。
- 改完跑 §5.4 回归：`npx tsc --noEmit` + `npx vitest run` + `node scripts/check-layers.mjs`。
