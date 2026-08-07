import type { StockSearchItem, StockSearchResponse } from '../types/stock';

/**
 * 搜索股票（东方财富 Suggest API）
 * 搜索关键词支持：股票代码、中文名称、拼音首字母
 */
export async function searchStocks(input: string): Promise<StockSearchItem[]> {
  if (!input || input.trim().length === 0) return [];

  // 通过 Vite 代理转发请求，避免跨域问题
  const params = new URLSearchParams({
    input: input.trim(),
    type: '14',
    count: '10',
  });

  const res = await fetch(`/api/suggest/get?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signe',
    },
  });

  if (!res.ok) {
    throw new Error(`股票搜索请求失败: ${res.status} ${res.statusText}`);
  }

  const data: StockSearchResponse = await res.json();

  if (
    data.QuotationCodeTable?.Status !== 0 ||
    !Array.isArray(data.QuotationCodeTable?.Data)
  ) {
    return [];
  }

  return data.QuotationCodeTable.Data;
}

/**
 * 防抖工具函数
 * @param fn 要防抖的函数
 * @param delay 延迟毫秒数
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}
