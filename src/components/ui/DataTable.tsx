/**
 * @file DataTable.tsx
 * @description 配置式表格：由 columns 配置数组驱动（表头 / render / 对齐 / 宽度），
 *              窄屏横向滚动、内置空态插槽。设计取舍：只抽象「结构固定、列不同」的列表，
 *              单元格业务差异一律走 column.render 外置，禁止往本组件加业务 props。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 骨架模板
 */

import React, { type ReactNode } from 'react';

/** 列配置 */
export interface ColumnConfig<T> {
  /** 列键（同时作为 React key） */
  key: string;
  /** 表头文案 */
  header: string;
  /** 单元格渲染（业务差异外置点） */
  render: (row: T, index: number) => ReactNode;
  /** 对齐方式，默认 left */
  align?: 'left' | 'right' | 'center';
  /** 列宽（Tailwind 宽度类或 CSS 值） */
  width?: string;
}

export interface DataTableProps<T> {
  /** 列配置 */
  columns: ColumnConfig<T>[];
  /** 数据行 */
  rows: T[];
  /** 行主键 */
  rowKey: (row: T) => string;
  /** 空态插槽（不传则渲染「暂无数据」） */
  empty?: ReactNode;
  /** 行点击回调（可选） */
  onRowClick?: (row: T) => void;
  /** 追加类名 */
  className?: string;
}

const ALIGN_CLASS: Record<'left' | 'right' | 'center', string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/**
 * 配置式表格组件。
 *
 * @description 按 columns 渲染表头与单元格；rows 为空时渲染 empty 插槽或默认空态。
 * @returns {JSX.Element} 表格视图
 */
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  onRowClick,
  className = '',
}: DataTableProps<T>) {
  return (
    <div className={`overflow-x-auto rounded-lg border border-slate-700 ${className}`}>
      <table className="min-w-full text-sm">
        <thead className="bg-slate-800/70 text-xs uppercase tracking-wide text-slate-400">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                style={col.width ? { width: col.width } : undefined}
                className={`whitespace-nowrap px-3 py-2 font-medium ${ALIGN_CLASS[col.align ?? 'left']}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-slate-500">
                {empty ?? '暂无数据'}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'cursor-pointer hover:bg-slate-800/40' : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} className={`px-3 py-2 ${ALIGN_CLASS[col.align ?? 'left']}`}>
                    {col.render(row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
