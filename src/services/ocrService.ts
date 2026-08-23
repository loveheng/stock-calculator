/**
 * @file ocrService.ts
 * @description OCR 图像解析服务：调用后端 POST /api/import/ocr-parse 接口，
 *              将图片上传后获取解析结果并归一化为 RawTxRecord[]。
 *              支持图片拖拽 / 剪贴板粘贴 / 文件选择三种入口。
 * @layer Service
 * @author 开发团队
 */

import { parseOcrPayload, type RawTxRecord } from './importAdapter';

/** OCR 解析产物 */
export interface OcrParseResult {
  records: RawTxRecord[];
  /** 图片预览 dataURL 或 Object URL（仅当输入为图片时设置） */
  previewUrl?: string;
}

/**
 * 将已选定的图片/文本文件解析为交易记录。
 * - 图片文件 → POST /api/import/ocr-parse（FormData multipart）
 * - 文本/CSV/TSV 文件 → 本地读取文本
 * @param file 图片或文本文件
 * @param readText 文本读取回调（由调用方注入 parseClipboardText），图片时可不传
 */
export async function parseOcrFile(
  file: File,
  readText: (text: string) => RawTxRecord[],
): Promise<OcrParseResult> {
  // 文本/CSV/TSV → 本地降级解析
  if (file.type.startsWith('text/') || /\.(txt|csv|tsv)$/i.test(file.name)) {
    const text = await file.text();
    const records = readText(text);
    return { records, previewUrl: undefined };
  }

  // 图片 → OCR 接口
  const previewUrl = URL.createObjectURL(file);
  const formData = new FormData();
  formData.append('file', file);
  const resp = await fetch('/api/import/ocr-parse', { method: 'POST', body: formData });
  if (!resp.ok) throw new Error(`OCR 服务返回 ${resp.status}`);
  const json = await resp.json();
  const records = parseOcrPayload(json);
  if (records.length === 0) throw new Error('OCR 解析结果为空');
  return { records, previewUrl };
}

/**
 * 直接从剪贴板事件提取图片文件（若有）。
 * @returns 图片文件；无图片时返回 null
 */
export function extractImageFromClipboard(e: ClipboardEvent): File | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/** 释放对象的 Object URL（避免内存泄漏） */
export function revokeObjectUrl(url?: string): void {
  if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
}