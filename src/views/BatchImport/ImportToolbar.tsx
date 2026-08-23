/**
 * @file ImportToolbar.tsx
 * @description 批量导入页面顶部工具栏：图片上传区（拖拽+点击+全局粘贴）、
 *              全局操作按钮（展开/折叠/风险过滤/清空/过账）、OCR 图片缩略图浮窗。
 * @layer View
 * @author 开发团队
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Upload, ClipboardPaste, Maximize2, Minimize2, Filter, Eraser, Send, Eye, X } from 'lucide-react';

interface ImportToolbarProps {
  onFileDrop: (file: File) => void;
  onPasteText: () => void;
  onToggleExpand: () => void;
  onToggleRiskFilter: () => void;
  riskFilterOn: boolean;
  allExpanded: boolean;
  onClear: () => void;
  onCommitAll: () => void;
  committing: boolean;
  rowCount: number;
  skipCount: number;
  /** OCR 图片预览 URL（若有则显示缩略图） */
  ocrImageUrl?: string;
  onDismissOcrImage: () => void;
}

export default function ImportToolbar({
  onFileDrop, onPasteText, onToggleExpand, onToggleRiskFilter,
  riskFilterOn, allExpanded, onClear, onCommitAll, committing,
  rowCount, skipCount, ocrImageUrl, onDismissOcrImage,
}: ImportToolbarProps) {
  const [dragOver, setDragOver] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const handleDragLeave = useCallback(() => setDragOver(false), []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFileDrop(file);
  }, [onFileDrop]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileDrop(file);
    e.target.value = '';
  }, [onFileDrop]);

  return (
    <div className="space-y-3">
      {/* 上传区 */}
      <div
        className={`relative flex items-center justify-center h-24 rounded-lg border-2 border-dashed transition-all cursor-pointer ${
          dragOver
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-slate-600 bg-slate-800/30 hover:border-slate-500 hover:bg-slate-800/50'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input ref={fileInputRef} type="file" accept="image/*,.csv,.tsv,.txt" className="hidden" onChange={handleFileSelect} />
        <div className="flex flex-col items-center gap-1 text-slate-400">
          <Upload className="w-5 h-5" />
          <span className="text-xs">点击选择文件 或 拖拽图片/CSV/TSV 到此处</span>
          <span className="text-[10px] text-slate-500">支持图片→OCR 解析 / 文本→TSV 本地解析</span>
        </div>
      </div>

      {/* 操作栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onPasteText} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded-lg transition-colors">
          <ClipboardPaste className="w-3.5 h-3.5" /> 粘贴文本 (Ctrl+V)
        </button>

        <div className="w-px h-5 bg-slate-700 mx-1" />

        <button onClick={onToggleExpand} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded-lg transition-colors">
          {allExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          {allExpanded ? '全部折叠' : '全部展开'}
        </button>
        <button
          onClick={onToggleRiskFilter}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
            riskFilterOn ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
          }`}
        >
          <Filter className="w-3.5 h-3.5" /> 仅看风险项
        </button>

        <div className="w-px h-5 bg-slate-700 mx-1" />

        <button onClick={onClear} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-red-500/30 text-slate-400 hover:text-red-400 text-xs rounded-lg transition-colors">
          <Eraser className="w-3.5 h-3.5" /> 清空暂存区
        </button>
        <button onClick={onCommitAll} disabled={committing} className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-green-800 disabled:text-slate-400 text-white text-xs rounded-lg transition-colors ml-auto">
          <Send className="w-3.5 h-3.5" /> {committing ? '过账中...' : '🚀 一键全部过账'}
        </button>

        <span className="text-xs text-slate-500">{rowCount} 条 | {skipCount} 跳过</span>

        {/* OCR 图片缩略图 */}
        {ocrImageUrl && (
          <div className="relative group">
            <img
              src={ocrImageUrl}
              alt="OCR 截图"
              className="w-8 h-8 rounded object-cover border border-slate-600 cursor-pointer hover:opacity-80"
              onClick={() => setShowPreview(true)}
            />
            <button
              onClick={onDismissOcrImage}
              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        )}
      </div>

      {/* 图片放大预览 Modal */}
      {showPreview && ocrImageUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setShowPreview(false)}>
          <div className="relative max-w-3xl max-h-[90vh] p-4" onClick={(e) => e.stopPropagation()}>
            <img src={ocrImageUrl} alt="OCR 截图放大" className="max-w-full max-h-[85vh] rounded-lg shadow-2xl" />
            <button onClick={() => setShowPreview(false)} className="absolute top-2 right-2 p-1.5 rounded-full bg-slate-800/80 text-slate-300 hover:bg-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}