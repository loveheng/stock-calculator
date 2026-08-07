# 股票计算助手 (PWA)

一个轻量、极速的股票辅助计算器 PWA 应用，包含四大核心工具：

- **📈 涨跌幅计算** — 计算股票、基金等品种的涨跌幅、盈亏比例与金额
- **🔄 做T计算器与账本** — 记录做T操作，自动计算持仓成本、盈亏，支持历史记录
- **📉 成本摊薄** — 补仓后成本价、摊薄比例以及回本价计算
- **⚙️ 费率配置** — 自定义佣金、印花税、过户费等交易费率

## 技术栈

- **Vite** — 闪电级构建工具
- **Tailwind CSS v3** — 原子化样式
- **decimal.js** — 高精度浮点数运算
- **ES Modules** — 零依赖前端路由

## 本地运行

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器
npm run dev
```

## 项目结构

```
src/
├── main.js              # 入口文件
├── App.js               # 路由 & 导航管理
├── mathUtils.js         # 核心计算工具函数
├── store.js             # 全局状态管理（localStorage 持久化）
└── components/
    ├── Home.js          # 首页
    ├── ChangeRate.js    # 涨跌幅计算
    ├── TCalculator.js   # 做T计算器与账本
    ├── CostAveraging.js # 成本摊薄
    └── FeeConfig.js     # 费率配置
```

## 部署到 Vercel

1. 将代码推送到你的 **GitHub** 仓库。
2. 登录 [Vercel](https://vercel.com/)，点击 **Add New Project**。
3. 选择刚刚创建的 GitHub 仓库，Vercel 会自动识别 Vite 项目并完成一键部署。