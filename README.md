# 应用骨架（app-skeleton）

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-purple)](https://vitejs.dev/)
[![PWA](https://img.shields.io/badge/PWA-ready-green)](https://web.dev/progressive-web-apps/)

**本地优先（local-first）PWA 骨架**：数据存浏览器 IndexedDB，离线可用、无后端即可运行。
从成熟项目中抽出的工程骨架，用来快速起新项目——架构、护栏、持久化范式、通用 UI 都已就位，
只需要替换领域模型与业务页面。

- 文档入口：[docs/README.md](./docs/README.md)（分层护栏 + 组件/抽象规范）

---

## 技术栈

| 层 | 选型 |
|---|---|
| UI 框架 | React 19 + TypeScript（strict）+ React Router 7 |
| 状态管理 | Zustand 5（切片化：core / notes / settings / io） |
| 持久化 | Dexie 4（IndexedDB），增量 `put`/`update`/`delete`，零 `table.clear()` |
| 构建 | Vite 8 + vite-plugin-pwa |
| 样式 | Tailwind CSS 3 + 语义类（`.card` / `.btn` / `.form-group` / `.tab-bar`） |
| 测试 | Vitest 4 + fake-indexeddb |

**架构核心**：单向依赖分层
`types/domain.ts`（零依赖权威类型）→ `utils`（纯函数 / 持久化军械）→ `db`（DAO）→ `services`（跨层编排）→ `store`（Zustand 切片）→ `hooks` → `views`/`components`，
由静态护栏 `check:layers`（R1/R2/R3）+ madge 循环检测在 `npm test` 与 CI 中强制。

---

## 目录结构

```
src/
├── types/domain.ts     领域类型权威源（零依赖叶子，护栏 R3）
├── db/
│   ├── schema.ts       Dexie 表结构与实体类型（epoch ms）
│   ├── index.ts        DAO：实体↔领域转换、按需加载、增量写入
│   └── cleanUndefined.ts  写库前剔除 undefined（结构化克隆防炸）
├── services/           跨层编排（示例：backupService 快照导出/导入）
├── store/
│   ├── index.ts        Store 组装（初始状态 + 切片装配）
│   ├── types.ts        AppStore 契约
│   ├── bootstrap.ts    initStore：冷启动水合 + 打开持久化闸门
│   └── slices/         core / notes / settings / io 切片
├── hooks/              useLoadCoreData（按需加载）
├── views/Home.tsx      示例页面（CRUD + 设置 + 快照导入导出）
├── components/ui/      通用 UI：Toast / ConfirmModal / EmptyState / InstallPrompt / ModeTabs
└── __tests__/          示例测试（链路冒烟 + 持久化军械）
```

---

## 快速开始

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # 产物 dist/
npm test               # pretest 自动先跑架构护栏
npm run check:arch     # 分层依赖 + 循环依赖
npm run map:features   # 功能 → 文件触点速查
```

---

## 扩展指南（起新项目改这几处）

1. **领域模型**：`src/types/domain.ts` —— 定义自己的领域类型与默认值（替换示例 `Note`）。
2. **表结构**：`src/db/schema.ts` —— 新增实体与索引；升版本时追加 `STORES_Vx` 增量定义。
3. **读写**：`src/db/index.ts` —— 补 `load*` / `put*` / `delete*`（软删，禁用 `table.clear()`）。
4. **状态**：`src/store/slices/` 新增切片 → 在 `store/types.ts` 扩 Action 签名 → 在 `store/index.ts` 装配。
   - 写入纪律：先 `set()` 更新内存态，再 `safePersist(() => dao())` 落库。
5. **页面**：`src/views/` 新增页面 → 在 `src/App.tsx` 的 `NAV_ITEMS` 与 `<Routes>` 注册。
6. **护栏**：保持 R1（views 不直连 db）/ R2（utils 不依赖 store）/ R3（domain 零依赖），CI 会自动拦截。

---

## 工程约定

- **数据零丢失**：全库禁用 `table.clear()`；写库统一经 `safePersist`（首载闸门 + 指数退避重试 + 失败队列重放）。
- **类型单一权威源**：领域类型只在 `types/domain.ts` 定义，`db/schema.ts` 仅 re-export。
- **架构护栏**：`check:layers` + madge 已挂 `pretest` 与 CI；禁止为通过检查而绕过护栏脚本。
- **功能地图**：`npm run map:features` 实时扫描生成；「未归类」清单即漂移探测器。
- **开发规范**：写新功能前先读 [docs/development/component-standards.md](./docs/development/component-standards.md)
  —— 抽象阈值（Rule of Three）、组件三级目录（`ui/` → `blocks/` → 页面私有）、配置式优先的四类场景。
  骨架已内置两个配置式组件：`SchemaForm`（字段配置驱动表单）、`DataTable`（列配置驱动列表）。
