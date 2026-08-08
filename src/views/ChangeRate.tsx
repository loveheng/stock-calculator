import React, { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { calcChangeRate, calcTargetPrice, calcLadder } from '../utils/mathUtils';
import type { LadderItem } from '../utils/mathUtils';

type CalcMode = 'A' | 'B';
type BoardPreset = '+10' | '-10' | '+20' | '-20' | 'custom';

interface BoardOption {
  key: BoardPreset;
  label: string;
  rate: number | null;
}

const BOARD_OPTIONS: BoardOption[] = [
  { key: '+10', label: '主板涨 10%', rate: 10 },
  { key: '-10', label: '主板跌 10%', rate: -10 },
  { key: '+20', label: '科创/创业涨 20%', rate: 20 },
  { key: '-20', label: '科创/创业跌 20%', rate: -20 },
  { key: 'custom', label: '自定义', rate: null },
];

/** 过滤非数字字符（允许小数点，仅允许首个负号，用于涨跌幅输入） */
const sanitizeSignedDecimal = (value: string): string =>
  value
    .replace(/[^\d.\-]/g, '')
    .replace(/(?!^)-/g, '')
    .replace(/(\..*)\./g, '$1');

/** 过滤非数字字符（仅数字与小数点，用于价格/数值输入） */
const sanitizeDecimal = (value: string): string =>
  value
    .replace(/[^\d.]/g, '')
    .replace(/(\..*)\./g, '$1');

/** 过滤非数字字符（仅正整数，用于天数输入） */
const sanitizeInteger = (value: string): string => value.replace(/[^\d]/g, '');

export default function ChangeRate() {
  // 公共输入：基准价格
  const [basePrice, setBasePrice] = useState('');

  // 模式 A：输入涨跌幅 → 输出目标价格
  const [percentInput, setPercentInput] = useState('');

  // 模式 B：输入目标价格 → 输出涨跌幅
  const [targetPrice, setTargetPrice] = useState('');

  // 计算模式切换
  const [mode, setMode] = useState<CalcMode>('A');

  // 即时阶梯：方向拆分的快捷预设
  const [board, setBoard] = useState<BoardPreset>('+10');

  // 自定义涨跌幅：正负号切换 + 纯数字输入
  const [customSign, setCustomSign] = useState<'+' | '-'>('+');
  const [customValue, setCustomValue] = useState('');

  // 连续天数 N
  const [days, setDays] = useState('3');

  // 模式 A：按涨跌幅计算目标价格
  const targetResult = useMemo(() => {
    if (mode !== 'A' || !basePrice || !percentInput) return null;
    const base = Number(basePrice);
    const pct = Number(percentInput);
    if (!isFinite(base) || base <= 0 || !isFinite(pct)) return null;
    return calcTargetPrice(base, pct);
  }, [mode, basePrice, percentInput]);

  // 模式 B：按目标价格计算涨跌幅
  const changeResult = useMemo(() => {
    if (mode !== 'B' || !basePrice || !targetPrice) return null;
    const base = Number(basePrice);
    const target = Number(targetPrice);
    if (!isFinite(base) || base <= 0 || !isFinite(target)) return null;
    return calcChangeRate(base, target);
  }, [mode, basePrice, targetPrice]);

  // 连续阶梯计算：实时响应，即时更新
  const { ladder, rate } = useMemo<{ ladder: LadderItem[]; rate: number | null }>(() => {
    const base = Number(basePrice);
    const d = Math.max(1, Math.min(30, Number(days) || 1));
    if (!isFinite(base) || base <= 0) return { ladder: [], rate: null };

    let r: number | null = null;
    if (board === 'custom') {
      const v = Number(customValue);
      if (!isFinite(v) || v <= 0) return { ladder: [], rate: null };
      r = customSign === '-' ? -v : v;
    } else {
      r = BOARD_OPTIONS.find((o) => o.key === board)?.rate ?? null;
    }

    if (r === null || r === 0) return { ladder: [], rate: null };
    return { ladder: calcLadder(base, d, r), rate: r };
  }, [basePrice, days, board, customSign, customValue]);

  const isUp = (rate ?? 0) >= 0;
  const lastItem = ladder.length > 0 ? ladder[ladder.length - 1] : null;

  const toggleCustomSign = () => {
    setCustomSign((s) => (s === '+' ? '-' : '+'));
  };

  return (
    <div className="page-container space-y-5">
      {/* ========== 涨跌幅计算 ========== */}
      <div className="card">
        <h3>涨跌幅计算</h3>

        {/* 模式切换 */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <button
            onClick={() => setMode('A')}
            className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              mode === 'A'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            按涨跌幅计算目标价
          </button>
          <button
            onClick={() => setMode('B')}
            className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              mode === 'B'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <TrendingDown className="w-4 h-4" />
            按目标价计算涨跌幅
          </button>
        </div>

        {/* 基准价格 */}
        <div className="form-group">
          <label>基准价格（元）</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="输入基准价格"
            value={basePrice}
            onChange={(e) => setBasePrice(sanitizeDecimal(e.target.value))}
          />
        </div>

        {/* 模式 A：涨跌幅输入 */}
        {mode === 'A' ? (
          <div className="form-group">
            <label>涨跌幅（%）</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="如 10 表示 +10%，-5 表示 -5%"
              value={percentInput}
              onChange={(e) => setPercentInput(sanitizeSignedDecimal(e.target.value))}
            />
          </div>
        ) : (
          /* 模式 B：目标价格输入 */
          <div className="form-group">
            <label>目标价格（元）</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="输入目标价格"
              value={targetPrice}
              onChange={(e) => setTargetPrice(sanitizeDecimal(e.target.value))}
            />
          </div>
        )}

        {/* 模式 A 结果 */}
        {targetResult && (
          <div className="mt-4 p-4 bg-slate-900 rounded-lg">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs text-slate-500">目标价格</span>
                <p className="text-lg font-bold text-blue-400">
                  ¥{targetResult.target.toFixed(3)}
                </p>
              </div>
              <div>
                <span className="text-xs text-slate-500">涨跌绝对金额</span>
                <p className={`text-lg font-bold ${targetResult.diff >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {targetResult.diff >= 0 ? '+' : ''}{targetResult.diff.toFixed(3)}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 模式 B 结果 */}
        {changeResult && (
          <div className="mt-4 p-4 bg-slate-900 rounded-lg">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs text-slate-500">涨跌幅</span>
                <p className={`text-lg font-bold ${changeResult.percent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {changeResult.percent >= 0 ? '+' : ''}{changeResult.percent.toFixed(2)}%
                </p>
              </div>
              <div>
                <span className="text-xs text-slate-500">涨跌绝对金额</span>
                <p className={`text-lg font-bold ${changeResult.diff >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {changeResult.diff >= 0 ? '+' : ''}{changeResult.diff.toFixed(3)}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ========== 连续涨跌停阶梯 ========== */}
      <div className="card">
        <h3>连续涨跌停阶梯</h3>

        {/* 方向拆分的快捷预设（桌面一行5个 / 移动端自动2列换行） */}
        <div className="grid grid-cols-5 gap-2 mb-4">
          {BOARD_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setBoard(opt.key)}
              className={`min-h-11 px-2 py-2.5 rounded-xl text-xs font-medium transition-all whitespace-nowrap ${
                board === opt.key
                  ? 'bg-blue-600 text-white shadow-lg'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* 自定义输入区（动画展开，单行 Inline：± 按钮 + 数字输入框 + %） */}
        <div
          className={`grid transition-all duration-300 ease-in-out ${
            board === 'custom' ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="overflow-hidden">
            <div className="pb-4">
              <div className="flex items-center gap-2.5">
                {/* 正负号切换按钮（触控热区 ≥44px） */}
                <button
                  type="button"
                  onClick={toggleCustomSign}
                  aria-label="切换正负号"
                  className={`w-12 h-12 shrink-0 rounded-xl text-xl font-bold border transition-all ${
                    customSign === '+'
                      ? 'border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                      : 'border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20'
                  }`}
                >
                  {customSign}
                </button>
                {/* 数字输入框（移除原生微调箭头，Focus 蓝色描边） */}
                <input
                  type="text"
                  inputMode="decimal"
                  className="flex-1 appearance-none px-3 py-3 md:py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-sm md:text-base text-slate-200 outline-none transition-colors duration-200 placeholder:text-slate-600 focus:border-blue-500 focus:shadow-[0_0_0_2px_rgba(59,130,246,0.2)]"
                  placeholder="输入涨跌幅数值，如 7.5"
                  value={customValue}
                  onChange={(e) => setCustomValue(sanitizeDecimal(e.target.value))}
                />
                <span className="shrink-0 text-sm font-medium text-slate-400 select-none">%</span>
              </div>
            </div>
          </div>
        </div>

        {/* 连续天数 N */}
        <div className="form-group">
          <label>连续天数 N（最大30天）</label>
          <input
            type="text"
            inputMode="numeric"
            placeholder="输入连续天数，如 5"
            value={days}
            maxLength={2}
            onChange={(e) => setDays(sanitizeInteger(e.target.value))}
          />
        </div>

        {/* 阶梯摘要（移动端紧凑，超长截断不折行） */}
        {rate !== null && lastItem && (
          <div className="mt-4 p-3 bg-slate-900 rounded-lg">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="min-w-0">
                <span className="text-xs text-slate-500">单日涨跌幅</span>
                <p className={`text-sm font-bold truncate tabular-nums ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                  {isUp ? '+' : ''}{rate.toFixed(2)}%
                </p>
              </div>
              <div className="min-w-0">
                <span className="text-xs text-slate-500">第{days || 0}天价格</span>
                <p className="text-sm font-bold text-blue-400 truncate tabular-nums">¥{lastItem.price.toFixed(3)}</p>
              </div>
              <div className="min-w-0">
                <span className="text-xs text-slate-500">累计涨跌幅</span>
                <p className={`text-sm font-bold truncate tabular-nums ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                  {lastItem.cumulativePercent >= 0 ? '+' : ''}
                  {lastItem.cumulativePercent.toFixed(2)}%
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 每日阶梯明细（移动端紧凑卡片，数字等宽不折行） */}
        {ladder.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {ladder.map((item) => (
              <div
                key={item.day}
                className="flex items-center justify-between gap-2 p-2.5 bg-slate-900/60 rounded-lg text-sm"
              >
                <span className="text-slate-400 w-16 shrink-0">第{item.day}天</span>
                <span className={`font-medium whitespace-nowrap tabular-nums ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                  {item.cumulativePercent >= 0 ? '+' : ''}
                  {item.cumulativePercent.toFixed(2)}%
                </span>
                <span className="font-mono text-slate-200 whitespace-nowrap tabular-nums">¥{item.price.toFixed(3)}</span>
                <span className={`text-xs w-24 text-right shrink-0 whitespace-nowrap tabular-nums ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                  {item.diff >= 0 ? '+' : ''}¥{item.diff.toFixed(3)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
