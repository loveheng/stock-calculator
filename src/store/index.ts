// ============================================================
// 全局持久化状态 (Zustand + localStorage)
// ============================================================
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { type FeeConfig } from '../utils/mathUtils';

// ---- 做T记录 ----
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

// ---- 全局 Store 类型 ----
export interface AppStore {
  // 费率配置
  feeConfig: FeeConfig;
  setFeeConfig: (config: Partial<FeeConfig>) => void;
  resetFeeConfig: (config: FeeConfig) => void;

  // 做T记录
  tRecords: TRecord[];
  addTRecord: (record: TRecord) => void;
  updateTRecord: (id: string, updates: Partial<TRecord>) => void;
  removeTRecord: (id: string) => void;
  clearTRecords: () => void;

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
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ---- 创建 Store ----
export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      feeConfig: { ...DEFAULT_FEE_CONFIG },
      tRecords: [],
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
          positions: state.positions,
        };
      },

      importData: (data: AppStoreExport) => {
        set({
          feeConfig: data.feeConfig,
          tRecords: data.tRecords,
          positions: data.positions,
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
      version: 1,
    }
  )
);