/**
 * @file useLiveQuotes.ts
 * @description 实时行情刷新钩子：按 A 股交易时段策略轮询腾讯行情接口
 *              （fetchStockSummaries 多代码批量合并，当前页全部标的单次请求）——
 *              - 交易时段（工作日 9:30-11:30 / 13:00-15:00）：每 5 秒刷新一次；
 *              - 非交易时段：打开视图时仅刷新一次；
 *              - 跨时段切换（开市 / 收市）：自动执行各自时段策略，
 *                收市瞬间额外刷新一次以捕捉收盘价。
 * @layer Hooks
 * @storage_impact 纯网络层钩子，不读写 IndexedDB；行情数据仅存于组件内存。
 * @author 开发团队
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchStockSummaries } from '../services/stockService';
import { isTradingTime } from '../utils/tradingTime';
import type { StockQuoteSummary } from '../types/stock';

/** 交易时段内的行情轮询间隔（毫秒）：5 秒 */
export const QUOTE_REFRESH_INTERVAL_MS = 5_000;

/** useLiveQuotes 返回值 */
export interface LiveQuotesState {
  /** fullCode → 最新行情摘要；该标的暂无数据或拉取失败时为 null */
  quotes: Record<string, StockQuoteSummary | null>;
  /** 当前是否处于交易时段（用于 UI 状态提示） */
  isTrading: boolean;
  /** 最近一次行情刷新完成的时间戳（epoch ms）；尚未完成过刷新时为 null */
  lastUpdated: number | null;
}

/**
 * 批量刷新所有标的最新行情并合并进 state。
 *
 * @description 全部标的合并为一次批量请求（腾讯 q=code1,code2），返回后
 *              一次性合并更新；通过 inFlightRef 防止上一轮请求未结束时重复
 *              发起（避免 5 秒间隔内因慢网络叠加并发请求）。
 */
export function useLiveQuotes(fullCodes: string[]): LiveQuotesState {
  const [quotes, setQuotes] = useState<Record<string, StockQuoteSummary | null>>({});
  const [isTrading, setIsTrading] = useState<boolean>(() => isTradingTime(new Date()));
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const codesRef = useRef<string[]>([]);
  const inFlightRef = useRef(false);

  const refreshAll = useCallback(async () => {
    const codes = codesRef.current;
    if (codes.length === 0 || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      // 批量合并：当前页面全部标的一次请求（q=code1,code2），返回后一起更新
      const next = await fetchStockSummaries(codes);
      setQuotes((prev) => ({ ...prev, ...next }));
      setLastUpdated(Date.now());
    } catch (err) {
      // 整体失败不崩页：保留旧数据，仅提示（单个标的缺失由服务层降级为 null）
      console.warn('[useLiveQuotes] 批量行情刷新失败：', err);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  // 同步最新标列表；持仓新增/删除时立即刷新一次
  useEffect(() => {
    const next = Array.from(new Set(fullCodes.map((c) => c.trim()).filter(Boolean)));
    const prev = codesRef.current;
    const changed =
      next.length !== prev.length || next.some((code, i) => code !== prev[i]);
    codesRef.current = next;
    if (changed) void refreshAll();
  }, [fullCodes, refreshAll]);

  // 打开视图立即刷新一次（非交易时段策略：仅此一次）
  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // 5 秒周期检查交易时段：交易时段内持续刷新；
  // 跨时段切换自动切换策略 —— 开市即开始 5 秒刷新，收市做最后一次刷新后停止
  useEffect(() => {
    let prevTrading = isTradingTime(new Date());
    const timer = setInterval(() => {
      const trading = isTradingTime(new Date());
      setIsTrading(trading);
      if (trading || (!trading && prevTrading)) {
        void refreshAll();
      }
      prevTrading = trading;
    }, QUOTE_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  return { quotes, isTrading, lastUpdated };
}
