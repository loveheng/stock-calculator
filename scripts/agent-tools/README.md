# scripts/agent-tools — 项目专属工具池

本目录是**项目池**：与具体仓库强相关的持久脚本放这里，随仓库版本化；跨项目通用脚本放全局池
（~/.agents/toolbox/scripts/）。同名工具项目池覆盖全局池。规范与命令口径见 `toolbox spec`。

## 常用
  toolbox list                  看当前可用工具（含全局池与项目池）
  toolbox new <name>            生成脚手架（默认项目池；--scope global 入全局池）
  toolbox check <path>          合规校验并登记入池（门禁：头部块/--help/--json/--self-test）
  toolbox run <工具|别名>       运行（KEY=value 可内联覆盖参数）
  toolbox remove <name>         退役 → 全局池 .trash/

## 纪律
  - 持久脚本一律入池，**禁止散放在仓库根或家目录**（/tmp 一次性脚本豁免）
  - 新工具首次登记 = 引入新能力，需用户确认
  - guard 类（trigger≠manual）必须带 --self-test 金丝雀
  - 已有散放脚本按 agent-toolbox「散乱脚本治理」收编：评估 → 合规化 → check 入池 → 原址清理
