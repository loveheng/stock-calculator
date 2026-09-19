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
