/**
 * @file guideService.ts
 * @description 选股引导服务（docs/guide-spec.md v1.1）：/api/guide/* 薄封装，取数范式镜像
 *              searchService（同应用同信封：恒 200 + body.code 分支）。一期仅 stock-brief
 *              （画布 brief 块取数通道，G1/G3）；analyze-message 随向导页二期再加。
 *              契约：后端仓 docs/guide/api.md——400=参数非法、500=系统异常（AuthApiError
 *              透出后端 message）；端点族不挂鉴权，401 分支仅作信封安全兜底。
 * @layer Service
 * @storage_impact 无持久化读写。
 * @author 开发团队
 */
import { AuthApiError, SessionExpiredError } from './apiClient';
import type { GuideAnnouncementItem, GuideArticleBrief, GuideSubjectItem } from '../types/domain';

export const GUIDE_API_BASE_URL = '/api/guide';
const REQUEST_TIMEOUT_MS = 15_000;

/** GET /api/guide/stock-brief 响应 data（后端仓 docs/guide/api.md §2.2） */
export interface StockBrief {
  nextSteps: string[];
  stockId: string;
  stockName: string;
  clsMention: { count: number; articles: GuideArticleBrief[] };
  subjects: GuideSubjectItem[];
  announcements: GuideAnnouncementItem[];
}

interface ApiEnvelopeShape<T> {
  code: number;
  message: string;
  data: T;
}

async function guideRequest<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(GUIDE_API_BASE_URL + path, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('网络异常：请求超时，请检查连接后重试');
    }
    throw new Error('网络异常：无法连接引导服务，请检查网络后重试');
  }
  clearTimeout(timer);

  let parsed: ApiEnvelopeShape<T> | null = null;
  try {
    parsed = (await response.json()) as ApiEnvelopeShape<T> | null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.code !== 'number') {
    throw new Error('服务响应异常（HTTP ' + response.status + '），请稍后重试');
  }
  if (parsed.code === 200) return parsed.data;
  if (parsed.code === 401) throw new SessionExpiredError(parsed.message);
  throw new AuthApiError(parsed.code, parsed.message);
}

/** 近窗口天数边界（后端 1-30 越界静默钳制；客户端同步钳制保证 UI 语义一致） */
const MIN_DAYS = 1;
const MAX_DAYS = 30;

export function clampGuideDays(days: number): number {
  return Math.min(Math.max(Math.trunc(days), MIN_DAYS), MAX_DAYS);
}

/**
 * Step2 个股引导档案（后端仓 docs/guide/api.md §2）。stockId 接受候选 stockId/裸 6 位代码/
 * 腾讯形态（大小写不限），服务端归一化到字典键；未收录股票返回 200 + 空聚合 + 空名（非 404）。
 */
export async function fetchStockBrief(stockId: string, days = 7): Promise<StockBrief> {
  const id = stockId.trim();
  if (!id) throw new AuthApiError(400, 'stockId 不能为空');
  return guideRequest<StockBrief>('/stock-brief?stockId=' + encodeURIComponent(id) + '&days=' + clampGuideDays(days));
}
