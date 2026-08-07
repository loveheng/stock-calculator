import React, { useState, useMemo } from 'react';
import { TrendingUp, TrendingDown, Trash2, AlertTriangle, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import { useAppStore } from '../store';
import ConfirmModal from '../components/ui/ConfirmModal';

type TimeFilter = 'all' | '7d' | '30d';

export default function Statistics() {
  const { tRecords, clearTRecords, removeTRecord, positions } = useAppStore();
  const [tab, setTab] = useState<'trades' | 'positions'>('trades');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [expandedStocks, setExpandedStocks] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);

  // 时间筛选
  const filteredRecords = useMemo(() => {
    const now = Date.now();
    return tRecords.filter((r) => {
      const t = new Date(r.timestamp).getTime();
      if (timeFilter === '7d') return now - t <= 7 * 24 * 60 * 60 * 1000;
      if (timeFilter === '30d') return now - t <= 30 * 24 * 60 * 60 * 1000;
      return true;
    });
  }, [tRecords, timeFilter]);

  // 按标的汇总
  const stockSummary = useMemo(() => {
    const map = new Map<string, { total: number; wins: number; fee: number; profit: number }>();
    filteredRecords.forEach((r) => {
      const key = r.stockName || '未命名';
      const item = map.get(key) || { total: 0, wins: 0, fee: 0, profit: 0 };
      item.total++;
      if (r.netProfit > 0) item.wins++;
      item.fee += r.totalFee;
      item.profit += r.netProfit;
      map.set(key, item);
    });
    return Array.from(map.entries()).sort((a, b) => b[1].profit - a[1].profit);
  }, [filteredRecords]);

  const toggleExpand = (stock: string) => {
    const next = new Set(expandedStocks);
    if (next.has(stock)) next.delete(stock);
    else next.add(stock);
    setExpandedStocks(next);
  };

  const handleDelete = (id: string) => {
    removeTRecord(id);
    setDeleteConfirmId(null);
  };

  const handleClear = () => {
    clearTRecords();
    setClearConfirm(false);
  };

  return (
    <div className="page-container space-y-5">
      {/* 时间筛选器 */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-slate-500" />
          <span className="text-sm text-slate-400">时间范围</span>
        </div>
        <div className="flex gap-2">
          {[
            { value: 'all' as TimeFilter, label: '全部' },
            { value: '7d' as TimeFilter, label: '近7天' },
            { value: '30d' as TimeFilter, label: '近30天' },
          ].map((f) => (
            <button
              key={f.value}
              onClick={() => setTimeFilter(f.value)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                timeFilter === f.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="card">
        <div className="tab-bar">
          <button
            className={`tab-btn ${tab === 'trades' ? 'active' : ''}`}
            onClick={() => setTab('trades')}
          >
            做T账本统计
          </button>
          <button
            className={`tab-btn ${tab === 'positions' ? 'active' : ''}`}
            onClick={() => setTab('positions')}
          >
            建仓履历统计
          </button>
        </div>
      </div>

      {tab === 'trades' ? (
        <div className="space-y-3">
          {/* 汇总卡片 */}
          <div className="card">
            <h3>按标的汇总</h3>
            {stockSummary.length === 0 ? (
              <p className="text-center text-slate-500 py-6 text-sm">暂无做T记录</p>
            ) : (
              <div className="space-y-2">
                {stockSummary.map(([stock, data]) => {
                  const winRate = data.total > 0 ? ((data.wins / data.total) * 100).toFixed(1) : '0.0';
                  return (
                    <div key={stock}>
                      <button
                        onClick={() => toggleExpand(stock)}
                        className="w-full flex items-center justify-between p-3 bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          {expandedStocks.has(stock) ? (
                            <ChevronUp className="w-4 h-4 text-slate-500" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-slate-500" />
                          )}
                          <span className="font-medium text-slate-200">{stock}</span>
                          <span className="text-xs text-slate-500">{data.total}笔</span>
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                          <span className="text-slate-400">
                            胜率 <span className="text-green-400">{winRate}%</span>
                          </span>
                          <span className="text-slate-400">
                            费用 <span className="text-red-400">¥{data.fee.toFixed(2)}</span>
                          </span>
                          <span className={data.profit >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {data.profit >= 0 ? '+' : ''}¥{data.profit.toFixed(2)}
                          </span>
                        </div>
                      </button>

                      {/* 展开明细 */}
                      {expandedStocks.has(stock) && (
                        <div className="mt-1 space-y-1 pl-4">
                          {filteredRecords
                            .filter((r) => (r.stockName || '未命名') === stock)
                            .map((r) => (
                              <div
                                key={r.id}
                                className="flex items-center justify-between p-2.5 bg-slate-900/50 rounded-lg text-xs"
                              >
                                <div className="flex items-center gap-3">
                                  <span className="text-slate-500">
                                    {new Date(r.timestamp).toLocaleDateString()}
                                  </span>
                                  <span className={`px-1.5 py-0.5 rounded ${
                                    r.mode === 'long'
                                      ? 'bg-red-500/20 text-red-400'
                                      : 'bg-green-500/20 text-green-400'
                                  }`}>
                                    {r.mode === 'long' ? '正T' : '倒T'}
                                  </span>
                                  <span className="text-slate-400">
                                    ¥{r.buyPrice.toFixed(2)} → ¥{r.sellPrice.toFixed(2)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <span className={r.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}>
                                    {r.netProfit >= 0 ? '+' : ''}¥{r.netProfit.toFixed(2)}
                                  </span>
                                  <button
                                    onClick={() => setDeleteConfirmId(r.id)}
                                    className="p-1 rounded hover:bg-slate-800 text-slate-600 hover:text-red-400"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 清空按钮 */}
          {tRecords.length > 0 && (
            <button
              onClick={() => setClearConfirm(true)}
              className="btn btn-outline btn-block text-red-400 border-red-500/30 hover:bg-red-500/10"
            >
              <Trash2 className="w-4 h-4" />
              清空所有做T记录
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* 进行中 */}
          <div className="card">
            <h3>进行中建仓</h3>
            {positions.filter((p) => !p.isClosed).length === 0 ? (
              <p className="text-center text-slate-500 py-6 text-sm">暂无进行中的建仓</p>
            ) : (
              positions.filter((p) => !p.isClosed).map((pos) => (
                <div key={pos.id} className="p-3 bg-slate-900 rounded-lg mb-2">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-slate-200">{pos.stockName}</span>
                    <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">进行中</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-slate-400">
                    <span>成本 ¥{pos.currentCost.toFixed(3)}</span>
                    <span>{pos.currentAmount.toLocaleString()}股</span>
                    <span>共{pos.batches.length}次操作</span>
                  </div>
                  {/* 操作时间轴 */}
                  <div className="mt-3 space-y-1.5">
                    {pos.batches.map((batch) => (
                      <div key={batch.id} className="flex items-center gap-3 text-xs text-slate-500">
                        <div className="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0" />
                        <span className={`px-1.5 py-0.5 rounded ${
                          batch.type === 'open' ? 'bg-blue-500/20 text-blue-400' :
                          batch.type === 'add' ? 'bg-green-500/20 text-green-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {batch.type === 'open' ? '建仓' : batch.type === 'add' ? '加仓' : '减仓'}
                        </span>
                        <span>¥{batch.price.toFixed(3)} × {Math.abs(batch.amount)}股</span>
                        <span className="ml-auto">{new Date(batch.timestamp).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 已结案 */}
          <div className="card">
            <h3>已结案建仓</h3>
            {positions.filter((p) => p.isClosed).length === 0 ? (
              <p className="text-center text-slate-500 py-6 text-sm">暂无已结案的建仓</p>
            ) : (
              positions.filter((p) => p.isClosed).map((pos) => (
                <div key={pos.id} className="p-3 bg-slate-900/50 rounded-lg mb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm text-slate-400">{pos.stockName}</span>
                      <span className="ml-2 text-xs text-slate-600">
                        ¥{pos.currentCost.toFixed(3)} × {pos.currentAmount.toLocaleString()}股
                      </span>
                    </div>
                    <span className="text-xs text-slate-500">
                      {pos.closedAt ? new Date(pos.closedAt).toLocaleDateString() : ''}
                    </span>
                  </div>
                  {/* 操作时间轴 */}
                  <div className="mt-2 space-y-1">
                    {pos.batches.map((batch) => (
                      <div key={batch.id} className="flex items-center gap-3 text-xs text-slate-500">
                        <div className="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0" />
                        <span className={`px-1.5 py-0.5 rounded ${
                          batch.type === 'open' ? 'bg-blue-500/20 text-blue-400' :
                          batch.type === 'add' ? 'bg-green-500/20 text-green-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {batch.type === 'open' ? '建仓' : batch.type === 'add' ? '加仓' : '减仓'}
                        </span>
                        <span>¥{batch.price.toFixed(3)} × {Math.abs(batch.amount)}股</span>
                        <span className="ml-auto">{new Date(batch.timestamp).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 删除确认 */}
      <ConfirmModal
        open={deleteConfirmId !== null}
        title="删除记录"
        message="确认删除该条做T记录？删除后不可恢复。"
        confirmText="确认删除"
        danger
        onConfirm={() => deleteConfirmId && handleDelete(deleteConfirmId)}
        onCancel={() => setDeleteConfirmId(null)}
      />

      {/* 清空确认 */}
      <ConfirmModal
        open={clearConfirm}
        title="清空所有记录"
        message="确认清空所有做T记录？此操作不可恢复！"
        confirmText="确认清空"
        danger
        onConfirm={handleClear}
        onCancel={() => setClearConfirm(false)}
      />
    </div>
  );
}