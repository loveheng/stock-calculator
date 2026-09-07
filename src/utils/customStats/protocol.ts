/**
 * @file protocol.ts
 * @description 沙箱 Worker 消息协议（主线程 ↔ Worker）唯一权威定义。
 *              仅类型：client.ts（主线程）与 worker.ts（Worker 内）各自 import，
 *              不产生任何运行时依赖（Worker 代码不会进主线程 chunk）。
 * @layer Utils (Pure) —— 纯类型，无运行时代码
 * @storage_impact 无。
 * @author 开发团队
 */

/** 主线程 → Worker */
export type RunnerRequest =
  | { type: 'init' } // 预热（wasm 懒加载 + VM 初始化）
  | { type: 'ctx'; batchId: string; ctxJson: string } // 批次注入（Worker 内缓存，批次内复用）
  | { type: 'run'; runId: string; batchId: string; code: string; deadlineMs: number }
  | { type: 'fixture'; runId: string; code: string }; // 夹具预跑（内置夹具数据）

/** Worker → 主线程 */
export type RunnerResponse =
  | { type: 'ready' }
  | { type: 'result'; runId: string; resultJson: string }
  | { type: 'error'; runId: string; message: string; line?: number }
  | { type: 'timeout'; runId: string };
