---
dev-loop: devlog
format: v1
epic: misc
total-merged: 1
last-merge: 2026-09-26
---
- [2026-09-26] [变更]: 修「AI 放画布只落第一块」根因——未提交新文件 utils/toast.ts 函数体仅自调用（无限递归爆栈）；add_block 执行器「先建块后 toast 汇报」，toast 异常杀死 handleCopilotActions 动作循环，同响应第二条 canvas_add_block（kline）静默丢失；修复为按文件头契约派发 app-toast CustomEvent（Toast.tsx 宿主消费）；补回归用例「同一响应两条 canvas_add_block（brief+kline）都落地」
- [2026-09-26] [验证]: npx tsc --noEmit 零错误；npm test 870 用例全绿；真机（IAB 登录态实机复现+修复后复测）：修复前仅 A1 落地+toast 递归爆栈与用户控制台一致，修复后同两条动作 A1+A2 全落地无异常，测试区块已清理
