# 股票计算器 PWA（stock-calculator）

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6+-purple)](https://vitejs.dev/)
[![PWA](https://img.shields.io/badge/PWA-ready-green)](https://web.dev/progressive-web-apps/)

面向个人投资者的**全功能股票做T账本与成本计算器 PWA**。全部数据保存在浏览器本地（IndexedDB），无需后端服务，离线可用；并支持 WebDAV 备份、服务端密文同步与多端部署。

---

## 文档导航（先读这里）

- **[docs/README.md](./docs/README.md)** — 文档总索引：按功能域（部署 / 架构 / 各业务模块 / 前端规范 / 监控）列出全部 28 篇文档，是检索文档的入口。
- **[GUIDE.md](./GUIDE.md)** — 项目深度阅读指南：目录结构、分层架构、数据流、核心模块详解、设计决策与版本演进。改代码前必读。
- 文档内互相引用均为相对路径，可直接跳转；状态以各文档 frontmatter（`status` / `updated`）为准。

---

## 核心特点（这个项目有什么不同）

- **为「做T」而生，而非普通记账**：围绕正T / 倒T 日内套利构建——FIFO 撮合引擎自动配对结算、5 种结算类型、超卖/超买超限防御弹窗，并自动归档为 Round 战报（净收益 / 胜率 / 持股天数）。
- **本地优先 · 隐私可控**：全部数据存于浏览器 IndexedDB，无后端也能用、离线可用（PWA）；即使开启云端同步，也走 E2EE 密文（服务端只存密文，密钥在本地）。
- **金融级精度**：全程 Decimal.js 定点运算，杜绝浮点误差；费率按品种（股票 / ETF / 债券）分层精确计费（ETF 免印花税、债券免税）。
- **数据零丢失工程**：增量 `put` / `delete` 持久化、全代码库禁用 `table.clear()`；`safePersist` 三重防护（启动装载守卫 + 指数退避重试 + 失败队列重放）。
- **沙盘复盘（What-if）**：以真实资金占用峰值为预算，重演不同买卖决策路径，9 套策略生成器 + 四维对比，决策前先推演。
- **工程护栏即工具**：单向依赖分层 + 静态 `check:layers`（R1/R2/R3）+ 循环依赖检测挂进 `pretest` / CI；领域类型单一权威源 `types/domain.ts`，架构约定由工具强制而非口头。

---

## 功能特性

| 模块 | 说明 |
|---|---|
| 估值计算器 | 涨跌幅 / 目标价 / 补仓数量联动计算，手续费实时联动 |
| 成本摊薄 | 持仓加权平均法：买入/卖出/分红批次管理，成本重算 |
| 做T计算器 | 正T / 倒T 双向记录，FIFO 撮合引擎自动配对结算 + 超限防御 |
| Round 战报 | 每轮做T自主归档（交易明细 + 净收益 + 胜率 + 持股天数） |
| 沙盘复盘 | What-if：以真实资金占用峰值为预算，重演决策路径，多方案对比 |
| 统计面板 | 盈亏汇总 / 胜率 / 日历热力图（月度/年度） |
| 费率配置 | 佣金 / 印花税 / 过户费 / 其它费用，按交易所与品种精确配置 |
| 云端同步 | WebDAV 备份恢复 + 服务端 E2EE 密文同步（登录即备份） |
| 离线访问 | PWA 安装到桌面，service worker 离线缓存 |

共 8 个功能页面：`/`（仪表盘）、`/change-rate`、`/t-calculator`、`/cost-averaging`、`/sandbox`、`/statistics`、`/fee-config`、`/webdav`。

---

## 技术栈

| 层 | 选型 |
|---|---|
| UI 框架 | React 19 + TypeScript（strict）+ React Router 7 |
| 状态管理 | Zustand 5（切片化：core / positions / orders / rounds / streams / io + 沙盘独立 Store） |
| 持久化 | Dexie 4（IndexedDB），增量 `put`/`delete`，零 `table.clear()` |
| 构建 | Vite + vite-plugin-pwa |
| 样式 | Tailwind CSS + 自定义组件 |
| 数值计算 | Decimal.js（金融精度，避免浮点误差） |
| 图表 | lightweight-charts / recharts |
| 加密同步 | scure/bip39 + QuickJS（E2EE 密文同步） |

**架构核心**：单向依赖分层（`types/domain.ts` 零依赖权威类型 → `utils`/`risk` 纯计算 → `db`/`services` → `store` → `hooks` → `views`/`components`），由静态护栏 `check:layers`（R1/R2/R3）+ madge 循环检测在 `npm test` 与 CI 中强制。详见 [GUIDE.md](./GUIDE.md)。

---

## 快速开始

```bash
npm install          # 安装依赖

npm run dev          # 开发服务器 → http://localhost:5173（HMR）
npm run build        # 生产构建 → dist/（vite build + scripts/postbuild.js）
npm run preview      # 预览生产构建

npx tsc --noEmit     # TypeScript 类型检查
npm test             # 单元测试（pretest 自动先跑 check:arch 架构护栏）
npm run check:arch   # 手动单跑架构护栏：分层依赖 + 循环依赖
npm run map:features # 功能 → 文件触点实时速查（脚本扫描生成，永不过期）
```

---

## 部署

三种部署形态并存、互不影响：

| 形态 | 说明 |
|---|---|
| **Vercel** | `vercel.json` 路由 + `middleware.js` 代理 + `api/` Serverless Function，零额外配置 |
| **Docker / GHCR** | 多阶段构建，运行时 `server/index.mjs` 零依赖；镜像自动发布至 `ghcr.io/loveheng/stock-calculator`（`docker pull` 即用） |
| **Cloud Run** | 同一 Dockerfile 容器化跑在 GCP，构建逻辑与本地一致。详见 [docs/deploy/cloud-run-deploy.md](./docs/deploy/cloud-run-deploy.md) |

环境变量（Docker / Cloud Run 通用）：`PORT`（默认 3000）、`HOST`、`AUTH_UPSTREAM`、`IMPORT_UPSTREAM`（覆盖认证/OCR 上游）。

基础 Docker 用法：

```bash
docker build -t stock-calculator .
docker run -d -p 3000:3000 --name stock-calculator stock-calculator
# 访问 http://localhost:3000，健康检查探针 /healthz
```

---

## 数据库设计

IndexedDB（库名 `TradingLedgerDB`），全部在线/离线可用；v5 起所有写入改为增量 `put`/`delete`，消除数据丢失隐患。

| 表 | 说明 |
|---|---|
| `feeConfigs` | 费率配置（单行） |
| `stocks` | 已操作股票元信息（含 `kind` 费率分类） |
| `positions` / `positionBatches` | 持仓账本（底仓 + 加权成本）/ 持仓批次明细 |
| `tRounds` | 做T轮次（OPENED 进行中 / COMPLETED 已归档） |
| `tTransactions` | 做T流水唯一持久化表（Round 内流水池 + 成交明细；v8 取代 tStreams） |
| `longTermRecords` | 中长期操作记录 |
| `settings` / `accountCash` | 通用键值配置 / 现金账户（单行） |

---

## 开发约定

- **架构护栏**：分层依赖（`check:layers` R1/R2/R3）与循环依赖（madge）已挂 `pretest` 与 CI（`.github/workflows/arch-guard.yml`），合入前自动拦截违例。**禁止为通过检查而绕过护栏脚本。**
- **类型单一权威源**：领域类型统一定义在 `src/types/domain.ts`，`db/schema` 仅 re-export。
- **增量持久化**：写库统一经 `safePersist`（initialLoadDone 守卫 + 指数退避重试 + 失败队列重放），全代码库禁用 `table.clear()`。
- **功能地图**：`npm run map:features` 实时扫描生成功能→文件触点；末尾「未归类」清单即漂移探测器。

---

## 版本

- **v9**（2026-08）— 分层解耦 + 架构护栏：领域类型下沉 `types/domain.ts`、Store 切片化、静态护栏进 CI、生成式功能地图
- **v8** — 做T数据模型重构：流水唯一持久化为 `tTransactions`，结清复用同一 Round（消除重复归档）
- **v7** — 按需加载重构：冷启动仅加载费率，增量持久化 + 证券分层费率
- **v5** — 增量持久化重构：移除 `table.clear()`
- **v1–v4** — 基础计算器 → 做T记录 → FIFO 撮合引擎 → 战报归档

完整演进与决策见 [GUIDE.md](./GUIDE.md) 第六、八节。
