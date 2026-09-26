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
import type { CanvasBlock, CanvasBoardEntity, CanvasBoardMeta, CanvasBlobEntity } from '../types/domain';

/**
 * 一期默认画布 id（多画布下的兜底画布：列表为空时以其重建，保证永远有画布可画）。
 * 存量数据（单画布时期写入的行）即此 id，升级后天然成为列表里的第一块画布。
 */
export const DEFAULT_CANVAS_ID = 'canvas-default';

/**
 * 加载指定画布（无则返回 null，由调用方决定初始化空画布）。
 * @param {string} boardId - 画布 id（缺省为默认画布）
 * @returns {Promise<CanvasBoardEntity | null>} 画布实体或 null
 */
export async function loadBoard(boardId: string = DEFAULT_CANVAS_ID): Promise<CanvasBoardEntity | null> {
  const { db } = await import('../db/index');
  const board = await db.canvasBoards.get(boardId);
  return board && !board.isDeleted ? board : null;
}

/**
 * 整块保存画布（区块数组 JSON 内嵌列，整块序列化写回——天然规避 Dexie 同 tick 隐式 put 覆盖陷阱）。
 * 不存在则创建（默认画布 isDefault=true）。
 * @param {CanvasBlock[]} blocks - 全量区块数组（含 layout/notes）
 * @param {number} labelSeq - 标号分配单调计数器（只增不减，删除不复用的保证）
 * @param {string} boardId - 目标画布 id（缺省为默认画布）
 */
export async function saveBoard(
  blocks: CanvasBoardEntity['blocks'],
  labelSeq: number,
  boardId: string = DEFAULT_CANVAS_ID,
): Promise<void> {
  const { db } = await import('../db/index');
  const now = new Date().toISOString();
  const existing = await db.canvasBoards.get(boardId);
  const board: CanvasBoardEntity = {
    id: boardId,
    title: existing?.title ?? (boardId === DEFAULT_CANVAS_ID ? '我的画布' : '新建画布'),
    blocks,
    isDefault: boardId === DEFAULT_CANVAS_ID || existing?.isDefault === true,
    labelSeq,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    isDeleted: false,
  };
  await db.canvasBoards.put(board);
}

/**
 * 列出全部未删除画布（轻量元数据；默认画布置顶，其余按更新时间倒序）。
 * @returns {Promise<CanvasBoardMeta[]>} 画布列表元数据
 */
export async function listBoards(): Promise<CanvasBoardMeta[]> {
  const { db } = await import('../db/index');
  const all = await db.canvasBoards.toArray();
  return all
    .filter((b) => !b.isDeleted)
    .map((b) => ({
      id: b.id,
      title: b.title,
      blockCount: b.blocks.length,
      updatedAt: b.updatedAt,
      isDefault: b.isDefault,
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

/**
 * 新建空白画布（非默认画布）。
 * @param {string} title - 画布标题
 * @returns {Promise<CanvasBoardEntity>} 新建的画布实体
 */
export async function createBoard(title = '新建画布'): Promise<CanvasBoardEntity> {
  const { db } = await import('../db/index');
  const { generateId } = await import('../utils/idGenerator');
  const now = new Date().toISOString();
  const board: CanvasBoardEntity = {
    id: generateId(),
    title,
    blocks: [],
    isDefault: false,
    labelSeq: 0,
    createdAt: now,
    updatedAt: now,
    isDeleted: false,
  };
  await db.canvasBoards.put(board);
  return board;
}

/**
 * 重命名画布（保留其余字段，仅改 title）。
 * @param {string} boardId - 画布 id
 * @param {string} title - 新标题
 */
export async function renameBoard(boardId: string, title: string): Promise<void> {
  const { db } = await import('../db/index');
  const board = await db.canvasBoards.get(boardId);
  if (!board) return;
  await db.canvasBoards.put({ ...board, title, updatedAt: new Date().toISOString() });
}

/**
 * 删除画布（软删除 isDeleted=true：与其他域一致，保留可恢复性）。
 * @param {string} boardId - 画布 id
 */
export async function deleteBoard(boardId: string): Promise<void> {
  const { db } = await import('../db/index');
  const board = await db.canvasBoards.get(boardId);
  if (!board) return;
  await db.canvasBoards.put({ ...board, isDeleted: true, isDefault: false, updatedAt: new Date().toISOString() });
}

/**
 * 兜底保证至少存在一块画布：有则返回列表首块（默认画布优先），无则以默认 id 重建空画布。
 * @returns {Promise<string>} 可安全使用的画布 id
 */
export async function ensureDefaultBoard(): Promise<string> {
  const boards = await listBoards();
  if (boards.length > 0) return boards[0].id;
  const { db } = await import('../db/index');
  const now = new Date().toISOString();
  await db.canvasBoards.put({
    id: DEFAULT_CANVAS_ID,
    title: '我的画布',
    blocks: [],
    isDefault: true,
    labelSeq: 0,
    createdAt: now,
    updatedAt: now,
    isDeleted: false,
  });
  return DEFAULT_CANVAS_ID;
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
