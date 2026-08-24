/**
 * @file ocrService.test.ts
 * @description 单元测试：OCR 图像解析服务（纯函数部分）
 * @layer Test
 * @storage_impact 纯函数测试，不触达网络与存储。
 *                 validateImageDimensions / validateImage 需要浏览器 Image API，
 *                 在 node 环境下无法测试，需在 jsdom/happy-dom 环境中进行。
 */

import { describe, test, expect } from 'vitest';
import { validateImageFile } from '../services/ocrService';

/**
 * 辅助：创建模拟 File 对象
 */
function mockFile({ name, type, size }: { name: string; type: string; size: number }): File {
  const blob = new Blob(['x'.repeat(size)], { type });
  return new File([blob], name, { type });
}

// ============================================================
// validateImageFile
// ============================================================
describe('validateImageFile', () => {
  test('合法的 JPEG 文件通过', () => {
    const file = mockFile({ name: 'screenshot.jpg', type: 'image/jpeg', size: 100 * 1024 });
    expect(validateImageFile(file)).toEqual({ valid: true });
  });

  test('合法的 PNG 文件通过', () => {
    const file = mockFile({ name: 'screenshot.png', type: 'image/png', size: 200 * 1024 });
    expect(validateImageFile(file)).toEqual({ valid: true });
  });

  test('合法的 WEBP 文件通过', () => {
    const file = mockFile({ name: 'screenshot.webp', type: 'image/webp', size: 150 * 1024 });
    expect(validateImageFile(file)).toEqual({ valid: true });
  });

  test('非图片格式 → FORMAT_INVALID', () => {
    const file = mockFile({ name: 'data.csv', type: 'text/csv', size: 100 * 1024 });
    const result = validateImageFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('FORMAT_INVALID');
  });

  test('不支持的文件扩展名 → FORMAT_INVALID', () => {
    const file = mockFile({ name: 'screenshot.gif', type: 'image/gif', size: 100 * 1024 });
    const result = validateImageFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('FORMAT_INVALID');
  });

  test('HEIC 格式不被支持 → FORMAT_INVALID', () => {
    const file = mockFile({ name: 'screenshot.heic', type: 'image/heic', size: 100 * 1024 });
    const result = validateImageFile(file);
    expect(result.valid).toBe(false);
  });

  test('空文件 → FILE_EMPTY', () => {
    const file = mockFile({ name: 'empty.jpg', type: 'image/jpeg', size: 0 });
    const result = validateImageFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('FILE_EMPTY');
  });

  test('文件过小（< 10KB）→ FILE_TOO_SMALL', () => {
    const file = mockFile({ name: 'tiny.jpg', type: 'image/jpeg', size: 5 * 1024 });
    const result = validateImageFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('FILE_TOO_SMALL');
  });

  test('文件过大（> 10MB）→ FILE_TOO_LARGE', () => {
    const file = mockFile({ name: 'huge.jpg', type: 'image/jpeg', size: 15 * 1024 * 1024 });
    const result = validateImageFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('FILE_TOO_LARGE');
  });

  test('刚好 10MB 通过', () => {
    const file = mockFile({ name: 'large.jpg', type: 'image/jpeg', size: 10 * 1024 * 1024 });
    expect(validateImageFile(file).valid).toBe(true);
  });

  test('刚好 10KB 通过', () => {
    const file = mockFile({ name: 'small.jpg', type: 'image/jpeg', size: 10 * 1024 });
    expect(validateImageFile(file).valid).toBe(true);
  });

  test('JPEG 扩展名（小写 jpg）通过', () => {
    const file = mockFile({ name: 'shot.jpg', type: 'image/jpeg', size: 100 * 1024 });
    expect(validateImageFile(file).valid).toBe(true);
  });

  test('JPEG 扩展名（大写 JPG）通过', () => {
    const file = mockFile({ name: 'SHOT.JPG', type: 'image/jpeg', size: 100 * 1024 });
    expect(validateImageFile(file).valid).toBe(true);
  });
});