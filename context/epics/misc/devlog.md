---
dev-loop: devlog
format: v1
epic: misc
total-merged: 0
last-merge: none
---
- [2026-09-12] [变更]: ma20 同根先卖后买抖动确认已修（0d87177 同日单向互斥守卫），补 6 策略「同日买卖互斥」回归单测（mkSwing 摆动夹具），strategy-generators-review.md P2/§4.2 状态同步为已修；769 用例全绿
- [2026-09-19] [变更]: 恢复验证 v1.3 未提交批次（列表分页续拉 + F1 筛选即查 + 线上脏数据防御）；修复 searchSlice 遗漏的 SearchRequest 类型导入、补同步 1 处存量断言分页参数，tsc 零错误 + 779 用例全绿
- [2026-09-19] [变更]: 资源(资讯)搜索页公告卡移除订阅按钮（档案卡与交易卡片保留）；Copilot V2.1 区块独立会话——聚焦时线程键经 copilotThreadKey 下沉为 scopeId:blockId，每条公告/日报问答互不叠加，spec v1.4 / implementation v1.3 同步，781 用例全绿
- [2026-09-19] [变更]: 资讯页日期预设（近7天/近30天）移除，改为单一日期筛选（dateRange 单日闭区间 start=end，清除即不限；日期改动走 stale 提示不自动重查），spec v1.5 同步，781 用例全绿
- [2026-09-26] [变更]: 新增 docs/guide-spec.md v1.0（guide 选股引导向导前端设计定稿：零新 slice 视图本地态、nextAction 分支纪律、prefillDraft handoff 通道、落点清单与验证口径；对接后端仓 docs/guide/api.md）
- [2026-09-26] [验证]: 写后自检通过——引用锚点（copilotSlice setCopilotOpen / GlobalCopilot draft 与 quickActions / useCanvasContext 样例 / 后端 api.md §5.1）逐一 grep 实存；前端池无 docs-index-lint，未跑 lint
- [2026-09-26] [变更]: guide-spec v1.0→v1.1（档案卡归宿改画布 brief 块：dataVocab 登记方案一期只上「提及数」、canvas_add_block 枚举七类→八类同步点 G5、落点重排为 canvasTemplates/domain/CanvasBriefCard；向导页与 prefillDraft 降可选二期）
- [2026-09-26] [验证]: 写后自检通过——新增锚点（canvasTemplates.ts:459 枚举/:259-260 initData stockCode/:276 词表、CanvasBlockContent.tsx、canvasDataQuery 三分支）逐一 grep 实存；未跑 lint（前端池无 docs-index-lint）
- [2026-09-26] [变更]: guide-spec 一期实现——画布 brief 块（guideService + CanvasBriefCard + 模板注册 dataVocab「提及数」+ 守卫/摘要/布局/徽标穷举表同步 + canvas_add_block 枚举八类 + add_block exec brief 分支）；feature-map GROUPS 与项目索引登记 guide 域
- [2026-09-26] [验证]: npx tsc --noEmit 零错误；npm test 866 用例全绿（pretest 含 check:arch R1/R2/R3+madge 循环依赖）；npm run map:features -- guide 归组 2 文件；人工冒烟（联调落块/取数词直出）未执行——需后端 :18080 在线，待用户跑
- [2026-09-26] [变更]: D33 v1.6 修复「放上画布」失灵——buildCanvasPromptHints 公共段改 canvas scope 内必带（v1.5 触发词条件携带下放置类说法漏触发词，LLM 误用 fetch_kline 只回数据不落画布并幻觉成功）；COMMON 补 brief 块语义半句；copilot-spec v1.6 + canvasPrompts/copilotSlice 测试同轮修订
- [2026-09-26] [验证]: npx tsc --noEmit 零错误；npm test 867 用例全绿（含新增事故回归用例「把茅台放到画布上→公共段必在」）；真机复测未执行——待用户刷新前端重试原话
