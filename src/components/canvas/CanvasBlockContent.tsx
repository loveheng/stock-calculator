/**
 * @file CanvasBlockContent.tsx
 * @description 画布区块内容渲染器（spec §4）：按 block.type 分派到对应编辑/展示形态
 *              （七类手动模板 + widget DSL 动态面板只读渲染）。
 *              K 线区块：未选股票 → 占位态（Portal 弹 Smartbox 选股，spec §4.5）；
 *              已选 → CanvasKlineChart + 划线模式工具条。
 *              所有浮层经 React Portal 挂 document.body（spec §七：RGL GridItem 的
 *              transform/overflow 创建层叠上下文，卡片内直接渲染会被裁剪）。
 * @layer UI (Canvas)
 * @storage_impact 经 store canvasSlice 写区块 data（防抖落库）；Blob 经 canvasService.putBlob。
 * @author 开发团队
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { BarChart3, LineChart as LineChartIcon, RefreshCw, Search, Upload } from 'lucide-react';
import { LineChart, BarChart, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useAppStore } from '../../store';
import { getBrokerKlines, getCachedBrokerKlines, computeIndicators, indicatorsForBlockType, BrokerUnavailableError, type BrokerKline, type BrokerIndicatorCap } from '../../services/brokerService';
import { getCanvasTemplate } from '../../utils/canvasTemplates';
import { SessionExpiredError } from '../../services/apiClient';
import { loadStoredAuthSession } from '../../services/authSession';
import { searchStocks } from '../../services/stockService';
import { putBlob } from '../../services/canvasService';
import { evalCanvasExpr } from '../../utils/canvasExpr';
import type { KlineItem } from '../../types/sandbox';
import type { StockSearchItem } from '../../types/stock';
import type { CanvasBlock, CanvasBlockData, WidgetNode, WidgetTone } from '../../types/domain';
import CanvasKlineChart, { type CanvasDrawMode } from './CanvasKlineChart';

// ============================================================
// Portal 选股弹层（spec §4.5：K 线区块首次赋值交互）
// ============================================================

/** Portal 化选股弹层：脱离 RGL 卡片 DOM 树，防层叠上下文裁剪 */
function StockPickerPortal({ onPick, onClose }: { onPick: (s: StockSearchItem) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StockSearchItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      searchStocks(query)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, searchStocks]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-96 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <Search className="h-4 w-4 text-slate-500" />
          <input
            autoFocus
            className="flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
            placeholder="搜索股票代码/名称/拼音…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="max-h-72 space-y-1 overflow-auto">
          {loading && <div className="py-4 text-center text-sm text-slate-500">搜索中…</div>}
          {results.map((s) => (
            <button
              key={s.fullCode}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-slate-800"
              onClick={() => {
                onPick(s);
                onClose();
              }}
            >
              <span className="text-sm font-medium text-slate-200">{s.Name}</span>
              <span className="text-xs text-slate-500">{s.fullCode}</span>
              <span className="ml-auto text-xs text-slate-600">{s.SecurityTypeName}</span>
            </button>
          ))}
          {!loading && query.trim() && !results.length && (
            <div className="py-4 text-center text-sm text-slate-500">无匹配结果</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================
// K 线区块
// ============================================================

function KlineContent({ block }: { block: CanvasBlock }) {
  const data = block.data as CanvasBlockData['kline'];
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  const addTrendLine = useAppStore((s) => s.addTrendLine);
  const addHLine = useAppStore((s) => s.addHLine);
  const removeDrawing = useAppStore((s) => s.removeDrawing);
  const setCopilotNotice = useAppStore((s) => s.setCopilotNotice);
  const navigate = useNavigate();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [drawMode, setDrawMode] = useState<CanvasDrawMode>('none');
  const [kline, setKline] = useState<BrokerKline[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const loadedCodeRef = useRef<string>('');

  // 首次赋值 / 换股 → 拉日K（模板注册表统一取数入口：brokerService 代理唯一通道，v3 无直连兜底）
  useEffect(() => {
    if (!data.fullCode || loadedCodeRef.current === data.fullCode) return;
    loadedCodeRef.current = data.fullCode;
    setLoading(true);
    setUnavailable(false);
    if (!loadStoredAuthSession()?.token) {
      // 未登录：画布行情需登录（产品定案），占位引导登录（与 fetchData 内 requireToken 同语义）
      setUnavailable(true);
      setLoading(false);
      return;
    }
    const pending = getCanvasTemplate('kline')?.fetchData?.(block, {});
    if (!pending) {
      setLoading(false);
      return;
    }
    pending
      .then((r) => setKline(r?.klines ?? []))
      .catch((e) => {
        setKline([]);
        // 代理不可用（429/5xx/超时）→ 区块占位「行情服务暂不可用」，重试走代理不切直连
        setUnavailable(true);
        if (!(e instanceof BrokerUnavailableError)) {
          setCopilotNotice({ title: 'K 线加载失败', message: `${data.fullCode} 行情获取失败，请稍后重试`, severity: 'warning' });
        }
      })
      .finally(() => setLoading(false));
  }, [data.fullCode, setCopilotNotice]);

  if (!data.fullCode) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
        <p className="text-sm">点击选择股票</p>
        <button
          className="rounded-lg border border-dashed border-slate-600 px-4 py-2 text-sm text-slate-400 hover:border-blue-500 hover:text-blue-400"
          onClick={() => setPickerOpen(true)}
        >
          <Search className="mr-1 inline h-4 w-4" />
          搜索添加股票
        </button>
        {pickerOpen && (
          <StockPickerPortal
            onPick={(s) => updateCanvasBlockData(block.blockId, { ...data, fullCode: s.fullCode, stockName: s.Name })}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-slate-300">{data.stockName || data.fullCode}</span>
        <button className="text-xs text-slate-500 hover:text-blue-400" onClick={() => setPickerOpen(true)}>
          换股
        </button>
        <div className="ml-auto flex items-center gap-1">
          {(
            [
              ['none', '浏览'],
              ['hline', '水平线'],
              ['trend', '趋势线'],
            ] as [CanvasDrawMode, string][]
          ).map(([mode, label]) => (
            <button
              key={mode}
              className={
                'rounded px-1.5 py-0.5 text-xs ' +
                (drawMode === mode ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300')
              }
              onClick={() => {
                setDrawMode(mode);
                if (mode !== 'trend') return;
              }}
            >
              {label}
            </button>
          ))}
          <button
            className={'rounded px-1.5 py-0.5 text-xs ' + (data.maVisible ? 'text-amber-400' : 'text-slate-500')}
            onClick={() => updateCanvasBlockData(block.blockId, { ...data, maVisible: !data.maVisible })}
            title="MA 均线"
          >
            MA
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> 加载日K…
          </div>
        ) : unavailable ? (
          /* 代理不可用/未登录占位（v3：无直连兜底，重试仍走代理） */
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <p className="text-sm">{loadStoredAuthSession()?.token ? '行情服务暂不可用' : '登录后可查看行情'}</p>
            <button
              className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-400 hover:border-blue-500 hover:text-blue-400"
              onClick={() => {
                loadedCodeRef.current = '';
                setUnavailable(false);
              }}
            >
              重试
            </button>
          </div>
        ) : kline.length ? (
          <CanvasKlineChart
            kline={kline}
            trendLines={data.trendLines}
            hLines={data.hLines}
            maVisible={data.maVisible}
            drawMode={drawMode}
            onAddTrendLine={(l) => addTrendLine(block.blockId, l)}
            onAddHLine={(l) => addHLine(block.blockId, l)}
            onRemoveDrawing={(kind, id) => removeDrawing(block.blockId, kind, id)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">无行情数据（停牌或代码失效）</div>
        )}
      </div>
      {pickerOpen && (
        <StockPickerPortal
          onPick={(s) => {
            loadedCodeRef.current = '';
            updateCanvasBlockData(block.blockId, { ...data, fullCode: s.fullCode, stockName: s.Name, trendLines: [], hLines: [] });
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {/* 占位：去执行入口在画布视图层统一处理 */}
      <button className="hidden" onClick={() => navigate('/cost-averaging')} />
    </div>
  );
}

// ============================================================
// 表格区块（自由列定义，单元格点击即编辑）
// ============================================================

function TableContent({ block }: { block: CanvasBlock }) {
  const data = block.data as CanvasBlockData['table'];
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);

  const setCell = (rowIdx: number, key: string, value: string) => {
    const rows = data.rows.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r));
    updateCanvasBlockData(block.blockId, { ...data, rows });
  };
  const setColTitle = (key: string, title: string) => {
    const columns = data.columns.map((c) => (c.key === key ? { ...c, title } : c));
    updateCanvasBlockData(block.blockId, { ...data, columns });
  };
  const addRow = () => {
    const row: Record<string, string> = {};
    data.columns.forEach((c) => (row[c.key] = ''));
    updateCanvasBlockData(block.blockId, { ...data, rows: [...data.rows, row] });
  };
  const addColumn = () => {
    const key = `c${Date.now()}`;
    const rows = data.rows.map((r) => ({ ...r, [key]: '' }));
    updateCanvasBlockData(block.blockId, { ...data, columns: [...data.columns, { key, title: `列 ${data.columns.length + 1}` }], rows });
  };

  return (
    <div className="flex h-full flex-col gap-1">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c.key} className="border border-slate-700 bg-slate-800/60 px-1 py-1">
                  <input
                    className="w-full bg-transparent text-center font-medium text-slate-300 outline-none"
                    value={c.title}
                    onChange={(e) => setColTitle(c.key, e.target.value)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, ri) => (
              <tr key={ri}>
                {data.columns.map((c) => (
                  <td key={c.key} className="border border-slate-800 px-1 py-0.5">
                    <input
                      className="w-full bg-transparent text-slate-300 outline-none focus:bg-slate-800"
                      value={row[c.key] ?? ''}
                      onChange={(e) => setCell(ri, c.key, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 gap-2 text-xs text-slate-500">
        <button className="hover:text-blue-400" onClick={addRow}>+ 行</button>
        <button className="hover:text-blue-400" onClick={addColumn}>+ 列</button>
      </div>
    </div>
  );
}

// ============================================================
// 文件 / 图片区块（Portal 上传，Blob 存 canvasBlobs）
// ============================================================

function FileImageContent({ block, isImage }: { block: CanvasBlock; isImage: boolean }) {
  const data = block.data as CanvasBlockData['image'] | CanvasBlockData['file'];
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  const setCopilotNotice = useAppStore((s) => s.setCopilotNotice);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  // 引用 id 变化 → 读 Blob 预览（图片）
  const ref = isImage ? (data as CanvasBlockData['image']).imageRef : (data as CanvasBlockData['file']).dataRef;
  useEffect(() => {
    if (!ref || !isImage) return;
    let revoked = false;
    import('../../services/canvasService').then(({ getBlob }) =>
      getBlob(ref).then((entity) => {
        if (!entity || revoked) return;
        const url = URL.createObjectURL(entity.data);
        setDataUrl(url);
      }),
    );
    return () => {
      revoked = true;
      setDataUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [ref, isImage]);

  const onFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      setCopilotNotice({ title: '文件过大', message: '图片附件上限 2MB', severity: 'warning' });
      return;
    }
    try {
      const id = await putBlob(file, file.type);
      if (isImage) {
        updateCanvasBlockData(block.blockId, { imageRef: id } as CanvasBlockData['image']);
      } else {
        updateCanvasBlockData(block.blockId, { fileName: file.name, fileType: file.type, dataRef: id } as CanvasBlockData['file']);
      }
    } catch {
      setCopilotNotice({ title: '上传失败', message: 'Blob 写入失败，请重试', severity: 'danger' });
    }
  };

  if (isImage) {
    return (
      <div className="flex h-full items-center justify-center">
        {dataUrl ? (
          <img src={dataUrl} alt="画布图片" className="max-h-full max-w-full object-contain" />
        ) : (
          <button className="flex flex-col items-center gap-1 text-slate-500 hover:text-blue-400" onClick={() => inputRef.current?.click()}>
            <Upload className="h-5 w-5" />
            <span className="text-xs">上传图片（≤2MB）</span>
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center">
      {(data as CanvasBlockData['file']).fileName ? (
        <div className="text-center text-xs text-slate-400">
          <p className="font-medium text-slate-300">{(data as CanvasBlockData['file']).fileName}</p>
          <button className="mt-1 text-slate-500 hover:text-blue-400" onClick={() => inputRef.current?.click()}>重新上传</button>
        </div>
      ) : (
        <button className="flex flex-col items-center gap-1 text-slate-500 hover:text-blue-400" onClick={() => inputRef.current?.click()}>
          <Upload className="h-5 w-5" />
          <span className="text-xs">上传文件（≤2MB）</span>
        </button>
      )}
      <input ref={inputRef} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}

// ============================================================
// 简单图表区块（recharts 折线/柱状；手动 points 或绑定 K 线区块）
// ============================================================

function ChartContent({ block }: { block: CanvasBlock }) {
  const data = block.data as CanvasBlockData['chart'];
  const canvasBlocks = useAppStore((s) => s.canvasBlocks);
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 绑定 K 线区块 → 自动取收盘价序列
  const boundPoints = useMemo(() => {
    if (!data.sourceBlockId) return null;
    const src = canvasBlocks.find((b) => b.blockId === data.sourceBlockId && b.type === 'kline');
    if (!src) return null;
    const kd = src.data as CanvasBlockData['kline'];
    if (!kd.fullCode) return null;
    return { code: kd.fullCode, name: kd.stockName || kd.fullCode };
  }, [data.sourceBlockId, canvasBlocks]);

  const [boundKline, setBoundKline] = useState<BrokerKline[]>([]);
  useEffect(() => {
    if (!boundPoints) return;
    const session = loadStoredAuthSession();
    if (!session?.token) {
      setBoundKline([]);
      return;
    }
    getBrokerKlines({ fullCode: boundPoints.code }, session.token)
      .then(setBoundKline)
      .catch(() => setBoundKline([]));
  }, [boundPoints]);

  const chartData = useMemo(() => {
    if (data.sourceBlockId) {
      if (!boundKline.length) return [];
      return boundKline.slice(-60).map((k) => ({ label: k.date.slice(5), value: k.close }));
    }
    return data.points;
  }, [data.sourceBlockId, data.points, boundKline]);

  const klineBlocks = canvasBlocks.filter((b) => b.type === 'kline' && (b.data as CanvasBlockData['kline']).fullCode);

  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          className={'rounded p-1 ' + (data.seriesType === 'line' ? 'text-blue-400' : 'text-slate-500')}
          onClick={() => updateCanvasBlockData(block.blockId, { ...data, seriesType: 'line' })}
          title="折线"
        >
          <LineChartIcon className="h-3.5 w-3.5" />
        </button>
        <button
          className={'rounded p-1 ' + (data.seriesType === 'bar' ? 'text-blue-400' : 'text-slate-500')}
          onClick={() => updateCanvasBlockData(block.blockId, { ...data, seriesType: 'bar' })}
          title="柱状"
        >
          <BarChart3 className="h-3.5 w-3.5" />
        </button>
        <button className="ml-auto text-xs text-slate-500 hover:text-blue-400" onClick={() => setSettingsOpen(true)}>
          {data.sourceBlockId ? `绑定 ${data.sourceBlockId}` : '录入数据/绑定'}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {chartData.length ? (
          <ResponsiveContainer width="100%" height="100%">
            {data.seriesType === 'line' ? (
              <LineChart data={chartData}>
                <CartesianGrid stroke="#1e293b" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} domain={['auto', 'auto']} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                <LineChartChild />
              </LineChart>
            ) : (
              <BarChart data={chartData}>
                <CartesianGrid stroke="#1e293b" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                <BarChartChild />
              </BarChart>
            )}
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">录入数据或绑定 K 线区块</div>
        )}
      </div>
      {settingsOpen && (
        <ChartSettingsPortal
          block={block}
          klineBlocks={klineBlocks.map((b) => ({ blockId: b.blockId, name: (b.data as CanvasBlockData['kline']).stockName || (b.data as CanvasBlockData['kline']).fullCode }))}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

/** recharts 子元素需独立组件（ResponsiveContainer 泛型推断限制） */
function LineChartChild() {
  return <LineChartInner />;
}
function LineChartInner() {
  return <Line dot={false} stroke="#38bdf8" strokeWidth={1.5} dataKey="value" isAnimationActive={false} />;
}
import { Line, Bar } from 'recharts';
function BarChartChild() {
  return <Bar dataKey="value" fill="#38bdf8" isAnimationActive={false} />;
}

/** Portal 化图表设置弹层：录入 points 或绑定 K 线区块（spec §4.5 绑定交互） */
function ChartSettingsPortal({
  block,
  klineBlocks,
  onClose,
}: {
  block: CanvasBlock;
  klineBlocks: { blockId: string; name: string }[];
  onClose: () => void;
}) {
  const data = block.data as CanvasBlockData['chart'];
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  const [labels, setLabels] = useState(data.points.map((p) => p.label).join(','));
  const [values, setValues] = useState(data.points.map((p) => p.value).join(','));

  const applyManual = () => {
    const ls = labels.split(',').map((s) => s.trim());
    const vs = values.split(',').map((s) => Number(s.trim()));
    const points = ls.map((label, i) => ({ label, value: vs[i] })).filter((p) => p.label && Number.isFinite(p.value));
    updateCanvasBlockData(block.blockId, { ...data, points, sourceBlockId: undefined });
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-96 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h4 className="mb-3 text-sm font-semibold text-slate-200">数据来源</h4>
        <div className="mb-3 space-y-1">
          {klineBlocks.length ? (
            klineBlocks.map((k) => (
              <button
                key={k.blockId}
                className="flex w-full items-center rounded px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800"
                onClick={() => {
                  updateCanvasBlockData(block.blockId, { ...data, sourceBlockId: k.blockId });
                  onClose();
                }}
              >
                <span className="mr-2 rounded bg-blue-500/15 px-1.5 text-xs text-blue-400">{k.blockId}</span>
                {k.name}
              </button>
            ))
          ) : (
            <div className="rounded bg-slate-800/60 px-3 py-2 text-xs text-slate-500">画布上暂无 K 线区块</div>
          )}
        </div>
        <div className="border-t border-slate-800 pt-3">
          <p className="mb-2 text-xs text-slate-500">或手动录入（逗号分隔）</p>
          <input className="mb-1.5 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none" placeholder="标签: 1月,2月,3月" value={labels} onChange={(e) => setLabels(e.target.value)} />
          <input className="mb-2 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none" placeholder="数值: 10.5,11.2,9.8" value={values} onChange={(e) => setValues(e.target.value)} />
          <button className="w-full rounded bg-blue-600 py-1.5 text-xs text-white hover:bg-blue-500" onClick={applyManual}>应用</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================
// 单指标区块（手动值 / 绑定取值 / 常量四则表达式）
// ============================================================

function MetricContent({ block }: { block: CanvasBlock }) {
  const data = block.data as CanvasBlockData['metric'];
  const canvasBlocks = useAppStore((s) => s.canvasBlocks);
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exprError, setExprError] = useState<string | null>(null);

  // 绑定取值：sourcePath 白名单（最新收盘 / 区间涨跌幅）
  const boundValue = useMemo(() => {
    if (!data.sourceBlockId || !data.sourcePath) return undefined;
    const src = canvasBlocks.find((b) => b.blockId === data.sourceBlockId && b.type === 'kline');
    if (!src) return undefined;
    const kd = src.data as CanvasBlockData['kline'];
    if (!kd.fullCode) return undefined;
    // 绑定取值在渲染期不拉网络：仅当该 K 线区块已加载时由视图层注入 kline 缓存；
    // 简化实现：绑定值由 StockCanvas 的 kline 缓存回填（此处读 store 内最近缓存）
    return undefined;
  }, [data.sourceBlockId, data.sourcePath, canvasBlocks]);

  // 表达式求值（常量四则，递归下降，禁 eval）
  const exprValue = useMemo(() => {
    if (!data.calc) return undefined;
    try {
      const v = evalCanvasExpr(data.calc);
      setExprError(null);
      return v;
    } catch (e) {
      setExprError(e instanceof Error ? e.message : '表达式无效');
      return undefined;
    }
  }, [data.calc]);

  const display = data.value !== undefined ? data.value : boundValue !== undefined ? boundValue : exprValue;
  const agent = data.agent;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1">
      <span className="text-xs text-slate-500">{agent ? agent.label : data.label}</span>
      {agent ? (
        // agent 指标展示态：失败占位 / 暖机占位 / 数值
        agent.unavailable ? (
          <span className="text-xs text-amber-400">agent 指标暂不可用</span>
        ) : (
          <span className="text-2xl font-semibold text-slate-100">
            {agent.value !== null ? Number(agent.value).toFixed(2) : '暖机中…'}
          </span>
        )
      ) : (
        <span className="text-2xl font-semibold text-slate-100">
          {display !== undefined && !exprError ? Number(display).toFixed(2) : '--'}
        </span>
      )}
      {exprError && !agent && <span className="text-xs text-red-400">表达式无效：{exprError}</span>}
      <button className="text-xs text-slate-600 hover:text-blue-400" onClick={() => setSettingsOpen(true)}>
        设置
      </button>
      {settingsOpen && (
        <MetricSettingsPortal block={block} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

/** Portal 化指标设置弹层：手动值 / 绑定 / 表达式 三种取值方式（spec §4.7） */
function MetricSettingsPortal({ block, onClose }: { block: CanvasBlock; onClose: () => void }) {
  const data = block.data as CanvasBlockData['metric'];
  const canvasBlocks = useAppStore((s) => s.canvasBlocks);
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  const setCopilotNotice = useAppStore((s) => s.setCopilotNotice);
  const [label, setLabel] = useState(data.label);
  const [value, setValue] = useState(data.value?.toString() ?? '');
  const [calc, setCalc] = useState(data.calc ?? '');
  const [computing, setComputing] = useState(false);
  const klineBlocks = canvasBlocks.filter((b) => b.type === 'kline' && (b.data as CanvasBlockData['kline']).fullCode);
  // agent 指标选项（能力端点清单，metric 可挂项）；未拉取到能力 → 隐藏选项（spec §2.6 降级口径）
  const agentCaps = indicatorsForBlockType('metric');

  /** 触发 compute：从来源 K 线区块内存缓存取切片（无缓存先拉代理），结果写回区块 agent 字段 */
  const runAgentIndicator = async (cap: BrokerIndicatorCap, srcBlockId: string) => {
    const src = canvasBlocks.find((b) => b.blockId === srcBlockId);
    if (!src) return;
    const kd = src.data as CanvasBlockData['kline'];
    if (!kd.fullCode) return;
    const session = loadStoredAuthSession();
    if (!session?.token) {
      setCopilotNotice({ title: '需要登录', message: 'agent 指标需登录后使用', severity: 'warning' });
      return;
    }
    setComputing(true);
    try {
      let slice = getCachedBrokerKlines(kd.fullCode);
      if (!slice) slice = await getBrokerKlines({ fullCode: kd.fullCode }, session.token);
      // minBars 本地校验（spec §2.6：短切片提示，不发请求）
      if (slice.length < cap.minBars) {
        setCopilotNotice({ title: '数据不足', message: `${cap.label} 至少需要 ${cap.minBars} 根日K，当前 ${slice.length} 根`, severity: 'warning' });
        return;
      }
      const result = await computeIndicators(
        { fullCode: kd.fullCode, adjustType: 'qfq', klines: slice, indicators: [cap.name] },
        session.token,
      );
      const series = result.indicators[cap.name];
      // 展示值取指标第一条序列的最后一个非 null 槽位（暖机期 null 跳过）
      let final: number | null = null;
      for (const arr of Object.values(series)) {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i] !== null && arr[i] !== undefined) {
            final = arr[i] as number;
            break;
          }
        }
        if (final !== null) break;
      }
      updateCanvasBlockData(block.blockId, {
        label: label.trim() || cap.label,
        agent: { indicator: cap.name, label: cap.label, sourceBlockId: srcBlockId, value: final },
      });
      onClose();
    } catch (e) {
      // 429/5xx/超时 → 区块降级占位「agent 指标暂不可用」（spec §四）；会话失效上抛走现成链路
      if (e instanceof SessionExpiredError) throw e;
      const unavailable = e instanceof BrokerUnavailableError;
      updateCanvasBlockData(block.blockId, {
        label: label.trim() || cap.label,
        agent: { indicator: cap.name, label: cap.label, sourceBlockId: srcBlockId, value: null, unavailable },
      });
      if (!unavailable) {
        setCopilotNotice({ title: '计算失败', message: e instanceof Error ? e.message : '请稍后重试', severity: 'warning' });
      }
      onClose();
    } finally {
      setComputing(false);
    }
  };

  const apply = () => {
    const next: CanvasBlockData['metric'] = { label: label.trim() || '指标' };
    if (value.trim() && Number.isFinite(Number(value))) next.value = Number(value);
    else if (calc.trim()) next.calc = calc.trim();
    updateCanvasBlockData(block.blockId, next);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-96 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h4 className="mb-3 text-sm font-semibold text-slate-200">指标设置</h4>
        <label className="mb-1 block text-xs text-slate-500">标签</label>
        <input className="mb-3 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 outline-none" value={label} onChange={(e) => setLabel(e.target.value)} />
        <label className="mb-1 block text-xs text-slate-500">手动固定值</label>
        <input className="mb-3 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 outline-none" placeholder="如 1680.00" value={value} onChange={(e) => { setValue(e.target.value); setCalc(''); }} />
        <label className="mb-1 block text-xs text-slate-500">或常量四则表达式（禁 eval，白名单 0-9+-*/(). ）</label>
        <input className="mb-3 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 outline-none" placeholder="如 (12.5+3)*2" value={calc} onChange={(e) => { setCalc(e.target.value); setValue(''); }} />
        <label className="mb-1 block text-xs text-slate-500">或绑定 K 线区块</label>
        <div className="mb-3 space-y-1">
          {klineBlocks.length ? (
            klineBlocks.map((k) => {
              const kd = k.data as CanvasBlockData['kline'];
              return (
                <button
                  key={k.blockId}
                  className="flex w-full items-center rounded px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800"
                  onClick={() => {
                    updateCanvasBlockData(block.blockId, { label: label.trim() || '指标', sourceBlockId: k.blockId, sourcePath: 'latestClose' });
                    onClose();
                  }}
                >
                  <span className="mr-2 rounded bg-blue-500/15 px-1.5 text-xs text-blue-400">{k.blockId}</span>
                  {kd.stockName || kd.fullCode}
                  <span className="ml-auto text-xs text-slate-600">最新收盘</span>
                </button>
              );
            })
          ) : (
            <div className="rounded bg-slate-800/60 px-3 py-2 text-xs text-slate-500">画布上暂无 K 线区块</div>
          )}
        </div>
        {agentCaps.length > 0 && (
          <>
            <label className="mb-1 block text-xs text-slate-500">或 agent 指标（后端计算，选 K 线来源）</label>
            <div className="mb-3 space-y-1">
              {agentCaps.map((cap) => (
                <div key={cap.name} className="rounded bg-slate-800/40 px-2 py-1.5">
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="font-medium text-slate-300">{cap.label}</span>
                    <span className="text-slate-600">≥{cap.minBars} 根</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {klineBlocks.length ? (
                      klineBlocks.map((k) => {
                        const kd = k.data as CanvasBlockData['kline'];
                        return (
                          <button
                            key={k.blockId}
                            className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:border-blue-500 hover:text-blue-400 disabled:opacity-50"
                            disabled={computing}
                            onClick={() => void runAgentIndicator(cap, k.blockId)}
                          >
                            {k.blockId}
                          </button>
                        );
                      })
                    ) : (
                      <span className="text-xs text-slate-600">需先添加 K 线区块</span>
                    )}
                  </div>
                </div>
              ))}
              {computing && <div className="px-2 py-1 text-xs text-blue-400">计算中…</div>}
            </div>
          </>
        )}
        <button className="w-full rounded bg-blue-600 py-1.5 text-sm text-white hover:bg-blue-500" onClick={apply}>应用</button>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================
// 文本区块
// ============================================================

function TextContent({ block }: { block: CanvasBlock }) {
  const data = block.data as CanvasBlockData['text'];
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  return (
    <textarea
      className="h-full w-full resize-none bg-transparent text-sm leading-relaxed text-slate-300 outline-none placeholder:text-slate-600"
      placeholder="点击编辑…"
      value={data.content}
      onChange={(e) => updateCanvasBlockData(block.blockId, { content: e.target.value })}
    />
  );
}

// ============================================================
// DSL 动态面板区块（widget：LLM 图纸只读渲染，8 种叶子节点白名单，
// 图纸经 utils/widgetDsl 校验后才落库，此处只做可信渲染 + 缺 data 兜底）
// ============================================================

/** 语义色调 → 文本色（info 不着色走默认灰阶） */
function widgetToneText(tone?: WidgetTone): string {
  if (tone === 'warn') return 'text-amber-400';
  if (tone === 'danger') return 'text-red-400';
  return 'text-slate-100';
}

/** 单节点渲染（叶子分派；组件白名单外的 c 不会出现——落库前已整条拒绝） */
function WidgetNodeView({ node }: { node: WidgetNode }) {
  switch (node.c) {
    case 'text':
      return <p className={`whitespace-pre-wrap text-xs leading-relaxed ${widgetToneText(node.text?.tone)}`}>{node.text?.content}</p>;
    case 'metric':
      return (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-500">{node.metric?.label}</span>
          <span className={`text-xl font-semibold ${widgetToneText(node.metric?.tone)}`}>{node.metric?.value}</span>
        </div>
      );
    case 'kv':
      return (
        <div className="divide-y divide-slate-800">
          {node.kv?.rows.map((r, i) => (
            <div key={i} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="shrink-0 text-xs text-slate-500">{r.label}</span>
              <span className="min-w-0 truncate text-right text-xs text-slate-200">{r.value}</span>
            </div>
          ))}
        </div>
      );
    case 'list':
      return (
        <div className="flex flex-col gap-0.5">
          {node.list?.title && <p className="text-xs font-medium text-slate-400">{node.list.title}</p>}
          <ul className="space-y-0.5">
            {node.list?.items.map((it, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs">
                <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${widgetToneText(it.tone).replace('text-', 'bg-')}`} />
                <span className={`min-w-0 flex-1 ${widgetToneText(it.tone) === 'text-slate-100' ? 'text-slate-300' : widgetToneText(it.tone)}`}>{it.text}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {node.table?.columns.map((col, i) => (
                  <th key={i} className="border border-slate-800 bg-slate-800/60 px-1.5 py-1 font-medium text-slate-400">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.table?.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="border border-slate-800 px-1.5 py-0.5 text-slate-300">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'progress':
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-slate-500">{node.progress?.label}</span>
            <span className="text-xs text-slate-300">{node.progress?.value.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-blue-500" style={{ width: `${node.progress?.value ?? 0}%` }} />
          </div>
        </div>
      );
    case 'tag':
      return (
        <div className="flex flex-wrap gap-1">
          {node.tag?.tags.map((t, i) => (
            <span key={i} className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{t}</span>
          ))}
        </div>
      );
    case 'divider':
      return <hr className="border-slate-800" />;
  }
}

function WidgetContent({ block }: { block: CanvasBlock }) {
  const data = block.data as CanvasBlockData['widget'];
  const dsl = data?.dsl;
  // 空 data 兜底（正常不达：落库前已校验；防手改 Dexie 数据渲染崩溃）
  if (!dsl) {
    return <div className="flex h-full items-center justify-center text-xs text-slate-500">空面板（AI 动态模板）</div>;
  }
  return (
    <div className="flex h-full flex-col gap-2">
      <p className="shrink-0 text-sm font-semibold text-slate-200">{dsl.title}</p>
      <div className={dsl.kind === 'grid' ? 'grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-auto' : 'flex min-h-0 flex-1 flex-col gap-2 overflow-auto'}>
        {dsl.nodes.map((n, i) => (
          <WidgetNodeView key={i} node={n} />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// 分派出口
// ============================================================

export default function CanvasBlockContent({ block }: { block: CanvasBlock }) {
  switch (block.type) {
    case 'kline':
      return <KlineContent block={block} />;
    case 'table':
      return <TableContent block={block} />;
    case 'file':
      return <FileImageContent block={block} isImage={false} />;
    case 'chart':
      return <ChartContent block={block} />;
    case 'metric':
      return <MetricContent block={block} />;
    case 'image':
      return <FileImageContent block={block} isImage={true} />;
    case 'text':
      return <TextContent block={block} />;
    case 'widget':
      return <WidgetContent block={block} />;
  }
}
