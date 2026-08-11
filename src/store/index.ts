/**
 * @file index.ts
 * @description 全局内存状态中心（Zustand 纯内存管理）：
 *              管理费率配置、做T流水池（FIFO 撮合）、Round 生命周期归档库、持仓账本与数据导入导出。
 *              v3 引入做T流水池 tStreams（FIFO 撮合引擎级联重算）；v4 引入 Round 战报归档与绝对现金流划转。
 *              v5 重构：持久化改为 Store Action 内增量写库，彻底移除全量覆盖写。
 * @layer Store
 * @storage_impact 通过 db/index.ts 的增量写函数直接在 Action 内写 IndexedDB；
 *                 feeConfigs / positions / tRounds / tStreams / stocks / longTermRecords 表。
 * @author 开发团队
 */

// ============================================================
// 全局内存状态 (Zustand)
//  - v3: 做T流水池 tStreams（FIFO 撮合）
//  - v4: Round 生命周期归档库 tRounds + 绝对现金流划转
//  - v5: 增量写库（移除全量覆盖写订阅）
// ============================================================
import Decimal from 'decimal.js';
import { create } from 'zustand';
import { useMemo } from 'react';
import {
  processAllStreams,
  processStockStream,
  validateStreamTrade,
  type TStreamRecord,
  type StockStreamResult,
  type SellValidation,
} from '../utils/tStreamEngine';
import { calcTradeFees, roundTo, type FeeConfig } from '../utils/mathUtils';
import type { StockMeta, StockSearchItem } from '../types/stock';
import {
  putFeeConfig,
  putStock,
  deleteStock as dbDeleteStock,
  putPosition,
  deletePositionWithBatches,
  putPositionBatch,
  putTRound,
  deleteTRoundWithTransactions,
  putTStream,
  deleteTStream,
  bulkDeleteTStreams,
  putLongTermRecord,
  deleteLongTermRecord,
  deleteLongTermRecordsBySourceReportId,
  safeImportAllData,
  type FeeConfigRow,
  type PositionRow,
  type TRoundRow,
  type TStreamRow,
  type LongTermRecordRow,
  type StockRow,
} from '../db/index';
import { isInitialLoadDone } from '../db/storeInit';

/**
 * 安全的增量持久化包装器：仅在 initialLoadDone 完成且 DB 可用时执行写库操作。
 * 写库失败仅 console.error 记录，不阻断 UI 与内存状态更新。
 */
async function safePersist(fn: () => Promise<void>): Promise<void> {
  if (!isInitialLoadDone()) return;
  try {
    await fn();
  } catch (err) {
    console.error('[StorePersistence] Failed to persist:', err);
  }
}

// ---- 做T记录（旧版：买卖成对，仅保留用于统计页兼容展示） ----
export interface TRecord {
  id: string;
  timestamp: string;
  stockName: string;
  mode: 'long' | 'short';
  buyPrice: number;
  buyAmount: number;
  sellPrice: number;
  sellAmount: number;
  totalFee: number;
  netProfit: number | null;
  profitRate: number | null;
  status: string;
  /** 完整证券代码（含市场前缀，如 sh601318），作为与持仓账本关联的唯一主键 */
  fullCode: string;
  /** 东财 QuoteID，作为唯一标识  */
  quoteId?: string;
  /** 搜索时选择的完整股票数据 */
  selectedStock?: StockSearchItem;
}

// ---- 建仓批次 ----
export interface PositionBatch {
  id: string;
  timestamp: string;
  type: 'open' | 'add' | 'reduce' | 'close';
  price: number;
  amount: number;
  costAfter: number;
  amountAfter: number;
  note?: string;
  /** 该笔操作的总规费（买入规费之和 or 卖出规费之和） */
  fee?: number;
}

// ---- 持仓标的 ----
export interface Position {
  id: string;
  stockName: string;
  /** 完整证券代码（含市场前缀，如 sh601318），作为做T记录关联的唯一主键 */
  fullCode: string;
  currentCost: number;
  currentAmount: number;
  batches: PositionBatch[];
  isClosed: boolean;
  createdAt: string;
  closedAt?: string;
  /** 累计已实现盈亏（从减仓中累积） */
  realizedPnL?: number;
  /** 累计投入总资金（含规费，用于准确成本计算） */
  totalInvested?: number;
}

// ---- 中长期操作记录（Long-term Transaction History） ----
// 记录底仓操作（加仓/减仓/归并），用于与短线交易归并动作联动删除
export interface LongTermRecord {
  id: string;
  /** 关联标的完整代码（如 sh601318） */
  fullCode: string;
  /** 股票名称 */
  stockName: string;
  /** 操作类型：buy=加仓 / sell=减仓 / merge=归并（短线T+0归并到底仓） */
  type: 'buy' | 'sell' | 'merge';
  /** 成交单价（元） */
  price: number;
  /** 成交数量（股） */
  amount: number;
  /** 手续费（元） */
  fee: number;
  /** 操作时间戳（ISO 字符串） */
  timestamp: string;
  /** 关联短线战报 id（仅 type=merge 时有值，用于联动删除） */
  sourceReportId?: string;
  /** 备注 */
  note?: string;
}

// ---- 归档成交明细（历史穿透查看用） ----
export interface RoundTxn {
  id: string;
  timestamp: string;
  /** 交易方向：buy / sell / transfer(划转底仓) */
  direction: 'buy' | 'sell' | 'transfer';
  price: number;
  amount: number;
  /** 该笔规费（划转为 0，平价划转非真实交易） */
  fee: number;
  /** 该笔撮合配对数量 */
  matchedAmount: number;
  /** 该笔已实现对冲差价盈亏（划转恒为 0） */
  realizedProfit: number;
  note?: string;
}

// ---- 归档周期 (Round) 战报 ----
export interface TRoundArchive {
  id: string;
  /** 关联标的（含市场前缀，如 sh601318） */
  fullCode: string;
  stockName: string;
  /** 周期序号（同一标的从 1 递增，自动开启 Round + 1） */
  roundNo: number;
  /** 做T模式：正T / 倒T */
  mode: 'long' | 'short';
  /** 结算方式：正常清仓 clear | 划转底仓 transfer */
  settleType: 'clear' | 'transfer';
  /** 该 Round 全部成交明细快照（含划转记录），用于历史穿透查看 */
  transactions: RoundTxn[];
  /** 绝对现金流归档净收益 = Σ((卖出价 - P_avg)×卖出量) - 总规费 */
  netProfit: number;
  /** 系统计算总规费（动态费率联动） */
  fees: number;
  /** 已对冲卖出数量 */
  sellAmount: number;
  /** 划转到底仓数量（仅 transfer 场景） */
  transferAmount?: number;
  /** 加权均价 P_avg */
  avgPrice: number;
  /** 总买入数量 */
  buyAmount: number;
  /** 交易笔数 */
  tradeCount: number;
  /** 持股天数 */
  holdingDays: number;
  /** 是否盈利单（netProfit >= 0） */
  win: boolean;
  /** 开启时间（第一笔流水） */
  openedAt: string;
  /** 归档（结清）时间 */
  closedAt: string;
}

// ---- 归档/划转返回结果 ----
export interface MergeStreamResult {
  ok: boolean;
  message: string;
}

// ---- 流水池流水新增结果（用于持仓归零自动结清 Toast） ----
export interface StreamAddResult {
  /** 是否触发持仓归零自动结清（本轮做T已完全结清） */
  cleared: boolean;
  /** 结清时累计净盈亏 */
  netProfit?: number;
  /** 归档的 Round 序号 */
  roundNo?: number;
  /** 该股票新增后的撮合结果 */
  stream?: StockStreamResult;
  /** 是否被 Store 层校验拒绝（倒T首笔卖出底仓校验失败） */
  rejected?: boolean;
  /** 被拒绝时的提示文本 */
  rejectedReason?: string;
}

// ---- 全局 Store 类型 ----
export interface AppStore {
  // 费率配置
  feeConfig: FeeConfig;
  setFeeConfig: (config: Partial<FeeConfig>) => void;
  resetFeeConfig: (config: FeeConfig) => void;

  // 旧版做T记录（兼容统计页历史数据）
  tRecords: TRecord[];
  addTRecord: (record: TRecord) => void;
  updateTRecord: (id: string, updates: Partial<TRecord>) => void;
  removeTRecord: (id: string) => void;
  clearTRecords: () => void;

  // 做T流水池（核心新模型：单边买卖流水，撮合引擎自动级联重算）
  tStreams: TStreamRecord[];
  stocks: StockMeta[];
  addStreamRecord: (record: TStreamRecord) => StreamAddResult;
  /** 倒T首笔卖出严格底仓校验（标的存在性 + 可卖数量），表单提交与 Store 更新共用 */
  validateSellWithPosition: (
    fullCode: string,
    sellPrice: number,
    sellAmount: number
  ) => SellValidation;
  updateStreamRecord: (id: string, updates: Partial<TStreamRecord>) => void;
  removeStreamRecord: (id: string) => void;
  clearStreams: () => void;
  /** 将历史成对 TRecord 一次性导入为流水池流水（buy/sell 拆分） */
  importLegacyTRecords: () => number;

  // Round 生命周期归档库（历史战报）
  tRounds: TRoundArchive[];
  addRound: (round: TRoundArchive) => void;
  removeRound: (id: string) => { ok: boolean; message?: string };
  clearRounds: () => void;
  /** 一键划转底仓（绝对现金流法：剩余持仓按 P_avg 平价划入；做T归零自动归档战报） */
  transferToPosition: (
    fullCode: string,
    transferAmount?: number,
    transferPrice?: number
  ) => MergeStreamResult;
  /** 倒T主动结算；有剩余则转底仓，无剩余则直接归档 */
  settleShortRound: (fullCode: string) => MergeStreamResult;

  // 持仓账本
  positions: Position[];
  addPosition: (pos: Position) => void;
  updatePosition: (id: string, pos: Partial<Position>) => void;
  addBatch: (positionId: string, batch: PositionBatch) => void;
  closePosition: (id: string) => void;
  deletePositionBatch: (positionId: string, batchId: string) => void;
  removePosition: (id: string) => void;

  // 中长期操作记录
  longTermRecords: LongTermRecord[];
  addLongTermRecord: (record: LongTermRecord) => void;
  removeLongTermRecord: (id: string) => void;
  /** 根据 sourceReportId 删除对应中长期记录（级联删除用） */
  removeLongTermRecordsBySourceReportId: (sourceReportId: string) => void;
  clearLongTermRecords: () => void;

  // 全量数据导入导出
  exportData: () => AppStoreExport;
  importData: (data: AppStoreExport) => void;
  exportJSON: () => AppStoreExport;
  importJSON: (data: AppStoreExport) => void;
  exportCSV: () => string;
}

export interface AppStoreExport {
  feeConfig: FeeConfig;
  tRecords: TRecord[];
  tStreams: TStreamRecord[];
  tRounds: TRoundArchive[];
  positions: Position[];
  stocks: StockMeta[];
  longTermRecords: LongTermRecord[];
}

// ---- 默认费率配置 ----
export const DEFAULT_FEE_CONFIG: FeeConfig = {
  commissionRate: 0.00025,
  isFreeFive: false,
  minCommission: 0.5,
  transferRate: 0.00001,
  stampRate: 0.0005,
};

// ---- 预设模板 ----
export const FEE_TEMPLATES: Record<string, FeeConfig> = {
  'A股标准模板': {
    commissionRate: 0.00025,
    isFreeFive: false,
    minCommission: 0.5,
    transferRate: 0.00001,
    stampRate: 0.0005,
  },
  '港股/美股免佣模板': {
    commissionRate: 0.0001,
    isFreeFive: true,
    minCommission: 0.5,
    transferRate: 0.000025,
    stampRate: 0.0013,
  },
};

/**
 * 生成全局唯一 ID。
 *
 * @description 基于当前时间戳与随机数构造短唯一标识，用于流水、Round、持仓批次等实体主键。
 * @returns {string} 形如 `1690000000000-abc1234` 的唯一字符串 ID
 * @note 仅供内存态与归库前主键生成使用；IndexedDB 持久化由 storeInit 统一补全 `id`
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================
// 派生撮合结果 hook（级联重算核心）
// ------------------------------------------------------------
// 任何 tStreams 增删改 或 feeConfig 变化，
// 全市场流水池都会按时间顺序 FIFO 重新撮合，
// 保证"删除/修改某笔流水 -> 后续所有未结清持仓与已结盈亏自动刷新"。
// 同时输出 Round 生命周期汇总（P_avg / transferProfit / 持股天数等）。
// ============================================================
/**
 * 从持仓/成本摊薄账本构建 全Code -> 底仓持仓均价(P_base) 映射，
 * 供引擎在倒T首笔卖出时继承该均价作为对冲成本基准。
 */
export function buildBasePositionCosts(positions: Position[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const pos of positions) {
    if (pos.isClosed) continue;
    const open = pos.batches.some((b) => b.type === 'open' || b.amount > 0);
    if (!open) continue;
    map.set(pos.fullCode, pos.currentCost);
  }
  return map;
}

/**
 * 恢复底仓数量（倒T回补）。
 *
 * @description 对指定标的的未平仓持仓按当前成本价追加数量，联动重算
 *              加权成本 currentCost、当前数量 currentAmount 与累计投入 totalInvested；
 *              若持仓此前因倒T被扣减为 0，会重新置为未平仓。
 * @param {Position[]} positions - 全部持仓账本
 * @param {string} fullCode - 标的完整代码（如 sh601318）
 * @param {number} amount - 需要恢复的底仓股数（>0）
 * @returns {Position[]} 恢复数量后的新持仓数组（不可变更新）
 */
function restoreBasePositionQuantity(
  positions: Position[],
  fullCode: string,
  amount: number
): Position[] {
  return positions.map((p) => {
    if (p.fullCode !== fullCode || p.isClosed) return p;
    const currentAmount = p.currentAmount;
    const currentTotalCost = new Decimal(p.currentCost).mul(currentAmount);
    const addedCost = new Decimal(p.currentCost).mul(amount);
    const newAmount = currentAmount + amount;
    const newTotalCost = currentTotalCost.plus(addedCost);
    const newCost = newAmount > 0 ? roundTo(newTotalCost.div(newAmount).toNumber(), 3) : 0;
    return {
      ...p,
      currentAmount: newAmount,
      currentCost: newCost,
      totalInvested: roundTo(newCost * newAmount, 2),
      isClosed: false,
    };
  });
}

/**
 * 归一化倒T首笔卖出的底仓扣减标记。
 *
 * @description 按标的分组、按时间排序流水后，将「初始连续卖出」的总数量与
 *              持仓中已扣减的 baseDeductedAmount 对账：
 *              不足则从底仓中补扣（deductBasePositionQuantity），
 *              多扣则恢复底仓数量（restoreBasePositionQuantity），
 *              并逐笔更新流水的 baseDeductedAmount 字段。
 * @param {TStreamRecord[]} rawStreams - 原始做T流水池
 * @param {Position[]} positions - 当前持仓账本
 * @returns {{ streams: TStreamRecord[]; positions: Position[] }}
 *          归一化后的流水池与持仓数组（会原地修改原始流水对象的 baseDeductedAmount）
 * @note 纯内存计算，不写 IndexedDB；供撮合引擎 processAllStreams 预处理调用
 */
function normalizeShortTDeductions(
  rawStreams: TStreamRecord[],
  positions: Position[]
): { streams: TStreamRecord[]; positions: Position[] } {
  const normalizedPositions = [...positions];
  const grouped = new Map<string, TStreamRecord[]>();
  for (const stream of rawStreams) {
    const list = grouped.get(stream.fullCode);
    if (list) list.push(stream);
    else grouped.set(stream.fullCode, [stream]);
  }

  const updatedStreams: TStreamRecord[] = [...rawStreams];

  for (const [fullCode, streams] of grouped) {
    const sorted = [...streams].sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });

    const initialSellStreams = [] as TStreamRecord[];
    let initialShortSellAmount = 0;
    for (const stream of sorted) {
      if (stream.direction === 'sell') {
        initialShortSellAmount += stream.amount;
        initialSellStreams.push(stream);
        continue;
      }
      break;
    }

    const currentDeducted = initialSellStreams.reduce(
      (sum, stream) => sum + (stream.baseDeductedAmount ?? 0),
      0
    );
    const diff = initialShortSellAmount - currentDeducted;

    if (diff > 0) {
      const before = normalizedPositions.find(
        (p) => p.fullCode === fullCode && !p.isClosed
      );
      if (before && before.currentAmount > 0) {
        const result = deductBasePositionQuantity(normalizedPositions, fullCode, diff);
        let remaining = diff;
        for (const stream of initialSellStreams) {
          if (remaining <= 0) break;
          const want = Math.min(stream.amount, initialShortSellAmount);
          const existing = stream.baseDeductedAmount ?? 0;
          const assign = Math.max(0, Math.min(want - existing, remaining));
          if (assign > 0) {
            stream.baseDeductedAmount = existing + assign;
            remaining -= assign;
          }
          const idx = updatedStreams.findIndex((s) => s.id === stream.id);
          if (idx !== -1) {
            updatedStreams[idx] = stream;
          }
        }
        normalizedPositions.splice(0, normalizedPositions.length, ...result);
      }
    } else if (diff < 0) {
      const restoreAmount = Math.abs(diff);
      const result = restoreBasePositionQuantity(normalizedPositions, fullCode, restoreAmount);
      normalizedPositions.splice(0, normalizedPositions.length, ...result);
    }

    let remainingDeduct = initialShortSellAmount;
    for (const stream of sorted) {
      if (stream.direction !== 'sell') {
        stream.baseDeductedAmount = 0;
      } else {
        const assigned = Math.min(stream.amount, remainingDeduct);
        stream.baseDeductedAmount = assigned > 0 ? assigned : 0;
        remainingDeduct -= assigned;
      }
      const idx = updatedStreams.findIndex((s) => s.id === stream.id);
      if (idx !== -1) {
        updatedStreams[idx] = stream;
      }
    }
  }

  return { streams: updatedStreams, positions: normalizedPositions };
}

/**
 * 判断两个 ISO 时间字符串是否属于同一天。
 *
 * @param {string} timestampA - 时间 A（ISO 字符串）
 * @param {string} timestampB - 时间 B（ISO 字符串）
 * @returns {boolean} 同一天返回 true，否则 false
 * @note 按 UTC 日期取前 10 位比较；仅供撮合引擎日内分组使用
 */
function isSameDay(timestampA: string, timestampB: string): boolean {
  const dateA = new Date(timestampA).toISOString().slice(0, 10);
  const dateB = new Date(timestampB).toISOString().slice(0, 10);
  return dateA === dateB;
}

/**
 * 从底仓中扣减数量（倒T首笔卖出）。
 *
 * @description 按 fullCode 匹配未平仓持仓，减少 currentAmount（下限 0），
 *              保持 currentCost 不变，并同步重算累计投入 totalInvested。
 * @param {Position[]} positions - 全部持仓账本
 * @param {string} fullCode - 标的完整代码
 * @param {number} amount - 扣减股数（>0）
 * @returns {Position[]} 扣减后的新持仓数组（不可变更新）
 */
function deductBasePositionQuantity(
  positions: Position[],
  fullCode: string,
  amount: number
): Position[] {
  return positions.map((p) => {
    if (p.fullCode !== fullCode) return p;
    const newAmount = Math.max(0, p.currentAmount - amount);
    const newCost = p.currentCost;
    const newTotalInvested = roundTo(newCost * newAmount, 2);
    return {
      ...p,
      currentAmount: newAmount,
      currentCost: newCost,
      totalInvested: newTotalInvested,
      isClosed: false,
    };
  });
}

/**
 * 向底仓追加数量并合并做T盈亏（归档回补）。
 *
 * @description 将做T实现的 profit 计入底仓总成本：若原始数量为 0 且提供
 *              buyTotal，则以 (buyTotal - profit) / amount 重算成本；
 *              否则用「原总成本 - 盈利」除以新数量得到加权成本。
 * @param {Position[]} positions - 全部持仓账本
 * @param {string} fullCode - 标的完整代码
 * @param {number} amount - 追加股数（>0）
 * @param {number} profit - 本次做T净盈利（元，负数表示亏损，会抬高成本）
 * @param {number} [buyTotal] - 可选：本次买入总金额（元）
 * @returns {Position[]} 追加并重算后的新持仓数组（不可变更新）
 */
function addBasePositionQuantity(
  positions: Position[],
  fullCode: string,
  amount: number,
  profit: number,
  buyTotal?: number
): Position[] {
  return positions.map((p) => {
    if (p.fullCode !== fullCode) return p;
    const currentAmount = p.currentAmount;
    const currentTotalCost = new Decimal(p.currentCost).mul(currentAmount);
    const newAmount = currentAmount + amount;
    let newCost: number;

    if (currentAmount === 0) {
      if (buyTotal !== undefined && amount > 0) {
        newCost = roundTo((buyTotal - profit) / amount, 3);
      } else {
        const newTotalCost = new Decimal(currentTotalCost).minus(profit);
        newCost = newAmount > 0 ? roundTo(newTotalCost.div(newAmount).toNumber(), 3) : 0;
      }
    } else {
      const newTotalCost = currentTotalCost.minus(profit);
      newCost = newAmount > 0 ? roundTo(newTotalCost.div(newAmount).toNumber(), 3) : 0;
    }

    return {
      ...p,
      currentAmount: newAmount,
      currentCost: newCost,
      totalInvested: roundTo(newCost * newAmount, 2),
      isClosed: newAmount === 0,
    };
  });
}

/**
 * 恢复底仓成本与数量（倒T归档还原）。
 *
 * @description 若目标标的无未平仓持仓，则按 profit 反推建仓成本并新建一条
 *              open 批次底仓；若已有持仓，则在原数量上追加 amount，并用
 *              「原总成本 - 盈利」重算加权成本。
 * @param {Position[]} positions - 全部持仓账本
 * @param {string} fullCode - 标的完整代码
 * @param {number} amount - 恢复股数（倒T卖出数量，>0）
 * @param {number} profit - 倒T实现盈亏（元，负数表示亏损抬高成本）
 * @returns {Position[]} 恢复后的新持仓数组（不可变更新；可能新增持仓项）
 */
function restoreBasePositionCost(
  positions: Position[],
  fullCode: string,
  amount: number,
  profit: number
): Position[] {
  const now = new Date().toISOString();
  const pos = positions.find((p) => p.fullCode === fullCode && !p.isClosed);
  if (!pos) {
    const cost = amount > 0 ? roundTo((profit >= 0 ? 0 : -profit) / amount + 0, 3) : 0;
    const newPos: Position = {
      id: generateId(),
      stockName: fullCode,
      fullCode,
      currentCost: cost,
      currentAmount: amount,
      batches: [
        {
          id: generateId(),
          timestamp: now,
          type: 'open',
          price: cost,
          amount,
          costAfter: cost,
          amountAfter: amount,
          note: '倒T 归档恢复底仓',
        },
      ],
      isClosed: false,
      createdAt: now,
      totalInvested: roundTo(cost * amount, 2),
      realizedPnL: 0,
    };
    return [...positions, newPos];
  }

  const originalAmount = pos.currentAmount;
  const finalAmount = originalAmount + amount;
  const originalTotalCost = new Decimal(pos.currentCost).mul(finalAmount);
  const newTotalCost = originalTotalCost.minus(profit);
  const newCost = finalAmount > 0 ? roundTo(newTotalCost.div(finalAmount).toNumber(), 3) : 0;
  const newTotalInvested = roundTo(newCost * finalAmount, 2);

  return positions.map((p) =>
    p.id !== pos.id
      ? p
      : {
          ...p,
          currentAmount: finalAmount,
          currentCost: newCost,
          totalInvested: newTotalInvested,
          isClosed: false,
        }
  );
}

/**
 * 回滚划转底仓（transfer 结算撤销 / 归并剥离）。
 *
 * @description 从持仓数量中扣回已归并的 transferAmount 股，按归并均价
 *              avgPrice 从总成本中扣除对应金额，重算加权成本与累计投入；
 *              若持仓数量不足以归并剥离则返回错误信息。
 *              同时清理该归并产生的批次记录与已实现盈亏。
 * @param {Position[]} positions - 全部持仓账本
 * @param {string} fullCode - 标的完整代码
 * @param {number} transferAmount - 需要回滚的归并股数（>0）
 * @param {number} avgPrice - 当时归并的加权均价（元）
 * @param {number} [transferFee] - 归并时产生的手续费（若有）
 * @returns {{ positions: Position[]; ok: boolean; message?: string }}
 *          回滚结果；ok=false 时 positions 为原始数组，message 为错误描述
 */
export function rollbackTransferPosition(
  positions: Position[],
  fullCode: string,
  transferAmount: number,
  avgPrice: number,
  transferFee?: number
): { positions: Position[]; ok: boolean; message?: string } {
  let hasError = false;
  let errorMsg = '';
  const nextPositions = positions.map((p) => {
    if (p.fullCode !== fullCode || p.isClosed) return p;
    if (p.currentAmount < transferAmount) {
      hasError = true;
      errorMsg = `无法删除该战报，后续交易已消耗该归并持仓（当前底仓 ${p.currentAmount} 股 < 需剥离 ${transferAmount} 股）`;
      return p;
    }
    const currentTotal = new Decimal(p.currentCost).mul(p.currentAmount);
    const rollbackTotal = new Decimal(avgPrice).mul(transferAmount);
    // 归并时产生的手续费（若有），也一并从 totalInvested 中扣除
    const rollbackFee = transferFee ?? 0;
    const nextAmount = p.currentAmount - transferAmount;
    const nextTotal = currentTotal.minus(rollbackTotal);
    const nextCost = nextAmount > 0 ? roundTo(nextTotal.div(nextAmount).toNumber(), 3) : 0;
    // 从 totalInvested 中精准扣除：归并时投入的资金 = avgPrice * transferAmount + rollbackFee
    const investedDeduction = new Decimal(avgPrice).mul(transferAmount).plus(rollbackFee);
    const nextInvested = new Decimal(p.totalInvested ?? 0).minus(investedDeduction);
    // 清理批次中属于该归并操作的记录（按金额和数量匹配）
    const remainingBatches = p.batches.filter((b) => {
      if (b.type === 'add' && b.amount === transferAmount) {
        const batchCost = b.price * b.amount + (b.fee ?? 0);
        const deductCost = avgPrice * transferAmount + rollbackFee;
        // 允许微小浮点误差（0.01 元以内视为同一笔）
        return Math.abs(batchCost - deductCost) > 0.01;
      }
      return true;
    });
    return {
      ...p,
      currentAmount: nextAmount,
      currentCost: nextCost > 0 ? nextCost : 0,
      totalInvested: nextInvested.gt(0) ? roundTo(nextInvested.toNumber(), 2) : 0,
      batches: remainingBatches,
      isClosed: nextAmount === 0 ? true : p.isClosed,
      closedAt: nextAmount === 0 ? new Date().toISOString() : p.closedAt,
    };
  });
  if (hasError) {
    return { positions, ok: false, message: errorMsg };
  }
  return { positions: nextPositions, ok: true };
}

/**
 * 派生全市场撮合结果 Hook（级联重算核心）。
 *
 * @description 订阅 tStreams / feeConfig / positions 变化，按 FIFO 顺序重新
 *              撮合全部流水池，输出每股的持仓、盈亏、Round 生命周期汇总；
 *              任何流水增删改或费率变化都会自动重算并驱动 UI 刷新。
 * @returns {StockStreamResult[]} 全标的撮合结果数组（每标的一项）
 * @note 纯派生计算，不写 IndexedDB；由 useMemo 缓存降低重算开销
 */
export function useStreamResults(): StockStreamResult[] {
  const tStreams = useAppStore((s) => s.tStreams);
  const feeConfig = useAppStore((s) => s.feeConfig);
  const positions = useAppStore((s) => s.positions);
  return useMemo(() => {
    const baseCosts = buildBasePositionCosts(positions);
    return processAllStreams(tStreams, feeConfig, baseCosts);
  }, [tStreams, feeConfig, positions]);
}

/**
 * 计算绝对现金流归档净收益（划转/自动归档共用）。
 *
 * @description 直接复用引擎已按「Σ((卖出单价 - P_avg)×卖出数量) - 已实现总规费」
 *              口径计算好的 transferProfit，作为 Round 战报的归档净收益。
 * @param {StockStreamResult} stream - 单标的撮合结果
 * @returns {number} 归档净收益（元）
 * @note 非事务方法，不写 IndexedDB；仅用于生成 TRoundArchive.netProfit
 */
function calcTransferArchiveProfit(stream: StockStreamResult): number {
  return stream.transferProfit;
}

/**
 * Round 自动归档：池归零且发生过卖出时生成战报。
 *
 * @description 当撮合结果状态为 CLEARED 且存在卖出流水时，将该股票全部成交明细
 *              快照为 TRoundArchive（roundNo 自动 +1），追加到归档库；
 *              否则原样返回归档列表。
 * @param {StockStreamResult} stream - 单标的撮合结果
 * @param {TRoundArchive[]} rounds - 现有 Round 归档列表
 * @returns {TRoundArchive[]} 追加新战报后的归档数组（若满足归档条件）
 * @note 非事务方法，不写 IndexedDB；由 addStreamRecord/removeStreamRecord 等调用并 set 回 Store
 */
function archiveRoundIfCleared(stream: StockStreamResult, rounds: TRoundArchive[]): TRoundArchive[] {
  const hasSell = stream.entries.some((e) => e.direction === 'sell');
  // 池持仓归零且发生过卖出才能归档（纯买入后清空流水不算一轮 T）
  if (stream.status !== 'CLEARED' || !hasSell) return rounds;

  const existing = rounds.filter((r) => r.fullCode === stream.fullCode);
  const maxRound = existing.reduce((m, r) => Math.max(m, r.roundNo), 0);

  // 成交明细快照：全部流水按时间序（含撮合配对量/已实现盈亏）
  const transactions: RoundTxn[] = stream.entries.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    direction: e.direction,
    price: e.price,
    amount: e.amount,
    fee: e.fee,
    matchedAmount: e.matchedAmount,
    realizedProfit: e.realizedProfit,
    note: e.note,
  }));

  const round: TRoundArchive = {
    id: generateId(),
    fullCode: stream.fullCode,
    stockName: stream.stockName,
    mode: stream.mode,
    roundNo: maxRound + 1,
    settleType: 'clear',
    transactions,
    netProfit: stream.transferProfit,
    fees: stream.totalFee,
    sellAmount: stream.realizedSellAmount,
    avgPrice: stream.avgPrice,
    buyAmount: stream.buyAmount,
    tradeCount: stream.tradeCount,
    holdingDays: stream.holdingDays,
    win: stream.transferProfit >= 0,
    openedAt: stream.openedAt ?? stream.entries[0]?.timestamp ?? new Date().toISOString(),
    closedAt: stream.lastClosedAt ?? new Date().toISOString(),
  };
  return [...rounds, round];
}

// ---- 创建 Store ----
export const useAppStore = create<AppStore>()((set, get) => ({
      feeConfig: { ...DEFAULT_FEE_CONFIG },
      tRecords: [],
      tStreams: [],
      tRounds: [],
      longTermRecords: [],
      positions: [],
      stocks: [],

      setFeeConfig: (config: Partial<FeeConfig>) => {
        set((state) => ({
          feeConfig: { ...state.feeConfig, ...config },
        }));
        const merged = { ...get().feeConfig };
        safePersist(() => putFeeConfig(merged as FeeConfigRow));
      },

      resetFeeConfig: (config: FeeConfig) => {
        set({ feeConfig: config });
        safePersist(() => putFeeConfig(config as FeeConfigRow));
      },

      addTRecord: (record: TRecord) => {
        set((state) => ({
          tRecords: [record, ...state.tRecords],
        }));
      },

      removeTRecord: (id: string) => {
        set((state) => ({
          tRecords: state.tRecords.filter((r) => r.id !== id),
        }));
      },

      updateTRecord: (id: string, updates: Partial<TRecord>) => {
        set((state) => ({
          tRecords: state.tRecords.map((r) =>
            r.id === id ? { ...r, ...updates } : r
          ),
        }));
      },

      clearTRecords: () => {
        set({ tRecords: [] });
      },

      // ---- 倒T首笔卖出严格底仓校验（标的存在性 + 可卖数量） ----
      // 规则：
      //  - 首笔卖出（Round 尚无该标的流水）= 倒T先卖后买 -> 严格校验底仓：标的存在性 + 卖出数量 ≤ N_base
      //  - 后续卖出 = 正常校验（maxSellable = 待对冲持仓 pending + 底仓 N_base）
      validateSellWithPosition: (
        fullCode: string,
        sellPrice: number,
        sellAmount: number
      ) => {
        const { tStreams, positions, feeConfig } = get();
        const existing = tStreams.filter((s) => s.fullCode === fullCode);
        // 倒T首笔卖出 = Round 尚无该标的任何流水（先卖后买）
        const isFirstSell = existing.length === 0;
        const pos = positions.find(
          (p) => p.fullCode === fullCode && !p.isClosed
        );
        const baseAmount = pos?.currentAmount ?? 0;
        // 后续卖出：传入实际流水池撮合结果，正常计算待对冲持仓 + 底仓 => 最大可卖
        const stream = isFirstSell
          ? null
          : processStockStream(
              existing,
              feeConfig,
              buildBasePositionCosts(positions).get(fullCode)
            );
        return validateStreamTrade(
          stream,
          baseAmount,
          'sell',
          sellPrice,
          sellAmount,
          isFirstSell
        );
      },

      // ---- 做T流水池（增删改后自动检查 Round 归档） ----
      addStreamRecord: (record: TStreamRecord) => {
        // ---- Store 层兜底校验：倒T首笔卖出（Round 首条流水即卖出）严格底仓校验 ----
        // 标的存在性 + 卖出数量 ≤ 底仓可用数量 N_base；UI 未拦截时此处也阻止写入
        if (record.direction === 'sell') {
          const existing = get().tStreams.filter(
            (s) => s.fullCode === record.fullCode
          );
          if (existing.length === 0) {
            const baseAmount =
              get().positions.find(
                (p) => p.fullCode === record.fullCode && !p.isClosed
              )?.currentAmount ?? 0;
            const check = validateStreamTrade(
              null,
              baseAmount,
              'sell',
              record.price,
              record.amount,
              true
            );
            if (!check.valid) {
              return {
                cleared: false,
                rejected: true,
                rejectedReason: check.error,
              };
            }
          }
        }

        const { tStreams, feeConfig, tRounds, positions } = get();
        const rawNext = [...tStreams, record];
        const normalized = normalizeShortTDeductions(rawNext, positions);
        const baseCosts = buildBasePositionCosts(normalized.positions);
        const results = processAllStreams(normalized.streams, feeConfig, baseCosts);
        const stream = results.find((r) => r.fullCode === record.fullCode);
        const rounds = stream ? archiveRoundIfCleared(stream, tRounds) : tRounds;
        const cleared =
          !!stream &&
          stream.status === 'CLEARED' &&
          stream.entries.some((e) => e.direction === 'sell');
        const streamsAfter = cleared
          ? normalized.streams.filter((s) => s.fullCode !== record.fullCode)
          : normalized.streams;
        let nextPositions = normalized.positions;
        if (cleared && stream && stream.mode === 'short' && stream.initialShortSellQty) {
          nextPositions = addBasePositionQuantity(nextPositions, stream.fullCode, stream.initialShortSellQty, stream.transferProfit);
        }

        let addResult: StreamAddResult = { cleared: false, stream };
        if (cleared && stream) {
          const archivedRound = rounds
            .filter((r) => r.fullCode === record.fullCode)
            .find((r) => r.closedAt === stream.lastClosedAt);
          addResult = {
            cleared: true,
            netProfit: stream.transferProfit,
            roundNo: archivedRound?.roundNo,
            stream,
          };
        }
        set({ tStreams: streamsAfter, tRounds: rounds, positions: nextPositions });
        // 增量持久化：新增流水 + 清理已结清的流水
        safePersist(async () => {
          await putTStream(record as unknown as TStreamRow);
          // 若当前标的已结清，则删除该标的所有 DB 流水
          if (cleared) {
            const clearedIds = tStreams.filter((s) => s.fullCode === record.fullCode).map((s) => s.id);
            if (clearedIds.length > 0) {
              await bulkDeleteTStreams(clearedIds);
            }
            // 同步新归档的 Round
            const newRounds = rounds.filter((r) => !tRounds.some((old) => old.id === r.id));
            for (const nr of newRounds) {
              await putTRound(nr as unknown as TRoundRow);
            }
          }
        });
        return addResult;
      },

      removeStreamRecord: (id: string) => {
        const { tStreams, feeConfig, tRounds, positions } = get();
        const target = tStreams.find((r) => r.id === id);
        const rawNext = tStreams.filter((r) => r.id !== id);
        let rounds = tRounds;
        let streams = rawNext;
        if (target) {
          const normalized = normalizeShortTDeductions(rawNext, positions);
          const results = processAllStreams(normalized.streams, feeConfig, buildBasePositionCosts(normalized.positions));
          const stream = results.find((r) => r.fullCode === target.fullCode);
          let nextPositions = normalized.positions;
          if (stream && stream.status === 'CLEARED' && stream.mode === 'short' && stream.initialShortSellQty) {
            nextPositions = addBasePositionQuantity(nextPositions, stream.fullCode, stream.initialShortSellQty, stream.transferProfit);
          }
          if (stream) {
            rounds = archiveRoundIfCleared(stream, tRounds);
            const hasSell = stream.entries.some((e) => e.direction === 'sell');
            if (stream.status === 'CLEARED' && hasSell) {
              streams = normalized.streams.filter((s) => s.fullCode !== target.fullCode);
            } else {
              streams = normalized.streams;
            }
          } else {
            streams = normalized.streams;
          }
          set({ positions: nextPositions });
        }
        set({ tStreams: streams, tRounds: rounds });
        // 增量持久化：删除流水 + 同步结清
        safePersist(async () => {
          await deleteTStream(id);
          // 若结清了，删除该标的 DB 清理的流水
          const currentStreamIds = new Set(streams.map((s) => s.id));
          const removedIds = tStreams.filter((s) => !currentStreamIds.has(s.id)).map((s) => s.id);
          if (removedIds.length > 0) {
            await bulkDeleteTStreams(removedIds);
          }
        });
      },

      updateStreamRecord: (id: string, updates: Partial<TStreamRecord>) => {
        const { tStreams, feeConfig, tRounds, positions } = get();
        const target = tStreams.find((r) => r.id === id);
        const rawNext = tStreams.map((r) => (r.id === id ? { ...r, ...updates } : r));
        let rounds = tRounds;
        let streams = rawNext;
        if (target) {
          const normalized = normalizeShortTDeductions(rawNext, positions);
          const results = processAllStreams(normalized.streams, feeConfig, buildBasePositionCosts(normalized.positions));
          const stream = results.find((r) => r.fullCode === target.fullCode);
          let nextPositions = normalized.positions;
          if (stream && stream.status === 'CLEARED' && stream.mode === 'short' && stream.initialShortSellQty) {
            nextPositions = addBasePositionQuantity(nextPositions, stream.fullCode, stream.initialShortSellQty, stream.transferProfit);
          }
          if (stream) {
            rounds = archiveRoundIfCleared(stream, tRounds);
            const hasSell = stream.entries.some((e) => e.direction === 'sell');
            if (stream.status === 'CLEARED' && hasSell) {
              streams = normalized.streams.filter((s) => s.fullCode !== target.fullCode);
            } else {
              streams = normalized.streams;
            }
          } else {
            streams = normalized.streams;
          }
          set({ positions: nextPositions });
        }
        set({ tStreams: streams, tRounds: rounds });
        // 增量持久化：更新流水
        const updated = get().tStreams.find((s) => s.id === id);
        if (updated) {
          safePersist(() => putTStream(updated as unknown as TStreamRow));
        }
      },

      clearStreams: () => {
        const ids = get().tStreams.map((s) => s.id);
        set({ tStreams: [] });
        safePersist(() => bulkDeleteTStreams(ids));
      },

      importLegacyTRecords: () => {
        const { tRecords } = get();
        if (tRecords.length === 0) return 0;

        const converted: TStreamRecord[] = [];
        for (const r of tRecords) {
          if (r.buyPrice > 0 && r.buyAmount > 0) {
            converted.push({
              id: `${r.id}-buy`,
              timestamp: r.timestamp,
              fullCode: r.fullCode,
              stockName: r.stockName,
              direction: 'buy',
              price: r.buyPrice,
              amount: r.buyAmount,
              fee: 0, // 级联重算时按系统费率自动计算
              note: `${r.mode === 'long' ? '正T' : '倒T'}买入（历史导入）`,
              quoteId: r.quoteId,
              selectedStock: r.selectedStock,
            });
          }
          if (r.sellPrice > 0 && r.sellAmount > 0) {
            converted.push({
              id: `${r.id}-sell`,
              timestamp: r.timestamp,
              fullCode: r.fullCode,
              stockName: r.stockName,
              direction: 'sell',
              price: r.sellPrice,
              amount: r.sellAmount,
              fee: 0,
              note: `${r.mode === 'long' ? '正T' : '倒T'}卖出（历史导入）`,
              quoteId: r.quoteId,
              selectedStock: r.selectedStock,
            });
          }
        }

        set((state) => ({
          tStreams: [...state.tStreams, ...converted],
        }));
        // 增量持久化：写入所有导入的流水
        safePersist(async () => {
          for (const stream of converted) {
            await putTStream(stream as unknown as TStreamRow);
          }
        });
        return converted.length;
      },

      // ---- Round 归档库 ----
      addRound: (round: TRoundArchive) => {
        set((state) => ({ tRounds: [...state.tRounds, round] }));
        safePersist(() => putTRound(round as unknown as TRoundRow));
      },

      removeRound: (id: string) => {
        const state = get();
        const round = state.tRounds.find((r) => r.id === id);
        if (!round) return { ok: false, message: '战报不存在或已被删除' };

        let nextPositions = state.positions;
        // 自动检测归并类型：任何包含 transferAmount 的战报均需剥离底仓
        if (round.transferAmount && round.transferAmount > 0) {
          const rollbackResult = rollbackTransferPosition(
            state.positions,
            round.fullCode,
            round.transferAmount,
            round.avgPrice
          );
          if (!rollbackResult.ok) {
            return { ok: false, message: rollbackResult.message };
          }
          nextPositions = rollbackResult.positions;
        }

        set({
          tRounds: state.tRounds.filter((r) => r.id !== id),
          positions: nextPositions,
          // 级联删除：同步清理该战报生成的中长期操作记录（归并标记）
          longTermRecords: state.longTermRecords.filter(
            (r) => r.sourceReportId !== id
          ),
        });
        // 增量删除 DB：Round + 交易明细 + 相关中长期记录
        safePersist(async () => {
          await deleteTRoundWithTransactions(id);
          await deleteLongTermRecordsBySourceReportId(id);
          // 同步更新受影响的持仓
          for (const pos of nextPositions) {
            await putPosition(pos as unknown as PositionRow);
          }
        });
        return { ok: true };
      },

      clearRounds: () => {
        const ids = get().tRounds.map((r) => r.id);
        set({ tRounds: [] });
        safePersist(async () => {
          for (const id of ids) {
            await deleteTRoundWithTransactions(id);
          }
        });
      },

      // ---- 中长期操作记录 CRUD ----
      addLongTermRecord: (record: LongTermRecord) => {
        set((state) => ({
          longTermRecords: [...state.longTermRecords, record],
        }));
        safePersist(() => putLongTermRecord(record as unknown as LongTermRecordRow));
      },

      removeLongTermRecord: (id: string) => {
        set((state) => ({
          longTermRecords: state.longTermRecords.filter((r) => r.id !== id),
        }));
        safePersist(() => deleteLongTermRecord(id));
      },

      removeLongTermRecordsBySourceReportId: (sourceReportId: string) => {
        set((state) => ({
          longTermRecords: state.longTermRecords.filter(
            (r) => r.sourceReportId !== sourceReportId
          ),
        }));
        safePersist(() => deleteLongTermRecordsBySourceReportId(sourceReportId));
      },

      clearLongTermRecords: () => {
        const ids = get().longTermRecords.map((r) => r.id);
        set({ longTermRecords: [] });
        safePersist(async () => {
          for (const id of ids) {
            await deleteLongTermRecord(id);
          }
        });
      },

      // ---- 一键划转底仓（绝对现金流法） ----
      transferToPosition: (fullCode: string, transferAmount?: number, transferPrice?: number) => {
        const { tStreams, tRounds, positions, feeConfig } = get();
        const baseCosts = buildBasePositionCosts(positions);
        const streams = tStreams.filter((s) => s.fullCode === fullCode);
        if (streams.length === 0) {
          return { ok: false, message: '该股票没有做T流水，无法划转' };
        }
        const result = processAllStreams(streams, feeConfig, baseCosts).find(
          (r) => r.fullCode === fullCode
        );
        const stream = result ?? processStockStream(streams, feeConfig, baseCosts.get(fullCode));
        const pending = stream.netPendingAmount;
        const avg = transferPrice && transferPrice > 0 ? transferPrice : stream.avgPrice;

        // 1) 计算待划转数量（默认全部剩余）
        const toTransfer = transferAmount && transferAmount > 0
          ? Math.min(transferAmount, pending)
          : pending;
        if (toTransfer <= 0) {
          return { ok: false, message: '当前做T项目持仓已归零，无需划转' };
        }

        const now = new Date().toISOString();
        const txnFee = calcTradeFees(avg, toTransfer, 'buy', feeConfig).total;
        let newPositions = positions;
        let created = false;

        // 2) 找到或创建底仓
        let pos = positions.find(
          (p) => p.fullCode === fullCode && !p.isClosed
        );
        if (!pos) {
          pos = {
            id: generateId(),
            stockName: stream.stockName,
            fullCode,
            currentCost: 0,
            currentAmount: 0,
            batches: [],
            isClosed: false,
            createdAt: now,
            realizedPnL: 0,
            totalInvested: 0,
          };
          created = true;
        }

        const posDef = pos;
        const addQty = toTransfer;
        const totalBefore = posDef.currentAmount;
        const investedBefore = posDef.totalInvested ?? 0;
        const addInvested = avg * addQty + txnFee;
        const newAmount = totalBefore + addQty;
        const newInvested = investedBefore + addInvested;
        const newCost = newAmount > 0 ? newInvested / newAmount : 0;

        const batch: PositionBatch = {
          id: generateId(),
          timestamp: now,
          type: 'add',
          price: avg,
          amount: addQty,
          costAfter: newCost,
          amountAfter: newAmount,
          note: `做T划转底仓（P_avg=${avg}）`,
          fee: txnFee,
        };

        if (created) {
          // 自动新建底仓（成本摊薄账本首笔 open 批次）
          const openBatch: PositionBatch = {
            id: generateId(),
            timestamp: now,
            type: 'open',
            price: avg,
            amount: addQty,
            costAfter: newCost,
            amountAfter: newAmount,
            note: `做T划转新建底仓（P_avg=${avg}）`,
            fee: txnFee,
          };
          const newPos: Position = {
            ...posDef,
            currentCost: newCost,
            currentAmount: newAmount,
            batches: [openBatch],
            totalInvested: newInvested,
          };
          newPositions = [...positions, newPos];
        } else {
          // 3) 加权平均法合并入既有底仓
          if (toTransfer < pending) {
            // 部分划转：只沉淀，不回写做T（剩余的继续做T）
            newPositions = positions.map((p) =>
              p.id === posDef.id
                ? {
                    ...p,
                    currentCost: newCost,
                    currentAmount: newAmount,
                    totalInvested: newInvested,
                    batches: [...p.batches, batch],
                  }
                : p
            );
            return { ok: true, message: `已划转 ${toTransfer} 股至底仓（均价 ${avg.toFixed(3)} 元），做T剩余 ${pending - toTransfer} 股继续持仓` };
          }
          newPositions = positions.map((p) =>
            p.id === posDef.id
              ? {
                  ...p,
                  currentCost: newCost,
                  currentAmount: newAmount,
                  totalInvested: newInvested,
                  batches: [...p.batches, batch],
                }
              : p
          );
        }

        // 3) 做T持仓扣减归零 -> 直接触发 Round 归档（绝对现金流战报）
        const existing = tRounds.filter((r) => r.fullCode === fullCode);
        const maxRound = existing.reduce((m, r) => Math.max(m, r.roundNo), 0);

        // P_avg 平价划转后做T归零，归档净收益 = 划转前已实现卖出 - 已实现规费
        const transferProfit = calcTransferArchiveProfit(stream);
        // 成交明细快照：全部流水按时间序 + 末尾追加一条划转记录
        const transactions: RoundTxn[] = [
          ...stream.entries.map((e) => ({
            id: e.id,
            timestamp: e.timestamp,
            direction: e.direction,
            price: e.price,
            amount: e.amount,
            fee: e.fee,
            matchedAmount: e.matchedAmount,
            realizedProfit: e.realizedProfit,
            note: e.note,
          })),
          {
            id: generateId(),
            timestamp: now,
            direction: 'transfer' as const,
            price: avg,
            amount: toTransfer,
            fee: 0,
            matchedAmount: 0,
            realizedProfit: 0,
            note: `划转底仓（P_avg=${avg}）`,
          },
        ];
        const round: TRoundArchive = {
          id: generateId(),
          fullCode,
          stockName: stream.stockName,
          mode: stream.mode,
          roundNo: maxRound + 1,
          settleType: 'transfer',
          transactions,
          netProfit: transferProfit,
          fees: stream.realizedFee,
          sellAmount: stream.realizedSellAmount,
          transferAmount: toTransfer,
          avgPrice: stream.avgPrice,
          buyAmount: stream.buyAmount,
          tradeCount: stream.tradeCount,
          holdingDays: stream.holdingDays,
          win: transferProfit >= 0,
          openedAt: stream.openedAt ?? now,
          closedAt: now,
        };
        const newRounds = [...tRounds, round];

        // 4a) 创建中长期操作记录（标记为「归并」）
        const mergeRecord: LongTermRecord = {
          id: generateId(),
          fullCode,
          stockName: stream.stockName,
          type: 'merge',
          price: avg,
          amount: toTransfer,
          fee: txnFee,
          timestamp: now,
          sourceReportId: round.id,
          note: `${round.mode === 'long' ? '正T' : '倒T'}归并到底仓（Round ${round.roundNo}）`,
        };
        const newLongTermRecords = [...get().longTermRecords, mergeRecord];

        // 4) 清空该股票做T流水（Round 结束，下次买入自动开启 Round + 1）
        const streamsAfter = tStreams.filter((s) => s.fullCode !== fullCode);

        set({ tStreams: streamsAfter, tRounds: newRounds, positions: newPositions, longTermRecords: newLongTermRecords });

        // 增量持久化：清理流水、写入新 Round、同步持仓与中长期记录
        safePersist(async () => {
          // 删除已清空的做T流水
          const clearedIds = tStreams.filter((s) => s.fullCode === fullCode).map((s) => s.id);
          if (clearedIds.length > 0) {
            await bulkDeleteTStreams(clearedIds);
          }
          // 写入新的归档 Round
          await putTRound(round as unknown as TRoundRow);
          // 写入中长期操作记录
          await putLongTermRecord(mergeRecord as unknown as LongTermRecordRow);
          // 同步受影响的持仓
          const affectedPos = newPositions.filter((p) => p.fullCode === fullCode && !p.isClosed);
          for (const pos of affectedPos) {
            await putPosition(pos as unknown as PositionRow);
          }
        });

        return {
          ok: true,
          message: `已划转 ${toTransfer} 股@${avg.toFixed(3)} 元至底仓，做T归零归档 Round ${round.roundNo}，累计净收益 ¥${transferProfit.toFixed(2)}`,
        };
      },
      settleShortRound: (fullCode: string) => {
        const { tStreams, tRounds, feeConfig, positions } = get();
        const streams = tStreams.filter((s) => s.fullCode === fullCode);
        if (streams.length === 0) {
          return { ok: false, message: '当前无该标的做T流水，无法结算' };
        }
        const baseCosts = buildBasePositionCosts(positions);
        const result = processAllStreams(streams, feeConfig, baseCosts).find(
          (r) => r.fullCode === fullCode
        );
        if (!result) {
          return { ok: false, message: '结算失败：未能计算当前做T结果' };
        }
        if (result.mode !== 'short') {
          return { ok: false, message: '当前操作仅支持倒T结算' };
        }

        const now = new Date().toISOString();
        const existing = tRounds.filter((r) => r.fullCode === fullCode);
        const maxRound = existing.reduce((m, r) => Math.max(m, r.roundNo), 0);
        const transactions: RoundTxn[] = result.entries.map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          direction: e.direction,
          price: e.price,
          amount: e.amount,
          fee: e.fee,
          matchedAmount: e.matchedAmount,
          realizedProfit: e.realizedProfit,
          note: e.note,
        }));

        if (result.netPendingAmount > 0) {
          const transferRes = get().transferToPosition(fullCode);
          if (!transferRes.ok) {
            return transferRes;
          }
          return { ok: true, message: transferRes.message };
        }

        const round: TRoundArchive = {
          id: generateId(),
          fullCode: result.fullCode,
          stockName: result.stockName,
          mode: result.mode,
          roundNo: maxRound + 1,
          settleType: 'clear',
          transactions,
          netProfit: result.transferProfit,
          fees: result.totalFee,
          sellAmount: result.realizedSellAmount,
          avgPrice: result.avgPrice,
          buyAmount: result.buyAmount,
          tradeCount: result.tradeCount,
          holdingDays: result.holdingDays,
          win: result.transferProfit >= 0,
          openedAt: result.openedAt ?? now,
          closedAt: now,
        };
        const streamsAfter = tStreams.filter((s) => s.fullCode !== fullCode);
        const newRounds = [...tRounds, round];
        const updatedPositions = positions.map((p) =>
          p.fullCode === fullCode && !p.isClosed && p.currentAmount === 0
            ? { ...p, isClosed: true, closedAt: now }
            : p
        );
        set({ tStreams: streamsAfter, tRounds: newRounds, positions: updatedPositions });
        // 增量持久化：清理流水、写入新 Round
        safePersist(async () => {
          const clearedIds = tStreams.filter((s) => s.fullCode === fullCode).map((s) => s.id);
          if (clearedIds.length > 0) {
            await bulkDeleteTStreams(clearedIds);
          }
          await putTRound(round as unknown as TRoundRow);
        });
        return {
          ok: true,
          message: `已结算倒T Round ${round.roundNo}，累计净收益 ¥${result.transferProfit.toFixed(2)}`,
        };
      },
      addPosition: (pos: Position) => {
        set((state) => ({
          positions: [...state.positions, pos],
        }));
        safePersist(async () => {
          await putPosition(pos as unknown as PositionRow);
          for (const batch of pos.batches) {
            await putPositionBatch(batch, pos.id);
          }
        });
      },

      updatePosition: (id: string, pos: Partial<Position>) => {
        set((state) => ({
          positions: state.positions.map((p) =>
            p.id === id ? { ...p, ...pos } : p
          ),
        }));
        const updated = get().positions.find((p) => p.id === id);
        if (updated) {
          safePersist(() => putPosition(updated as unknown as PositionRow));
        }
      },

      addBatch: (positionId: string, batch: PositionBatch) => {
        set((state) => ({
          positions: state.positions.map((p) =>
            p.id === positionId
              ? { ...p, batches: [...p.batches, batch] }
              : p
          ),
        }));
        const updated = get().positions.find((p) => p.id === positionId);
        if (updated) {
          safePersist(async () => {
            await putPosition(updated as unknown as PositionRow);
            await putPositionBatch(batch, positionId);
          });
        }
      },

      closePosition: (id: string) => {
        set((state) => ({
          positions: state.positions.map((p) =>
            p.id === id
              ? { ...p, isClosed: true, closedAt: new Date().toISOString() }
              : p
          ),
        }));
        const closed = get().positions.find((p) => p.id === id);
        if (closed) {
          safePersist(() => putPosition(closed as unknown as PositionRow));
        }
      },

      deletePositionBatch: (positionId: string, batchId: string) => {
        set((state) => {
          const positions = state.positions.map((p) => {
            if (p.id !== positionId) return p;

            // 按时间排序
            const sorted = [...p.batches].sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );

            // 保护第一条建仓记录：若有多条记录，禁止删除第一条
            if (sorted.length > 1 && sorted[0].id === batchId) {
              return p;
            }

            const remainingBatches = p.batches.filter((b) => b.id !== batchId);

            if (remainingBatches.length === 0) {
              return {
                ...p,
                batches: [],
                currentCost: 0,
                currentAmount: 0,
                isClosed: false,
                closedAt: undefined,
                realizedPnL: 0,
                totalInvested: 0,
              };
            }

            // Replay all remaining batches in chronological order
            const remainingSorted = [...remainingBatches].sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );

            let totalInvested = 0;
            let amount = 0;
            let realizedPnL = 0;

            for (const batch of remainingSorted) {
              const qty = Math.abs(batch.amount);
              const batchFee = batch.fee || 0;
              if (batch.amount > 0) {
                // 买入：投入资金
                const cost = batch.price * qty + batchFee;
                totalInvested += cost;
                amount += qty;
              } else {
                // 卖出：抽回资金
                if (amount > 0) {
                  const costBasisPerShare = totalInvested / amount;
                  const costBasisOfSold = costBasisPerShare * qty;
                  const netProceeds = batch.price * qty - batchFee;
                  realizedPnL += netProceeds - costBasisOfSold;
                  totalInvested -= costBasisOfSold;
                }
                amount -= qty;
                if (amount <= 0) {
                  totalInvested = 0;
                  amount = 0;
                }
              }
            }

            const cost = amount > 0 ? totalInvested / amount : 0;

            return {
              ...p,
              batches: remainingBatches,
              currentCost: cost,
              currentAmount: amount,
              isClosed: amount === 0 ? true : p.isClosed,
              closedAt: amount === 0 ? new Date().toISOString() : p.closedAt,
              realizedPnL,
              totalInvested,
            };
          });
          return { positions };
        });
      },

      removePosition: (id: string) => {
        set((state) => ({
          positions: state.positions.filter((p) => p.id !== id),
        }));
        safePersist(() => deletePositionWithBatches(id));
      },

      exportData: () => {
        const state = get();
        return {
          feeConfig: state.feeConfig,
          tRecords: state.tRecords,
          tStreams: state.tStreams,
          tRounds: state.tRounds,
          positions: state.positions,
          stocks: state.stocks,
          longTermRecords: state.longTermRecords,
        };
      },

      importData: (data: AppStoreExport) => {
        set({
          feeConfig: data.feeConfig,
          tRecords: data.tRecords ?? [],
          tStreams: data.tStreams ?? [],
          tRounds: data.tRounds ?? [],
          positions: data.positions ?? [],
          stocks: data.stocks ?? [],
          longTermRecords: data.longTermRecords ?? [],
        });
        // 安全的全量增量导入：绝不调用 table.clear()
        safePersist(() =>
          safeImportAllData(
            data.feeConfig as FeeConfigRow,
            (data.positions ?? []) as unknown as PositionRow[],
            (data.tRounds ?? []) as unknown as TRoundRow[],
            (data.tStreams ?? []) as unknown as TStreamRow[],
            (data.stocks ?? []) as unknown as StockRow[],
            (data.longTermRecords ?? []) as unknown as LongTermRecordRow[],
          )
        );
      },

      exportJSON: () => {
        return get().exportData();
      },

      importJSON: (data: AppStoreExport) => {
        get().importData(data);
      },

      exportCSV: () => {
        const records = get().tRecords;
        const headers = ['日期', '股票名称', '模式', '买入价', '买入数量', '卖出价', '卖出数量', '摩擦成本', '净利润', '收益率', '状态'];
        const rows = records.map((r) => [
          new Date(r.timestamp).toLocaleDateString(),
          r.stockName,
          r.mode === 'long' ? '正T' : '倒T',
          String(r.buyPrice),
          String(r.buyAmount),
          String(r.sellPrice),
          String(r.sellAmount),
          String(r.totalFee),
          r.netProfit !== null ? String(r.netProfit) : '--',
          r.profitRate !== null ? String(r.profitRate) : '--',
          r.status === 'CLOSED' ? '已平仓' : '未平仓',
        ]);
        return [headers.join(','), ...rows.map((row) => row.map((cell) => `"${cell}"`).join(','))].join('\n');
      },
    }));
