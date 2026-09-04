/**
 * @file snapshotService.ts
 * @description 全量数据快照序列化/反序列化服务：WebDAV 与服务端密文同步两条备份通道
 *              共用的快照格式（v1 冻结）。自 webdavSync 提取，逻辑逐字保留——
 *              序列化输出不含 plannedOrders（反序列化侧补默认空数组），
 *              反序列化兼容 {data:...} 包裹层，保证两条通道快照格式逐字节一致。
 * @layer Service
 * @storage_impact 无直接持久化读写；序列化产物由 webdavSync / serverSync 上传云端。
 * @author 开发团队
 */

import type { AppStoreExport } from '../store/types';

/**
 * 导出完整数据快照（调用 Store 的 exportData 获取数据）。
 */
export function serializeSnapshot(data: AppStoreExport): string {
  const snapshot = {
    version: data.version,
    exportedAt: new Date().toISOString(),
    timestamp: Date.now(),
    feeConfig: data.feeConfig,
    tRounds: data.tRounds,
    positions: data.positions,
    stocks: data.stocks,
    longTermRecords: data.longTermRecords,
  };
  return JSON.stringify(snapshot, null, 2);
}

/**
 * 反序列化云端快照 JSON。
 */
export function deserializeSnapshot(json: string): { data: AppStoreExport; timestamp: number } | null {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const snapshot = parsed.version !== undefined ? parsed : (parsed.data ?? parsed);
    if (!snapshot.version || !Array.isArray(snapshot.tRounds)) return null;

    const data: AppStoreExport = {
      version: snapshot.version,
      feeConfig: snapshot.feeConfig ?? {},
      tRounds: snapshot.tRounds ?? [],
      positions: snapshot.positions ?? [],
      stocks: snapshot.stocks ?? [],
      longTermRecords: snapshot.longTermRecords ?? [],
      plannedOrders: snapshot.plannedOrders ?? [],
    };

    const timestamp = parsed.timestamp ?? snapshot.timestamp ?? Date.now();
    return { data, timestamp };
  } catch {
    return null;
  }
}
