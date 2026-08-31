/**
 * @file ioSlice.ts
 * @description Store 导入导出切片：内存导出（exportData）/ 全量导入（importData，含
 *              风控完整性校验与远端同步防回环标记）/ JSON 导出（合并 DB 归档数据）/
 *              JSON 导入 / CSV 导出。从 store/index.ts 拆出，index 只负责组装。
 * @layer Store (Slice)
 * @storage_impact importData 经 safePersist 全量落库；exportJSON 只读 DB 归档数据。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import { safePersist, setIsSyncingFromRemote } from '../persistence';
import { recordAudit } from '../../risk/auditLogger';
import { importDataIntegrityRule } from '../../risk/validator';
import { safeImportAllData } from '../../db/index';
import { runRiskValidation } from '../reconcile';
import { EXPORT_VERSION } from '../types';
import type { AppStore } from '../types';
import type { TRoundArchive } from '../types';

export type IoSlice = Pick<
  AppStore,
  'exportData' | 'importData' | 'exportJSON' | 'importJSON' | 'exportCSV'
>;

export const createIoSlice: StateCreator<AppStore, [], [], IoSlice> = (set, get) => ({

  exportData: () => { const state = get(); return { version: EXPORT_VERSION, feeConfig: state.feeConfig, tRounds: state.tRounds, positions: state.positions, stocks: state.stocks, longTermRecords: state.longTermRecords, plannedOrders: state.plannedOrders }; },

  importData: (data, silent) => {
    // 【风控 R3】导入数据完整性校验
    const riskReport = runRiskValidation([importDataIntegrityRule(data)], data, undefined);
    if (riskReport.blocked) {
      console.warn('[Risk] 导入数据校验未通过:', riskReport.summary);
      return;
    }
    const rounds = data.tRounds ?? [];
    set({ feeConfig: data.feeConfig, tRounds: rounds, positions: data.positions ?? [], stocks: data.stocks ?? [], longTermRecords: data.longTermRecords ?? [], plannedOrders: data.plannedOrders ?? [] });
    safePersist(() => safeImportAllData(data.feeConfig, data.positions ?? [], rounds, data.stocks ?? [], data.longTermRecords ?? [], data.plannedOrders ?? []));
    // silent 模式：来自远端拉取合并（Pull & Merge），跳过后续自动上传/同步逻辑
    // 设置 isSyncingFromRemote 标记，自动同步监听器必须检查此标记后跳过触发
    if (silent) {
      setIsSyncingFromRemote(true);
      // 下轮微任务中自动复位，确保不影响后续用户手动触发同步
      // 使用 setTimeout(0) 而非 Promise.resolve().then()，因为 Zustand set 同步执行，
      // 自动同步监听器若使用 store.subscribe 会同步/微任务内触发，需要在此之后才复位
      setTimeout(() => { setIsSyncingFromRemote(false); }, 0);
    }
    // 【风控审计】记录导入操作
    recordAudit('import_data', 'system', 'all', 'success', {
      tags: { silent: String(silent), version: String(data.version) },
    });
  },

  exportJSON: async () => {
    const state = get();
    const [closedPositions, completedRounds, ltRecs] = await Promise.all([
      import('../../db/index').then(m => m.fetchAllClosedPositions()),
      import('../../db/index').then(m => m.fetchAllCompletedRounds()),
      import('../../db/index').then(m => m.fetchAllLongTermRecords()),
    ]);
    // 合并 state.tRounds（OPENED 含流水 + COMPLETED 概览）与 DB 完整明细，
    // 按 id 去重并保留含 transactions 的完整版本（导入后流水不丢失）
    const roundMap = new Map<string, TRoundArchive>();
    for (const r of [...state.tRounds, ...completedRounds]) {
      const existing = roundMap.get(r.id);
      if (!existing || (r.transactions?.length ?? 0) > (existing.transactions?.length ?? 0)) {
        roundMap.set(r.id, r);
      }
    }
    return { version: EXPORT_VERSION, feeConfig: state.feeConfig, tRounds: Array.from(roundMap.values()), positions: [...state.positions, ...closedPositions], stocks: state.stocks, longTermRecords: [...state.longTermRecords, ...ltRecs], plannedOrders: state.plannedOrders };
  },

  importJSON: (data) => {
    if (data.version !== EXPORT_VERSION) console.warn(`[Store] 导入数据版本 (${data.version}) 与当前版本 (${EXPORT_VERSION}) 不一致，尝试继续导入，但部分字段可能不兼容。`);
    get().importData(data);
  },

  exportCSV: () => {
    // v8：Round 是唯一数据源，CSV 从 tRounds 导出（OPENED + COMPLETED）
    const rounds = get().tRounds;
    const headers = ['日期', '股票名称', '模式', '状态', '净收益', '买入量', '卖出量', '手续费', '成交笔数'];
    const rows = rounds.map(r => [new Date(r.closedAt ?? r.openedAt).toLocaleDateString(), r.stockName, r.mode === 'long' ? '正T' : '倒T', r.status === 'COMPLETED' ? '已结清' : '进行中', (r.netProfit ?? 0).toFixed(2), String(r.buyAmount ?? ''), String(r.sellAmount ?? ''), String(r.totalFees ?? 0), String(r.tradeCount ?? r.transactions?.length ?? 0)]);
    return [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n');
  },
});
