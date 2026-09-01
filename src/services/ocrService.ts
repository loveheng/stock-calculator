/**
 * @file ocrService.ts
 * @description OCR 图像解析服务：调用后端 POST /api/import/process-image 接口，
 *              将图片上传后获取解析结果并归一化为 RawTxRecord[]。
 *              支持图片拖拽 / 剪贴板粘贴 / 文件选择三种入口。
 *              包含前端图片预检（格式、大小、尺寸、高宽比）。
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

/** 图片预检结果 */
export interface ImageValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
}

// ============================================================
// 前端图片预检（无需后端，纯浏览器校验）
// ============================================================

/** 支持的图片格式 */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXT = /\.(jpg|jpeg|png|webp)$/i;

/** 文件大小边界（字节） */
const MIN_SIZE = 10 * 1024;   // 10KB
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

/** 尺寸与比例约束 */
const MIN_WIDTH = 400;
const MIN_HEIGHT = 600;
/** 最大高度（拦截滚动长图）：超过则提示截取单屏 */
const MAX_HEIGHT = 5000;
/** 最大高宽比（长图拦截）：用户放宽到 5:1 */
const MAX_ASPECT_RATIO = 5;
/** 最小高宽比（横屏拦截）：竖屏截图通常 ≥ 0.5:1 */
const MIN_ASPECT_RATIO = 0.5;

/**
 * 同步校验文件格式与大小。
 * 校验失败时返回 { valid: false, code, message }。
 */
export function validateImageFile(file: File): ImageValidationResult {
  // 格式校验
  if (!ALLOWED_TYPES.has(file.type) && !ALLOWED_EXT.test(file.name)) {
    return {
      valid: false,
      code: 'FORMAT_INVALID',
      message: '仅支持 JPG、PNG、WEBP 格式的图片文件，请重新选择。',
    };
  }

  // 文件大小下限
  if (file.size === 0) {
    return {
      valid: false,
      code: 'FILE_EMPTY',
      message: '图片文件为空，请上传清晰原图截图。',
    };
  }
  if (file.size < MIN_SIZE) {
    return {
      valid: false,
      code: 'FILE_TOO_SMALL',
      message: '图片文件过小，可能不包含有效交易数据，请上传清晰原图截图。',
    };
  }

  // 文件大小上限
  if (file.size > MAX_SIZE) {
    return {
      valid: false,
      code: 'FILE_TOO_LARGE',
      message: '图片文件超过 10MB 上限，请上传原始单屏截图。',
    };
  }

  return { valid: true };
}

/**
 * 异步加载图片并校验分辨率与高宽比。
 * @returns 校验结果；若图片无法解码返回对应错误码。
 */
export function validateImageDimensions(file: File): Promise<ImageValidationResult> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { width, height } = img;
      const aspectRatio = height / width;

      if (width < MIN_WIDTH || height < MIN_HEIGHT) {
        resolve({
          valid: false,
          code: 'RESOLUTION_TOO_LOW',
          message: `图片分辨率过低 (${width}×${height})，无法保证价格与代码清晰度，请上传手机原图截图。`,
        });
        return;
      }

      if (height > MAX_HEIGHT) {
        resolve({
          valid: false,
          code: 'IMAGE_TOO_TALL',
          message: `图片高度 ${height}px 超过上限 ${MAX_HEIGHT}px，请截取单屏页面上传，避免使用滚动截图。`,
        });
        return;
      }

      if (aspectRatio > MAX_ASPECT_RATIO) {
        resolve({
          valid: false,
          code: 'ASPECT_RATIO_TOO_TALL',
          message: `检测到超长截图（长宽比 ${aspectRatio.toFixed(1)}:1，上限 ${MAX_ASPECT_RATIO}:1）。滚动长图易导致数字和小数点丢失，建议截取单屏画面分批上传。`,
        });
        return;
      }

      if (aspectRatio < MIN_ASPECT_RATIO) {
        resolve({
          valid: false,
          code: 'ASPECT_RATIO_TOO_WIDE',
          message: '图片比例过于扁平，请上传手机正常的竖屏交割单截图。',
        });
        return;
      }

      resolve({ valid: true });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({
        valid: false,
        code: 'IMAGE_DECODE_FAILED',
        message: '无法读取该图片文件，文件可能已损坏或格式不兼容，请重新截图后上传。',
      });
    };
    img.src = url;
  });
}

/**
 * 对图片文件执行完整的前端预检（格式 → 大小 → 尺寸 → 高宽比）。
 * 若全部通过返回 { valid: true }，否则立即返回第一个失败原因。
 */
export async function validateImage(file: File): Promise<ImageValidationResult> {
  // 第一步：同步校验格式与大小
  const syncResult = validateImageFile(file);
  if (!syncResult.valid) return syncResult;

  // 第二步：异步校验分辨率与比例
  return validateImageDimensions(file);
}

// ============================================================
// 图片压缩与转码（上传前预处理）
// ============================================================

/** 压缩输出尺寸上限（只缩小不放大） */
const COMPRESS_MAX_WIDTH = 1024;
const COMPRESS_MAX_HEIGHT = 2048;
const COMPRESS_QUALITY = 0.8;
const COMPRESS_FORMAT = 'image/jpeg';

/**
 * 用 Canvas 对图片进行等比缩放压缩并转码为 JPEG。
 * - 只缩小不放大（原图小于上限时不做处理）
 * - 返回新 File 对象，替换原始文件用于上传
 * @param file 原始图片文件
 * @returns 压缩后的 File 对象
 */
export async function compressImage(file: File): Promise<File> {
  const img = await loadImage(file);

  let { width, height } = img;

  // 只在超出上限时缩小
  if (width > COMPRESS_MAX_WIDTH || height > COMPRESS_MAX_HEIGHT) {
    const ratio = Math.min(COMPRESS_MAX_WIDTH / width, COMPRESS_MAX_HEIGHT / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  // 如果原图尺寸未超出上限，且已经是 JPEG（无需转码），直接返回原文件
  if (width === img.width && height === img.height && file.type === COMPRESS_FORMAT) {
    closeImage(img);
    return file;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('Canvas toBlob 失败'));
    }, COMPRESS_FORMAT, COMPRESS_QUALITY);
  });

  closeImage(img);

  // 保持原始文件名，扩展名改为 .jpg
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: COMPRESS_FORMAT });
}

/** 加载图片为 ImageBitmap 或 HTMLImageElement */
async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // 优先使用 createImageBitmap（更高效，在主线程外解码）
  try {
    return await createImageBitmap(file);
  } catch {
    // 降级到 Image 对象
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
      img.src = url;
    });
  }
}

/** 释放 ImageBitmap 资源 */
function closeImage(img: ImageBitmap | HTMLImageElement): void {
  if (img instanceof ImageBitmap) {
    img.close();
  }
}

/**
 * 将已选定的图片/文本文件解析为交易记录。
 * - 图片文件 → POST /api/import/process-image（FormData multipart）
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

  // 图片 → 压缩 → OCR 接口
  const previewUrl = URL.createObjectURL(file);

  // 上传前压缩（只缩小不放大，转 JPEG 质量 0.8）
  const compressed = await compressImage(file);

  const formData = new FormData();
  formData.append('file', compressed);
  const resp = await fetch('/api/import/process-image', { method: 'POST', body: formData });
  if (!resp.ok) throw new Error(`OCR 服务返回 ${resp.status}`);
  const json = await resp.json();
  const records = parseOcrPayload(json);
  if (records.length === 0) throw new Error('OCR 解析结果为空');
  return { records, previewUrl };
}

// ============================================================
// 剪贴板工具
// ============================================================

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
