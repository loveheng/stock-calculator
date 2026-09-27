---
status: active
updated: 2026-09-27
---

# 文档索引（docs/）

> 纯结构索引；各文档时效以自身 frontmatter（`status` / `updated`）为唯一事实源，此处不重复。
> 功能域：部署运维 / 架构规范 / 各业务功能 / 前端规范 / 监控。跨域迁移见各文档正文墓碑。

## deploy（部署运维）

- [cloud-run-deploy](deploy/cloud-run-deploy.md) — PWA 容器化部署到 Google Cloud Run 的架构与运维命令

## architecture（跨域架构与规范）

- [guide-spec](architecture/guide-spec.md) — 全局指南/总纲，跨模块约定与决策索引
- [behavior-spec](architecture/behavior-spec.md) — 统一行为/交互规范
- [risk-module-doc](architecture/risk-module-doc.md) — 风险计算模块设计
- [strategy-generators-review](architecture/strategy-generators-review.md) — 策略生成器评审
- [e2ee-auth-spec](architecture/e2ee-auth-spec.md) — 端到端加密与认证方案

## features/batch-import（批量导入）

- [batch-import](features/batch-import/batch-import.md) — 批量导入功能规格与目录结构
- [batch-import-vue](features/batch-import/batch-import-vue.md) — 批量导入 Vue 页面实现

## features/custom-stats（自定义统计）

- [custom-stats-spec](features/custom-stats/custom-stats-spec.md) — 自定义统计前端规格
- [custom-stats-implementation](features/custom-stats/custom-stats-implementation.md) — 自定义统计前端实现
- [custom-stats-server-sync](features/custom-stats/custom-stats-server-sync.md) — 自定义统计与服务端同步

## features/free-canvas（自由画布）

- [free-canvas-spec](features/free-canvas/free-canvas-spec.md) — 自由画布功能规格
- [free-canvas-backend-integration](features/free-canvas/free-canvas-backend-integration.md) — 画布与后端集成
- [free-canvas-template-registry](features/free-canvas/free-canvas-template-registry.md) — 画布区块模板注册表

## features/news（资讯）

- [news-search-spec](features/news/news-search-spec.md) — 资讯检索规格
- [news-search-implementation](features/news/news-search-implementation.md) — 资讯检索实现
- [news-kg-spec](features/news/news-kg-spec.md) — 资讯知识图谱规格

## features/planned-orders（计划委托）

- [planned-orders-spec](features/planned-orders/planned-orders-spec.md) — 计划委托功能规格

## features/position-ledger（持仓台账）

- [position-ledger-spec](features/position-ledger/position-ledger-spec.md) — 持仓台账功能规格

## features/sandbox（沙盘回放）

- [sandbox-replay-spec](features/sandbox/sandbox-replay-spec.md) — 沙盘回放功能规格
- [sandbox-replay-implementation](features/sandbox/sandbox-replay-implementation.md) — 沙盘回放实现

## features/copilot（Copilot 上下文）

- [copilot-spec](features/copilot/copilot-spec.md) — Copilot 上下文机制规格
- [copilot-implementation](features/copilot/copilot-implementation.md) — Copilot 上下文实现

## features/server-sync（服务端同步）

- [server-sync-spec](features/server-sync/server-sync-spec.md) — 服务端数据同步规格
- [server-sync-implementation](features/server-sync/server-sync-implementation.md) — 服务端同步实现

## standards（规范）

- [frontend-doc-standard](standards/frontend-doc-standard.md) — 前端文档规范（docs-spec 在前端子域的落地细则）

## monitor（监控）

- [api](monitor/api.md) — 监控 API 字段契约
- [design](monitor/design.md) — 监控判定链/合并窗口/推送设计
