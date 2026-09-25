---
dev-loop: devlog
format: v1
epic: advance-notice
total-merged: 1
last-merge: 2026-09-25
---
- [2026-09-25] [变更]: AI 能力提示分层化收编注册表——CanvasTemplate 增 aiPrompt（模板专属深规格，与守卫同仓演进）/aiTriggers（触发词）；canvasWidgetPrompt.ts 删除，widget 图纸 schema 迁入 CANVAS_TEMPLATES.widget.aiPrompt；新增 kline（换股/划线格式）/metric（值与表达式）/table（行列覆写）/text（覆写）四段，chart/image/file 无写操作不设；CANVAS_PROMPT_COMMON 公共段（通用动作/标号约定/数据纪律）+ buildCanvasPromptHints(question) 组装器（includes 宽匹配，宁多带 ~1KB 勿静默失败，词表按守卫拒绝日志养护；未命中 undefined 零 token）；copilotSlice canvasPromptHints 改组装器委托；useCanvasContext「自定义面板」draft 触发词改读注册表；新增 canvasPrompts.test.ts 6 用例（widget 段体积守护/完备性对称/组装口径）+ slice 断言改 contains 口径。验证：tsc 零错误，npm test 56 文件 862 用例全绿。
- [2026-09-25] [变更]: 动作外壳权责边界落地（联调首轮根因=模型散文输出致后端提取器 actions:null；定案「外壳归后端、载荷归前端」）——widget aiPrompt 去「在响应 actions 数组输出」外壳措辞改引「系统动作输出规范」；copilotActions 增 stripCopilotActionBlock 剥离纯函数（完整块移除/流式半截截断/大小写容错）+ GlobalCopilot.MessageBubble assistant 渲染双保险；canvasPrompts.test 增权责边界断言（hints 永不含 <copilot-actions> 且无「actions 数组」措辞）+ copilotActions.test 剥离 3 用例；spec D33 与 registry §六 权责边界落档。后端侧待办（对端执行）：编排系统提示增【系统动作输出规范】（含 few-shot 示例/禁围栏/禁正文动作描述/最末尾闭合）+ 流式转发截断与归档剥离。验证：tsc 零错误，npm test 56 文件 866 用例全绿。
