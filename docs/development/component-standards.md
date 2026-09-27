---
status: active
updated: 2026-09-27
---

# 功能开发规范（配置式组件 + 抽象纪律）

## 0. 结论：规范先行，配置式组件跟上

| | 作用 | 缺失症状 |
|---|---|---|
| **开发规范** | 解决一致性：放哪儿、怎么命名、何时抽象、数据怎么落库 | 每个人/每次写法不同，AI 也无从遵循，代码越快越乱 |
| **配置式组件** | 解决重复：结构相同、字段不同的 UI（表单/列表/子菜单/筛选） | 每个页面手写一遍，改一处要改 N 处 |

顺序固定：**先有规范，再从重复里长出配置式组件**。反过来先造组件库，多半变成没人用的轮子。

## 1. 抽象阈值：Rule of Three

1. **第 1 次**：在页面里写死，别抽象（你不知道第二次需求长什么样）
2. **第 2 次**：允许复制一份（复制成本 < 错误抽象成本）
3. **第 3 次**：必须抽象，且优先做成**配置驱动**，而不是加布尔参数

**配置化 vs 参数化**：

```tsx
// ❌ 参数化布尔炸弹：需求一变就失控
<Panel showTags sortable compact withFooter />

// ✅ 配置驱动：结构稳定，差异外置
<DataTable columns={NOTE_COLUMNS} rows={notes} rowKey={(n) => n.id} />
<SchemaForm fields={NOTE_FIELDS} values={draft} onChange={setField} onSubmit={submit} />
```

## 2. 组件分三级（目录即规则）

| 级别 | 目录 | 准入标准 | 例子 |
|---|---|---|---|
| **通用原子** | `src/components/ui/` | 零业务语义、可跨项目复用、配置驱动 | `SchemaForm` `DataTable` `Toast` `ConfirmModal` `EmptyState` `ModeTabs` |
| **复用块** | `src/components/blocks/` | 跨 2+ 页面复用的业务块（含业务类型） | `NoteRow` `SettingsBar`（有业务语义才放这层） |
| **页面私有** | `src/views/Xxx/` 或页面内子组件 | 只在一个页面用到 | 页面专属卡片、局部筛选条 |

**默认放页面私有**，被第二、三次用到才上移 —— 不要一开始就往 `ui/` 塞。

## 3. 配置式优先的四类场景

| 场景 | 组件 | 配置形态 |
|---|---|---|
| 表单（新增/编辑/筛选） | `SchemaForm` | `fields: SchemaField[]`（类型/校验/占位/栅格跨度） |
| 列表 / 表格 | `DataTable` | `columns: ColumnConfig<T>[]`（表头 + render + 对齐 + 宽度） |
| 页内子菜单 / 分段切换 | `ModeTabs` | `tabs: { key, label }[]` |
| 空态 / 确认 / 提示 | `EmptyState` `ConfirmModal` `Toast` | props 直接配置 |

判断标准：**"结构固定、字段/列不同"** 的都该配置化；**"交互流程不同"** 的不该硬套。

## 4. 反模式（明令禁止）

- 给通用组件加业务字段（如 `noteMode`）—— 业务差异用 `render`/`fields` 外置
- 用布尔 props 表达变体（超过 3 个布尔就该拆组件或改配置）
- 在 `ui/` 里 import `store/` `db/`（护栏 R1；通用组件只接收 props 与回调）
- 为"可能用到"提前做泛型/扩展点（YAGNI）
- 抽象后调用比原来还难懂 —— 立刻回退为复制

## 5. 新增功能 SOP（照做即可）

1. **类型**：`src/types/domain.ts` 定义领域模型（零依赖，R3）
2. **持久化**：`src/db/schema.ts` 加表/索引（追加版本）→ `src/db/index.ts` 加 `load*`/`put*`/`delete*`（软删，禁用 `table.clear()`）
3. **状态**：`store/slices/` 新增切片 → `store/types.ts` 补 Action 签名 → `store/index.ts` 装配
   - 写入纪律：先 `set()` 更新内存态，再 `safePersist(() => dao())` 落库
4. **页面**：`src/views/` 新增 → `App.tsx` 的 `NAV_ITEMS` + `<Routes>` 注册
   - 表单/列表优先用 `SchemaForm` / `DataTable`，配置写在页面顶部常量
5. **测试**：`src/__tests__/` 补一条「落库后可回读」用例
6. **验收**：`npm run check:arch && npm test && npm run build`

## 6. 文件头注释模板（每个文件必带）

```ts
/**
 * @file Xxx.tsx
 * @description 一句话职责 + 关键设计取舍（为什么这么做，不是做了什么）
 * @layer UI | Views | Store | Services | DB | Utils | Types
 * @storage_impact 是否读写 IndexedDB / 走 safePersist；纯展示写「无存储读写」
 * @author 团队名
 */
```

## 7. 命名约定

- 组件/类型：`PascalCase`；文件与默认导出同名
- 配置常量：`XXX_FIELDS` / `XXX_COLUMNS`（全大写 + 下划线），放页面顶部或 `config/` 子目录
- Store Action：动词开头（`loadXxx` `addXxx` `saveXxx` `removeXxx`）
- 布尔字段：`is/has/auto` 前缀；时间戳：领域层 ISO 字符串，实体层 epoch ms
