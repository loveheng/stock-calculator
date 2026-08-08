// ============================================================
// 全局持久化状态 (Zustand + localStorage)
//  - v3: 做T流水池 tStreams（FIFO 撮合）
//  - v4: Round 生命周期归档库 tRounds + 绝对现金流划转
// ============================================================
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useMemo } from 'react';
import {
  processAllStreams,
  processStockStream,
  type TStreamRecord,
  type StockStreamResult,
} from '../utils/tStreamEngine';
import { calcTradeFees, type FeeConfig } from '../utils/mathUtils';
import type { StockSearchItem } from '../types/stock';

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
  addStreamRecord: (record: TStreamRecord) => StreamAddResult;
  updateStreamRecord: (id: string, updates: Partial<TStreamRecord>) => void;
  removeStreamRecord: (id: string) => void;
  clearStreams: () => void;
  /** 将历史成对 TRecord 一次性导入为流水池流水（buy/sell 拆分） */
  importLegacyTRecords: () => number;

  // Round 生命周期归档库（历史战报）
  tRounds: TRoundArchive[];
  addRound: (round: TRoundArchive) => void;
  removeRound: (id: string) => void;
  clearRounds: () => void;
  /** 一键划转底仓（绝对现金流法：剩余持仓按 P_avg 平价划入；做T归零自动归档战报） */
  transferToPosition: (
    fullCode: string,
    transferAmount?: number,
    transferPrice?: number
  ) => MergeStreamResult;

  // 持仓账本
  positions: Position[];
  addPosition: (pos: Position) => void;
  updatePosition: (id: string, pos: Partial<Position>) => void;
  addBatch: (positionId: string, batch: PositionBatch) => void;
  closePosition: (id: string) => void;
  deletePositionBatch: (positionId: string, batchId: string) => void;
  removePosition: (id: string) => void;

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

// ---- 生成唯一 ID ----
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
export function useStreamResults(): StockStreamResult[] {
  const tStreams = useAppStore((s) => s.tStreams);
  const feeConfig = useAppStore((s) => s.feeConfig);
  return useMemo(
    () => processAllStreams(tStreams, feeConfig),
    [tStreams, feeConfig]
  );
}

// ---- 绝对现金流归档净收益（划转/自动归档共用） ----
// = Σ((卖出单价 - P_avg)×卖出数量) - 系统计算总规费(已实现部分)
// 引擎已按此口径计算 transferProfit，此处直接复用
function calcTransferArchiveProfit(stream: StockStreamResult): number {
  return stream.transferProfit;
}

// ---- 内部：Round 自动归档（池归零且发生过卖出 -> 生成战报并重置池） ----
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
export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      feeConfig: { ...DEFAULT_FEE_CONFIG },
      tRecords: [],
      tStreams: [],
      tRounds: [],
      positions: [],

      setFeeConfig: (config: Partial<FeeConfig>) => {
        set((state) => ({
          feeConfig: { ...state.feeConfig, ...config },
        }));
      },

      resetFeeConfig: (config: FeeConfig) => {
        set({ feeConfig: config });
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

      // ---- 做T流水池（增删改后自动检查 Round 归档） ----
      addStreamRecord: (record: TStreamRecord) => {
        const { tStreams, feeConfig, tRounds } = get();
        const next = [...tStreams, record];
        // 级联重算，若该股票池归零则自动归档 Round
        const results = processAllStreams(next, feeConfig);
        const stream = results.find((r) => r.fullCode === record.fullCode);
        const rounds = stream ? archiveRoundIfCleared(stream, tRounds) : tRounds;
        // 本轮做T持仓归零 -> 自动结清归档（触发绿色 Toast）
        const cleared =
          !!stream &&
          stream.status === 'CLEARED' &&
          stream.entries.some((e) => e.direction === 'sell');
        const streamsAfter = cleared
          ? next.filter((s) => s.fullCode !== record.fullCode)
          : next;
        // 构造归零结清返回结果（供 UI Toast：「本轮做T已完全结清！累计净盈亏：¥XXX.XX」）
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
        set({ tStreams: streamsAfter, tRounds: rounds });
        return addResult;
      },

      removeStreamRecord: (id: string) => {
        const { tStreams, feeConfig, tRounds } = get();
        const target = tStreams.find((r) => r.id === id);
        const next = tStreams.filter((r) => r.id !== id);
        let rounds = tRounds;
        let streams = next;
        if (target) {
          const results = processAllStreams(next, feeConfig);
          const stream = results.find((r) => r.fullCode === target.fullCode);
          if (stream) {
            rounds = archiveRoundIfCleared(stream, tRounds);
            const hasSell = stream.entries.some((e) => e.direction === 'sell');
            if (stream.status === 'CLEARED' && hasSell) {
              streams = next.filter((s) => s.fullCode !== target.fullCode);
            }
          }
        }
        set({ tStreams: streams, tRounds: rounds });
      },

      updateStreamRecord: (id: string, updates: Partial<TStreamRecord>) => {
        const { tStreams, feeConfig, tRounds } = get();
        const target = tStreams.find((r) => r.id === id);
        const next = tStreams.map((r) => (r.id === id ? { ...r, ...updates } : r));
        let rounds = tRounds;
        let streams = next;
        if (target) {
          const results = processAllStreams(next, feeConfig);
          const stream = results.find((r) => r.fullCode === target.fullCode);
          if (stream) {
            rounds = archiveRoundIfCleared(stream, tRounds);
            const hasSell = stream.entries.some((e) => e.direction === 'sell');
            if (stream.status === 'CLEARED' && hasSell) {
              streams = next.filter((s) => s.fullCode !== target.fullCode);
            }
          }
        }
        set({ tStreams: streams, tRounds: rounds });
      },

      clearStreams: () => {
        set({ tStreams: [] });
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
        return converted.length;
      },

      // ---- Round 归档库 ----
      addRound: (round: TRoundArchive) => {
        set((state) => ({ tRounds: [...state.tRounds, round] }));
      },

      removeRound: (id: string) => {
        set((state) => ({
          tRounds: state.tRounds.filter((r) => r.id !== id),
        }));
      },

      clearRounds: () => {
        set({ tRounds: [] });
      },

      // ---- 一键划转底仓（绝对现金流法） ----
      transferToPosition: (fullCode: string, transferAmount?: number, transferPrice?: number) => {
        const { tStreams, tRounds, positions, feeConfig } = get();
        const streams = tStreams.filter((s) => s.fullCode === fullCode);
        if (streams.length === 0) {
          return { ok: false, message: '该股票没有做T流水，无法划转' };
        }
        const result = processAllStreams(streams, feeConfig).find(
          (r) => r.fullCode === fullCode
        );
        const stream = result ?? processStockStream(streams, feeConfig);
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
          roundNo: maxRound + 1,
          settleType: 'transfer',
          transactions,
          netProfit: transferProfit,
          fees: stream.realizedFee,
          sellAmount: stream.realizedSellAmount,
          avgPrice: stream.avgPrice,
          buyAmount: stream.buyAmount,
          tradeCount: stream.tradeCount,
          holdingDays: stream.holdingDays,
          win: transferProfit >= 0,
          openedAt: stream.openedAt ?? now,
          closedAt: now,
        };
        const newRounds = [...tRounds, round];

        // 4) 清空该股票做T流水（Round 结束，下次买入自动开启 Round + 1）
        const streamsAfter = tStreams.filter((s) => s.fullCode !== fullCode);

        set({ tStreams: streamsAfter, tRounds: newRounds, positions: newPositions });

        return {
          ok: true,
          message: `已划转 ${toTransfer} 股@${avg.toFixed(3)} 元至底仓，做T归零归档 Round ${round.roundNo}，累计净收益 ¥${transferProfit.toFixed(2)}`,
        };
      },
      addPosition: (pos: Position) => {
        set((state) => ({
          positions: [...state.positions, pos],
        }));
      },

      updatePosition: (id: string, pos: Partial<Position>) => {
        set((state) => ({
          positions: state.positions.map((p) =>
            p.id === id ? { ...p, ...pos } : p
          ),
        }));
      },

      addBatch: (positionId: string, batch: PositionBatch) => {
        set((state) => ({
          positions: state.positions.map((p) =>
            p.id === positionId
              ? { ...p, batches: [...p.batches, batch] }
              : p
          ),
        }));
      },

      closePosition: (id: string) => {
        set((state) => ({
          positions: state.positions.map((p) =>
            p.id === id
              ? { ...p, isClosed: true, closedAt: new Date().toISOString() }
              : p
          ),
        }));
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
      },

      exportData: () => {
        const state = get();
        return {
          feeConfig: state.feeConfig,
          tRecords: state.tRecords,
          tStreams: state.tStreams,
          tRounds: state.tRounds,
          positions: state.positions,
        };
      },

      importData: (data: AppStoreExport) => {
        set({
          feeConfig: data.feeConfig,
          tRecords: data.tRecords ?? [],
          tStreams: data.tStreams ?? [],
          tRounds: data.tRounds ?? [],
          positions: data.positions ?? [],
        });
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
    }),
    {
      name: 'stock-calculator-store',
      version: 5,
      // 迁移：
      //  v1 -> v2 : 为旧 TRecord / Position 补全 fullCode 主键
      //  v2 -> v3 : 新增做T流水池 tStreams
      //  v3 -> v4 : 新增 Round 生命周期归档库 tRounds
      //  v4 -> v5 : 归档战报补全结算方式 settleType 与成交明细快照 transactions
      migrate: (persistedState: unknown, version: number) => {
        let state = persistedState as Partial<AppStoreExport>;

        if (version < 2) {
          state = {
            ...state,
            tRecords: (state.tRecords ?? []).map((r) => ({
              ...r,
              fullCode:
                r.fullCode ??
                r.selectedStock?.fullCode ??
                r.quoteId ??
                '',
            })),
            positions: (state.positions ?? []).map((p) => ({
              ...p,
              fullCode: p.fullCode ?? '',
            })),
          };
        }

        if (version < 3) {
          state = {
            ...state,
            tStreams: state.tStreams ?? [],
          };
        }

        if (version < 4) {
          state = {
            ...state,
            tRounds: state.tRounds ?? [],
          };
        }

        if (version < 5) {
          // 旧归档无结算方式与成交明细：默认 'clear' + 按流水时间序补全快照
          state = {
            ...state,
            tRounds: (state.tRounds ?? []).map((r) => {
              if (r.settleType && r.transactions) return r;
              const txns: RoundTxn[] = [
                ...(r.buyAmount > 0
                  ? [{
                      id: `${r.id}-buy`,
                      timestamp: r.openedAt,
                      direction: 'buy' as const,
                      price: r.buyAmount > 0 ? r.avgPrice : 0,
                      amount: r.buyAmount,
                      fee: 0,
                      matchedAmount: 0,
                      realizedProfit: 0,
                    }]
                  : []),
                ...(r.sellAmount > 0
                  ? [{
                      id: `${r.id}-sell`,
                      timestamp: r.closedAt,
                      direction: 'sell' as const,
                      price: r.avgPrice,
                      amount: r.sellAmount,
                      fee: 0,
                      matchedAmount: r.sellAmount,
                      realizedProfit: 0,
                    }]
                  : []),
              ];
              return {
                ...r,
                settleType: (r as Partial<TRoundArchive>).settleType ?? 'clear',
                transactions: (r as Partial<TRoundArchive>).transactions ?? txns,
              };
            }),
          };
        }

        return {
          feeConfig: state.feeConfig ?? DEFAULT_FEE_CONFIG,
          tRecords: state.tRecords ?? [],
          tStreams: state.tStreams ?? [],
          tRounds: state.tRounds ?? [],
          positions: state.positions ?? [],
        };
      },
    }
  )
);