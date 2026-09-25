/**
 * @file canvasService.ts
 * @description 自由画布服务门面：画布读查/整块保存/Blob 存取 + 行情保鲜刷新。
 *              惰性封装范本（对齐 ledgerService）：动态 import('../db/index')，不静态依赖 Dexie 实例。
 *              画布为纯前端域（spec §九）：读写只走 Dexie，不触 apiClient/serverSync/copilot 管道。
 * @layer Service
 * @storage_impact 读写 canvasBoards / canvasBlobs 两表（db/schema v15）；K 线刷新经 brokerService 代理（v3 唯一通道）。
 * @author 开发团队
 */

import { SessionExpiredError } from './apiClient';
import { loadStoredAuthSession } from './authSession';
import { getCanvasTemplate } from '../utils/canvasTemplates';
import type { CanvasBlock, CanvasBoardEntity, CanvasBlobEntity } from '../types/domain';

/** 一期默认画布 id（单画布；多画布二期扩展时改为列表管理） */
export const DEFAULT_CANVAS_ID = 'canvas-default';

/**
 * 加载默认画布（无则返回 null，由调用方决定初始化空画布）。
 * @returns {Promise<CanvasBoardEntity | null>} 画布实体或 null
 */
export async function loadBoard(): Promise<CanvasBoardEntity | null> {
  const { db } = await import('../db/index');
  const board = await db.canvasBoards.get(DEFAULT_CANVAS_ID);
  return board && !board.isDeleted ? board : null;
}

/**
 * 整块保存画布（区块数组 JSON 内嵌列，整块序列化写回——天然规避 Dexie 同 tick 隐式 put 覆盖陷阱）。
 * 不存在则创建（isDefault=true）。
 * @param {CanvasBlock[]} blocks - 全量区块数组（含 layout/notes）
 * @param {number} labelSeq - 标号分配单调计数器（只增不减，删除不复用的保证）
 */
export async function saveBoard(blocks: CanvasBoardEntity['blocks'], labelSeq: number): Promise<void> {
  const { db } = await import('../db/index');
  const now = new Date().toISOString();
  const existing = await db.canvasBoards.get(DEFAULT_CANVAS_ID);
  const board: CanvasBoardEntity = {
    id: DEFAULT_CANVAS_ID,
    title: existing?.title ?? '我的画布',
    blocks,
    isDefault: true,
    labelSeq,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    isDeleted: false,
  };
  await db.canvasBoards.put(board);
}

/**
 * 写入 Blob（图片/文件二进制），返回引用 id（区块 data 仅存此 id）。
 * @param {Blob} blob - 二进制内容
 * @param {string} mime - MIME 类型
 * @returns {Promise<string>} 引用 id
 */
export async function putBlob(blob: Blob, mime: string): Promise<string> {
  const { db } = await import('../db/index');
  const { generateId } = await import('../utils/idGenerator');
  const entity: CanvasBlobEntity = {
    id: generateId(),
    mime,
    data: blob,
    createdAt: new Date().toISOString(),
  };
  await db.canvasBlobs.put(entity);
  return entity.id;
}

/**
 * 读取 Blob 引用（image/file 区块渲染用）。
 * @param {string} id - 引用 id
 * @returns {Promise<CanvasBlobEntity | undefined>}
 */
export async function getBlob(id: string): Promise<CanvasBlobEntity | undefined> {
  const { db } = await import('../db/index');
  return db.canvasBlobs.get(id);
}

/**
 * 行情保鲜刷新（spec §5.1.1）：遍历传入的 K 线区块，经模板注册表统一取数入口
 * （kline.fetchData，force 绕过缓存强拉）刷新。刷新只更新行情序列，layout/notes/划线不受影响；
 * 单区块失败静默保留旧数据（降级边界）；会话失效（401）向上抛出由调用方分流。
 * @param {CanvasBlock[]} klineBlocks - 画布内已选标的的 K 线区块（调用方过滤后传入）
 * @returns {Promise<{ ok: string[]; failed: string[] }>} 成功/失败区块 blockId 清单（供 UI 提示计数）
 * @throws {SessionExpiredError} 会话失效（画布数据需登录，游客不可见）
 */
export async function refreshAllKlines(klineBlocks: CanvasBlock[]): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  if (klineBlocks.length === 0) return { ok, failed };
  const session = loadStoredAuthSession();
  if (!session?.token) throw new SessionExpiredError();
  const fetchData = getCanvasTemplate('kline')?.fetchData;
  if (!fetchData) return { ok, failed };
  await Promise.all(
    klineBlocks.map(async (block) => {
      try {
        // force=true 绕过内存缓存（重拉语义）；401 由 fetchData 内链路上抛
        await fetchData(block, { force: true });
        ok.push(block.blockId);
      } catch (e) {
        // 会话失效直接上抛（终止其余刷新）；其他失败静默保留旧数据
        if (e instanceof SessionExpiredError) throw e;
        failed.push(block.blockId);
      }
    }),
  );
  return { ok, failed };
}
