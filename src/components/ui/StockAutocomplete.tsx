/**
 * @file StockAutocomplete.tsx
 * @description 股票搜索自动补全输入框组件：输入关键词后经 stockService.searchStocks
 *              防抖搜索（350ms），下拉列表展示匹配结果并支持键盘上下键导航、
 *              Enter 选择、Escape 关闭、点击外部收起；选中后回填「名称 (代码)」。
 * @layer UI
 * @storage_impact 本组件不直接读写 IndexedDB，仅调用网络搜索接口 stockService；
 *                 选中结果通过 onChange 回传父组件用于后续落库。
 * @author 开发团队
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { searchStocks, debounce } from '../../services/stockService';
import type { StockSearchItem } from '../../types/stock';

/**
 * StockAutocomplete 组件入参定义。
 *
 * @property {StockSearchItem | null} value - 当前选中的股票（外部受控值）
 * @property {(item: StockSearchItem | null) => void} onChange - 选中/清空回调
 * @property {string} [placeholder] - 输入框占位文案，默认「搜索股票代码/名称/拼音」
 */
interface StockAutocompleteProps {
  value: StockSearchItem | null;
  onChange: (item: StockSearchItem | null) => void;
  placeholder?: string;
}

/**
 * 股票搜索自动补全输入框组件。
 *
 * @description 受控组件：外部通过 value/onChange 双向绑定选中股票；
 *              内部维护输入框文本、防抖搜索结果与键盘高亮索引。
 *              手动修改输入时自动清空已选中的 value（触发父组件置空）。
 * @param {StockAutocompleteProps} props - 见 {@link StockAutocompleteProps}
 * @returns {JSX.Element} 自动补全输入框视图（含下拉列表）
 * @note 防抖搜索依赖 stockService 的网络接口，失败时展示空结果；
 *       组件为纯 UI 交互层，不产生任何数据持久化
 */
export default function StockAutocomplete({
  value,
  onChange,
  placeholder = '搜索股票代码/名称/拼音',
}: StockAutocompleteProps) {
  const [input, setInput] = useState('');
  const [results, setResults] = useState<StockSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 当外部 value 变化时，回填输入框
  useEffect(() => {
    if (value) {
      setInput(`${value.Name} (${value.Code})`);
    } else {
      setInput('');
    }
  }, [value]);

  // 防抖搜索
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedSearch = useCallback(
    debounce(async (keyword: string) => {
      if (keyword.trim().length === 0) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const items = await searchStocks(keyword);
        setResults(items);
        setHighlightIndex(-1);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350),
    []
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);
    // 如果用户手动修改输入，清空已选
    if (value) {
      onChange(null);
    }
    setOpen(true);
    debouncedSearch(val);
  };

  const handleSelect = (item: StockSearchItem) => {
    onChange(item);
    setInput(`${item.Name} (${item.Code})`);
    setOpen(false);
    setResults([]);
  };

  const handleClear = () => {
    onChange(null);
    setInput('');
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  };

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < results.length) {
        handleSelect(results[highlightIndex]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-8 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          placeholder={placeholder}
          value={input}
          onChange={handleInputChange}
          onFocus={() => {
            if (input.trim().length > 0) {
              setOpen(true);
              debouncedSearch(input);
            }
          }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
        {input && (
          <button
            onClick={handleClear}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-slate-700 text-slate-500 hover:text-slate-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 下拉列表 */}
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg shadow-xl max-h-60 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-4 text-xs text-slate-500">
              <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin mr-2" />
              搜索中...
            </div>
          ) : results.length === 0 ? (
            <div className="text-center py-4 text-xs text-slate-500">
              {input.trim() ? '未找到匹配结果' : '输入股票代码、名称或拼音搜索'}
            </div>
          ) : (
            results.map((item, index) => (
              <button
                key={item.QuoteID}
                className={`w-full flex items-center justify-between px-3 py-2.5 text-xs text-left transition-colors ${
                  index === highlightIndex
                    ? 'bg-blue-600/30 text-blue-200'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setHighlightIndex(index)}
              >
                <span className="font-medium">
                  {item.Name}{' '}
                  <span className="text-slate-500 font-normal">({item.Code})</span>
                </span>
                <span className="px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400 text-[10px]">
                  {item.SecurityTypeName}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}