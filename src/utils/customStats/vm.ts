/**
 * @file vm.ts
 * @description QuickJS(WASM) 沙箱执行器核心：单例模块 + 单例 VM 驻留，eval HELPERS_SOURCE
 *              挂载 globalThis.__helpers，ctx 以 JSON 注入并与 helpers 合并到 globalThis.__ctx，
 *              再以 (ctx) => result 形态求值执行。零宿主函数注入（RELEASE_SYNC 单文件变体可用的前提）。
 *              资源防线：interrupt 时限（默认 500ms）+ 内存上限 128MB + 栈上限 1MB；
 *              宿主侧另有 Worker terminate 兜底（client.ts），一次死循环不报废沙箱。
 * @layer Utils (Pure) —— 只依赖 types/quickjs，禁碰 store/db（R2）
 * @storage_impact 纯内存执行器，无存储。
 * @author 开发团队
 */

import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import VARIANT from '@jitl/quickjs-singlefile-browser-release-sync';
import type { CustomStatsContextWire } from '../../types/domain';
import { HELPERS_SOURCE } from './helpers';

/** 单次执行 CPU 时限（毫秒，spec §5.1：P0 建议 500ms/次执行） */
export const STAT_DEADLINE_MS = 500;
/** 沙箱内存上限（128MB，spec §5.1） */
export const STAT_MEMORY_LIMIT = 128 * 1024 * 1024;
/** 沙箱 JS 栈上限（防深递归击穿 wasm C 栈） */
export const STAT_STACK_LIMIT = 1024 * 1024;

export interface StatExecOk {
  ok: true;
  /** 结果 JSON（Guard 归一化前的原始序列化产物） */
  resultJson: string;
}

export interface StatExecErr {
  ok: false;
  message: string;
  /** QuickJS 报错行号（对应生成代码行，「AI 修复」提示词携带） */
  line?: number;
  /** 超时/interrupt 终止 */
  timedOut?: boolean;
}

export type StatExecOutcome = StatExecOk | StatExecErr;

let modulePromise: Promise<QuickJSWASMModule> | null = null;
let vmPromise: Promise<QuickJSContext> | null = null;

/** QuickJS 模块单例（wasm 懒加载，首次触发后常驻） */
export function getQuickJSModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(VARIANT);
  return modulePromise;
}

/** VM 单例：创建时挂 helpers 与资源上限，进程内常驻复用 */
export function getSandboxVm(): Promise<QuickJSContext> {
  vmPromise ??= (async () => {
    const module = await getQuickJSModule();
    const vm = module.newContext();
    vm.runtime.setMemoryLimit(STAT_MEMORY_LIMIT);
    vm.runtime.setMaxStackSize(STAT_STACK_LIMIT);
    const helpersRet = vm.evalCode(HELPERS_SOURCE);
    if (helpersRet.error) {
      helpersRet.error.dispose();
      vm.dispose();
      vmPromise = null;
      throw new Error('沙箱初始化失败：helpers 源码执行异常');
    }
    helpersRet.value.dispose();
    return vm;
  })();
  return vmPromise;
}

/** 从 QuickJS 错误信息中提取行号（供「AI 修复」提示词携带） */
export function extractErrorLine(message: string): number | undefined {
  const m = /(?:line\s*:?\s*|@)(\d+)/i.exec(message) ?? /:(\d+):\d+/.exec(message);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 读取沙箱异常值的可读描述（Error 对象取 message/stack，字符串原样） */
function describeError(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle);
  if (typeof dumped === 'string') return dumped;
  if (typeof dumped === 'object' && dumped !== null) {
    const o = dumped as Record<string, unknown>;
    const msg = typeof o.message === 'string' ? o.message : '';
    const stack = typeof o.stack === 'string' ? o.stack : '';
    const line = msg || stack || JSON.stringify(dumped);
    return line;
  }
  return String(dumped);
}

/** 结果序列化出沙箱：仅允许 JSON 安全值，函数/循环引用按执行错误处理 */
function dumpAndSerialize(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle);
  return JSON.stringify(dumped);
}

/**
 * 执行一段统计代码。
 *
 * @param code  完整箭头函数表达式 `(ctx) => CustomStatsResult`
 * @param ctxWire 序列化前上下文（helpers 由沙箱内挂载，不在此列）
 * @param deadlineMs CPU 时限（interrupt）
 */
export async function executeStatCode(
  code: string,
  ctxWire: CustomStatsContextWire,
  deadlineMs: number = STAT_DEADLINE_MS,
): Promise<StatExecOutcome> {
  let vm: QuickJSContext;
  try {
    vm = await getSandboxVm();
  } catch (e) {
    return { ok: false, message: `沙箱初始化失败：${e instanceof Error ? e.message : String(e)}` };
  }

  // interrupt 按次设置（VM 常驻，handler 闭包捕获本次 deadline）
  const deadline = Date.now() + Math.max(1, deadlineMs);
  vm.runtime.setInterruptHandler(() => Date.now() > deadline);

  const json = JSON.stringify(ctxWire);
  const holders: QuickJSHandle[] = [];
  try {
    // ① ctx 注入：JSON 字符串在沙箱内 parse，helpers 挂到 ctx.helpers（契约形态 CustomStatsContext.helpers）
    const ctxSrc = `globalThis.__ctx = JSON.parse(${JSON.stringify(json)}); globalThis.__ctx.helpers = globalThis.__helpers; globalThis.__ctx`;
    const ctxRet = vm.evalCode(ctxSrc);
    if (ctxRet.error) {
      const msg = describeError(vm, ctxRet.error);
      ctxRet.error.dispose();
      return { ok: false, message: `ctx 注入失败：${msg}` };
    }
    const ctxHandle = ctxRet.value;
    holders.push(ctxHandle);

    // ② 求值函数：完整箭头函数表达式，异常在 eval 阶段即暴露（语法/签名错误）
    const fnRet = vm.evalCode(`(${code})`);
    if (fnRet.error) {
      const msg = describeError(vm, fnRet.error);
      fnRet.error.dispose();
      return { ok: false, message: msg, line: extractErrorLine(msg) };
    }
    const fnHandle = fnRet.value;
    holders.push(fnHandle);

    // ③ 调用：ctx 以实参传入（参数名 ctx）；未声明参数的生成代码也可经 globalThis.__ctx 取值
    const callRet = vm.callFunction(fnHandle, vm.undefined, ctxHandle);
    if (callRet.error) {
      const msg = describeError(vm, callRet.error);
      callRet.error.dispose();
      // interrupt 触发的终止以超时语义上报（宿主侧据此走 terminate 重建）
      return { ok: false, message: msg, line: extractErrorLine(msg), timedOut: Date.now() > deadline };
    }
    const resultHandle = callRet.value;
    holders.push(resultHandle);

    const resultJson = dumpAndSerialize(vm, resultHandle);
    return { ok: true, resultJson };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message, timedOut: Date.now() > deadline };
  } finally {
    for (const h of holders) {
      try {
        h.dispose();
      } catch {
        // 已随异常释放或生命周期归届，忽略
      }
    }
  }
}

/** 测试/诊断用：销毁沙箱单例（下一次执行重新初始化） */
export async function resetSandbox(): Promise<void> {
  const vmPromiseSnapshot = vmPromise;
  vmPromise = null;
  modulePromise = null;
  try {
    const vm = await vmPromiseSnapshot;
    vm?.dispose();
  } catch {
    // 初始化失败的单例无需清理
  }
}
