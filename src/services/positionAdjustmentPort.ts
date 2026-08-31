/**
 * @file positionAdjustmentPort.ts
 * @description 做T侧 ↔ 中长线侧的唯一衔接端口（PositionAdjustmentPort）。
 *              实现目标态方案：中间表 positionAdjustments（命令登记簿 + 占用视图 + 物化快照）
 *              + 痕迹层 positionEvents（append-only 事件流）+ 收敛层 longTermRecords（每轮一条最终记录）。
 * @see docs/position-ledger-spec.md §1
 * @layer Service
 * @storage_impact 读写 positionAdjustments / positionEvents / longTermRecords / positionBatches / positions / tRounds
 * @author 开发团队
 */
// ============================================================
// Types
// ============================================================

import { ulid } from 'ulid';
import { db } from '../db/index';
import type {
  PositionAdjustmentEntity,
  PositionEventEntity,
  PositionBatchEntity,
} from '../db/schema';
import { cleanUndefined } from '../db/cleanUndefined';
import type { Position, PositionBatch, RoundTxn, TRoundArchive } from '../store/types';
import { calcTradeFees, matchSecurityKind, roundTo, type FeeConfig } from '../utils/mathUtils';
import { recomputePositionSnapshot } from '../utils/calculator';
import { putTRound } from '../db/index';
/**
 * 命令 id 格式：`${roundId}-${seq}`
 * 幂等去重与回滚定位。
 */
export interface TPositionAdjustmentCommand {
  id: string;
  roundId: string;
  seq: number;
  fullCode: string;
  kind: 'borrow' | 'return-borrow' | 'finalize-sell' | 'merge-buy';
  qty: number;
  /** 参考成交价 */
  price?: number;
  createdAt: number;
}

/** 应用/回滚结果 */
export interface ApplyResult {
  ok: boolean;
  message?: string;
}

/** 回滚选项（v1 仅支持 reject，预留接口扩展） */
export interface RollbackOptions {
  capacityConflict?: 'reject' | 'truncate';
}

/** 聚合快照（物化于中间表，读时 O(1) 直取） */
export interface MaterializedSnapshot {
  fullCode: string;
  currentCost: number;
  currentAmount: number;
  reservedForT: number;
  totalInvested: number;
  realizedPnL: number;
  isClosed: 0 | 1;
  updatedAt: number;
}

/** 底仓读视图 */
export interface BasePositionView {
  currentCost: number;
  currentAmount: number;
  reservedForT: number;
  availableForT: number;
}

/** Round 状态读视图 */
export interface TRoundStatusView {
  open: boolean;
  borrowNet: number;
}

// ============================================================
// Helpers
// ============================================================

function makeId(): string {
  return ulid();
}

function now(): number {
  return Date.now();
}

function toEntityBase(): { createdAt: number; updatedAt: number; isDeleted: number } {
  const t = now();
  return { createdAt: t, updatedAt: t, isDeleted: 0 };
}

// ============================================================
// 1. Pure Function: emitRoundAdjustments
// ============================================================

/**
 * 从做T轮次状态 + 底仓快照 + 费率配置投影出命令序列（纯函数）。
 *
 * 规则：
 * - 倒T（short）：
 *   - 在途：净借出 = max(0, Σ卖出 − Σ买入) → borrow(净借出)
 *   - 结算：已回补 → return-borrow; 未回补 → finalize-sell; 超额买入 → merge-buy
 * - 正T（long）：
 *   - 结算时净买入 → merge-buy(净买入量, price=买入均价)
 *
 * @param roundId 轮次 id（用于生成命令 id）
 * @param mode 做T方向
 * @param transactions 轮次成交明细
 * @param settle 是否结算归档
 * @returns 命令序列
 */
export function emitRoundAdjustments(
  roundId: string,
  mode: 'long' | 'short',
  transactions: RoundTxn[],
  settle: boolean = false,
): TPositionAdjustmentCommand[] {
  const commands: TPositionAdjustmentCommand[] = [];
  const t = now();

  if (mode === 'short') {
    const totalSell = transactions
      .filter((tx) => tx.direction === 'sell')
      .reduce((s, tx) => s + tx.amount, 0);
    const totalBuy = transactions
      .filter((tx) => tx.direction === 'buy')
      .reduce((s, tx) => s + tx.amount, 0);
    const netBorrow = Math.max(0, totalSell - totalBuy);

    if (settle) {
      const buyBack = Math.min(totalBuy, totalSell);
      const unmatched = netBorrow;
      const sellEntries = transactions.filter((tx) => tx.direction === 'sell');
      const buyEntries = transactions.filter((tx) => tx.direction === 'buy');
      const avgSellPrice = sellEntries.length > 0
        ? sellEntries.reduce((s, tx) => s + tx.price * tx.amount, 0) / sellEntries.reduce((s, tx) => s + tx.amount, 0)
        : 0;
      const avgBuyPrice = buyEntries.length > 0
        ? buyEntries.reduce((s, tx) => s + tx.price * tx.amount, 0) / buyEntries.reduce((s, tx) => s + tx.amount, 0)
        : 0;

      if (buyBack > 0) {
        commands.push({
          id: `${roundId}-${commands.length}`,
          roundId,
          seq: commands.length,
          fullCode: transactions[0]?.fullCode ?? '',
          kind: 'return-borrow',
          qty: buyBack,
          price: avgBuyPrice,
          createdAt: t,
        });
      }
      if (unmatched > 0) {
        commands.push({
          id: `${roundId}-${commands.length}`,
          roundId,
          seq: commands.length,
          fullCode: transactions[0]?.fullCode ?? '',
          kind: 'finalize-sell',
          qty: unmatched,
          price: avgSellPrice,
          createdAt: t,
        });
      }
      const excessBuy = Math.max(0, totalBuy - totalSell);
      if (excessBuy > 0) {
        commands.push({
          id: `${roundId}-${commands.length}`,
          roundId,
          seq: commands.length,
          fullCode: transactions[0]?.fullCode ?? '',
          kind: 'merge-buy',
          qty: excessBuy,
          price: avgBuyPrice,
          createdAt: t,
        });
      }
    } else if (netBorrow > 0) {
      commands.push({
        id: `${roundId}-${commands.length}`,
        roundId,
        seq: commands.length,
        fullCode: transactions[0]?.fullCode ?? '',
        kind: 'borrow',
        qty: netBorrow,
        createdAt: t,
      });
    }
  } else {
    // 正T（long）
    const totalBuy = transactions
      .filter((tx) => tx.direction === 'buy')
      .reduce((s, tx) => s + tx.amount, 0);
    const totalSell = transactions
      .filter((tx) => tx.direction === 'sell')
      .reduce((s, tx) => s + tx.amount, 0);
    const netBuy = Math.max(0, totalBuy - totalSell);

    if (settle && netBuy > 0) {
      const buyEntries = transactions.filter((tx) => tx.direction === 'buy');
      const avgBuyPrice = buyEntries.length > 0
        ? buyEntries.reduce((s, tx) => s + tx.price * tx.amount, 0) / buyEntries.reduce((s, tx) => s + tx.amount, 0)
        : 0;
      commands.push({
        id: `${roundId}-${commands.length}`,
        roundId,
        seq: commands.length,
        fullCode: transactions[0]?.fullCode ?? '',
        kind: 'merge-buy',
        qty: netBuy,
        price: avgBuyPrice,
        createdAt: t,
      });
    }
  }

  return commands;
}
// ============================================================
// 2. DB Functions: applyRoundAdjustments
// ============================================================

/**
 * 应用一组命令到 DB（同一事务；幂等：仅应用尚未应用的 id）。
 */
export async function applyRoundAdjustments(
  cmds: TPositionAdjustmentCommand[],
  round: TRoundArchive,
  stockName: string,
  feeConfig: FeeConfig,
): Promise<ApplyResult> {
  if (cmds.length === 0) return { ok: true };

  const fullCode = round.fullCode;
  const securityKind = matchSecurityKind('', fullCode.replace(/^sh|sz|bj/, ''));

  await db.transaction(
    'rw',
    [db.positions, db.positionBatches, db.tRounds, db.tTransactions,
    db.longTermRecords, db.positionAdjustments, db.positionEvents] as const,
    async () => {
      let pos = await db.positions
        .where('[isClosed+isDeleted]').equals([0, 0])
        .and((p) => p.fullCode === fullCode)
        .first();
      const entityBase = { ...toEntityBase(), createdAt: pos?.createdAt ?? now() };

      const existingIds = new Set(
        (await db.positionAdjustments
          .where({ roundId: round.id })
          .filter((a) => (a.isDeleted ?? 0) === 0)
          .toArray())
          .map((a) => a.id),
      );

      const newCmds = cmds.filter((c) => !existingIds.has(c.id));
      const adjustments: PositionAdjustmentEntity[] = [];
      const events: PositionEventEntity[] = [];

      let posEntity = pos
        ? { ...pos }
        : { id: makeId(), fullCode, currentCost: 0, currentAmount: 0,
            isClosed: 0 as 0 | 1, totalInvested: 0, realizedPnL: 0, ...entityBase };

      let reservedForT = 0, totalBorrow = 0, buyBack = 0;
      let netSellQty = 0, netBuyQty = 0, totalFee = 0;
      const profit = round.netProfit ?? 0;

      for (const cmd of newCmds) {
        const adj: PositionAdjustmentEntity = {
          id: cmd.id, roundId: cmd.roundId, seq: cmd.seq, kind: cmd.kind,
          fullCode: cmd.fullCode, qty: cmd.qty, price: cmd.price,
          batchId: undefined, status: 'in-flight', appliedAt: cmd.createdAt,
          ...toEntityBase(),
        };
        adjustments.push(adj);
        let batchId: string | undefined;

        switch (cmd.kind) {
          case 'borrow':
            reservedForT += cmd.qty; totalBorrow += cmd.qty;
            // 在途借出只更新 reservedForT 占用，不追加中间事件
            break;

          case 'return-borrow':
            reservedForT = Math.max(0, reservedForT - cmd.qty); buyBack += cmd.qty;
            // 在途归还只更新 reservedForT 占用，不追加中间事件
            break;

          case 'finalize-sell': {
            const sellFee = calcTradeFees(
              cmd.price ?? posEntity.currentCost, cmd.qty, 'sell', feeConfig, securityKind).total;
            const curAmt = posEntity.currentAmount;
            const curInv = posEntity.totalInvested;
            const costPerShare = curAmt > 0 ? curInv / curAmt : 0;
            const costBasisOfSold = costPerShare * cmd.qty;
            const netProceeds = (cmd.price ?? 0) * cmd.qty - sellFee;
            const realizedPnL = netProceeds - costBasisOfSold;

            const batchEntity: PositionBatchEntity = {
              id: makeId(), positionId: posEntity.id,
              type: 'reduce', price: cmd.price ?? 0, amount: -cmd.qty,
              fee: sellFee, costAfter: costPerShare,
              amountAfter: Math.max(0, curAmt - cmd.qty),
              timestamp: cmd.createdAt,
              note: `做T归档卖出${cmd.qty}股（${round.roundCode}）`,
              sourceRoundId: round.id, ...toEntityBase(),
            };
            await db.positionBatches.put(cleanUndefined(batchEntity));
            batchId = batchEntity.id;
            adj.batchId = batchId;
            adj.status = 'settled';

            posEntity.currentAmount = Math.max(0, curAmt - cmd.qty);
            posEntity.currentCost = posEntity.currentAmount > 0
              ? (curInv - costBasisOfSold) / posEntity.currentAmount : 0;
            posEntity.totalInvested = Math.max(0, curInv - costBasisOfSold);
            posEntity.realizedPnL = (posEntity.realizedPnL ?? 0) + realizedPnL;
            if (posEntity.currentAmount <= 0) posEntity.isClosed = 1;
            netSellQty += cmd.qty; totalFee += sellFee;

            events.push({ id: makeId(), fullCode: cmd.fullCode, roundId: round.id,
              eventType: 'finalize-sell', qty: cmd.qty, price: cmd.price,
              fee: sellFee, batchId, timestamp: cmd.createdAt, ...toEntityBase() });
            break;
          }

          case 'merge-buy': {
            const buyFee = calcTradeFees(
              cmd.price ?? posEntity.currentCost, cmd.qty, 'buy', feeConfig, securityKind).total;
            const curAmt = posEntity.currentAmount;
            const curInv = posEntity.totalInvested;
            const addInvested = (cmd.price ?? 0) * cmd.qty + buyFee;
            const newAmount = curAmt + cmd.qty;
            const newCost = newAmount > 0 ? (curInv + addInvested) / newAmount : 0;

            const batchEntity: PositionBatchEntity = {
              id: makeId(), positionId: posEntity.id,
              type: 'add', price: cmd.price ?? 0, amount: cmd.qty,
              fee: buyFee, costAfter: newCost, amountAfter: newAmount,
              timestamp: cmd.createdAt,
              note: `做T归档买入${cmd.qty}股（${round.roundCode}）`,
              sourceRoundId: round.id, ...toEntityBase(),
            };
            await db.positionBatches.put(cleanUndefined(batchEntity));
            batchId = batchEntity.id;
            adj.batchId = batchId;
            adj.status = 'settled';

            posEntity.currentAmount = newAmount;
            posEntity.currentCost = newCost;
            posEntity.totalInvested = curInv + addInvested;
            posEntity.isClosed = 0;
            netBuyQty += cmd.qty; totalFee += buyFee;

            events.push({ id: makeId(), fullCode: cmd.fullCode, roundId: round.id,
              eventType: 'merge-buy', qty: cmd.qty, price: cmd.price,
              fee: buyFee, batchId, timestamp: cmd.createdAt, ...toEntityBase() });
            break;
          }
        }
      }


      // 写入命令登记簿
      if (adjustments.length > 0) {
        await db.positionAdjustments.bulkPut(adjustments.map((a) => cleanUndefined(a)));
      }

      // 写入事件流
      if (events.length > 0) {
        await db.positionEvents.bulkPut(events.map((e) => cleanUndefined(e)));
      }

      // 同步更新 reservedForT 物化快照
      posEntity.reservedForT = Math.max(0, (posEntity.reservedForT ?? 0) + reservedForT);

      // 写入/更新持仓物化快照
      posEntity.updatedAt = now();
      if (pos) {
        await db.positions.put(posEntity);
      } else {
        posEntity.createdAt = now();
        await db.positions.put(posEntity);
      }

      // 写入最终记录（收敛层）
      const qtyNet = netBuyQty - netSellQty;
      const ltRecord = {
        id: makeId(),
        fullCode,
        stockName,
        type: 't-round' as const,
        price: round.avgPrice ?? 0,
        amount: Math.abs(qtyNet),
        fee: roundTo(totalFee, 2),
        timestamp: now(),
        sourceReportId: round.id,
        qtyNet,
        totalBorrow,
        buyBack,
        profit,
        ...toEntityBase(),
      };
      await db.longTermRecords.put(cleanUndefined(ltRecord) as any);

      // 翻转 Round 状态为 COMPLETED
      const updatedRound: TRoundArchive = {
        ...round,
        status: 'COMPLETED',
        settleType: 'clear',
        closedAt: new Date().toISOString(),
        lastTouched: new Date().toISOString(),
        lastUpdated: Date.now(),
      };
      await putTRound(updatedRound);
    },
  );

  return { ok: true };
}


// ============================================================
// 3. DB Functions: rollbackRound
// ============================================================

/**
 * 撤销一个 round 的全部已应用命令（删除战报 / 回滚已归档流水）。
 *
 * 流程（见 spec §5.1）：
 * ① 从 positionAdjustments 取该 round 全部已应用命令（按 seq 升序）
 * ② 逆序处理每条命令
 * ③ 用剩余批次履历重建权威快照
 * ④ 删除该 round 的最终记录
 * ⑤ 追加 rollback 事件
 * ⑥ 删除 positionAdjustments（roundId）
 * ⑦ 删除 tRounds 中的该 round
 * ⑧ 全部同一事务
 */
export async function rollbackRound(
  roundId: string,
  options?: RollbackOptions,
): Promise<ApplyResult> {
  const capacityConflict = options?.capacityConflict ?? 'reject';

  return db.transaction(
    'rw',
    [db.positions, db.positionBatches, db.tRounds, db.tTransactions,
    db.longTermRecords, db.positionAdjustments, db.positionEvents] as const,
    async () => {
      // ① 取全部已应用命令
      const adjustments = await db.positionAdjustments
        .where({ roundId })
        .filter((a) => (a.isDeleted ?? 0) === 0)
        .sortBy('seq');

      if (adjustments.length === 0) {
        const round = await db.tRounds.get(roundId);
        if (round) {
          await db.tRounds.delete(roundId);
          await db.tTransactions.where({ roundId }).delete();
        }
        return { ok: true } as ApplyResult;
      }

      const fullCode = adjustments[0].fullCode;

      // ② 逆序处理每条命令
      const batchIdsToDelete: string[] = [];
      let reservedForT = 0;
      let netPositionDelta = 0;

      for (const adj of adjustments.reverse()) {
        switch (adj.kind) {
          case 'borrow':
            reservedForT -= adj.qty;
            netPositionDelta += adj.qty;
            break;
          case 'return-borrow':
            reservedForT += adj.qty;
            netPositionDelta -= adj.qty;
            break;
          case 'finalize-sell':
            if (adj.batchId) batchIdsToDelete.push(adj.batchId);
            netPositionDelta += adj.qty;
            break;
          case 'merge-buy':
            if (adj.batchId) batchIdsToDelete.push(adj.batchId);
            netPositionDelta -= adj.qty;
            break;
        }
      }

      // ③ 删除批次 + 重建快照
      let pos = await db.positions
        .where('[isClosed+isDeleted]').equals([0, 0])
        .and((p) => p.fullCode === fullCode)
        .first();

      if (pos) {
        for (const batchId of batchIdsToDelete) {
          await db.positionBatches.delete(batchId);
        }

        const remainingBatches = await db.positionBatches
          .where({ positionId: pos.id })
          .filter((b) => (b.isDeleted ?? 0) === 0)
          .toArray();

        const storeBatches: PositionBatch[] = remainingBatches.map((b) => ({
          id: b.id,
          timestamp: new Date(b.timestamp).toISOString(),
          type: b.type as PositionBatch['type'],
          price: b.price,
          amount: b.amount,
          costAfter: b.costAfter,
          amountAfter: b.amountAfter,
          fee: b.fee,
          note: b.note,
        }));

        const snap = recomputePositionSnapshot(storeBatches);

        // ③a 容量检查 —— 软化处理：冲突时不中断报错，而是返回友好提示
        if (snap.currentAmount < 0 && capacityConflict === 'reject') {
          return { ok: false, message: `回滚失败：做T删除后底仓数量为负（${snap.currentAmount} 股），请先补仓再删除。` } as ApplyResult;
        }

        // ③b 回写物化快照（truncate 模式：截断为 0 并标记已结仓）
        const finalAmount = snap.currentAmount < 0 ? 0 : snap.currentAmount;
        pos.updatedAt = now();
        pos.currentCost = snap.currentCost;
        pos.currentAmount = finalAmount;
        pos.totalInvested = snap.totalInvested;
        pos.realizedPnL = snap.realizedPnL;
        pos.isClosed = finalAmount <= 0 ? 1 : 0;
        // 同步更新 reservedForT 物化快照：回滚后净借出 = 0
        const posReservedForT = Math.max(0, (pos.reservedForT ?? 0) + reservedForT);
        pos.reservedForT = posReservedForT;
        await db.positions.put(pos);
      }

      // ④ 删除该 round 的最终记录
      await db.longTermRecords
        .where({ sourceReportId: roundId })
        .filter((r) => (r.isDeleted ?? 0) === 0)
        .delete();

      // ⑤ 追加 rollback 事件
      const rollbackEvent: PositionEventEntity = {
        id: makeId(),
        fullCode,
        roundId,
        eventType: 'rollback',
        qty: netPositionDelta,
        timestamp: now(),
        note: `删除战报回滚：净还原 ${netPositionDelta} 股`,
        ...toEntityBase(),
      };
      await db.positionEvents.put(cleanUndefined(rollbackEvent));

      // ⑥ 删除 positionAdjustments
      await db.positionAdjustments
        .where({ roundId })
        .filter((a) => (a.isDeleted ?? 0) === 0)
        .delete();

      // ⑦ 删除 tRounds + tTransactions
      await db.tRounds.delete(roundId);
      await db.tTransactions.where({ roundId }).delete();

      return { ok: true } as ApplyResult;
    },
  );
}


// ============================================================
// 4. Read Functions
// ============================================================

/**
 * 读取底仓视图（含 reservedForT 占用）。
 * 做T侧借仓/超卖校验用。
 */
export async function getBasePosition(fullCode: string): Promise<BasePositionView> {
  const pos = await db.positions
    .where('[isClosed+isDeleted]').equals([0, 0])
    .and((p) => p.fullCode === fullCode)
    .first();

  if (!pos) {
    return { currentCost: 0, currentAmount: 0, reservedForT: 0, availableForT: 0 };
  }

  // O(1) 直取 position 物化快照中的 reservedForT，无需扫描 positionAdjustments
  const reservedForT = pos.reservedForT ?? 0;

  return {
    currentCost: pos.currentCost,
    currentAmount: pos.currentAmount,
    reservedForT,
    availableForT: Math.max(0, pos.currentAmount - reservedForT),
  };
}

/**
 * 读取 Round 状态（中长线侧结仓拦截用）。
 */
export async function getTRoundStatus(fullCode: string): Promise<TRoundStatusView> {
  const openRound = await db.tRounds
    .where('[status+isDeleted]').equals(['OPENED', 0])
    .and((r) => r.fullCode === fullCode)
    .first();

  if (!openRound) {
    return { open: false, borrowNet: 0 };
  }

  const adjustments = await db.positionAdjustments
    .where({ roundId: openRound.id })
    .filter((a) => (a.isDeleted ?? 0) === 0 && a.status === 'in-flight')
    .toArray();

  let borrowNet = 0;
  for (const adj of adjustments) {
    if (adj.kind === 'borrow') borrowNet += adj.qty;
    else if (adj.kind === 'return-borrow') borrowNet -= adj.qty;
  }

  return { open: true, borrowNet: Math.max(0, borrowNet) };
}

// ============================================================
// 5. Port Object
// ============================================================

export const positionAdjustmentPort = {
  emitRoundAdjustments,
  applyRoundAdjustments,
  rollbackRound,
  getBasePosition,
  getTRoundStatus,
};
