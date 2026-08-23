/**
 * @file priceCache.ts
 * @description 模块级实时行情价格缓存（内存）。由视图层（如 TCalculator）在
 *              useLiveQuotes 每次刷新后调用 setMarketPrice 填充，供风控校验引擎
 *              （R2 价格偏离规则）在 store action 中同步读取。
 *              缓存仅为纯内存 Map，不持久化，不依赖 React 响应式。
 * @layer Risk
 * @storage_impact 纯内存，不读写 IndexedDB。
 * @author 开发团队
 */

/** 内存价格缓存：fullCode → currentPrice */
const priceCache = new Map<string, number>();

/**
 * 设置/更新某只标的的实时行情价。
 * 由视图层（TCalculator/SandboxPlayback 等）在 useLiveQuotes 刷新后调用。
 */
export function setMarketPrice(fullCode: string, price: number): void {
  if (price > 0) priceCache.set(fullCode, price);
}

/**
 * 批量设置行情价（配合 useLiveQuotes 的 quotes 对象）。
 * 视图层在 useEffect 中调用即可一次性填充全部标的。
 */
export function setMarketPrices(quotes: Record<string, { currentPrice: number } | null>): void {
  for (const [fullCode, q] of Object.entries(quotes)) {
    if (q && q.currentPrice > 0) priceCache.set(fullCode, q.currentPrice);
  }
}

/**
 * 获取某只标的的最新行情价（同步，无网络请求）。
 * 缓存中无数据时返回 undefined，R2 规则据此跳过价格校验（空转）。
 */
export function getMarketPrice(fullCode: string): number | undefined {
  return priceCache.get(fullCode);
}

/**
 * 清空价格缓存（在视图卸载或切换标的时调用）。
 */
export function clearMarketPrices(): void {
  priceCache.clear();
}