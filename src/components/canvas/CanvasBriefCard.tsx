/**
 * @file CanvasBriefCard.tsx
 * @description 个股档案块内容（docs/guide-spec.md v1.1 G2）：近窗口电报提及/题材归属/公告蒸馏
 *              三段 + days 切换器。取数经模板 fetchData（挂载/stockId/days 变更/手动刷新触发），
 *              结果合并回块 data 持久化；count=0 与空数组是「近窗口无数据」业务态非错误
 *              （后端仓 docs/guide/api.md §2.3）。
 * @layer UI (Canvas)
 * @storage_impact 经 canvasSlice.updateCanvasBlockData 落 canvasBoards 表（防抖持久化）。
 * @author 开发团队
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store';
import { getCanvasTemplate } from '../../utils/canvasTemplates';
import type { CanvasBlock, CanvasBlockData } from '../../types/domain';

const DAY_PRESETS = [7, 14, 30] as const;

/** epoch 秒 → 本地日期（types/domain GuideArticleBrief 防腐注释同源：×1000 转毫秒） */
function formatCtime(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString('zh-CN');
}

function Section({ title, empty, children }: { title: string; empty?: string; children: ReactNode }) {
  return (
    <div className="min-h-0">
      <p className="mb-1 text-[11px] text-slate-500">{title}</p>
      {empty ? <p className="text-slate-600">{empty}</p> : <ul className="space-y-0.5">{children}</ul>}
    </div>
  );
}

export default function CanvasBriefCard({ block }: { block: CanvasBlock }) {
  const d = block.data as CanvasBlockData['brief'];
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // 依赖收缩为原语（blockId/stockId/days/tick）：fetch 结果写回 store 会使 block 对象换引用，
  // 若以 block 对象为依赖将「取数→写库→对象换引用→再取数」死循环；blockRef 供 effect 内读最新 data
  const blockRef = useRef(block);
  blockRef.current = block;

  useEffect(() => {
    const current = blockRef.current;
    const data = current.data as CanvasBlockData['brief'];
    if (!data.stockId) return;
    const pending = getCanvasTemplate('brief')?.fetchData?.(current, {});
    if (!pending) return;
    setLoading(true);
    setError(null);
    pending
      .then((r) => {
        // updateCanvasBlockData 是整体替换非合并——以写回时刻的最新 data 展开增量
        if (r?.data) {
          updateCanvasBlockData(
            current.blockId,
            { ...(blockRef.current.data as CanvasBlockData['brief']), ...r.data } as CanvasBlockData['brief'],
          );
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : '取数失败'))
      .finally(() => setLoading(false));
  }, [block.blockId, d.stockId, d.days, refreshTick, updateCanvasBlockData]);

  const name = d.stockName || d.stockId;

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-2 text-xs text-slate-300">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-medium text-slate-200" title={name + '（' + d.stockId + '）'}>
          {name}
          <span className="ml-1 text-slate-500">{d.stockId}</span>
        </span>
        <span className="flex flex-shrink-0 items-center gap-1">
          {DAY_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => updateCanvasBlockData(block.blockId, { ...d, days: p } as CanvasBlockData['brief'])}
              className={
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors ' +
                (d.days === p
                  ? 'border-blue-500/70 bg-blue-900/30 text-blue-300'
                  : 'border-slate-600/70 bg-slate-800/60 text-slate-400 hover:text-slate-200')
              }
            >
              {p}天
            </button>
          ))}
          <button
            type="button"
            title="刷新"
            disabled={loading || !d.stockId}
            onClick={() => setRefreshTick((t) => t + 1)}
            className="text-slate-500 hover:text-blue-400 disabled:opacity-50"
          >
            <RefreshCw className={'h-3.5 w-3.5' + (loading ? ' animate-spin' : '')} />
          </button>
        </span>
      </div>

      {!d.stockId ? (
        <div className="flex flex-1 items-center justify-center px-2 text-center text-slate-500">
          空档案：对话下发 canvas_add_block（type=brief + stockCode）建档
        </div>
      ) : (
        <>
          {error && <div className="rounded border border-red-800/60 bg-red-900/20 px-2 py-1 text-red-300">{error}</div>}
          <Section title={'电报提及 · ' + d.mention.count} empty={d.mention.articles.length === 0 ? '近窗口无数据' : undefined}>
            {d.mention.articles.map((a) => (
              <li key={a.articleId} className="truncate" title={a.title}>
                <span className="text-slate-500">{formatCtime(a.ctime)}</span> {a.title}
              </li>
            ))}
          </Section>
          <Section title={'题材归属 · ' + d.subjects.length} empty={d.subjects.length === 0 ? '近窗口无数据' : undefined}>
            {d.subjects.map((s) => (
              <li key={s.subjectId} className="truncate">
                {s.subjectName}（{s.articleCount}）
              </li>
            ))}
          </Section>
          <Section title={'公告 · ' + d.announcements.length} empty={d.announcements.length === 0 ? '近窗口无公告' : undefined}>
            {d.announcements.map((a) => (
              <li key={a.annDate + a.title} className="truncate" title={a.summary}>
                {a.annDate} {a.title}
              </li>
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
