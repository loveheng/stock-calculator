# 股票计算器 PWA

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6-purple)](https://vitejs.dev/)
[![PWA](https://img.shields.io/badge/PWA-ready-green)](https://web.dev/progressive-web-apps/)

面向个人投资者的全功能股票成本计算与做T盈亏分析 PWA 应用。

---

## 功能

| 模块 | 说明 |
|---|---|
| 估值计算器 | 涨跌幅 / 目标价 / 补仓数量联动计算，手续费实时联动 |
| 成本摊薄 | 持仓加权平均法：买入/卖出/分红批次管理，成本重算 |
| 做T计算器 | 正T / 倒T 双向记录，FIFO 撮合引擎自动配对结算 |
| Round 战报 | 每轮做T自主归档（交易明细 + 净收益 + 胜率 + 持股天数） |
| 统计面板 | 盈亏汇总 / 胜率 / 日历热力图（月度/年度） |
| 费率配置 | 佣金 / 印花税 / 过户费 / 其它费用，按交易所精确配置 |
| 离线访问 | PWA 安装到桌面，service worker 离线缓存 |

---

## 技术架构

```
React 19 (UI)  →  Zustand (全局状态)  →  Dexie/IndexedDB (持久化)
                        │
                        ├── FIFO 撮合引擎 (tStreamEngine.ts)
                        ├── 费用计算 (mathUtils.ts)
                        └── 增量持久化 (put/delete/bulkPut)
```

- **前端框架**：React 19 + TypeScript 5.8
- **状态管理**：Zustand — 30+ Action，每个 Action 内置增量 DB 写入
- **持久化**：Dexie.js (IndexedDB wrapper) — 10 张表，v5 重构为增量写入（零 `table.clear()` 调用）
- **构建工具**：Vite 6 + PWA 插件
- **UI 样式**：Tailwind CSS + 自定义组件
- **数值计算**：Decimal.js（金融精度，避免浮点误差）

---

## 快速开始

```bash
# 安装
npm install

# 开发
npm run dev          # → http://localhost:5173

# 构建
npm run build        # → dist/

# 类型检查
npx tsc --noEmit

# 测试
npx vitest run
```

---

## 项目阅读指南

详见 [GUIDE.md](./GUIDE.md)，包含：
- 完整目录结构与分层架构
- 数据流说明（启动 → Action → DB 增量写入）
- 核心模块 API 一览
- 从新手到深入的阅读路径建议
- 关键设计决策记录
- 版本演进历史 (v1–v5)

---

## 数据库设计

| 表 | 说明 |
|---|---|
| `feeConfigs` | 费率配置（单行） |
| `stocks` | 已操作股票元信息 |
| `positions` | 持仓账本（底仓 + 加权成本） |
| `positionBatches` | 持仓批次明细 |
| `tRounds` | 做T轮次表（OPENED 进行中 / COMPLETED 已归档） |
| `tTransactions` | 做T流水唯一持久化表（Round 内流水池 + 成交明细；v8 取代 tStreams） |
| `longTermRecords` | 中长期操作记录 |
| `settings` | 通用键值配置 |

全部通过 IndexedDB 在线/离线可用；v5 重构后所有写入改为增量 `put` / `delete`，彻底消除数据丢失隐患。

---

## 版本

- **v5** (2026-08) — 增量持久化重构，移除 `table.clear()`，改为 `put`/`delete`/`bulkPut` 精确写入
- **v4** — Round 战报归档 + 绝对现金流划转 + 中长期操作记录
- **v3** — 做T流水池 tStreams + FIFO 撮合引擎
- **v2** — 做T 记录（正T/倒T）
- **v1** — 基础计算器 + 成本摊薄
