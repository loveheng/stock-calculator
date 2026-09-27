/**
 * @file Home.tsx
 * @description 示例页面：一条完整的「领域模型 → DAO → Store → 视图」链路演示
 *              —— 笔记增删改查（IndexedDB 持久化）、设置持久化、快照导出/导入。
 *              同时是「配置式组件」的示范页：表单只写 NOTE_FIELDS 配置（SchemaForm），
 *              列表只写列配置（DataTable），业务差异外置在 render 里，页面不含重复 UI 代码。
 *              扩展新项目时，请以本页为模板替换成自己的业务页面。
 * @layer Views
 * @storage_impact 经 Store Action 写库（safePersist 增量落库），本页不直连 db（护栏 R1）。
 * @author 骨架模板
 */

import React, { useMemo, useState } from 'react';
import { Trash2, Download, Upload, FileText } from 'lucide-react';
import EmptyState from '../components/ui/EmptyState';
import ConfirmModal from '../components/ui/ConfirmModal';
import SchemaForm, { type SchemaField } from '../components/ui/SchemaForm';
import DataTable, { type ColumnConfig } from '../components/ui/DataTable';
import { useAppStore } from '../store';
import { showToast } from '../utils/toast';
import type { Note } from '../types/domain';

/** 新增笔记表单配置（结构固定、字段不同 → 配置化，不手写 JSX） */
const NOTE_FIELDS: SchemaField[] = [
  { key: 'title', label: '标题', required: true, placeholder: '例如：第一条笔记' },
  { key: 'tags', label: '标签（逗号分隔）', placeholder: '示例, 骨架' },
  { key: 'content', label: '内容', type: 'textarea', span: 2, placeholder: '随便写点什么' },
];

/** 表单草稿初值 */
const EMPTY_DRAFT = { title: '', content: '', tags: '' };

export default function Home() {
  const notes = useAppStore((s) => s.notes);
  const settings = useAppStore((s) => s.settings);
  const addNote = useAppStore((s) => s.addNote);
  const updateNote = useAppStore((s) => s.updateNote);
  const removeNote = useAppStore((s) => s.removeNote);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const exportData = useAppStore((s) => s.exportData);
  const importData = useAppStore((s) => s.importData);

  const [draft, setDraft] = useState<Record<string, unknown>>({ ...EMPTY_DRAFT });
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);

  const handleSubmit = async (values: Record<string, unknown>) => {
    await addNote({
      title: String(values.title ?? '').trim(),
      content: String(values.content ?? '').trim(),
      tags: String(values.tags ?? '')
        .split(/[,，\s]+/)
        .filter(Boolean),
    });
    setDraft({ ...EMPTY_DRAFT });
    showToast('✅ 已新增笔记并写入 IndexedDB');
  };

  // 列表列配置：业务差异（勾选、标签、删除）全部外置到 render
  const columns = useMemo<ColumnConfig<Note>[]>(
    () => [
      {
        key: 'done',
        header: '完成',
        width: '56px',
        align: 'center',
        render: (note) => (
          <input
            type="checkbox"
            className="h-4 w-4 accent-blue-600"
            checked={note.done}
            onChange={(e) => void updateNote(note.id, { done: e.target.checked })}
            aria-label={`标记完成：${note.title}`}
          />
        ),
      },
      {
        key: 'title',
        header: '标题',
        render: (note) => (
          <div className="min-w-0">
            <p className={`text-sm font-medium ${note.done ? 'text-slate-500 line-through' : 'text-slate-200'}`}>
              {note.title}
            </p>
            {note.content && <p className="text-xs text-slate-500 mt-0.5">{note.content}</p>}
            {note.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {note.tags.map((tag) => (
                  <span key={tag} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'actions',
        header: '操作',
        width: '72px',
        align: 'center',
        render: (note) => (
          <button
            className="tap-target rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10"
            onClick={() => setPendingDelete(note)}
            aria-label={`删除：${note.title}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        ),
      },
    ],
    [updateNote],
  );

  const handleExport = () => {
    const snapshot = exportData();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snapshot-${snapshot.exportedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('✅ 快照已导出');
  };

  const handleImport = async (file: File) => {
    try {
      await importData(await file.text());
      showToast('✅ 快照已导入');
    } catch (err) {
      showToast(`❌ 导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="page-container">
      <div className="card">
        <h3>新增笔记</h3>
        <SchemaForm
          fields={NOTE_FIELDS}
          values={draft}
          onChange={(key, value) => setDraft((prev) => ({ ...prev, [key]: value }))}
          onSubmit={(values) => void handleSubmit(values)}
          submitText="新增"
        />
      </div>

      <div className="card">
        <h3>笔记列表（{notes.length}）</h3>
        <DataTable
          columns={columns}
          rows={notes}
          rowKey={(note) => note.id}
          empty={<EmptyState title="还没有笔记" description="在上面的表单里新增一条，数据会写入浏览器 IndexedDB" icon={FileText} variant="panel" />}
        />
      </div>

      <div className="card">
        <h3>设置与备份</h3>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 accent-blue-600"
              checked={settings.autoBackup}
              onChange={(e) => void saveSettings({ autoBackup: e.target.checked })}
            />
            自动备份开关（示例：设置单行持久化）
          </label>
          <button className="btn btn-outline btn-sm" onClick={handleExport}>
            <Download className="w-4 h-4" />
            导出快照
          </button>
          <label className="btn btn-outline btn-sm cursor-pointer">
            <Upload className="w-4 h-4" />
            导入快照
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImport(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </div>

      <ConfirmModal
        open={pendingDelete !== null}
        title="删除笔记"
        message={`确认删除「${pendingDelete?.title ?? ''}」？删除后不可恢复。`}
        variant="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) {
            void removeNote(target.id).then(() => showToast('✅ 已删除'));
          }
        }}
      />
    </div>
  );
}
