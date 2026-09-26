/**
 * @file CanvasBoardList.tsx
 * @description AI 选股台 · 画布列表 Tab：多画布管理（新建 / 切换 / 重命名 / 删除）。
 *              列表态为轻量元数据（canvasBoards），区块数组按需随切换加载，不常驻内存；
 *              删除为软删除且删光后自动重建默认画布（永远有画布可画）。
 * @layer View
 * @storage_impact 不直接读写 IndexedDB；全部经 store canvasSlice（listBoards/createBoard/…）落库。
 * @author 开发团队
 */

import { useEffect, useState } from 'react';
import { LayoutGrid, Pencil, Plus, Trash2, Check, X } from 'lucide-react';
import { useAppStore } from '../../store';
import { showToast } from '../../utils/toast';
import type { CanvasBoardMeta } from '../../types/domain';
import ConfirmModal from '../../components/ui/ConfirmModal';
import EmptyState from '../../components/ui/EmptyState';

/** 更新时间短格式（YYYY-MM-DD HH:mm） */
function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * AI 选股台 · 画布列表 Tab 面板。
 *
 * @param {{ onOpenBoard: () => void }} props - onOpenBoard：打开（切换）画布后切到「画布」Tab
 * @returns {JSX.Element} 画布列表视图
 */
export default function CanvasBoardList({ onOpenBoard }: { onOpenBoard: () => void }) {
  const boards = useAppStore((s) => s.canvasBoards);
  const currentId = useAppStore((s) => s.canvasBoardId);
  const loadCanvasBoards = useAppStore((s) => s.loadCanvasBoards);
  const switchCanvasBoard = useAppStore((s) => s.switchCanvasBoard);
  const createCanvasBoard = useAppStore((s) => s.createCanvasBoard);
  const renameCanvasBoard = useAppStore((s) => s.renameCanvasBoard);
  const deleteCanvasBoard = useAppStore((s) => s.deleteCanvasBoard);

  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [pendingDelete, setPendingDelete] = useState<CanvasBoardMeta | null>(null);

  // 进 Tab 即刷新列表（其他 Tab 的编辑可能改过标题/时间）
  useEffect(() => {
    void loadCanvasBoards();
  }, [loadCanvasBoards]);

  const toast = (msg: string) => showToast(msg);

  const handleCreate = async () => {
    setBusy(true);
    try {
      await createCanvasBoard(`画布 ${boards.length + 1}`);
      onOpenBoard();
      toast('✅ 已新建画布');
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (board: CanvasBoardMeta) => {
    setBusy(true);
    try {
      await switchCanvasBoard(board.id);
      onOpenBoard();
    } finally {
      setBusy(false);
    }
  };

  const startRename = (board: CanvasBoardMeta) => {
    setRenamingId(board.id);
    setDraftTitle(board.title);
  };

  const submitRename = async (boardId: string) => {
    const title = draftTitle.trim();
    setRenamingId(null);
    if (!title) return;
    await renameCanvasBoard(boardId, title);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    setBusy(true);
    try {
      await deleteCanvasBoard(target.id);
      toast(`🗑️ 已删除画布「${target.title}」`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">共 {boards.length} 块画布</span>
        <button
          className="ml-auto flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
          onClick={() => void handleCreate()}
          disabled={busy}
        >
          <Plus className="h-3.5 w-3.5" />
          新建画布
        </button>
      </div>

      {boards.length === 0 ? (
        <EmptyState icon={LayoutGrid} title="暂无画布" />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((b) => {
            const active = b.id === currentId;
            return (
              <div
                key={b.id}
                className={`rounded-xl border p-3 transition-colors ${
                  active ? 'border-blue-500/60 bg-blue-600/10' : 'border-slate-800 bg-slate-900/60'
                }`}
              >
                {renamingId === b.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitRename(b.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-blue-500 focus:outline-none"
                      autoFocus
                      aria-label="画布名称"
                    />
                    <button
                      className="rounded-lg p-1 text-emerald-400 hover:bg-slate-800"
                      onClick={() => void submitRename(b.id)}
                      title="保存"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="rounded-lg p-1 text-slate-500 hover:bg-slate-800"
                      onClick={() => setRenamingId(null)}
                      title="取消"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <LayoutGrid className={`h-4 w-4 shrink-0 ${active ? 'text-blue-400' : 'text-slate-500'}`} />
                    <button
                      className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-slate-200 hover:text-blue-300"
                      onClick={() => void handleOpen(b)}
                      title="打开画布"
                    >
                      {b.title}
                    </button>
                    {active && (
                      <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-bold text-blue-300">
                        当前
                      </span>
                    )}
                  </div>
                )}

                <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
                  <span>{b.blockCount} 个区块</span>
                  <span className="text-slate-700">|</span>
                  <span className="truncate">{formatUpdatedAt(b.updatedAt)}</span>
                </div>

                <div className="mt-2 flex items-center gap-1 border-t border-slate-800 pt-2">
                  <button
                    className="flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-xs text-blue-400 hover:bg-slate-800 disabled:opacity-50"
                    onClick={() => void handleOpen(b)}
                    disabled={busy || active}
                  >
                    {active ? '已打开' : '打开'}
                  </button>
                  <button
                    className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                    onClick={() => startRename(b)}
                    title="重命名"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-800 hover:text-red-400"
                    onClick={() => setPendingDelete(b)}
                    title="删除画布"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 删除确认（软删除，删当前画布则自动切到列表首块） */}
      <ConfirmModal
        open={pendingDelete !== null}
        title="删除画布"
        message={`确认删除画布「${pendingDelete?.title ?? ''}」？其 ${pendingDelete?.blockCount ?? 0} 个区块将一并移除（软删除）。`}
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
