---
name: frontend-ui-standards
description: stock-calculator 前端 UI 视觉与交互规范：按钮形状统一 rounded-lg（禁 rounded-full 胶囊）、移动端 44px 触摸热区（tap-target）、可折叠卡片展开面板响应式高度（移动端 60vh 上限滚动、宽屏固定 60vh 撑满）、头部操作组合容器与 stopPropagation。新增或修改页面/组件、写操作按钮、做折叠面板时使用。
---

# Frontend UI Standards

## Overview
Encodes the UI conventions established for the stock-calculator frontend (React + Tailwind + the global `.btn` utility system). Apply these rules so every new page matches the existing look-and-feel without re-deriving design decisions.

## When To Use
- Adding or editing a page/view under `src/views/` or a shared component under `src/components/`.
- Building operation buttons (加仓/减仓/结仓, 订阅公告, 问AI, 删除, etc.) or icon buttons.
- Building collapsible / expandable cards or detail panels.
- Any UI work touching mobile / responsive layout.

## Mandatory Conventions

### 1. Button shapes — unified to rounded rectangle
- All action buttons use the global `.btn` system, which is `rounded-lg` (rounded rectangle). Do **not** use `rounded-full` (capsule) for operation buttons.
- Icon buttons (e.g. 订阅公告, 删除) are also `rounded-lg`.
- The shared `问AI` button component `BlockFocusButton` is already `rounded-lg` — keep it that way; never reintroduce `rounded-full`. Its exact path must be looked up via the project index skill `stock-calculator-index`; do not hardcode volatile file paths in this skill.
- Keep related buttons visually consistent: same radius, same padding weight.

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

## Reference
For concrete JSX snippets (state boilerplate, panel class strings, group container), see `references/ui-conventions.md`.
