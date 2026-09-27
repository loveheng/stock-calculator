---
status: active
updated: 2026-09-27
---

# 分层架构与护栏

## 1. 依赖方向（自上而下单向）

```
views / components        UI 层：只消费 store 与 hooks
        ↓
hooks                     组装层：按需加载、视图逻辑
        ↓
store                     Zustand 切片：内存态 + safePersist 落库
        ↓
services                  跨层编排（备份、同步、外部接口）
        ↓
db                        DAO：Dexie 实体转换与增量读写
        ↓
utils                     纯函数 / 持久化军械（safePersist）
        ↓
types/domain.ts           领域类型权威源（零依赖叶子）
```

## 2. 护栏规则（`scripts/check-layers.mjs`）

| 规则 | 内容 | 目的 |
|---|---|---|
| **R1** | `views/` `components/` 不得 import `db/` | 持久化细节收敛在 store / hooks / services |
| **R2** | `utils/` 不得 import `store/` | 计算层保持纯函数，类型取自 `types/domain` |
| **R3** | `types/domain.ts` 零项目内依赖 | 领域类型唯一权威定义，禁止反向依赖 |

额外：`npm run check:circular`（madge）检测循环依赖。
两条检查挂在 `pretest` 与 `.github/workflows/arch-guard.yml`，合入前自动拦截。

## 3. 目录职责

| 目录 | 职责 | 禁区 |
|---|---|---|
| `types/` | 领域模型与常量（ISO 时间戳） | 禁止 import 任何项目内模块（R3） |
| `db/` | 实体定义（epoch ms）、索引、实体↔领域转换、增量读写 | 禁止 `table.clear()` |
| `services/` | 跨层编排（快照、同步、外部 API） | 禁止反向 import `store`（防循环） |
| `store/` | Zustand 切片：Action 与内存态 | 写库必须走 `safePersist` |
| `hooks/` | 视图侧组装（按需加载等） | 不直接写库 |
| `views/` `components/` | 页面与组件 | 禁止直连 `db`（R1） |
| `utils/` | 纯函数、持久化军械 | 禁止依赖 `store`（R2） |

## 4. 持久化范式

1. 冷启动 `initStore()`：只读「设置」单行 → `markInitialLoadDone()` 打开闸门；
   业务数据由视图挂载后 `useLoadCoreData()` 按需加载。
2. 所有写库经 `safePersist(fn)`：闸门未开直接 no-op；失败按 1s→2s→4s 退避重试 3 次，
   仍失败则入队，下次写库成功时自动重放。
3. 删除一律软删（`isDeleted=1`）或按主键删；**禁用 `table.clear()`**。
4. 写库前 `cleanUndefined()` 剔除 undefined 字段，避免结构化克隆报错。

## 5. 扩展新功能步骤

1. `types/domain.ts` 定义领域模型 → 2. `db/schema.ts` 加表/索引（追加版本）
3. `db/index.ts` 加读写函数 → 4. `store/slices/` 加切片并在 `store/types.ts` + `store/index.ts` 注册
5. `views/` 加页面并在 `App.tsx` 注册路由 → 6. `__tests__/` 补一条「落库后可回读」用例

跑 `npm run check:arch && npm test` 确认未破坏护栏。
