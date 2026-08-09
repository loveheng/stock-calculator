// ============================================================
// Store Initialization – Load from IndexedDB, then subscribe
// to state changes for automatic persistence back to Dexie.
// ============================================================

import { migrateFromLocalStorage } from './migration';
import {
  ensureDefaultData,
  loadAllFromDB,
  saveAllToDB,
  type FeeConfigRow,
  type PositionRow,
  type TRoundRow,
  type TStreamRow,
  type StockRow,
} from './index';
import { useAppStore, DEFAULT_FEE_CONFIG, type AppStore } from '../store';

let initialLoadDone = false;

export async function initStore(): Promise<void> {
  await migrateFromLocalStorage();
  await ensureDefaultData();

  const { feeConfig, positions, tRounds, tStreams, stocks } = await loadAllFromDB();

  if (feeConfig || positions.length > 0 || tRounds.length > 0 || tStreams.length > 0 || stocks.length > 0) {
    useAppStore.setState((current) => ({
      ...current,
      feeConfig: (feeConfig as FeeConfigRow) ?? { ...DEFAULT_FEE_CONFIG },
      positions: (positions as unknown as AppStore['positions']) ?? [],
      tRounds: (tRounds as unknown as AppStore['tRounds']) ?? [],
      tStreams: (tStreams as unknown as AppStore['tStreams']) ?? [],
      stocks: (stocks as unknown as AppStore['stocks']) ?? [],
    }));
  }

  initialLoadDone = true;
}

export function startStorePersistence(): () => void {
  return useAppStore.subscribe((state) => {
    if (!initialLoadDone) return;

    saveAllToDB(
      (state.feeConfig as FeeConfigRow),
      (state.positions as unknown as PositionRow[]),
      (state.tRounds as unknown as TRoundRow[]),
      (state.tStreams as unknown as TStreamRow[]),
      (state.stocks as unknown as StockRow[]),
    ).catch((err) => {
      console.error('[StorePersistence] Failed to save to IndexedDB:', err);
    });
  });
}
