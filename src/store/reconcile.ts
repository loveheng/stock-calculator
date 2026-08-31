/**
 * @file reconcile.ts
 * @description Store action 共享内核：全量对账引擎（reconcilePositionsWithStreams）与
 *              跨切片共享辅助（增量落库 diff、风控校验包装）。
 *              从 store/index.ts 拆出 —— streams / rounds / io 三个切片共用，
 *              本模块不依赖 store/index（不引用 useAppStore），仅操作入参状态，
 *              因此切片与 index 都可安全依赖它而不产生循环。
 * @layer Store (Shared Kernel)
 * @storage_impact persistPositionDiffs 经 safePersist 增量写 positions / positionBatches 表。
 * @author 开发团队
 */

import { processAllStreams, type TStreamRecord, type StockStreamResult } from '../utils/tStreamEngine';
import type { Position, PositionBatch, TRoundArchive } from './types';
import type { FeeConfig } from '../utils/mathUtils';
import { generateId, formatTradeNo, buildBasePositionCosts } from './utils';
import { recomputePositionSnapshot } from '../utils/calculator';
import { positionAdjustmentPort } from '../services/positionAdjustmentPort';
import { replacePositionSnapshotWithBatches } from '../db/index';
import { safePersist } from './persistence';
import { validate, type RiskRule } from '../risk/validator';
import { getMarketPrice } from '../risk/priceCache';
import type { RiskValidationContext, RiskValidationReport } from '../risk/types';

/**
 * 使用 emitRoundAdjustments 投影倒T出借（borrow）命令，在内存中创建出借批次。
 * 取代旧的 normalizeShortTDeductions 和 applyShortExcessMerge（超额买回归并现由端口在结算时处理）。
 */
function normalizeShortTDeductionsViaPort(
  streams: TStreamRecord[],
  positions: Position[],
  rounds: TRoundArchive[],
): { streams: TStreamRecord[]; positions: Position[] } {
  let updatedPositions = [...positions];
  for (const round of rounds) {
    if ((round.status ?? 'OPENED') === 'COMPLETED') continue;
    if (round.mode !== 'short') continue;
    const txns = round.transactions ?? [];
    if (txns.length === 0) continue;
    // ① 用 settle=false 投影出借（borrow）命令（在途净借出）
    const cmds = positionAdjustmentPort.emitRoundAdjustments(round.id, round.mode, txns, false);
    const borrowCmds = cmds.filter(c => c.kind === 'borrow');
    const sellTxns = txns.filter(t => t.direction === 'sell');
    const buyTxns = txns.filter(t => t.direction === 'buy');
    const totalSell = sellTxns.reduce((s, t) => s + t.amount, 0);
    const totalSellValue = sellTxns.reduce((s, t) => s + t.price * t.amount, 0);
    const avgSellPrice = totalSell > 0 ? totalSellValue / totalSell : 0;
    const totalBuy = buyTxns.reduce((s, t) => s + t.amount, 0);
    const totalBuyValue = buyTxns.reduce((s, t) => s + t.price * t.amount, 0);
    const avgBuyPrice = totalBuy > 0 ? totalBuyValue / totalBuy : 0;
    // ② 超额买回归并（excessBuy = max(0, totalBuy - totalSell)）
    const excessBuy = Math.max(0, totalBuy - totalSell);

    // 批量处理 borrow 命令
    for (const cmd of borrowCmds) {
      if (cmd.qty <= 0) continue;
      const pos = updatedPositions.find((p) => p.fullCode === cmd.fullCode && !p.isClosed);
      if (!pos) continue;
      const borrowBatch: PositionBatch = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: 'reduce',
        price: avgSellPrice,
        amount: -cmd.qty,
        kind: 'borrow',
        costPrice: pos.currentCost,
        costAfter: pos.currentCost,
        amountAfter: Math.max(0, pos.currentAmount - cmd.qty),
        note: `倒T出借（${formatTradeNo(new Date().toISOString())}）`,
        sourceRoundId: round.id,
      };
      const newBatches = [...pos.batches, borrowBatch];
      const snap = recomputePositionSnapshot(newBatches);
      updatedPositions = updatedPositions.map((p) =>
        p.id === pos.id
          ? { ...p, batches: newBatches, currentAmount: snap.currentAmount, currentCost: snap.currentCost, totalInvested: snap.totalInvested, realizedPnL: snap.realizedPnL, isClosed: snap.currentAmount <= 0 }
          : p,
      );
    }

    // ③ 批量处理超额买回归并（excessBuy > 0 时创建 merge 批次）
    if (excessBuy > 0) {
      for (const pos of updatedPositions) {
        if (pos.fullCode !== round.fullCode || pos.isClosed) continue;
        const mergeBatch: PositionBatch = {
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: 'add',
          price: avgBuyPrice,
          amount: excessBuy,
          kind: 'merge',
          costAfter: 0,
          amountAfter: 0,
          note: `倒T超额归并（${formatTradeNo(new Date().toISOString())}）`,
          sourceRoundId: round.id,
        };
        const newBatches = [...pos.batches, mergeBatch];
        const snap = recomputePositionSnapshot(newBatches);
        updatedPositions = updatedPositions.map((p) =>
          p.id === pos.id
            ? { ...p, batches: newBatches, currentAmount: snap.currentAmount, currentCost: snap.currentCost, totalInvested: snap.totalInvested, realizedPnL: snap.realizedPnL, isClosed: snap.currentAmount <= 0 }
            : p,
        );
        break; // 只处理一次
      }
    }
  }
  return { streams, positions: updatedPositions };
}

/** 比较持仓是否需要落库（diff 检测） */
export function positionChanged(a: Position, b: Position): boolean {
  return a.currentAmount !== b.currentAmount
    || a.currentCost !== b.currentCost
    || a.isClosed !== b.isClosed
    || a.batches.length !== b.batches.length
    || JSON.stringify(a.batches) !== JSON.stringify(b.batches);
}

/** 只持久化被修改的持仓（增量写库） */
export async function persistPositionDiffs(positions: Position[], finalPositions: Position[]): Promise<void> {
  for (const np of finalPositions) {
    const old = positions.find((p) => p.id === np.id);
    if (old && positionChanged(old, np)) {
      await replacePositionSnapshotWithBatches(np, np.batches);
    }
  }
}

/**
 * 风控校验辅助：执行规则集合并返回报告。无市价时跳过价格相关规则（getMarketPrice 返回 undefined）。
 * 校验仅使用纯函数，不产生副作用。
 */
export function runRiskValidation<T>(
  rules: RiskRule<T>[],
  data: T,
  marketPriceFn?: (fullCode: string) => number | undefined,
): RiskValidationReport {
  const ctx: RiskValidationContext = { now: new Date().toISOString(), getMarketPrice: marketPriceFn ?? getMarketPrice };
  return validate(rules, data, ctx);
}

/**
 * 全量对账：以持仓批次履历为基线，依据当前流水池状态重建底仓。
 *
 * 每个写操作（新增/删除/修改流水、清空流水池）后调用，保证：
 *  - 倒T首笔卖出扣减（通过 emitRoundAdjustments 投影）始终与当前流水池状态一致；
 *  - 删除/修改流水后，已不存在的调整批次会自动回滚（不再残留于底仓）；
 *  - 天然幂等：每次从「剥离调整批次后的基线」出发重新计算，扣减/归并不会重复叠加。
 *
 * @param positions 当前底仓（可能已含历史调整批次残留）
 * @param streams 当前流水池（新增/删除/修改后的最新状态）
 * @param feeConfig 系统费率配置
 * @param rounds 当前所有 Round（用于识别 COMPLETED 轮次保护固化批次）
 * @returns 对账后的底仓与撮合结果
 */
export function reconcilePositionsWithStreams(
  positions: Position[],
  streams: TStreamRecord[],
  feeConfig: FeeConfig,
  rounds?: TRoundArchive[],
): { positions: Position[]; streams: TStreamRecord[]; results: StockStreamResult[] } {
  // 已归档（COMPLETED）轮次引用的调整批次视为「固化履历」：其归并/扣减已随轮次
  // 归档落定，不能再被剥离回滚；否则多轮倒T中上一轮的归并效果会在下一轮
  // reconcile 时被错误撤销（如两轮各归并 100 → 底仓应 +200，旧逻辑只剩 +100）。
  // 保护策略：根据批次 kind + sourceRoundId 判断是否属于 COMPLETED 轮次
  const completedRoundIds = new Set<string>();
  if (rounds) {
    for (const r of rounds) {
      if ((r.status ?? 'OPENED') === 'COMPLETED') {
        completedRoundIds.add(r.id);
      }
    }
  }

  // ① 剥离历史调整批次，回到批次履历基线（数量/成本以批次为准）
  // 按 sourceRoundId 识别：不在 completedRoundIds 中的轮次对应的批次全部剥离
  // 覆盖：出借/归并（borrow/merge）、结算卖出（finalize-sell）、结算买入（merge-buy）
  const cleanPositions = positions.map((p) => {
    const cleanBatches = p.batches.filter((b) => {
      // 无 sourceRoundId 的批次为永久履历（如手工加减仓），保留
      if (!b.sourceRoundId) return true;
      // 保留 COMPLETED 轮次的固化批次（受保护不剥离）
      if (completedRoundIds.has(b.sourceRoundId)) return true;
      return false;
    });
    const snap = recomputePositionSnapshot(cleanBatches);
    const reOpened = snap.currentAmount > 0;
    return {
      ...p,
      batches: cleanBatches,
      currentCost: snap.currentCost,
      currentAmount: snap.currentAmount,
      realizedPnL: snap.realizedPnL,
      totalInvested: snap.totalInvested,
      isClosed: !reOpened,
      closedAt: reOpened ? undefined : p.closedAt,
    };
  });

  // ② 通过 emitRoundAdjustments 投影出借命令（取代旧的 normalizeShortTDeductions + applyShortExcessMerge）
  const { positions: deductedPositions } = normalizeShortTDeductionsViaPort(streams, cleanPositions, rounds ?? []);

  // ③ 计算撮合结果（用于结清检测）
  const baseCosts = buildBasePositionCosts(deductedPositions);
  const results = processAllStreams(streams, feeConfig, baseCosts);

  return { positions: deductedPositions, streams, results };
}
