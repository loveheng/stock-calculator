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
