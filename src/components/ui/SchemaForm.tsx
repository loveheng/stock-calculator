/**
 * @file SchemaForm.tsx
 * @description 配置式表单：由 fields 配置数组驱动渲染（text/number/textarea/select/checkbox），
 *              内置必填校验与栅格排布。设计取舍：只做「结构固定、字段不同」的表单，
 *              业务差异一律外置到配置，禁止往本组件加业务 props（见 docs/development/component-standards.md）。
 *              这是 Rule of Three 的产物：表单在第 3 次重复时才抽象，且选择配置化而非布尔参数化。
 * @layer UI
 * @storage_impact 纯受控展示组件，无存储读写（提交动作由调用方 onSubmit 决定）。
 * @author 骨架模板
 */

import React from 'react';
import { showToast } from '../../utils/toast';

/** 支持的字段类型 */
export type FieldType = 'text' | 'number' | 'textarea' | 'select' | 'checkbox';

/** 单字段配置 */
export interface SchemaField {
  /** 取值键（对应 values 的字段名） */
  key: string;
  /** 标签文案 */
  label: string;
  /** 控件类型，默认 text */
  type?: FieldType;
  /** 占位提示 */
  placeholder?: string;
  /** select 选项 */
  options?: { value: string; label: string }[];
  /** 是否必填（提交时校验） */
  required?: boolean;
  /** 栅格跨度，默认 1 */
  span?: 1 | 2 | 3 | 4;
  /** number 专用：最小值 / 最大值 / 步长 */
  min?: number;
  max?: number;
  step?: number;
}

export interface SchemaFormProps<T extends Record<string, unknown>> {
  /** 字段配置（结构固定，字段不同 → 配置化） */
  fields: SchemaField[];
  /** 受控值 */
  values: T;
  /** 字段变更回调 */
  onChange: (key: string, value: string | number | boolean) => void;
  /** 提交回调（必填校验通过后触发）；不传则不渲染提交按钮 */
  onSubmit?: (values: T) => void;
  /** 提交按钮文案 */
  submitText?: string;
  /** 每行栅格列数，默认 2 */
  columns?: 1 | 2 | 3 | 4;
  /** 追加类名 */
  className?: string;
}

/** 栅格列数 → Tailwind 响应式类（固定映射，避免动态类名不被 JIT 识别） */
const COLS_CLASS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
  4: 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4',
};

/** 字段跨度 → Tailwind 响应式类 */
const SPAN_CLASS: Record<number, string> = {
  1: '',
  2: 'md:col-span-2',
  3: 'md:col-span-2 xl:col-span-3',
  4: 'md:col-span-2 xl:col-span-4',
};

/** 统一取值：null/undefined 渲染为空串，避免受控输入警告 */
function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 配置式表单组件。
 *
 * @description 按 fields 渲染控件；提交前校验 required 字段，缺失则 Toast 提示并中止。
 * @returns {JSX.Element} 表单视图
 */
export default function SchemaForm<T extends Record<string, unknown>>({
  fields,
  values,
  onChange,
  onSubmit,
  submitText = '提交',
  columns = 2,
  className = '',
}: SchemaFormProps<T>) {
  const handleSubmit = () => {
    const missing = fields.find((f) => f.required && !toText(values[f.key]).trim());
    if (missing) {
      showToast(`⚠️ 请填写「${missing.label}」`);
      return;
    }
    onSubmit?.(values);
  };

  return (
    <div className={className}>
      <div className={`grid gap-3 ${COLS_CLASS[columns]}`}>
        {fields.map((field) => {
          const id = `field-${field.key}`;
          const type: FieldType = field.type ?? 'text';
          const raw = values[field.key];

          return (
            <div key={field.key} className={`form-group ${SPAN_CLASS[field.span ?? 1]}`}>
              <label htmlFor={id}>
                {field.label}
                {field.required && <span className="text-red-400"> *</span>}
              </label>

              {type === 'checkbox' ? (
                <input
                  id={id}
                  type="checkbox"
                  className="h-4 w-4 accent-blue-600"
                  checked={Boolean(raw)}
                  onChange={(e) => onChange(field.key, e.target.checked)}
                />
              ) : type === 'select' ? (
                <select
                  id={id}
                  value={toText(raw)}
                  onChange={(e) => onChange(field.key, e.target.value)}
                >
                  <option value="">请选择</option>
                  {field.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : type === 'textarea' ? (
                <textarea
                  id={id}
                  rows={3}
                  value={toText(raw)}
                  placeholder={field.placeholder}
                  onChange={(e) => onChange(field.key, e.target.value)}
                />
              ) : (
                <input
                  id={id}
                  type={type === 'number' ? 'number' : 'text'}
                  value={toText(raw)}
                  placeholder={field.placeholder}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  onChange={(e) =>
                    onChange(field.key, type === 'number' ? Number(e.target.value) : e.target.value)
                  }
                />
              )}
            </div>
          );
        })}
      </div>

      {onSubmit && (
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSubmit}>
          {submitText}
        </button>
      )}
    </div>
  );
}
