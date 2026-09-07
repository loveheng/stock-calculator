/**
 * @file worker.ts
 * @description 沙箱 Worker（type: 'module'，Vite 静态打包产物，PWA 可预缓存）：
 *              QuickJS(WASM) 单例驻留 + 上下文批次缓存。消息协议见 client.ts。
 *              关键行为：
 *              - init：加载 wasm 并初始化 VM（预热），回报 ready；
 *              - ctx：缓存批次 ctxJson（新批次释放旧批次，内存不随批次累积）；
 *              - run：仅引用 batchId，同步执行（interrupt 时限内），回报 result/error/timeout；
 *              - fixture：内置夹具（空数组 + 样例）预跑，任一失败即回报错误与行号。
 * @layer Utils (Worker) —— 不碰 store/db（R2）；浏览器专用入口
 * @storage_impact 纯内存，无存储。
 * @author 开发团队
 */

import type { CustomStatsContextWire } from '../../types/domain';
import { buildFixtureContexts } from './fixtures';
import type { RunnerRequest, RunnerResponse } from './protocol';
import { STAT_DEADLINE_MS, executeStatCode } from './vm';

/** tsconfig 无 WebWorker lib：以最小消息面显式收窄 self（DedicatedWorkerGlobalScope 子集） */
const ctx = self as unknown as {
  postMessage: (msg: RunnerResponse) => void;
  onmessage: ((ev: MessageEvent<RunnerRequest>) => void) | null;
};

/** 批次缓存：batchId → ctxJson（run 仅引用 batchId，兑现 1× 传输 + N× 执行） */
let cachedBatchId: string | null = null;
let cachedCtxJson: string | null = null;

function handleInit(): void {
  void executeStatCode('(ctx) => null', buildFixtureContexts()[0], STAT_DEADLINE_MS)
    .then(() => {
      // 预热执行兼作 VM 可用性自检；结果无意义（null 会被 Guard 拒绝，不外发）
      ctx.postMessage({ type: 'ready' });
    })
    .catch(() => {
      // 预热失败也回报 ready：真正的执行错误在 run 时按错误上报
      ctx.postMessage({ type: 'ready' });
    });
}

function handleCtx(batchId: string, ctxJson: string): void {
  cachedBatchId = batchId;
  cachedCtxJson = ctxJson;
}

async function handleRun(
  runId: string,
  batchId: string,
  code: string,
  deadlineMs: number,
): Promise<void> {
  if (batchId !== cachedBatchId || cachedCtxJson === null) {
    ctx.postMessage({ type: 'error', runId, message: '批次上下文缺失：请先注入 ctx' });
    return;
  }
  const outcome = await executeStatCode(code, JSON.parse(cachedCtxJson) as CustomStatsContextWire, deadlineMs);
  if (outcome.ok) {
    ctx.postMessage({ type: 'result', runId, resultJson: outcome.resultJson });
  } else if (outcome.timedOut) {
    ctx.postMessage({ type: 'timeout', runId });
  } else {
    ctx.postMessage({ type: 'error', runId, message: outcome.message, line: outcome.line });
  }
}

async function handleFixture(runId: string, code: string): Promise<void> {
  const fixtures = buildFixtureContexts();
  for (const fixture of fixtures) {
    const outcome = await executeStatCode(code, fixture, STAT_DEADLINE_MS);
    if (!outcome.ok) {
      if (outcome.timedOut) ctx.postMessage({ type: 'timeout', runId });
      else ctx.postMessage({ type: 'error', runId, message: outcome.message, line: outcome.line });
      return;
    }
  }
  ctx.postMessage({ type: 'result', runId, resultJson: JSON.stringify({ fixtures: 'ok' }) });
}

ctx.onmessage = (ev: MessageEvent<RunnerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      handleInit();
      break;
    case 'ctx':
      handleCtx(msg.batchId, msg.ctxJson);
      break;
    case 'run':
      void handleRun(msg.runId, msg.batchId, msg.code, msg.deadlineMs);
      break;
    case 'fixture':
      void handleFixture(msg.runId, msg.code);
      break;
  }
};
