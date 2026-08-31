/**
 * @file StockAutocomplete.tsx
 * @description 股票搜索自动补全组件：基于腾讯 Smartbox 接口的搜索输入框，
 *              支持按代码/中文名/拼音首字母搜索，防抖输入并展示下拉候选列表。
 * @layer UI
 * @storage_impact 用户在候选列表中选择股票时，将股票基础信息写入 stocks 表（upsert）；搜索结果来自 stockService 网络请求。
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { searchStocks, debounce, persistStockMeta } from '../../services/stockService';
import { matchSecurityKind } from '../../utils/mathUtils';
import type { StockSearchItem, StockMeta } from '../../types/stock';

interface StockAutocompleteProps {
  value: StockSearchItem | null;
  onChange: (stock: StockSearchItem | null) => void;
  placeholder?: string;
}

export default function StockAutocomplete({
  value,
  onChange,
  placeholder = '搜索股票代码/名称...',
}: StockAutocompleteProps) {
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<StockSearchItem[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Sync input value with selected stock
  useEffect(() => {
    if (value) {
      setInputValue(`${value.fullCode} ${value.Name}`);
    } else {
      setInputValue('');
    }
  }, [value]);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const doSearch = useCallback(
    debounce(async (q: string) => {
      if (q.trim().length === 0) {
        setSuggestions([]);
        setIsOpen(false);
        return;
      }
      setLoading(true);
      try {
        const results = await searchStocks(q);
        setSuggestions(results.slice(0, 10));
        setIsOpen(results.length > 0);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 300),
    [],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);
    if (value && val !== `${value.fullCode} ${value.Name}`) {
      onChange(null);
    }
    doSearch(val);
  };

  const handleSelect = async (stock: StockSearchItem) => {
    // 将股票基础信息写入 stocks 表（upsert，fullCode 为主键），
    // 供其他实体通过 fullCode 关联查询股票名称；经服务层落库，组件不直连 db
    const meta: StockMeta = {
      fullCode: stock.fullCode,
      code: stock.Code,
      stockName: stock.Name,
      pinYin: stock.PinYin,
      marketType: stock.MarketType,
      securityType: stock.SecurityType,
      kind: matchSecurityKind(stock.SecurityType, stock.Code),
      quoteId: stock.QuoteID,
      shortName: stock.ShortName,
      unifiedCode: stock.UnifiedCode,
    };
    await persistStockMeta(meta);
    onChange(stock);
    setInputValue(`${stock.fullCode} ${stock.Name}`);
    setIsOpen(false);
    setSuggestions([]);
  };

  const handleClear = () => {
    onChange(null);
    setInputValue('');
    setSuggestions([]);
    setIsOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <input
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onFocus={() => {
            if (suggestions.length > 0) setIsOpen(true);
          }}
          placeholder={placeholder}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50"
        />
        {inputValue && (
          <button
            onClick={handleClear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-lg leading-none"
            type="button"
          >
            ×
          </button>
        )}
        {loading && (
          <div className="absolute right-8 top-1/2 -translate-y-1/2">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-slate-500 border-t-transparent" />
          </div>
        )}
      </div>

      {isOpen && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-slate-800 border border-slate-600 rounded-xl shadow-2xl max-h-60 overflow-y-auto">
          {suggestions.map((s) => (
            <button
              key={s.fullCode}
              type="button"
              onClick={() => handleSelect(s)}
              className="w-full text-left px-3 py-2.5 hover:bg-slate-700/50 transition-colors border-b border-slate-700/50 last:border-b-0"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-200">{s.Name}</span>
                <span className="text-xs text-slate-500">{s.fullCode}</span>
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {s.SecurityTypeName} · {s.PinYin}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}