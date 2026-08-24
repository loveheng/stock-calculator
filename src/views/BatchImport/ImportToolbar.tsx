/**
 * @file ImportToolbar.tsx
 * @description 批量导入页面顶部工具栏：图片上传区（拖拽+点击+全局粘贴）、
 *              全局操作按钮（展开/折叠/风险过滤/清空/过账）、OCR 图片缩略图浮窗。
 *              包含上传规范提示条、截图规范说明弹窗、Loading 状态反馈。
 * @layer View
 * @author 开发团队
 */

import React, { useRef, useState, useCallback } from 'react';
import {
  Upload, ClipboardPaste, Maximize2, Minimize2, Filter, Eraser, Send, Eye, X,
  HelpCircle, FileImage, AlertTriangle, Loader2, CheckCircle, Lightbulb,
} from 'lucide-react';

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
  /** OCR 处理状态 */
  ocrStatus?: { loading: boolean; message: string };
}

export default function ImportToolbar({
  onFileDrop, onPasteText, onToggleExpand, onToggleRiskFilter,
  riskFilterOn, allExpanded, onClear, onCommitAll, committing,
  rowCount, skipCount, ocrImageUrl, onDismissOcrImage, ocrStatus,
}: ImportToolbarProps) {
  const [dragOver, setDragOver] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
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
        className={`relative flex items-center justify-center h-28 rounded-lg border-2 border-dashed transition-all cursor-pointer ${
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

        {/* OCR 处理中状态 */}
        {ocrStatus?.loading ? (
          <div className="flex flex-col items-center gap-2 text-blue-400">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="text-sm">{ocrStatus.message}</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-slate-400">
            <FileImage className="w-6 h-6 text-slate-500" />
            <span className="text-sm font-medium text-slate-300">
              点击或将交割单截图拖拽到此处
            </span>
            <span className="text-xs text-slate-500">
              支持单屏截图智能识别（深色 / 浅色模式均可）
            </span>
            <span className="text-[10px] text-slate-600">
              支持 JPG / PNG / WEBP · 图片 / CSV / TSV
            </span>
          </div>
        )}
      </div>

      {/* 常驻提示条 */}
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-slate-800/30 border border-slate-700/50">
        <Lightbulb className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 text-[11px] text-slate-400 leading-relaxed">
          <span className="text-slate-500 font-medium">上传规范：</span>
          推荐使用手机原生单屏垂直截图，单张包含 1~5 笔流水识别最精准。
          请勿使用滚动截长图或多图拼接，避免关键数字因画面压缩产生形变。
          支持 JPG、PNG、WEBP，单张文件大小在 10KB ~ 10MB 之间。
          <button
            onClick={() => setShowHelpModal(true)}
            className="ml-1.5 inline-flex items-center gap-0.5 text-blue-400 hover:text-blue-300 underline underline-offset-2"
          >
            <HelpCircle className="w-3 h-3" /> 查看截图规范
          </button>
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
        <button onClick={onCommitAll} disabled={committing || ocrStatus?.loading} className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-green-800 disabled:text-slate-400 text-white text-xs rounded-lg transition-colors ml-auto">
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

      {/* OCR 状态提示 */}
      {ocrStatus?.loading === false && ocrStatus?.message && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30 text-xs text-green-400">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{ocrStatus.message}</span>
        </div>
      )}

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

      {/* 截图规范说明模态弹窗 */}
      {showHelpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowHelpModal(false)}>
          <div className="w-full max-w-lg mx-4 rounded-xl border border-slate-600 bg-slate-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* 弹窗头部 */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
              <h2 className="text-base font-semibold text-slate-200">📋 交割单截图上传规范指南</h2>
              <button onClick={() => setShowHelpModal(false)} className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 弹窗内容 */}
            <div className="px-5 py-4 space-y-5 text-sm text-slate-300 max-h-[65vh] overflow-y-auto">
              <p className="text-slate-400 text-xs leading-relaxed">
                为了确保股票代码、成交价格、买卖方向等关键数据的 100% 准确提取，请遵循以下规范：
              </p>

              <div>
                <h3 className="text-green-400 font-medium mb-2 flex items-center gap-1.5">
                  <CheckCircle className="w-4 h-4" /> 推荐做法
                </h3>
                <ul className="space-y-2 pl-5 list-disc text-xs text-slate-400">
                  <li>截取券商 App 的「当日成交」或「历史成交流水」明细页面。</li>
                  <li>保持手机系统默认竖屏截图（深色/暗黑模式、浅色模式均支持）。</li>
                  <li>确保每笔流水的股票名称、代码、单价、数量、成交时间完整可见且无遮挡。</li>
                </ul>
              </div>

              <div>
                <h3 className="text-red-400 font-medium mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> 不建议的做法
                </h3>
                <ul className="space-y-2 pl-5 list-disc text-xs text-slate-400">
                  <li>请勿使用手机系统的「滚动截长图」或第三方拼图工具（长图缩放会导致小数点和小字模糊）。</li>
                  <li>请勿使用相机翻拍电脑/另一台手机屏幕（摩尔纹与反光会严重干扰字符识别）。</li>
                  <li>请勿上传包含大面积弹窗、水印遮挡关键价格的截图。</li>
                </ul>
              </div>
            </div>

            {/* 弹窗底部 */}
            <div className="px-5 py-3 border-t border-slate-700 flex justify-end">
              <button
                onClick={() => setShowHelpModal(false)}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}