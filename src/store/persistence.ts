/**
 * @file persistence.ts
 * @description Store 持久化军械：带指数退避重试的落库队列（safePersist）、失败重放队列、
 *              持久化错误状态（persistError）与远端同步标记（isSyncingFromRemote）。
 *              从 store/index.ts 拆出，供各 slice 与 roundService 共用。
 * @layer Store (Persistence)
 * @author 开发团队
 */
import { isInitialLoadDone } from '../db/storeInit';

let persistError: string | null = null;
let pendingQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

/**
 * 远端同步标记：当从云端恢复/合并数据时（importData 的 silent 模式），
 * 此标记设为 true，防止自动同步监听器将刚导入的数据又上传回云端。
 * 自动同步触发器（如 store.subscribe / useEffect）必须检查此标记：
 *   if (isSyncingFromRemote) { isSyncingFromRemote = false; return; }
 * 使用完成后立即复位，避免影响后续用户手动操作。
 */
let isSyncingFromRemote = false;

export function getIsSyncingFromRemote(): boolean { return isSyncingFromRemote; }
export function setIsSyncingFromRemote(value: boolean): void { isSyncingFromRemote = value; }

export function getPersistError(): string | null { return persistError; }
export function clearPersistError(): void { persistError = null; }

/**
 * 带指数退避重试机制的持久化函数。
 * - 最多重试 3 次（第 0 次为首次尝试，之后最多 3 次重试）
 * - 退避间隔为 1s → 2s → 4s（最大 8s，实际第 3 次重试间隔 4s）
 * - 所有重试均失败后，将操作加入待处理队列（pendingQueue），
 *   等待下次 safePersist 成功时自动重放（processPendingQueue）
 * - 不再直接操作 DOM（移除 window.dispatchEvent），
 *   改为设置 persistError 模块状态，由 UI 层通过 getPersistError() 读取
 * - 成功时自动清除 persistError 并触发队列重放
 */
export async function safePersist(fn: () => Promise<void>): Promise<void> {
  if (!isInitialLoadDone()) return;

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      // 成功时清除错误并尝试处理队列中的待办
      if (persistError) {
        persistError = null;
        processPendingQueue();
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[StorePersistence] 第 ${attempt + 1} 次重试失败，${delay}ms 后重试...`, err);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  persistError = msg;
  console.error('[StorePersistence] 所有重试均失败，已加入待处理队列:', lastError);

  // 将失败操作加入队列，下次成功时重放
  pendingQueue.push(fn);
}

/**
 * 重放待处理队列中的操作。
 * - 当 safePersist 所有重试均失败后，操作被加入 pendingQueue；
 * - 下次任何 safePersist 调用成功时，自动触发本函数重放队列；
 * - 重放期间若再次失败，操作重新入队，2s 后自动重试，避免无限递归；
 * - 使用 isProcessingQueue 互斥锁防止并发重放。
 */
async function processPendingQueue(): Promise<void> {
  if (isProcessingQueue || pendingQueue.length === 0) return;
  isProcessingQueue = true;

  const queue = [...pendingQueue];
  pendingQueue = [];

  for (const task of queue) {
    try {
      await task();
    } catch (err) {
      console.error('[StorePersistence] 队列处理失败，重新加入队列:', err);
      pendingQueue.push(task);
    }
  }

  isProcessingQueue = false;
  if (pendingQueue.length > 0) {
    // 仍有待处理项，延迟重试
    setTimeout(() => processPendingQueue(), 2000);
  }
}