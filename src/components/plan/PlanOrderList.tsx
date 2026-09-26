/**
 * @file PlanOrderList.tsx
 * @description 计划单列表容器（首页 / 短线交易 / 中长期交易 / AI 选股台共用）：
 *              统一「批量行情订阅 + 底仓匹配 + 短线项目池 + PlanOrderCard 网格 + 空态」四件套，
 *              此前四处各写一遍（行情订阅与项目池派生口径易漂移）。
 *              行情可由调用方注入（页面已订阅时复用以避免重复轮询），缺省内部自订阅。
 * @layer UI
 * @storage_impact 不直接读写 IndexedDB；执行/取消经调用方回调（通常接 usePlanExecutor）。
 * @author 开发团队
 */

import { useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import { useAppStore } from '../../store';
import { useLiveQuotes } from '../../hooks/useLiveQuotes';
import { useStreamResults } from '../../hooks/useStreamResults';
import { toShortTrialProject } from '../../utils/shortTermTrial';
import type { PlannedOrder } from '../../store/types';
import type { StockQuoteSummary } from '../../types/stock';
import PlanOrderCard from './PlanOrderCard';
import EmptyState from '../ui/EmptyState';

export interface PlanOrderListProps {
  /** 计划单（调用方已按语境过滤，如短线页只传 short-term） */
  orders: PlannedOrder[];
  /** 网格列数：1 = 单列（首页信息流）；2 = 响应式双列（默认） */
  columns?: 1 | 2;
  /** 最多渲染条数；缺省全部 */
  max?: number;
  /** 行情注入：页面已订阅行情时传入，避免重复轮询 */
  quotes?: Record<string, StockQuoteSummary | null>;
  onEdit?: (order: PlannedOrder) => void;
  onExecute?: (order: PlannedOrder, actualPrice: number, actualAmount: number, note: string) => void;
  onCancel?: (id: string) => void;
  onNavigate?: (order: PlannedOrder) => void;
  /** 空态文案（缺省「暂无计划单」） */
  emptyTitle?: string;
  emptyDescription?: string;
  /** 空态容器变体（缺省 card；交易页沿用虚线卡片为 dashed） */
  emptyVariant?: 'card' | 'dashed' | 'panel';
}

/**
 * 计划单列表容器组件。
 *
 * @description 卡片渲染与数据装配收敛于此；执行/取消等写操作仍由调用方注入回调
 *              （各页执行语义差异由 usePlanExecutor 的选项吸收，本组件不持有写逻辑）。
 * @returns {JSX.Element} 计划单网格 / 空态
 */
export default function PlanOrderList({
  orders,
  columns = 2,
  max,
  quotes: injectedQuotes,
  onEdit,
  onExecute,
  onCancel,
  onNavigate,
  emptyTitle = '暂无计划单',
  emptyDescription,
  emptyVariant = 'card',
}: PlanOrderListProps) {
  const positions = useAppStore((s) => s.positions);
  const feeConfig = useAppStore((s) => s.feeConfig);
  const streamResults = useStreamResults();

  // 【短线/中长期强隔离】短线试算项目池，供短线计划单卡片匹配
  const shortProjects = useMemo(
    () => streamResults.filter((s) => s.status !== 'CLEARED').map(toShortTrialProject),
    [streamResults],
  );

  const codes = useMemo(() => orders.map((p) => p.fullCode), [orders]);
  const { quotes: ownQuotes } = useLiveQuotes(codes);
  const quotes = injectedQuotes ?? ownQuotes;

  const visible = typeof max === 'number' ? orders.slice(0, max) : orders;

  if (visible.length === 0) {
    return <EmptyState icon={ClipboardList} title={emptyTitle} description={emptyDescription} variant={emptyVariant} />;
  }

  return (
    <div className={columns === 1 ? 'space-y-3' : 'grid grid-cols-1 gap-3 sm:grid-cols-2'}>
      {visible.map((p) => (
        <PlanOrderCard
          key={p.id}
          order={p}
          quote={quotes[p.fullCode] ?? null}
          position={positions.find((pos) => pos.fullCode === p.fullCode && !pos.isClosed) ?? null}
          feeConfig={feeConfig}
          shortProjects={shortProjects}
          onEdit={onEdit}
          onExecute={onExecute}
          onCancel={onCancel}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
