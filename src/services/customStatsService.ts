/**
 * @file customStatsService.ts
 * @description 自定义统计 Service：全量执行上下文组装（沙箱数据源）+ custom_stats 表读写门面。
 *              关键约束：
 *              - 全量数据只在端上组装并注入沙箱，不出设备、不进 LLM prompt（LLM 仅见
 *                buildPromptContext 产出的字段字典 + 每集合 ≤3 行样例）；
 *              - 活跃轮撮合结果与统计页同口径：buildBasePositionCosts → activeStreamsFromRounds
 *                → processAllStreams（tStreamEngine 管线重算）；
 *              - 编排（夹具预跑 → 全量执行 → Guard 归一 → 写回）在 store 切片，本文件只做数据读写；
 *              - 定义不可变：不提供 updateCode，修改走「重新生成」（replaceCustomStatDef 承接
 *                替换语义：存新行 + 软删旧行 + 钉选状态迁移）。
 * @layer Service
 * @storage_impact 动态 import db 层：读 tRounds/tTransactions/positions（只读），读写 customStats 表。
 * @author 开发团队
 */

import type {
  CustomStatDefinition,
  CustomStatFeeConfig,
  CustomStatStream,
  CustomStatTxn,
  CustomStatsContextWire,
  CustomStatsResult,
  Position,
  TRoundArchive,
} from '../types/domain';
import { CUSTOM_STAT_SCHEMA_VERSION } from '../types/domain';
import type { FeeConfig } from '../utils/mathUtils';
import {
  activeStreamsFromRounds,
  buildBasePositionCosts,
  processAllStreams,
  type StockStreamResult,
} from '../utils/tStreamEngine';
import { buildFieldDictionaryPayload, type CustomStatFieldDoc } from '../utils/customStats/dictionary';

/** StockStreamResult → ctx.activeStreams 序列化安全子集（剔除 entries 等非标量数组） */
function toCustomStatStream(s: StockStreamResult): CustomStatStream {
  return {
    fullCode: s.fullCode,
    stockName: s.stockName,
    status: s.status,
    netPendingAmount: s.netPendingAmount,
    weightedBuyCost: s.weightedBuyCost,
    realizedPnL: s.realizedPnL,
  };
}

/** FeeConfig → ctx.feeConfig 结构子集（domain 零依赖，不引用 utils 完整形态） */
function toStatFeeConfig(f: FeeConfig): CustomStatFeeConfig {
  return {
    commissionRate: f.commissionRate,
    isFreeFive: f.isFreeFive,
    minCommission: f.minCommission,
    transferRate: f.transferRate,
    stampRate: f.stampRate,
  };
}

/** 全量数据源一次取齐（轮次含 OPENED 流水，流水升序，持仓含已平仓） */
async function loadCoreData(): Promise<{
  allRounds: TRoundArchive[];
  txns: CustomStatTxn[];
  positions: Position[];
}> {
  const dbm = await import('../db/index');
  const [allRounds, txns, open, closed] = await Promise.all([
    dbm.loadTRoundsFromDB(),
    dbm.loadAllTxnsAscFromDB(),
    dbm.loadPositionsFromDB(),
    dbm.fetchAllClosedPositions(),
  ]);
  return { allRounds, txns, positions: [...open, ...closed] };
}

/**
 * 组装沙箱执行上下文（全量数据，一次性）。
 *
 * @description 批量刷新复用约定：一次 buildFullContext → ctx 消息注入 Worker →
 *              同批次 N 条定义复用（1× parse + N× 毫秒级执行）。
 */
export async function buildFullContext(feeConfig: FeeConfig): Promise<CustomStatsContextWire> {
  const { allRounds, txns, positions } = await loadCoreData();
  const baseCosts = buildBasePositionCosts(positions);
  const streams = processAllStreams(activeStreamsFromRounds(allRounds), feeConfig, baseCosts);
  return {
    schemaVersion: CUSTOM_STAT_SCHEMA_VERSION,
    now: new Date().toISOString(),
    rounds: allRounds.filter((r) => r.status === 'COMPLETED'),
    openRounds: allRounds.filter((r) => r.status === 'OPENED'),
    txns,
    positions,
    activeStreams: streams.map(toCustomStatStream),
    feeConfig: toStatFeeConfig(feeConfig),
  };
}

/** LLM 提示词上下文：字段字典 + 每集合 ≤3 行真实形状样例（仅进 prompt，不落库不打日志） */
export interface CustomStatPromptContext {
  sampleRows: {
    rounds: TRoundArchive[];
    openRounds: TRoundArchive[];
    txns: CustomStatTxn[];
    positions: Position[];
    activeStreams: CustomStatStream[];
  };
  fieldDictionary: Record<string, CustomStatFieldDoc[]>;
}

/** 组装 LLM 提示词上下文（首次生成与草稿迭代共用）；费率由调用方传入（service 不 import store） */
export async function buildPromptContext(feeConfig: FeeConfig): Promise<CustomStatPromptContext> {
  const { allRounds, txns, positions } = await loadCoreData();
  const baseCosts = buildBasePositionCosts(positions);
  const streams = processAllStreams(activeStreamsFromRounds(allRounds), feeConfig, baseCosts);
  return {
    sampleRows: {
      rounds: allRounds.filter((r) => r.status === 'COMPLETED').slice(0, 3),
      openRounds: allRounds.filter((r) => r.status === 'OPENED').slice(0, 3),
      txns: txns.slice(0, 3),
      positions: positions.slice(0, 3),
      activeStreams: streams.map(toCustomStatStream).slice(0, 3),
    },
    fieldDictionary: buildFieldDictionaryPayload(),
  };
}

// ---- custom_stats 表 CRUD 门面（不可变性由接口面保证：无 updateCode） ----

/** 加载全部未删除定义（含 lastResult 缓存；画廊一次轻量读入，UI 切片分页） */
export async function listCustomStatDefs(): Promise<CustomStatDefinition[]> {
  const dbm = await import('../db/index');
  return dbm.loadCustomStatsFromDB();
}

/** 保存新定义（保存动作的唯一写入入口） */
export async function saveCustomStatDef(def: CustomStatDefinition): Promise<void> {
  const dbm = await import('../db/index');
  await dbm.putCustomStatDef(def);
}

/** 写入（新增或整体覆盖）定义——同步合并专用，保留调用方传入的 updatedAt（LWW 排序键） */
export async function putCustomStatDef(def: CustomStatDefinition): Promise<void> {
  const dbm = await import('../db/index');
  await dbm.putCustomStatDef(def);
}

/**
 * 替换定义（重新生成后的「替换原定义」）：同事务内存新行 + 软删旧行 + 钉选状态迁移。
 *
 * @description 钉选按定义迁移（pinned/pinnedAt 原样带过，区由 kind 推导，kind 变更即落另一区），
 *              保证用户钉住的面板位置不因替换丢失。
 */
export async function replaceCustomStatDef(oldId: string, next: CustomStatDefinition): Promise<void> {
  const dbm = await import('../db/index');
  await dbm.db.transaction('rw', dbm.db.customStats, async () => {
    const old = await dbm.db.customStats.get(oldId);
    next.pinned = old?.pinned === true;
    next.pinnedAt = old?.pinnedAt;
    await dbm.putCustomStatDef(next);
    await dbm.deleteCustomStat(oldId);
  });
}

/** 钉选/取消钉选（画廊双区操作） */
export async function setCustomStatPinned(id: string, pinned: boolean): Promise<void> {
  const dbm = await import('../db/index');
  await dbm.setCustomStatPinnedInDB(id, pinned);
}

/** 收藏/取消收藏 */
export async function setCustomStatFavorite(id: string, favorite: boolean): Promise<void> {
  const dbm = await import('../db/index');
  await dbm.setCustomStatFavoriteInDB(id, favorite);
}

/** 软删除定义 */
export async function deleteCustomStatById(id: string): Promise<void> {
  const dbm = await import('../db/index');
  await dbm.deleteCustomStat(id);
}

/** 加载全部定义含软删墓碑（服务器同步合并专用） */
export async function listCustomStatDefsIncludingDeleted(): Promise<CustomStatDefinition[]> {
  const dbm = await import('../db/index');
  return dbm.loadCustomStatsIncludingDeletedFromDB();
}

/** 物理删除行（同步链路：墓碑在服务端确认删除后清理） */
export async function hardDeleteCustomStatById(id: string): Promise<void> {
  const dbm = await import('../db/index');
  await dbm.hardDeleteCustomStat(id);
}

/** 单条运行结果写回（stale-while-revalidate：每条完成即写，渐进替换对应卡片） */
export async function recordCustomStatRun(
  id: string,
  result: CustomStatsResult,
  nextRunCount: number,
): Promise<void> {
  const dbm = await import('../db/index');
  await dbm.updateCustomStatRunState(id, {
    lastResult: result,
    lastRunAt: new Date().toISOString(),
    runCount: nextRunCount,
  });
}

// ---- 门面 ----

export const customStatsService = {
  buildFullContext,
  buildPromptContext,
  listCustomStatDefs,
  saveCustomStatDef,
  putCustomStatDef,
  replaceCustomStatDef,
  setCustomStatPinned,
  setCustomStatFavorite,
  deleteCustomStatById,
  listCustomStatDefsIncludingDeleted,
  hardDeleteCustomStatById,
  recordCustomStatRun,
};
