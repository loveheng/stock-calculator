/**
 * @file storageUtils.ts
 * @description 浏览器端数据管理工具：JSON 全量备份/恢复下载、CSV 导出（带 BOM 防乱码）。
 * @layer Utility
 * @storage_impact 仅操作浏览器下载 Blob 与文件选择器；不直接读写 IndexedDB，
 *                 由 Store 层 exportData/importData 组装好数据后调用本模块完成落盘。
 * @author 开发团队
 */

// ============================================================
// 数据管理工具：JSON 备份/恢复、CSV 导出
// ============================================================

/**
 * 将对象序列化为 JSON 文件并触发浏览器下载。
 *
 * @description 将任意可序列化数据（通常为 AppStoreExport）以 `JSON.stringify(data, null, 2)`
 *              格式导出，便于人工查看与版本备份。
 * @param {unknown} data - 待导出的完整数据快照
 * @param {string} [filename='stock-data.json'] - 下载文件名（需含 .json 后缀）
 * @returns {void} 无返回值；通过浏览器下载直接落盘
 * @note 若 data 含 undefined 字段，JSON.stringify 会丢弃该键——导出前请确保字段完整
 */
export function exportJSON(data: unknown, filename: string = 'stock-data.json'): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, filename);
}

/**
 * 弹出文件选择器导入 JSON 并解析为泛型类型。
 *
 * @description 创建隐藏的 `<input type="file" accept=".json">` 并触发点击；
 *              用户选择文件后用 FileReader 读为文本并 JSON.parse。
 * @template T - 反序列化目标类型（通常为 AppStoreExport）
 * @returns {Promise<T>} 解析成功的结构化数据
 * @throws {Error} 未选择文件时 reject "No file selected"；
 *                 文件内容非法 JSON 时 reject "Invalid JSON file"；
 *                 读取失败时 reject "Failed to read file"
 * @note 校验职责由调用方承担：导入前建议对 T 做结构完整性兜底（空数组/默认现值）
 */
export function importJSON<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) {
        reject(new Error('No file selected'));
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string) as T;
          resolve(data);
        } catch (err) {
          reject(new Error('Invalid JSON file'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    };
    input.click();
  });
}

/**
 * 以 CSV 格式导出二维表格数据（表头 + 行），带 UTF-8 BOM 防 Excel 中文乱码。
 *
 * @description 表头与每行单元格均包裹双引号，规避逗号/换行导致列错位。
 * @param {string[]} headers - 表头列名数组
 * @param {string[][]} rows - 数据行二维数组（每行与表头列数对齐）
 * @param {string} [filename='export.csv'] - 下载文件名（需含 .csv 后缀）
 * @returns {void} 无返回值；直接触发浏览器下载
 * @note 单元格内若含双引号需调用方预先转义为 `""`
 */
export function exportCSV(
  headers: string[],
  rows: string[][],
  filename: string = 'export.csv'
): void {
  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
  ].join('\n');
  const bom = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
}

/**
 * 内部工具：将 Blob 通过临时 `<a download>` 触发浏览器下载。
 *
 * @description 创建对象 URL → 挂载隐藏链接 → 模拟点击 → 卸载并释放 URL。
 * @param {Blob} blob - 待下载的文件内容
 * @param {string} filename - 下载文件名
 * @returns {void} 无返回值
 * @note 仅模块内使用；调用方需确保 blob 非空
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}