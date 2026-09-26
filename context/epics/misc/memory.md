---
dev-loop: memory
format: v1
epic: misc
total-merged: 1
last-merge: 2026-09-26
---

# misc 常驻杂项（散修挂靠）

## 结论
- 2026-09-12 项目架构分析已完成（docs 全量 + 代码核对），报告会话内交付未落盘。
- 2026-09-12 ma20「同根先卖后买」抖动已修（0d87177 同日单向互斥守卫），补 6 策略「同日买卖互斥」回归单测；strategy-generators-review.md P2/§4.2 状态已同步。
- 2026-09-19 v1.3 批次恢复落地：列表分页续拉 + F1 筛选即查 + 线上脏数据防御（含 searchSlice 遗漏的 SearchRequest 类型导入补修）。
- 2026-09-19 Copilot V2.1 区块独立会话上线：线程键 copilotThreadKey = scopeId:blockId，公告/日报问答互不叠加（spec v1.4 / impl v1.3）；同轮资讯搜索页公告卡移除订阅按钮（档案卡/交易卡保留）、资讯页改单一日期筛选（dateRange 单日闭区间 start=end，改动走 stale 提示不自动重查，spec v1.5）。
- 2026-09-26 guide 向导一期落地：docs/guide-spec.md v1.0→v1.1（档案卡归宿改画布 brief 块，dataVocab 一期只上「提及数」），实现 guideService + CanvasBriefCard + 模板注册/守卫/摘要/布局/徽标穷举表同步 + canvas_add_block 七类→八类 + add_block exec brief 分支；feature-map GROUPS 与项目索引登记 guide 域；人工冒烟（联调落块/取数词直出）待用户跑（需后端 :18080 在线）。
- 2026-09-26 D33 v1.6 修「放上画布」失灵：buildCanvasPromptHints 公共段改 canvas scope 内必带（v1.5 触发词条件携带下放置类说法漏触发词，LLM 误用 fetch_kline 只回数据不落画布并幻觉成功）；COMMON 补 brief 块语义；copilot-spec v1.6 + canvasPrompts/copilotSlice 测试同轮修订；真机复测待用户。
- 2026-09-26 copilot 错误映射补 409：新增 REQUEST_IN_FLIGHT 子码（SUB_CODE_FEEDBACK 登记 + CODE_FALLBACK 409 兜底），SSE error 分支改与信封路径一致接 CODE_FALLBACK——修复后端「上一次提问仍在处理中」的 409 被当 UPSTREAM_ERROR、气泡显示「AI 服务暂不可用」的问题（气泡渲染 hint 字段，映射码缺卡时后端 message 会被固定 hint 覆盖）；copilotStream 补信封回落与 SSE 两路回归用例；真机冒烟待用户。

## 近期验证状态
- 2026-09-26 npm test 869 用例全绿（pretest check:arch 通过）+ npx tsc --noEmit 零错误。

## 断点
- [断点] 下一步：等待散修任务；多批未提交工作待用户提交（v1.3 批次 + guide brief 块 + D33 v1.6 + 409 映射 + toast.ts 递归修复）；proxy.config.js 的 DEV_UPSTREAM_ENV=local 去留待定
