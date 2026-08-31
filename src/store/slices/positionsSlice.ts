/**
 * @file positionsSlice.ts
 * @description Store 持仓切片：建仓 / 更新 / 结仓 / 批次增删 / 删除持仓。
 *              同标的唯一开启仓位的不变量在 addPosition 中强制（拒绝重复建仓并抛错）。
 *              从 store/index.ts 拆出，index 只负责组装。
 * @layer Store (Slice)
 * @storage_impact 经 safePersist 写 positions / positionBatches 表。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import { normalizeCode, normalizeStockName } from '../../utils/dedup';
import { computePositionLifecycleSummary } from '../../utils/mathUtils';
import { recomputePositionSnapshot } from '../../utils/calculator';
import { RiskController } from '../../risk';
import { recordAudit } from '../../risk/auditLogger';
import {
  putPositionWithBatches,
  putPosition,
  addBatchToPosition,
  deletePositionBatch,
  deletePositionWithBatches,
} from '../../db/index';
import { safePersist } from '../persistence';
import type { AppStore } from '../types';
import type { Position } from '../types';

export type PositionsSlice = Pick<
  AppStore,
  'addPosition' | 'updatePosition' | 'closePosition' | 'addBatch' | 'deletePositionBatch' | 'removePosition'
>;

export const createPositionsSlice: StateCreator<AppStore, [], [], PositionsSlice> = (set, get) => ({

  addPosition: (pos) => {
    // 【不变量】同一标的只能有一个「开启」仓位。若已存在开启仓位，拒绝重复建仓并抛错，
    // 确保调用方（CostAveraging / BatchImport）不会创建同标的多仓位。
    const norm = pos.fullCode ? normalizeCode(pos.fullCode) : '';
    const dup = get().positions.find((p) => {
      if (p.isClosed) return false;
      if (norm && normalizeCode(p.fullCode) === norm) return true;
      if (!norm) return normalizeStockName(p.stockName) === normalizeStockName(pos.stockName);
      return false;
    });
    if (dup) {
      recordAudit('add_position_blocked', 'position', pos.id, 'rejected', {
        reason: '同标的开启仓位已存在',
        tags: {
          fullCode: pos.fullCode,
          existingId: dup.id,
        },
      });
      throw new Error(`标的「${pos.stockName || pos.fullCode}」尚存在开启仓位（${dup.fullCode || dup.stockName}），请直接在原账本上加仓`);
    }
    set(s => ({ positions: [...s.positions, pos] }));
    safePersist(() => putPositionWithBatches(pos, pos.batches));
    // 【风控审计】记录建仓
    recordAudit('add_position', 'position', pos.id, 'success', {
      tags: { fullCode: pos.fullCode },
      after: { currentCost: pos.currentCost, currentAmount: pos.currentAmount, batchCount: pos.batches.length },
    });
  },
  updatePosition: (id, updates) => { set(s => ({ positions: s.positions.map(p => p.id === id ? { ...p, ...updates } : p) })); const u = get().positions.find(p => p.id === id); if (u) safePersist(() => putPosition(u)); },
  closePosition: (id) => {
    set(s => ({ positions: s.positions.map(p => p.id === id ? { ...p, isClosed: true, closedAt: new Date().toISOString() } : p) }));
    const u = get().positions.find(p => p.id === id);
    if (u) safePersist(() => putPosition(u));
    // 【结仓生命周期履历】审计留痕：历次加仓轮数 / 最终加仓健康分 / 膨胀倍数
    const lifecycle = u ? computePositionLifecycleSummary(u.batches) : undefined;
    recordAudit('close_position', 'position', id, 'success', {
      after: lifecycle ? { lifecycleSummary: lifecycle } : undefined,
      tags: lifecycle
        ? {
            totalAddRounds: String(lifecycle.totalAddRounds),
            finalPyramidScore: String(lifecycle.finalPyramidScore),
            finalPyramidLevel: lifecycle.finalPyramidLevel,
            strategyType: lifecycle.strategyType,
            expansionRatio: String(lifecycle.expansionRatio),
          }
        : undefined,
    });
  },
  addBatch: (pid, batch, updates) => {
    const base = get().positions.find(p => p.id === pid);
    if (!base) return;
    // 一次性合并「追加批次 + 快照更新」，只做一次 set 与一次 safePersist 写库。
    // 旧写法（先 addBatch 写旧快照，再 updatePosition 写新快照）会产生两次异步写，
    // 而 Dexie 在同一 tick 内总是先执行隐式单表 put、后执行显式 db.transaction：
    // updatePosition 的新值先落库，随后 addBatchToPosition 的旧快照显式事务必然覆盖新值 → 总是旧值。
    // 合并为单次写库后不存在该问题。
    const updated: Position = { ...base, ...updates, batches: [...base.batches, batch] };
    // 【风控】批次操作评估（含数量合理性 + 防负持仓 + 加仓健康度）
    const { report } = RiskController.evaluateBatch({
      amount: batch.amount,
      type: batch.type,
      currentAmount: base.currentAmount,
      price: batch.type === 'add' ? batch.price : undefined,
      existingBatches: batch.type === 'add' ? base.batches : undefined,
      batchId: batch.id,
    });
    if (report.blocked) return;
    set(s => ({ positions: s.positions.map(p => (p.id === pid ? updated : p)) }));
    safePersist(() => addBatchToPosition(updated, batch));
    // 【风控审计】记录批次追加
    recordAudit('add_batch', 'batch', batch.id, 'success', {
      tags: { positionId: pid, fullCode: base.fullCode, type: batch.type },
      before: { currentAmount: base.currentAmount, currentCost: base.currentCost },
      after: { currentAmount: updated.currentAmount, currentCost: updated.currentCost },
    });
  },
  deletePositionBatch: (pid, bid) => {
    const base = get().positions.find((p) => p.id === pid);
    if (!base) return;
    // 删除批次后按剩余履历重建权威快照（成本/数量/已实现盈亏/累计投入）。
    // 口径与建仓/加减仓一致（总资金抽回法，见 recomputePositionSnapshot），
    // 一次 set + 单次持久化，避免「批次已删但快照仍是旧值」的脏数据。
    const nextBatches = base.batches.filter((b) => b.id !== bid);
    const snapshot = recomputePositionSnapshot(nextBatches);
    const updated: Position = { ...base, batches: nextBatches, ...snapshot };
    set((s) => ({ positions: s.positions.map((p) => (p.id === pid ? updated : p)) }));
    safePersist(async () => {
      await deletePositionBatch(bid);
      await putPosition(updated);
    });
    // 【风控审计】记录批次删除
    recordAudit('delete_batch', 'batch', bid, 'success', {
      tags: { positionId: pid }
    });
  },
  removePosition: (id) => { set(s => ({ positions: s.positions.filter(p => p.id !== id) })); safePersist(() => deletePositionWithBatches(id)); recordAudit('remove_position', 'position', id, 'success'); },
});
