/**
 * @file monitorService.ts
 * @description 价格预告单监控（Spring Boot :18080 `/api/broker/monitor/*`）三端点客户端：
 *              start（开启）/ list（列表）/ stop（结束）。同源信封契约——HTTP 状态恒为 200，
 *              业务结果一律判 `body.code`。Bearer 由本服务从本地会话读取注入（与 pushService
 *              同模式，UI 层不感知令牌，避免 services 反向依赖 store）。
 *              错误分类：401 → SessionExpiredError（走现成会话失效链路）；
 *              429 → MonitorLimitError（RUNNING 已达上限 5）；400 → MonitorBadRequestError
 *              （携带后端中文文案，前端直接展示）；5xx/超时/网络故障 → MonitorServiceError。
 *              判定语义（单边触发边界、30 分钟检查、3 次封顶）见 docs/monitor/design.md。
 * @layer Service
 * @storage_impact 无本地持久化读写；会话令牌只读 localStorage（authSession）；任务状态由服务端持有。
 * @author 开发团队
 */

import { SessionExpiredError } from './apiClient';
import { loadStoredAuthSession } from './authSession';
import type { MonitorAlertType, MonitorDirection } from '../utils/monitorRule';

/** 方向与触发类型以 utils/monitorRule 为单一事实源（规则计算与服务层共用），此处转出供 UI 引用 */
export type { MonitorAlertType, MonitorDirection };

/** 任务状态：RUNNING=追踪中 / STOPPED=已结束（手动停或 3 次提醒完自动停） */
export type MonitorStatus = 'RUNNING' | 'STOPPED';

/** 单条预告单（list 返回条目） */
export interface MonitorTask {
  taskId: number;
  /** 腾讯形态全码（sh600519） */
  fullCode: string;
  /** 6 位字典码（600519） */
  stockCode: string;
  alertType: MonitorAlertType;
  direction: MonitorDirection;
  /** 目标价（元） */
  threshold: number;
  /** 容差（元），仅 PRICE_NEAR 非空 */
  band: number | null;
  status: MonitorStatus;
  /** 累计提醒次数（满 3 次自动结束） */
  alertCount: number;
  lastAlertAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** list 返回体 */
export interface MonitorListData {
  /** RUNNING 数（剩余额度 = 上限 − runningCount） */
  runningCount: number;
  tasks: MonitorTask[];
}

/** start 入参 */
export interface MonitorStartInput {
  fullCode: string;
  direction: MonitorDirection;
  type: MonitorAlertType;
  /** 目标价（元），正数 */
  threshold: number;
  /** 容差（元），PRICE_NEAR 必填且 ≥0；PRICE_BELOW 忽略 */
  band?: number;
}

/** start 返回体 */
export interface MonitorStartData {
  taskId: number;
  status: MonitorStatus;
}

/** 单用户 RUNNING 预告单上限（后端默认 5，超限返 429） */
export const MONITOR_MAX_RUNNING = 5;

/** 单条预告单累计提醒上限（满即自动 STOPPED，判定无成交意愿） */
export const MONITOR_MAX_ALERTS = 3;

/** 额度已满（429）：提示先结束部分预告单 */
export class MonitorLimitError extends Error {
  constructor(message = `最多同时追踪 ${MONITOR_MAX_RUNNING} 条预告单，请先结束部分后再创建`) {
    super(message);
    this.name = 'MonitorLimitError';
  }
}

/** 业务参数错误（400）：message 为后端中文文案，前端可直接展示 */
export class MonitorBadRequestError extends Error {
  constructor(message = '预告单参数有误，请检查后重试') {
    super(message);
    this.name = 'MonitorBadRequestError';
  }
}

/** 监控服务不可用（5xx / 超时 / 网络故障）：提示稍后重试 */
export class MonitorServiceError extends Error {
  constructor(message = '提醒服务暂不可用，请稍后重试') {
    super(message);
    this.name = 'MonitorServiceError';
  }
}

export const MONITOR_API_BASE_URL = '/api/broker/monitor';

const REQUEST_TIMEOUT_MS = 15_000;

/** 与 brokerService 同构的信封契约 */
interface MonitorEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/**
 * 统一请求底座：令牌注入 + 信封解析 + 错误分类。
 *
 * @param path - 端点路径（以 / 开头）
 * @param options - method / body
 * @returns 信封 data
 * @throws {SessionExpiredError} 401 或本地无会话（三端点均需登录）
 * @throws {MonitorLimitError} 429
 * @throws {MonitorBadRequestError} 400
 * @throws {MonitorServiceError} 5xx / 超时 / 网络故障 / 响应畸形
 */
async function monitorRequest<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const session = loadStoredAuthSession();
  if (!session?.token) throw new SessionExpiredError('请先登录后再使用价格提醒');

  let response: Response;
  try {
    // 同源相对路径（不经 window.location.origin：node 单测环境无 window）
    response = await fetch(MONITOR_API_BASE_URL + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${session.token}`,
      } as HeadersInit,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // 超时（AbortSignal.timeout 抛 TimeoutError）与网络故障统一归类
    throw new MonitorServiceError();
  }

  if (response.status === 401) throw new SessionExpiredError();
  if (response.status === 429) throw new MonitorLimitError();
  if (response.status >= 500) throw new MonitorServiceError();

  let envelope: MonitorEnvelope<T>;
  try {
    envelope = (await response.json()) as MonitorEnvelope<T>;
  } catch {
    throw new MonitorServiceError('提醒服务响应异常，请稍后重试');
  }
  if (!envelope || typeof envelope.code !== 'number') {
    throw new MonitorServiceError('提醒服务响应异常，请稍后重试');
  }
  // 业务码优先于 HTTP 状态（HTTP 恒 200）
  if (envelope.code === 401) throw new SessionExpiredError(envelope.message);
  if (envelope.code === 429) throw new MonitorLimitError();
  if (envelope.code === 400) throw new MonitorBadRequestError(envelope.message || undefined);
  if (envelope.code >= 500) throw new MonitorServiceError();
  if (envelope.code !== 200) throw new MonitorBadRequestError(envelope.message || undefined);
  return envelope.data;
}

/**
 * 开启预告单（幂等）：同用户 + 同股 + 同类型 + 同阈值 + 同容差 + 同方向已 RUNNING 时返回既有 taskId。
 *
 * @param input - 标的方向与触发参数
 * @returns 新建/既有的 taskId 与状态
 */
export async function startMonitor(input: MonitorStartInput): Promise<MonitorStartData> {
  return monitorRequest<MonitorStartData>('/start', {
    method: 'POST',
    body: {
      fullCode: input.fullCode,
      // 当前后端仅支持日线口径
      interval: '1d',
      direction: input.direction,
      alertRule: {
        type: input.type,
        threshold: input.threshold,
        ...(input.type === 'PRICE_NEAR' ? { band: input.band ?? 0 } : {}),
      },
    },
  });
}

/**
 * 预告单列表（管理页加载/刷新）：按更新时间倒序，含已 STOPPED。
 *
 * @returns RUNNING 数与任务列表
 */
export async function listMonitor(): Promise<MonitorListData> {
  return monitorRequest<MonitorListData>('/list');
}

/**
 * 结束预告单（幂等）：已 STOPPED 再调仍返回成功。
 *
 * @param taskId - start/list 返回的预告单 ID
 */
export async function stopMonitor(taskId: number): Promise<void> {
  await monitorRequest<{ status: MonitorStatus }>('/stop', {
    method: 'POST',
    body: { taskId },
  });
}
