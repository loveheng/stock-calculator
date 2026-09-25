---
name: stock-calculator-frontend-dev
description: stock-calculator 前端（React+TS+Vite+Dexie+zustand）开发规范：分层架构与依赖方向（R1/R2/R3 护栏）、领域/实体类型下沉 types/domain、store 切片模式、services 惰性封装 db、新增功能落点速查、文件头注释约定、验证命令。凡在该项目新增功能、修改 store/db/views/services/utils、遇到分层或循环依赖问题时使用。
---

# stock-calculator 前端开发规范

前端应用根目录即 git 仓库根（`stock-calculator/`），所有命令默认在该目录执行。

## 1. 分层架构与依赖方向（最高优先级）

依赖方向必须单向，护栏脚本会强制检查（见第 5 节）：

```
types/domain（零依赖叶子，唯一权威类型定义）
        ↑
utils / risk（纯计算层，不碰 store 状态机）
        ↑
db（持久化）   services（应用服务/网络）   store（状态机）
        ↑
hooks（数据桥接）
        ↑
views / components（UI）
```

### 各层规则

| 层 | 允许依赖 | 禁止 | 说明 |
|---|---|---|---|
| `src/types/domain.ts` | 无 | 任何 import | 领域类型（Position/PositionBatch/RoundTxn/TRoundArchive/LongTermRecord/PlannedOrder）+ 行级实体（BaseEntity/PositionEntity/PositionBatchEntity/PositionAdjustmentEntity/PositionEventEntity）+ 行级别名（TRoundRow）+ FeePresetName 的唯一权威定义 |
| `src/utils/**` | types、utils 内部 | **store（R2）**、db | 纯函数引擎（sandboxEngine/tStreamEngine/metricsEngine 是范本）；常量模块放这里（如 feePresets） |
| `src/risk/**` | types、utils、risk 内部 | store；db 仅限审计落库 | 纯计算层：validator/riskController/priceCache。**views 直调 RiskController 属有意设计，允许**，不要加 store 透传层 |
| `src/db/**` | types/domain、dexie | store/services/views | `db/index.ts` 是桶：Row 类型别名 + entity↔domain 映射 + 全部导出。**桶的 re-export 必须保留完整**——auditLogger、ioSlice 等动态 import 以桶为目标。新表结构定义在 `db/schema.ts` |
| `src/services/**` | db（推荐动态 import）、types | store、views | 惰性封装范本：ledgerService 的 `await import('../db/index')`；视图需要的新读查询优先加到对应 service |
| `src/store/**` | db、services、risk、types、utils | views/components | 新增功能优先新建 `store/slices/xxxSlice.ts`；`store/index.ts` 只做初始状态 + slices 组装 + 向后兼容 re-export，不要再膨胀 |
| `src/hooks/**` | store、services、risk、types | — | 数据桥接层，允许经 service 间接读 db |
| `src/views/**`、`src/components/**` | store、hooks、services、risk、utils、types | **db（R1）** | UI 不得直连持久化层；写操作走 store action，一次性读走 services |

### 三条护栏规则（scripts/check-layers.mjs 强制）

- **R1** `views/**`、`components/**` 不得 import `db/**`（含类型导入——视图不该知道行结构）
- **R2** `utils/**` 不得依赖 `store/**`
- **R3** `types/domain.ts` 零依赖叶子

被护栏拦截时的正确做法：改走 store action / hooks / services，或把类型下沉到 `types/domain.ts`。
**禁止**为了通过检查而修改或绕过护栏脚本。

## 2. 功能地图（修改已有功能先查项目索引）

功能级锚点表与实时触点脚本用法已迁至**前端项目索引** skill `stock-calculator-index`（位于前端仓库 `.agents/skills/`，随仓库演进；机制见 `project-index`）：

- 导航链路：索引归属表定位功能锚点 → `npm run map:features` 校验实时触点（含测试；单域展开 `-- <域>`）→ 到位修改。
- 文件级实时明细永远以脚本输出为准，索引与脚本冲突时以脚本为准。
- 新增功能：在索引表加一行 + 在 `scripts/feature-map.mjs` 的 GROUPS 登记关键词（跑一次确认「未归类」为 0）。
- 锚点按真实职责登记，不看文件名字面义（如 CostAveraging 实为实盘账本视图，Statistics 实为做T统计页）。

## 3. 新增功能落点速查

| 需求 | 落点 |
|---|---|
| 新页面/大视图 | `views/<Name>.tsx` 或 `views/<Name>/index.tsx` |
| 新状态 + 动作 | `store/slices/<feature>Slice.ts`（`StateCreator<AppStore, [], [], Pick<AppStore, ...>>`）+ `store/types.ts` 的 `AppStoreActions` 增加签名 + `store/index.ts` 组装 |
| 新表 | `db/schema.ts`：实体 interface（若被非 db 模块引用，定义放 `types/domain.ts`，schema re-export）+ `STORES_V<n+1>` + TradingLedgerDB 表声明 + 版本 upgrade |
| 新读查询（UI 用） | 对应 `services/*Service.ts`，动态 `import('../db/index')`，返回领域类型 |
| 新计算/引擎逻辑 | `utils/` 纯函数（显式入参、显式返回值，不碰 store/db） |
| 常量/预设 | `utils/`（如 feePresets）；纯类型常量随类型放 `types/domain.ts` |
| 规则类校验 | `risk/` 下加规则，或走 RiskController 门面 |
| 查某功能全部触点 | `npm run map:features`（scripts/feature-map.mjs 实时扫描按功能分组输出视图/状态/服务/计算/测试；新文件按功能词命名自动归组，特例登记脚本内 GROUPS 关键词；「未归类」非空 = 有文件待登记或命名违规） |

## 4. 代码风格约定

- 文件头注释：`@file` / `@description` / `@layer` / `@storage_impact`（涉及存储时必写）/ `@author 开发团队`
- 边界推演防腐注释：凡实现中写了**非显然逻辑**（复合计算、隐式前置条件、反直觉分支、时区/精度陷阱），**同轮**把推演一句话写进该函数的 JSDoc——写「为什么」不写「是什么」，防止未来重构被当冗余删除；超出单函数的宏观业务规则落本仓 `docs/`（文档格式口径参照后端仓 project-local skill `stock-calculator-docs`，跨仓只读）
- 未定论隐患标记：本节记**已定论**规则；若实现**未实证**（浏览器/库行为猜测、边界未验证）或 catch 里**猜测性兜底**（空 catch、仅 console、返回默认值），按 `ai-sideeffect-guard §1` 留 `// UNCERTAIN:` / `// DEGRADE:`（DEGRADE 须在兜底前打 `[DEGRADE] <场景key>` 日志）——扫描与处置口径见 `ai-sideeffect-guard §2`/§4，高危项转 `风险` 待办
- 类型导入：领域类型从 `../types/domain`（或经 `../store`、`../store/types` 兼容路径）；非 db 模块**不要**从 `db/schema`、`db/index` import 实体类型
- 持久化写路径：Dexie 同一 tick 内隐式 put 会覆盖后续显式写，跨表原子写必须用 `db.transaction`（参照 store/slices 中 addBatch 的注释）
- 金额计算用 `decimal.js`；规费统一走 `utils/mathUtils` 的 `calcTradeFees`
- 测试放 `src/__tests__/`，白盒用例不受分层规则约束（护栏自动跳过 `__tests__` 与 `*.test.*`）

## 5. 验证命令（改码后必须全过）

```sh
npx tsc --noEmit        # 类型检查，零错误
npm test                # 已挂 pretest：自动先跑 check:arch 再跑 vitest（要求全绿，用例数不硬编码）
npm run check:arch      # 手动单跑护栏 = check:layers + check:circular（madge）
```

- `check:layers`：R1/R2/R3 静态扫描（scripts/check-layers.mjs，零依赖，本地/CI 均可）
- `check:circular`：madge 循环依赖检测（经 npx 拉起，首次运行需网络）
- CI：`.github/workflows/arch-guard.yml` 在 push/PR 时自动跑护栏
- 测试基线：全绿（BEYOND_ASOF 缓存键碰撞已于 2026-08-31 修复：computeBranchResult 的 memo 键已含 baselineDigest 内容指纹 + feeConfig，基线内容/费率变化均会正确失效）。用例数不硬编码——以最近一次 npm test 实际输出为准

## 6. 环境限制

终端命令与长文件写入遵循 `stock-calculator-workflow` skill：命令禁含 `${...}` 形式字符串；单次写入过长会被截断，大文件分段写入。
