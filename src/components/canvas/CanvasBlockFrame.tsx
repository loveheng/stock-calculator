/**
 * @file CanvasBlockFrame.tsx
 * @description 画布区块统一外框：标题栏（标号 + 类型徽标 + 设置/删除按钮，RGL 拖拽手柄）+
 *              内容区（children）+ 底部备注区（折叠态显示条数，展开可编辑/删除）。
 *              拖拽手柄限定标题栏（draggableHandle），内容区滚动不触发拖拽（spec §10.2-2）。
 * @layer UI (Canvas)
 * @storage_impact 备注增删经 store canvasSlice（防抖落库），本组件不直连 db。
 * @author 开发团队
 */

import React, { useState } from 'react';
import { Settings2, Trash2, StickyNote, X, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store';
import type { CanvasBlock } from '../../types/domain';

/** 类型徽标文案 */
const TYPE_LABEL: Record<CanvasBlock['type'], string> = {
  kline: 'K线',
  table: '表格',
  file: '文档',
  chart: '图表',
  metric: '指标',
  image: '图片',
  text: '文本',
  brief: '个股档案',
  widget: '动态面板',
};

interface CanvasBlockFrameProps {
  block: CanvasBlock;
  /** 设置按钮回调（未传则不渲染设置按钮） */
  onSettings?: () => void;
  /** 删除回调（父级负责级联确认） */
  onRemove: () => void;
  children: React.ReactNode;
}

export default function CanvasBlockFrame({ block, onSettings, onRemove, children }: CanvasBlockFrameProps) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const addBlockNote = useAppStore((s) => s.addBlockNote);
  const removeBlockNote = useAppStore((s) => s.removeBlockNote);

  const submitNote = () => {
    const content = noteDraft.trim();
    if (!content) return;
    addBlockNote(block.blockId, content, 'manual');
    setNoteDraft('');
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70 shadow-sm">
      {/* 标题栏 = RGL 拖拽手柄（dragConfig.handle 选择器）；按钮加 .no-drag 防止点按误触拖拽 */}
      <div className="canvas-drag-handle flex shrink-0 cursor-move items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2">
        <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-xs font-semibold text-blue-400">
          {block.blockId}
        </span>
        <span className="text-xs text-slate-500">{TYPE_LABEL[block.type]}</span>
        <div className="ml-auto flex items-center gap-1">
          {onSettings && (
            <button
              className="no-drag tap-target rounded text-slate-500 hover:bg-slate-800 hover:text-slate-300"
              onClick={onSettings}
              title="设置"
            >
              <Settings2 className="h-4 w-4" />
            </button>
          )}
          <button
            className="no-drag tap-target rounded text-slate-500 hover:bg-slate-800 hover:text-red-400"
            onClick={onRemove}
            title="删除区块"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 内容区：滚动不触发拖拽 */}
      <div className="min-h-0 flex-1 overflow-auto p-2">{children}</div>

      {/* 底部备注区（折叠态显示条数） */}
      <div className="shrink-0 border-t border-slate-800 bg-slate-900/80">
        <button
          className="flex w-full items-center gap-1.5 px-3 py-1 text-xs text-slate-500 hover:text-slate-300"
          onClick={() => setNotesOpen((v) => !v)}
        >
          <StickyNote className="h-3 w-3" />
          备注{block.notes.length > 0 && ` (${block.notes.length})`}
        </button>
        {notesOpen && (
          <div className="space-y-1.5 px-3 pb-2">
            {block.notes.map((n) => (
              <div key={n.id} className="flex items-start gap-1.5 rounded bg-slate-800/60 px-2 py-1">
                {n.source === 'ai' && <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />}
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-slate-300">
                  {n.content}
                </span>
                <button
                  className="shrink-0 text-slate-600 hover:text-red-400"
                  onClick={() => removeBlockNote(block.blockId, n.id)}
                  title="删除备注"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <input
                className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-blue-500"
                placeholder="添加备注…"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitNote()}
              />
              <button
                className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
                onClick={submitNote}
              >
                添加
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
