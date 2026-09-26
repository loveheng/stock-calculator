/**
 * @file CanvasBoardView.tsx
 * @description AI 选股台 · 画布 Tab：顶部工具条（当前画布名/保存态/刷新行情/AI 助手）+
 *              RGL 网格画布区（拖拽/缩放/自由排列）+ 空画布引导（模板网格 / 对话创建）。
 *              由 StockCanvas/index.tsx（页级 Tab 壳层）持有；加载画布由壳层统一触发。
 * @layer View
 * @storage_impact 经 store canvasSlice 读写（800ms 防抖落库 canvasBoards）；本组件不直连 db。
 * @author 开发团队
 */

import React, { useMemo, useRef, useState } from 'react';
import GridLayout, { type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import {
  RefreshCw,
  Bot,
  Plus,
} from 'lucide-react';
import { useAppStore } from '../../store';
import { CANVAS_GRID } from '../../utils/canvasLayout';
import type { CanvasBlock, CanvasBlockType } from '../../types/domain';
import { CANVAS_TEMPLATES } from '../../utils/canvasTemplates';
import CanvasBlockFrame from '../../components/canvas/CanvasBlockFrame';
import CanvasBlockContent from '../../components/canvas/CanvasBlockContent';
import ConfirmModal from '../../components/ui/ConfirmModal';

/** 手动入口模板条目——注册表派生（单一事实源 utils/canvasTemplates）；aiOnly 模板（widget）不进手动入口，仅 canvas_add_widget 动作可创建 */
const TEMPLATES: { type: CanvasBlockType; label: string; icon: React.ElementType }[] = (
  Object.values(CANVAS_TEMPLATES) as { type: CanvasBlockType; label: string; icon: React.ElementType; aiOnly?: boolean }[]
).filter((t) => !t.aiOnly);

/**
 * 画布容器宽度测量（RGL v2 需要显式像素宽度）。
 */
function useContainerWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * AI 选股台 · 画布 Tab 内容组件。
 *
 * @description 区块布局经 RGL onLayoutChange 回写（与现态 diff 后才写，防回环）；
 *              删除区块时若被其他区块引用则弹级联确认。
 * @returns {JSX.Element} 自由画布视图
 */
export default function CanvasBoardView() {
  const canvasBlocks = useAppStore((s) => s.canvasBlocks);
  const canvasSaveState = useAppStore((s) => s.canvasSaveState);
  const boardTitle = useAppStore((s) => s.canvasBoards.find((b) => b.id === s.canvasBoardId)?.title ?? '自由画布');
  const addCanvasBlock = useAppStore((s) => s.addCanvasBlock);
  const removeCanvasBlock = useAppStore((s) => s.removeCanvasBlock);
  const updateCanvasLayouts = useAppStore((s) => s.updateCanvasLayouts);
  const refreshCanvasKlines = useAppStore((s) => s.refreshCanvasKlines);
  const setCopilotOpen = useAppStore((s) => s.setCopilotOpen);
  const setCopilotNotice = useAppStore((s) => s.setCopilotNotice);

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<CanvasBlock | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(canvasRef);

  // RGL 布局（i=blockId；minW/minH 按 §七 网格参数）
  const rglLayout: Layout = useMemo(
    () =>
      canvasBlocks.map((b) => ({
        i: b.blockId,
        x: b.layout.x,
        y: b.layout.y,
        w: b.layout.w,
        h: b.layout.h,
        minW: CANVAS_GRID.minW,
        minH: CANVAS_GRID.minH,
      })),
    [canvasBlocks],
  );

  // onLayoutChange → 与现态 diff 后回写（RGL 压缩会调整 y；无变化不写，防回环）
  const handleLayoutChange = (layout: Layout) => {
    const changed = canvasBlocks.some((b) => {
      const item = layout.find((l) => l.i === b.blockId);
      return item && (item.x !== b.layout.x || item.y !== b.layout.y || item.w !== b.layout.w || item.h !== b.layout.h);
    });
    if (!changed) return;
    updateCanvasLayouts(
      layout.map((l) => ({ blockId: l.i, layout: { x: l.x, y: l.y, w: l.w, h: l.h } })),
    );
  };

  // 删除级联检查：被 chart/metric sourceBlockId 引用 → 确认文案提示降级
  const requestRemove = (block: CanvasBlock) => {
    const referenced = canvasBlocks.some(
      (b) =>
        (b.type === 'chart' || b.type === 'metric') &&
        (b.data as { sourceBlockId?: string }).sourceBlockId === block.blockId,
    );
    if (referenced) {
      setPendingRemove(block);
    } else {
      removeCanvasBlock(block.blockId);
    }
  };

  const confirmRemove = () => {
    if (!pendingRemove) return;
    const target = pendingRemove.blockId;
    // 引用方降级：清 sourceBlockId（渲染层自然进入「来源已删除」占位态）
    canvasBlocks
      .filter(
        (b) =>
          (b.type === 'chart' || b.type === 'metric') &&
          (b.data as { sourceBlockId?: string }).sourceBlockId === target,
      )
      .forEach((b) => {
        const d = b.data as { sourceBlockId?: string };
        useAppStore.getState().updateCanvasBlockData(b.blockId, { ...d, sourceBlockId: undefined } as never);
      });
    removeCanvasBlock(target);
    setPendingRemove(null);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const { ok, failed } = await refreshCanvasKlines();
      if (ok.length || failed.length) {
        setCopilotNotice({
          title: '行情刷新完成',
          message: failed.length ? `成功 ${ok.length} 只，失败 ${failed.length} 只（保留旧数据）` : `已刷新 ${ok.length} 只标的`,
          severity: failed.length ? 'warning' : 'info',
        });
      } else {
        setCopilotNotice({ title: '无 K 线区块', message: '画布上暂无已选股票的 K 线区块', severity: 'info' });
      }
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex h-full gap-3">
      {/* 主区：工具条 + 画布（模板面板已移除——添加入口收敛到工具条「+ 添加」下拉与空态模板网格） */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2">
          <h2 className="truncate text-sm font-semibold text-slate-200">{boardTitle}</h2>
          <span className="shrink-0 text-xs text-slate-500">
            {canvasSaveState === 'saving' ? '保存中…' : '已保存'}
          </span>
          {/* 常驻添加入口：任意时刻可手动加模板（下拉选择，不依赖左侧面板开合） */}
          <div className="relative shrink-0">
            <button
              className="flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-blue-500/60 hover:text-blue-300"
              onClick={() => setAddMenuOpen((v) => !v)}
              title="添加区块"
            >
              <Plus className="h-3.5 w-3.5" />
              添加
            </button>
            {addMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setAddMenuOpen(false)} />
                <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded-xl border border-slate-700 bg-slate-900 p-1.5 shadow-xl">
                  {TEMPLATES.map(({ type, label, icon: Icon }) => (
                    <button
                      key={type}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800"
                      onClick={() => {
                        addCanvasBlock(type);
                        setAddMenuOpen(false);
                      }}
                    >
                      <Icon className="h-3.5 w-3.5 text-blue-400" />
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
              onClick={onRefresh}
              disabled={refreshing}
              title="强制刷新画布内全部 K 线行情"
            >
              <RefreshCw className={'h-3.5 w-3.5' + (refreshing ? ' animate-spin' : '')} />
              刷新行情
            </button>
            <button
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs text-white hover:bg-blue-500"
              onClick={() => setCopilotOpen(true)}
            >
              <Bot className="h-3.5 w-3.5" />
              AI 助手
            </button>
          </div>
        </div>

        {/* 画布区 */}
        <div ref={canvasRef} className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800 bg-slate-950/40 p-2">
          {canvasBlocks.length === 0 ? (
            /* 空画布引导（spec §十）：模板直选 + 对话创建并列，手动/对话双入口对等 */
            <div className="flex h-full min-h-[280px] w-full flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed border-slate-700 text-slate-500">
              <p className="text-sm">您的画布空空如也 —— 选一个模板开始，或让 AI 帮你搭</p>
              <div className="grid grid-cols-4 gap-2">
                {TEMPLATES.map(({ type, label, icon: Icon }) => (
                  <button
                    key={type}
                    className="flex w-24 flex-col items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-3 text-slate-300 hover:border-blue-500/60 hover:bg-slate-800"
                    onClick={() => addCanvasBlock(type)}
                  >
                    <Icon className="h-5 w-5 text-blue-400" />
                    <span className="text-xs">{label}</span>
                  </button>
                ))}
              </div>
              <button
                className="flex items-center gap-2 rounded-lg border border-blue-500/40 px-4 py-2 text-sm text-blue-300 hover:bg-blue-500/10"
                onClick={() => setCopilotOpen(true)}
              >
                <Bot className="h-4 w-4" />
                或让 AI 帮我搭画布（对话创建）
              </button>
            </div>
          ) : (
            width > 0 && (
              <GridLayout
                layout={rglLayout}
                width={width}
                gridConfig={{ cols: CANVAS_GRID.cols, rowHeight: CANVAS_GRID.rowHeight, margin: [8, 8] }}
                dragConfig={{ enabled: true, handle: '.canvas-drag-handle', cancel: '.no-drag' }}
                resizeConfig={{ enabled: true }}
                onLayoutChange={handleLayoutChange}
              >
                {canvasBlocks.map((b) => (
                  <div key={b.blockId} className="h-full">
                    <CanvasBlockFrame block={b} onRemove={() => requestRemove(b)}>
                      <CanvasBlockContent block={b} />
                    </CanvasBlockFrame>
                  </div>
                ))}
              </GridLayout>
            )
          )}
        </div>
      </div>

      {/* 删除级联确认 */}
      <ConfirmModal
        open={pendingRemove !== null}
        title="删除区块"
        message={`区块 ${pendingRemove?.blockId ?? ''} 正在被其他区块引用，删除后引用方将进入「来源已删除」占位态。确认删除？`}
        confirmLabel="删除"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
