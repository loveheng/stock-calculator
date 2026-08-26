import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useAppStore } from '../../store';
import { generateId, calcBatchExecution, recomputePositionSnapshot } from '../../store/utils';
import { calcTradeFees, matchSecurityKind } from '../../utils/mathUtils';
import { RiskController } from '../../risk/riskController';
import { parseClipboardText, enrichDraftRow, completeDedupCheck, buildHistoryFromStore, groupRowsByStock, inferPlanBind } from '../../services/importAdapter';
import { normalizeCode } from '../../utils/dedup';
import { parseOcrFile, extractImageFromClipboard, revokeObjectUrl, validateImage } from '../../services/ocrService';
import { generateTxFingerprint } from '../../utils/dedup';
import { mergeImportedTradesToPositions } from '../../utils/importMerger';
import type { ImportDraftRow, GroupRiskLevel } from '../../types/import';
import type { StockSearchItem } from '../../types/stock';
import type { PositionBatch } from '../../store/types';
import ImportToolbar from './ImportToolbar';
import StockImportCard from './StockImportCard';

export default function BatchImportPage() {
  const positions = useAppStore((s) => s.positions);
  const plannedOrders = useAppStore((s) => s.plannedOrders);
  const longTermRecords = useAppStore((s) => s.longTermRecords);
  const feeConfig = useAppStore((s) => s.feeConfig);
  const addBatch = useAppStore((s) => s.addBatch);
  const addStreamRecord = useAppStore((s) => s.addStreamRecord);
  const addPosition = useAppStore((s) => s.addPosition);
  const markPlanExecuted = useAppStore((s) => s.markPlanExecuted);

  const [rows, setRows] = useState<ImportDraftRow[]>([]);
  const [committing, setCommitting] = useState(false);
  const [allExpanded, setAllExpanded] = useState(true);
  const [riskFilterOn, setRiskFilterOn] = useState(false);
  const [ocrImageUrl, setOcrImageUrl] = useState<string | null>(null);
  const [ocrStatus, setOcrStatus] = useState<{ loading: boolean; message: string }>({ loading: false, message: '' });

  // ---- 自包含 Toast（与 TCalculator 相同的交互模式，但独立于路由） ----
  const [toast, setToast] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string, duration = 4000) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(msg);
    requestAnimationFrame(() => requestAnimationFrame(() => setToastVisible(true)));
    toastTimer.current = window.setTimeout(() => {
      setToastVisible(false);
      toastTimer.current = window.setTimeout(() => setToast(null), 300);
    }, duration);
  }, []);

  // 监听全局 app-toast 事件
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<string>).detail;
      showToast(msg, 4000);
    };
    window.addEventListener('app-toast', handler);
    return () => {
      window.removeEventListener('app-toast', handler);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, [showToast]);

  // 历史库指纹
  const history = useMemo(() => buildHistoryFromStore(positions, longTermRecords), [positions, longTermRecords]);

  // 按标的聚合
  const groups = useMemo(() => {
    const raw = groupRowsByStock(rows);
    return raw.map((g) => {
      const items = g.items;
      const first = items[0];
      const totalAmount = items.reduce((s, r) => s + r.price * r.amount, 0);
      const hasError = items.some((r) => r.validationStatus === 'ERROR' || (r.duplicateStatus === 'EXACT_DUPLICATE' && r.skipImport));
      const hasWarning = items.some((r) => r.validationStatus === 'WARNING' || r.duplicateStatus === 'POTENTIAL');
      const riskLevel: GroupRiskLevel = hasError ? 'ERROR' : hasWarning ? 'WARNING' : 'PASSED';
      return { key: g.key, items, name: first?.stockName || '', totalAmount, riskLevel };
    }).filter((g) => !riskFilterOn || g.riskLevel !== 'PASSED');
  }, [rows, riskFilterOn]);

  // 全局粘贴监听
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      // 文本粘贴
      const text = e.clipboardData?.getData('text/plain');
      if (text?.trim()) {
        e.preventDefault();
        await handlePasteText(text);
        return;
      }
      // 图片粘贴
      const imgFile = extractImageFromClipboard(e);
      if (imgFile) {
        e.preventDefault();
        await handleFileDrop(imgFile);
      }
    };
    document.addEventListener('paste', handler);
    return () => document.removeEventListener('paste', handler);
  }, [positions, plannedOrders, history]);

  // 键盘快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'BODY') {
        // 全局 Enter 不做特殊处理，避免干扰
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ---- 行操作 ----
  const addRow = useCallback((fullCode?: string, stockName?: string) => {
    const now = Date.now();
    const row: ImportDraftRow = {
      id: generateId(), fingerprint: '',
      timestamp: now, fullCode: fullCode || '', stockName: stockName || '',
      direction: 'buy', price: 0, amount: 0,
      targetCategory: 'LONG_TERM_BATCH',
      targetPositionId: undefined, targetPlannedOrderId: undefined,
      isNewPosition: true,
      duplicateStatus: 'UNIQUE', matchedRecordId: undefined, skipImport: false,
      validationStatus: 'PENDING', validationMessage: undefined, source: 'manual',
    };
    setRows((prev) => [...prev, row]);
  }, []);

  const updateRow = useCallback((id: string, patch: Partial<ImportDraftRow>) => {
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const updated = { ...r, ...patch };
      if (patch.fullCode !== undefined || patch.direction !== undefined || patch.price !== undefined || patch.amount !== undefined || patch.timestamp !== undefined) {
        updated.fingerprint = '';
        updated.duplicateStatus = 'UNIQUE';
        updated.matchedRecordId = undefined;
        updated.skipImport = false;
        updated.validationStatus = 'PENDING';
        updated.validationMessage = undefined;
        if (updated.fullCode && updated.price && updated.amount) {
          updated.fingerprint = generateTxFingerprint({ fullCode: updated.fullCode, direction: updated.direction, price: updated.price, amount: updated.amount, timestamp: updated.timestamp });
        }
      }
      return updated;
    }));
  }, []);

  const deleteRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  // ---- 粘贴/文件 ----
  const handlePasteText = useCallback(async (text?: string) => {
    const txt = text ?? (await navigator.clipboard.readText().catch(() => ''));
    if (!txt) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '⚠️ 剪贴板为空' }));
      return;
    }
    const raw = parseClipboardText(txt);
    if (raw.length === 0) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '⚠️ 剪贴板数据格式无法解析' }));
      return;
    }
    const newRows = raw.map((r) => {
      const ts = r.timestamp ? new Date(r.timestamp).getTime() : undefined;
      return enrichDraftRow({ fullCode: r.fullCode, direction: r.direction ?? 'buy', price: r.price ?? 0, amount: r.amount ?? 0, timestamp: ts, stockName: r.stockName }, positions, plannedOrders);
    });
    const deduped = completeDedupCheck(newRows, history);
    setRows((prev) => [...prev, ...deduped]);
    window.dispatchEvent(new CustomEvent('app-toast', { detail: `✅ 已导入 ${newRows.length} 条交易` }));
  }, [positions, plannedOrders, history]);

  const handleFileDrop = useCallback(async (file: File) => {
    // 文本/CSV 文件跳过图片校验
    const isImage = !file.type.startsWith('text/') && !/\.(txt|csv|tsv)$/i.test(file.name);

    if (isImage) {
      // 前端图片预检
      const validation = await validateImage(file);
      if (!validation.valid) {
        window.dispatchEvent(new CustomEvent('app-toast', { detail: `❌ ${validation.message}` }));
        return;
      }
    }

    // 设置 loading 状态
    setOcrStatus({ loading: true, message: isImage ? '正在校验图片尺寸与规格...' : '正在解析文件...' });

    try {
      if (isImage) {
        setOcrStatus({ loading: true, message: '正在智能提取交割单明细，请稍候...' });
      }
      const result = await parseOcrFile(file, parseClipboardText);
      if (result.previewUrl) setOcrImageUrl(result.previewUrl);
      const newRows = result.records.map((r) => {
        const ts = r.timestamp ? new Date(r.timestamp).getTime() : undefined;
        return enrichDraftRow({ fullCode: r.fullCode, direction: r.direction ?? 'buy', price: r.price ?? 0, amount: r.amount ?? 0, timestamp: ts, stockName: r.stockName }, positions, plannedOrders);
      });

      if (newRows.length === 0) {
        setOcrStatus({ loading: false, message: '' });
        window.dispatchEvent(new CustomEvent('app-toast', { detail: '❌ 未能从截图中识别到有效的成交记录，请确认是否为已成交流水明细' }));
        return;
      }

      const deduped = completeDedupCheck(newRows, history);
      setRows((prev) => [...prev, ...deduped]);
      setOcrStatus({ loading: false, message: `✅ 成功识别出 ${newRows.length} 笔成交记录，请核对明细` });
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `✅ 成功识别出 ${newRows.length} 笔成交记录` }));
    } catch (e: any) {
      setOcrStatus({ loading: false, message: '' });
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `❌ ${e.message}` }));
    }
  }, [positions, plannedOrders, history]);

  // ---- 批处理 ----
  const handleDedupAll = useCallback(() => {
    setRows((prev) => completeDedupCheck(prev, history));
  }, [history]);

  const handleValidateAll = useCallback(() => {
    setRows((prev) => prev.map((row) => {
      if (row.skipImport || !row.fullCode || !row.price || !row.amount) return row;
      if (row.targetCategory === 'SHORT_TERM_T') {
        const pos = positions.find((p) => p.id === row.targetPositionId);
        const { report } = RiskController.evaluateTTrade({
          sellAmount: row.direction === 'sell' ? row.amount : 0, pendingBuyAmount: row.direction === 'buy' ? row.amount : 0,
          availableForT: pos?.currentAmount ?? 0, price: row.price, fullCode: row.fullCode, direction: row.direction,
        });
        return { ...row, validationStatus: report.blocked ? 'ERROR' : report.ok ? 'PASSED' : 'WARNING' as const, validationMessage: report.summary };
      }
      if ((row.targetCategory === 'LONG_TERM_BATCH' || row.targetCategory === 'NEW_POSITION') && row.targetPositionId) {
        const pos = positions.find((p) => p.id === row.targetPositionId);
        const { report } = RiskController.evaluateBatch({
          amount: row.amount, type: row.direction === 'buy' ? 'add' : 'reduce',
          currentAmount: pos?.currentAmount, price: row.price, existingBatches: row.direction === 'buy' ? pos?.batches : undefined,
        });
        return { ...row, validationStatus: report.blocked ? 'ERROR' : report.ok ? 'PASSED' : 'WARNING' as const, validationMessage: report.summary };
      }
      return { ...row, validationStatus: 'PASSED' as const, validationMessage: '无需风控校验' };
    }));
  }, [positions]);

  const handleCommitRows = useCallback(async (targetRows: ImportDraftRow[]) => {
    const valid = targetRows.filter((r) => !r.skipImport && r.validationStatus !== 'ERROR' && r.fullCode && r.price > 0 && r.amount > 0);
    if (valid.length === 0) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '⚠️ 没有可过账的数据' }));
      return;
    }
    setCommitting(true);
    let success = 0;
    const errors: string[] = [];
    const successIds: string[] = [];

    // 【关键修复】先聚合同标的中长期流水，避免每个标的拆分成多个独立仓位
    // 1. 拆出中长期类别的行（LONG_TERM_BATCH / NEW_POSITION）与其他类别（短线做T / 计划单）
    const longTermRows = valid.filter((r) => r.targetCategory === 'LONG_TERM_BATCH' || r.targetCategory === 'NEW_POSITION');
    const otherRows = valid.filter((r) => r.targetCategory !== 'LONG_TERM_BATCH' && r.targetCategory !== 'NEW_POSITION');

    // 2. 中长期行按 stock_code 合并（加权加仓 / 卖出减仓）
    const mergedInstructions = mergeImportedTradesToPositions(longTermRows, positions);
    for (const instruction of mergedInstructions) {
      try {
        const count = await commitMergedLongTerm(instruction, { feeConfig, addBatch, addPosition });
        success += count;
        successIds.push(...instruction.allRows.map((r) => r.id));
      } catch (e: any) {
        errors.push(`${instruction.fullCode}: ${e.message}`);
      }
    }

    // 3. 其余行仍按原逻辑逐行过账
    for (const row of otherRows) {
      try {
        await commitRow(row, { positions, feeConfig, addBatch, addStreamRecord, markPlanExecuted, plannedOrders });
        success++; successIds.push(row.id);
      } catch (e: any) {
        errors.push(`${row.fullCode}: ${e.message}`);
      }
    }

    if (successIds.length > 0) setRows((prev) => prev.filter((r) => !successIds.includes(r.id)));
    setCommitting(false);
    window.dispatchEvent(new CustomEvent('app-toast', { detail: `✅ 成功过账 ${success} 条${errors.length ? `，${errors.length} 条失败` : ''}` }));
  }, [positions, feeConfig, addBatch, addStreamRecord, addPosition, markPlanExecuted, plannedOrders]);

  const handleCommitAll = useCallback(() => handleCommitRows(rows), [handleCommitRows, rows]);
  const handleCommitGroup = useCallback((groupRows: ImportDraftRow[]) => handleCommitRows(groupRows), [handleCommitRows]);
  const handleDiscardGroup = useCallback((groupRows: ImportDraftRow[]) => {
    const ids = new Set(groupRows.map((r) => r.id));
    setRows((prev) => prev.filter((r) => !ids.has(r.id)));
  }, []);

  const handleBindPosition = useCallback((groupRows: ImportDraftRow[], positionId: string | undefined, isNew: boolean) => {
    const ids = new Set(groupRows.map((r) => r.id));
    setRows((prev) => prev.map((r) => {
      if (!ids.has(r.id)) return r;
      if (isNew) return { ...r, targetCategory: 'NEW_POSITION' as const, targetPositionId: undefined, isNewPosition: true };
      return { ...r, targetPositionId: positionId, isNewPosition: false, targetCategory: 'LONG_TERM_BATCH' as const };
    }));
  }, []);

  const handleClear = useCallback(() => {
    if (rows.length > 0 && confirm('确认清空所有暂存数据？')) { setRows([]); if (ocrImageUrl) { revokeObjectUrl(ocrImageUrl); setOcrImageUrl(null); } }
  }, [rows, ocrImageUrl]);

  const skipCount = rows.filter((r) => r.skipImport).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-200">批量导入工作台</h3>
        <span className="text-xs text-slate-500">{rows.length} 条暂存 | {skipCount} 条跳过</span>
      </div>

      {/* Toast — 自动消失 + 淡入淡出 + 手动关闭 */}
      {toast && (
        <div
          className={`fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-slate-800 text-white text-sm shadow-lg border border-slate-600 transition-opacity duration-300 ${
            toastVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <span className="mr-3">{toast}</span>
          <button
            onClick={() => { setToastVisible(false); setTimeout(() => setToast(null), 300); }}
            className="text-slate-400 hover:text-white transition-colors text-base leading-none"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
      )}

      <ImportToolbar
        onFileDrop={handleFileDrop}
        onToggleExpand={() => setAllExpanded((v) => !v)}
        onToggleRiskFilter={() => setRiskFilterOn((v) => !v)}
        riskFilterOn={riskFilterOn}
        allExpanded={allExpanded}
        onClear={handleClear}
        onCommitAll={handleCommitAll}
        committing={committing}
        rowCount={rows.length}
        skipCount={skipCount}
        ocrImageUrl={ocrImageUrl ?? undefined}
        onDismissOcrImage={() => { revokeObjectUrl(ocrImageUrl ?? ''); setOcrImageUrl(null); }}
        ocrStatus={ocrStatus}
      />

      {/* 批量校验/去重快捷按钮 */}
      <div className="flex gap-2">
        <button onClick={handleDedupAll} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded-lg transition-colors">🔄 去重扫描</button>
        <button onClick={handleValidateAll} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded-lg transition-colors">🛡️ 批量风控校验</button>
      </div>

      {/* 卡片流 */}
      {groups.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <p className="text-sm">暂无数据，使用上方上传区上传图片/CSV 或按 Ctrl+V 粘贴</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <StockImportCard
              key={g.key}
              group={g}
              positions={positions}
              plannedOrders={plannedOrders}
              allExpanded={allExpanded}
              onUpdateRow={updateRow}
              onDeleteRow={deleteRow}
              onAddRow={(code, name) => addRow(code, name)}
              onCommitGroup={handleCommitGroup}
              onDiscardGroup={handleDiscardGroup}
              onBindPosition={handleBindPosition}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 单行过账逻辑（与之前保持不变） ----
async function commitRow(
  row: ImportDraftRow,
  deps: { positions: any[]; feeConfig: any; addBatch: any; addStreamRecord: any; markPlanExecuted: any; plannedOrders: any[] },
) {
  const { positions, feeConfig, addBatch, addStreamRecord, markPlanExecuted, plannedOrders } = deps;
  const now = new Date().toISOString();

  // 中长期（LONG_TERM_BATCH / NEW_POSITION）不走这里：已在 handleCommitRows 中
  // 经 mergeImportedTradesToPositions 聚合成单条指令后由 commitMergedLongTerm 过账。
  if (row.targetCategory === 'SHORT_TERM_T') {
    const totalFee = calcTradeFees(row.price, row.amount, row.direction, feeConfig, matchSecurityKind('', row.fullCode.replace(/^(sh|sz|bj)/, ''))).total;
    addStreamRecord({ id: generateId(), timestamp: new Date(row.timestamp).toISOString(), fullCode: row.fullCode, stockName: row.stockName || row.fullCode, direction: row.direction, price: row.price, amount: row.amount, fee: totalFee });
  } else if (row.targetCategory === 'BIND_PLANNED_ORDER') {
    if (!row.targetPlannedOrderId) throw new Error('未选择计划单');
    const order = plannedOrders.find((p: any) => p.id === row.targetPlannedOrderId);
    if (!order) throw new Error('计划单不存在');
    const pos = positions.find((p: any) => p.fullCode === row.fullCode && !p.isClosed);
    if (!pos) throw new Error('未找到对应持仓，请先建仓');
    const type = order.direction === 'buy' ? 'add' : 'reduce';
    const calc = calcBatchExecution(pos, type, row.price, row.amount, feeConfig);
    const batch: PositionBatch = { id: generateId(), timestamp: new Date(row.timestamp).toISOString(), type, price: row.price, amount: type === 'add' ? row.amount : -row.amount, costAfter: calc.newCost, amountAfter: calc.newAmount, fee: calc.totalFee };
    addBatch(pos.id, batch, { currentCost: calc.newCost, currentAmount: calc.newAmount, realizedPnL: calc.newRealizedPnL, totalInvested: calc.newTotalInvested });
    markPlanExecuted(order.id, { executedAt: now, actualPrice: row.price, actualAmount: row.amount, isAchieved: order.direction === 'buy' ? row.price <= order.plannedPrice : row.price >= order.plannedPrice, newCost: calc.newCost, newAmount: calc.newAmount, newTotalInvested: calc.newTotalInvested, totalFee: calc.totalFee });
  }
}

/**
 * 过账一条合并后的中长期导入指令（同标的多笔流水的聚合结果）。
 *
 * 保证同一 stock_code 在导入时只创建一个持仓（或追加到已有持仓），
 * 并根据多笔买入的加权平均成本价建/加仓、卖出做减仓。
 *
 * @param instruction 合并后的导入指令
 * @param deps 提交依赖
 * @returns 实际过账的流水条数（用于工具栏计数展示）
 */
async function commitMergedLongTerm(
  instruction: { action: 'create_position' | 'add_to_position'; fullCode: string; stockName: string; existingPositionId?: string; existingPosition?: any; buySummary: { totalAmount: number; totalCost: number; weightedPrice: number; count: number } | null; sellSummary: { totalAmount: number; totalProceeds: number; count: number } | null; allRows: ImportDraftRow[] },
  deps: { feeConfig: any; addBatch: any; addPosition: any },
): Promise<number> {
  const { feeConfig, addBatch, addPosition } = deps;
  const { fullCode, stockName, buySummary, sellSummary, allRows } = instruction;
  const now = new Date().toISOString();
  const kind = matchSecurityKind('', fullCode.replace(/^(sh|sz|bj)/, ''));
  let count = 0;

  // ── 新建持仓：合并多笔买入为加权平均价，若有卖出再减仓 ──
  if (instruction.action === 'create_position') {
    // 必须有买入才能建仓
    if (!buySummary || buySummary.totalAmount <= 0) {
      console.warn(`[importMerger] 跳过 ${fullCode}：无买入流水，无法建仓`);
      return 0;
    }

    // 合并买入的加权平均成本（含规费）
    const buyFee = calcTradeFees(buySummary.weightedPrice, buySummary.totalAmount, 'buy', feeConfig, kind).total;
    const totalInvested = buySummary.totalCost + buyFee;
    const weightedCost = totalInvested / buySummary.totalAmount;

    const batches: PositionBatch[] = [{
      id: generateId(),
      timestamp: new Date(allRows[0].timestamp).toISOString(),
      type: 'open' as const,
      price: buySummary.weightedPrice,
      amount: buySummary.totalAmount,
      costAfter: weightedCost,
      amountAfter: buySummary.totalAmount,
      fee: buyFee,
    }];
    count += buySummary.count;

    let currentCost = weightedCost;
    let currentAmount = buySummary.totalAmount;
    let realizedPnL = 0;
    let totalCostBasis = totalInvested;

    // 若有卖出，对新建持仓进行减仓
    if (sellSummary && sellSummary.totalAmount > 0) {
      const avgSellPrice = sellSummary.totalProceeds / sellSummary.totalAmount;
      const sellFee = calcTradeFees(avgSellPrice, sellSummary.totalAmount, 'sell', feeConfig, kind).total;
      const costBasisPerShare = currentCost;
      const netProceeds = sellSummary.totalProceeds - sellFee;
      realizedPnL += netProceeds - costBasisPerShare * sellSummary.totalAmount;
      totalCostBasis -= costBasisPerShare * sellSummary.totalAmount;
      currentAmount -= sellSummary.totalAmount;
      if (currentAmount <= 0) {
        currentCost = 0;
        currentAmount = 0;
        totalCostBasis = 0;
      } else {
        currentCost = totalCostBasis / currentAmount;
      }

      batches.push({
        id: generateId(),
        timestamp: new Date(Math.max(...allRows.map((r) => r.timestamp))).toISOString(),
        type: 'reduce' as const,
        price: avgSellPrice,
        amount: -sellSummary.totalAmount,
        costAfter: currentCost,
        amountAfter: currentAmount,
        fee: sellFee,
      });
      count += sellSummary.count;
    }

    addPosition({
      id: generateId(),
      stockName: stockName || fullCode,
      fullCode,
      currentCost,
      currentAmount,
      batches,
      isClosed: currentAmount <= 0,
      createdAt: now,
      openAt: new Date(allRows[0].timestamp).toISOString(),
      realizedPnL,
      totalInvested: totalCostBasis,
    });
    return count;
  }

  // ── 追加到已有持仓：加权加仓 + 卖出减仓 ──
  if (instruction.action === 'add_to_position') {
    if (!instruction.existingPosition) throw new Error('持仓不存在');
    const pos = instruction.existingPosition;

    // 1) 先处理买入（加权平均加仓）
    if (buySummary && buySummary.totalAmount > 0) {
      const buyFee = calcTradeFees(buySummary.weightedPrice, buySummary.totalAmount, 'buy', feeConfig, kind).total;
      const snap = recomputePositionSnapshot(pos.batches);
      const newAmount = snap.currentAmount + buySummary.totalAmount;
      const newTotalInvested = snap.totalInvested + buySummary.totalCost + buyFee;
      const newCost = newAmount > 0 ? newTotalInvested / newAmount : 0;

      const batch: PositionBatch = {
        id: generateId(),
        timestamp: new Date(allRows[0].timestamp).toISOString(),
        type: 'add' as const,
        price: buySummary.weightedPrice,
        amount: buySummary.totalAmount,
        costAfter: newCost,
        amountAfter: newAmount,
        fee: buyFee,
      };
      addBatch(pos.id, batch, { currentCost: newCost, currentAmount: newAmount, totalInvested: newTotalInvested });
      count += buySummary.count;
    }

    // 2) 后处理卖出（减仓）
    if (sellSummary && sellSummary.totalAmount > 0) {
      const avgSellPrice = sellSummary.totalProceeds / sellSummary.totalAmount;
      const sellFee = calcTradeFees(avgSellPrice, sellSummary.totalAmount, 'sell', feeConfig, kind).total;

      // 先计算当前持仓快照（若之前有买入批次，需以买入后的状态为基准）
      const snap = recomputePositionSnapshot(pos.batches);
      let preSellAmount = snap.currentAmount;
      let preSellInvested = snap.totalInvested;
      let preSellRealizedPnL = snap.realizedPnL;

      // 如果之前有买入批次，模拟买入后的状态（直接计算，不需模拟批次对象）
      if (buySummary && buySummary.totalAmount > 0) {
        const buyFee = calcTradeFees(buySummary.weightedPrice, buySummary.totalAmount, 'buy', feeConfig, kind).total;
        preSellAmount = snap.currentAmount + buySummary.totalAmount;
        preSellInvested = snap.totalInvested + buySummary.totalCost + buyFee;
      }

      // 基于买入后（或原始）状态计算卖出结果
      const costBasisPerShare = preSellAmount > 0 ? preSellInvested / preSellAmount : 0;
      const netProceeds = sellSummary.totalProceeds - sellFee;
      const newRealizedPnL = preSellRealizedPnL + (netProceeds - costBasisPerShare * sellSummary.totalAmount);
      const newTotalInvested = preSellInvested - costBasisPerShare * sellSummary.totalAmount;
      const newAmount = preSellAmount - sellSummary.totalAmount;
      const newCost = newAmount > 0 ? newTotalInvested / newAmount : 0;

      const batch: PositionBatch = {
        id: generateId(),
        timestamp: new Date(Math.max(...allRows.map((r) => r.timestamp))).toISOString(),
        type: 'reduce' as const,
        price: avgSellPrice,
        amount: -sellSummary.totalAmount,
        costAfter: newCost,
        amountAfter: newAmount,
        fee: sellFee,
      };
      addBatch(pos.id, batch, { currentCost: newCost, currentAmount: newAmount, realizedPnL: newRealizedPnL, totalInvested: newTotalInvested });
      count += sellSummary.count;
    }

    return count;
  }

  return 0;
}