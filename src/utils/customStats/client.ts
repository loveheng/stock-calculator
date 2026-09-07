/**
 * @file client.ts
 * @description 沙箱 Worker 主线程客户端（单例）：模块 Worker（type: 'module'）懒加载，
 *              copilot 浮窗打开 / 进入统计页时 prewarm 预热（wasm 加载 + VM 初始化）。
 *              消息协议（implementation §4.2）：ctx 批次注入复用（run 只带 batchId，
 *              兑现 1× parse + N× 毫秒级执行）；runId 配对响应。
 *              超时兜底：主线程定时器超时 → worker.terminate() → 重建单例 →
 *              该次运行失败上报，后续运行在新 Worker 上继续（一次死循环不报废沙箱）。
 *              所有 run 结果经 Result Guard 归一后返回 —— 本文件是渲染侧唯一结果通道。
 * @layer Utils (Pure) —— 不碰 store/db（R2）；浏览器专用（Worker），Node 测试走 vm.ts
 * @storage_impact 纯内存，无存储。
 * @author 开发团队
 */

import type { CustomStatsContextWire, CustomStatsResult } from '../../types/domain';
import { normalizeCustomStatsResult } from './guard';
import type { RunnerRequest, RunnerResponse } from './protocol';
import { STAT_DEADLINE_MS } from './vm';

/** 单次执行结果（已过 Result Guard；guard 拒绝 = 结构非法错误） */
export interface StatRunOutcome {
  result?: CustomStatsResult;
  error?: string;
  line?: number;
}

/** 主线程兜底定时器余量：interrupt 时限之外再给序列化/消息回程的余量 */
const CLIENT_KILL_MARGIN_MS = 1000;

let worker: Worker | null = null;
let runSeq = 0;
let readyPromise: Promise<void> | null = null;
const pending = new Map<string, {
  resolve: (o: StatRunOutcome) => void;
  killTimer: ReturnType<typeof setTimeout>;
}> ();

/** Worker 构造：new Worker(new URL(...)) 单表达式是 Vite 静态识别 worker 入口的约定形式 */
function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function killWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  readyPromise = null;
  for (const [, p] of pending) {
    clearTimeout(p.killTimer);
    p.resolve({ error: '沙箱执行已终止（超时），请重试' });
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (!worker) worker = createWorker();
  if (!worker) return null;
  worker.onmessage = (ev: MessageEvent<RunnerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      readyPromise ??= Promise.resolve();
      return;
    }
    const entry = pending.get(msg.runId);
    if (!entry) return; // 未知 runId（可能是被 terminate 的历史请求）静默忽略
    pending.delete(msg.runId);
    clearTimeout(entry.killTimer);
    if (msg.type === 'result') {
      const parsed = parseGuarded(msg.resultJson);
      entry.resolve(parsed);
    } else if (msg.type === 'timeout') {
      entry.resolve({ error: '执行超时：统计代码运行超过时限，已被中断' });
    } else {
      entry.resolve({ error: msg.message, line: msg.line });
    }
  };
  worker.onerror = () => {
    // 加载/运行期崩溃：重建 Worker，所有在途请求按失败收敛
    killWorker();
  };
  return worker;
}

/** 解析 Worker 结果 JSON 并过 Result Guard（渲染侧唯一结果通道） */
function parseGuarded(resultJson: string): StatRunOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(resultJson);
  } catch {
    return { error: '沙箱返回值不是合法 JSON' };
  }
  const result = normalizeCustomStatsResult(raw);
  if (!result) return { error: '结果形状非法（缺少 title/kind/chart 结构），可让 AI 修复' };
  return { result };
}

/** 预热：触发 wasm 懒加载与 VM 初始化（copilot 浮窗打开 / 进入统计页时调用，幂等） */
export function prewarmSandbox(): void {
  const w = ensureWorker();
  if (!w) return;
  if (!readyPromise) {
    readyPromise = new Promise<void>((resolve) => {
      // ready 消息由 worker.onmessage 消费；此处仅保证 init 已发出
      resolve();
    });
    w.postMessage({ type: "init" } satisfies RunnerRequest);
  }
}

/** 批次注入：一次 buildFullContext 的 JSON 只传一次，同批次 run 复用 */
export function injectStatContext(batchId: string, ctx: CustomStatsContextWire): void {
  const w = ensureWorker();
  if (!w) throw new Error('沙箱不可用（当前环境不支持 Worker）');
  w.postMessage({ type: 'ctx', batchId, ctxJson: JSON.stringify(ctx) } satisfies RunnerRequest);
}

/**
 * 执行一段统计代码（ctx 须已注入）。
 *
 * @param deadlineMs 沙箱 interrupt 时限；主线程在 deadlineMs + 余量后 terminate 重建
 */
export function runStatCode(
  batchId: string,
  code: string,
  deadlineMs: number = STAT_DEADLINE_MS,
): Promise<StatRunOutcome> {
  const w = ensureWorker();
  if (!w) return Promise.resolve({ error: '沙箱不可用（当前环境不支持 Worker）' });
  const runId = `run-${++runSeq}`;
  return new Promise<StatRunOutcome>((resolve) => {
    const killTimer = setTimeout(() => {
      pending.delete(runId);
      killWorker();
      resolve({ error: '执行超时：统计代码运行超过时限，沙箱已重建' });
    }, deadlineMs + CLIENT_KILL_MARGIN_MS);
    pending.set(runId, { resolve, killTimer });
    w.postMessage({ type: 'run', runId, batchId, code, deadlineMs } satisfies RunnerRequest);
  });
}

/**
 * 夹具预跑（空数组 + 样例夹具，spec FR2）：任一失败不进结果面板（转「一键 AI 修复」）。
 * 夹具 ctx 内置于 Worker（fixtures 常量），无需注入批次。
 */
export function runStatFixtures(code: string): Promise<StatRunOutcome> {
  const w = ensureWorker();
  if (!w) return Promise.resolve({ error: '沙箱不可用（当前环境不支持 Worker）' });
  const runId = `fx-${++runSeq}`;
  return new Promise<StatRunOutcome>((resolve) => {
    const killTimer = setTimeout(() => {
      pending.delete(runId);
      killWorker();
      resolve({ error: '夹具预跑超时：统计代码运行超过时限，沙箱已重建' });
    }, STAT_DEADLINE_MS * 2 + CLIENT_KILL_MARGIN_MS * 2);
    pending.set(runId, { resolve, killTimer });
    w.postMessage({ type: 'fixture', runId, code } satisfies RunnerRequest);
  });
}

/** 测试/诊断用：销毁单例 */
export function resetSandboxClient(): void {
  killWorker();
  runSeq = 0;
}
