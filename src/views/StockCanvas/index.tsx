/**
 * @file index.tsx
 * @description AI 选股台页（一级菜单「AI 选股台」，route /stock-canvas）页级三 Tab 壳层：
 *              计划单 / 画布列表 / 画布。切换范式对齐资讯页（NewsSearch MODE_TABS）——
 *              useState 内存态，不进路由、不进 store；切走再切回数据不丢（计划单态在
 *              ordersSlice、画布态在 canvasSlice）。AI 上下文经 useCanvasContext 注册
 *              （scopeId=canvas），聊天复用全局 GlobalCopilot 浮窗。
 * @layer View
 * @storage_impact 无直接持久化读写；数据经 store action（canvasSlice / ordersSlice）落库。
 * @author 开发团队
 */

import { useEffect, useState } from 'react';
import { ClipboardList, Layers, LayoutGrid } from 'lucide-react';
import { useAppStore } from '../../store';
import { useCanvasContext } from '../../hooks/useCanvasContext';
import ModeTabs from '../../components/ui/ModeTabs';
import SwipeTabPanel from '../../components/ui/SwipeTabPanel';
import PlanOrderPanel from './PlanOrderPanel';
import CanvasBoardList from './CanvasBoardList';
import CanvasBoardView from './CanvasBoardView';

/** 页级模式：plans = 计划单，boards = 画布列表，canvas = 画布（内存态切换，不进 store） */
type PickerPageMode = 'plans' | 'boards' | 'canvas';

const MODE_TABS: Array<{ id: PickerPageMode; label: string; icon: typeof LayoutGrid }> = [
  { id: 'plans', label: '计划单', icon: ClipboardList },
  { id: 'boards', label: '画布列表', icon: Layers },
  { id: 'canvas', label: '画布', icon: LayoutGrid },
];

/** 滑动切换顺序（与 Tab 条视觉顺序一致） */
const MODE_TAB_ORDER: readonly PickerPageMode[] = MODE_TABS.map((t) => t.id);

/**
 * AI 选股台页面组件（Tab 壳层）。
 *
 * @description 挂载时 loadCanvas（一次性，兜底保证至少一块画布）；三个 Tab 各自持有数据面板。
 * @returns {JSX.Element} AI 选股台视图
 */
export default function StockCanvas() {
  const canvasLoaded = useAppStore((s) => s.canvasLoaded);
  const loadCanvas = useAppStore((s) => s.loadCanvas);

  const [mode, setMode] = useState<PickerPageMode>('canvas');

  useCanvasContext();

  useEffect(() => {
    if (!canvasLoaded) void loadCanvas();
  }, [canvasLoaded, loadCanvas]);

  return (
    <div className="space-y-3">
      {/* 页级模式切换：计划单 / 画布列表 / 画布 */}
      <ModeTabs tabs={MODE_TABS} value={mode} onChange={setMode} ariaLabel="AI 选股台模式" />

      {/* 内容区左右滑动切换 Tab（移动端 Pivot 手势）；画布 Tab 内部标 data-swipe-ignore：
          RGL 拖块与画布横滚优先，避免横滑被误判为切 Tab */}
      <SwipeTabPanel order={MODE_TAB_ORDER} value={mode} onChange={setMode}>
        {mode === 'plans' ? (
          <PlanOrderPanel />
        ) : mode === 'boards' ? (
          <CanvasBoardList onOpenBoard={() => setMode('canvas')} />
        ) : (
          /* 画布 Tab：RGL 需显式高度容器（页头 + Tab 条已占约 9.5rem） */
          <div data-swipe-ignore className="h-[calc(100vh-9.5rem)] min-h-[420px]">
            <CanvasBoardView />
          </div>
        )}
      </SwipeTabPanel>
    </div>
  );
}
