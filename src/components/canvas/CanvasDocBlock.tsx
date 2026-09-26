/**
 * @file CanvasDocBlock.tsx
 * @description 画布「文档」区块（block.type = 'file'）：上传文档后可在画布内直接预览——
 *              PDF 走浏览器原生 iframe 渲染，文本类（txt/md/csv/json 等）读文本内联展示，
 *              图片按图预览，其余格式（Office 等前端无法解析）降级为「可下载」占位。
 *              区块内空间有限，另提供全屏放大预览（Portal + Esc 关闭）与下载/重新上传入口。
 *              二进制统一存 canvasService（Dexie canvasBlobs），区块 data 仅存 dataRef 引用。
 * @layer UI (Canvas)
 * @storage_impact Blob 经 canvasService.putBlob/getBlob 读写 canvasBlobs 表；元信息经 store canvasSlice 落库。
 * @author 开发团队
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, Maximize2, Upload, X } from 'lucide-react';
import { useAppStore } from '../../store';
import { getBlob, putBlob } from '../../services/canvasService';
import { docPreviewKind } from '../../utils/canvasDocText';
import type { CanvasBlock, CanvasBlockData } from '../../types/domain';

/** 文档上传上限（10MB；图片区块仍为 2MB） */
const DOC_MAX_BYTES = 10 * 1024 * 1024;
/** 文本预览展示上限（字符；超出截断，防大文件拖垮渲染） */
const TEXT_PREVIEW_CHARS = 20000;
/** 上传入口 accept：文本类 + PDF + 图片（误传兜底可预览） */
const ACCEPT = '.pdf,.txt,.md,.markdown,.csv,.json,.log,.png,.jpg,.jpeg,text/*,application/pdf';

/** 字节数人话格式（B / KB / MB） */
function formatBytes(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 画布文档区块：上传 → 预览（含全屏放大与下载）。
 *
 * @param block 文档区块（data = CanvasBlockData['file']）
 * @returns {JSX.Element} 文档区块内容视图
 */
export default function CanvasDocBlock({ block }: { block: CanvasBlock }) {
  const data = block.data as CanvasBlockData['file'];
  const updateCanvasBlockData = useAppStore((s) => s.updateCanvasBlockData);
  const setCopilotNotice = useAppStore((s) => s.setCopilotNotice);
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);

  // 预览形态判定单一事实源（AI 正文摘录层 canvasDocText 同函数，避免两处漂移）
  const kind = docPreviewKind(data.fileName || '', data.fileType || '');

  // 引用 id / 预览形态变化 → 读 Blob：一律建 objectURL（下载/iframe/img 用），文本类另读字符串
  useEffect(() => {
    if (!data.dataRef) return;
    let revoked = false;
    let objectUrl: string | null = null;
    void getBlob(data.dataRef).then(async (entity) => {
      if (!entity) return;
      if (revoked) return;
      objectUrl = URL.createObjectURL(entity.data);
      if (revoked) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      setUrl(objectUrl);
      if (kind !== 'text') return;
      const raw = await entity.data.text();
      if (!revoked) setText(raw.slice(0, TEXT_PREVIEW_CHARS));
    });
    return () => {
      revoked = true;
      setText(null);
      setUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [data.dataRef, kind]);

  // 全屏预览：Esc 关闭
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const onFile = async (file: File) => {
    if (file.size > DOC_MAX_BYTES) {
      setCopilotNotice({
        title: '文档过大',
        message: `文档上限 ${formatBytes(DOC_MAX_BYTES)}`,
        severity: 'warning',
      });
      return;
    }
    try {
      const id = await putBlob(file, file.type);
      updateCanvasBlockData(block.blockId, {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        dataRef: id,
      } as CanvasBlockData['file']);
    } catch {
      setCopilotNotice({ title: '上传失败', message: 'Blob 写入失败，请重试', severity: 'danger' });
    }
  };

  /** 空态：上传入口 */
  if (!data.dataRef) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5">
        <button
          className="no-drag flex flex-col items-center gap-1 text-slate-500 hover:text-blue-400"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-5 w-5" />
          <span className="text-xs">上传文档（≤10MB）</span>
        </button>
        <p className="text-center text-[11px] leading-relaxed text-slate-600">
          支持 PDF / TXT / Markdown / CSV 等
          <br />
          上传后可在区块内直接预览
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
      </div>
    );
  }

  /** 预览主体（四种形态） */
  const body =
    kind === 'pdf' && url ? (
      <iframe src={url} title={data.fileName} className="h-full w-full rounded border-0 bg-white" />
    ) : kind === 'image' && url ? (
      <div className="flex h-full items-center justify-center">
        <img src={url} alt={data.fileName} className="max-h-full max-w-full object-contain" />
      </div>
    ) : kind === 'text' ? (
      text === null ? (
        <p className="text-xs text-slate-500">读取中…</p>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-300">
          {text}
          {text.length >= TEXT_PREVIEW_CHARS ? '\n…（内容过长，预览已截断）' : ''}
        </pre>
      )
    ) : (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
        <FileText className="h-6 w-6 text-slate-600" />
        <p className="text-xs text-slate-500">{data.fileName || '未知文档'}</p>
        <p className="text-[11px] text-slate-600">该格式暂不支持在线预览，可下载查看</p>
      </div>
    );

  return (
    <div className="flex h-full flex-col gap-1.5">
      {/* 元信息条：文件名 + 大小 + 放大/下载/重新上传 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-800 pb-1.5">
        <FileText className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={data.fileName}>
          {data.fileName || '未命名文档'}
        </span>
        {data.fileSize ? (
          <span className="shrink-0 text-[11px] text-slate-600">{formatBytes(data.fileSize)}</span>
        ) : null}
        <button
          className="no-drag tap-target rounded text-slate-500 hover:bg-slate-800 hover:text-blue-400"
          onClick={() => setZoom(true)}
          title="放大预览"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        {url && (
          <a
            className="no-drag tap-target flex items-center rounded text-slate-500 hover:bg-slate-800 hover:text-blue-400"
            href={url}
            download={data.fileName || 'document'}
            title="下载文档"
          >
            <Download className="h-3.5 w-3.5" />
          </a>
        )}
        <button
          className="no-drag tap-target rounded text-slate-500 hover:bg-slate-800 hover:text-blue-400"
          onClick={() => inputRef.current?.click()}
          title="重新上传"
        >
          <Upload className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 预览区 */}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />

      {/* 全屏放大预览（Portal：RGL GridItem 层叠上下文会裁剪卡片内浮层） */}
      {zoom &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex flex-col bg-black/80 p-4"
            onClick={() => setZoom(false)}
          >
            <div className="mb-2 flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <FileText className="h-4 w-4 shrink-0 text-blue-400" />
              <span className="truncate text-sm text-slate-200" title={data.fileName}>
                {data.fileName || '未命名文档'}
              </span>
              <button
                className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                onClick={() => setZoom(false)}
                title="关闭（Esc）"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div
              className={`min-h-0 flex-1 overflow-auto rounded-lg ${kind === 'text' ? 'bg-slate-900 p-3' : 'bg-white'}`}
              onClick={(e) => e.stopPropagation()}
            >
              {kind === 'pdf' && url ? (
                <iframe src={url} title={data.fileName} className="h-full w-full border-0" />
              ) : kind === 'image' && url ? (
                <div className="flex h-full items-center justify-center">
                  <img src={url} alt={data.fileName} className="max-h-full max-w-full object-contain" />
                </div>
              ) : (
                <pre
                  className={`whitespace-pre-wrap break-words font-mono text-xs leading-relaxed ${
                    kind === 'text' ? 'text-slate-200' : 'text-slate-700'
                  }`}
                >
                  {text ?? '该格式暂不支持在线预览，请下载查看'}
                </pre>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
