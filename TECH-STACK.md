# 技术栈说明 —— 面向后端开发者

> 本文档面向**熟悉 JS/CSS/HTML 但不熟悉前端框架的后端开发者**，逐一解释本项目中用到的每项技术是什么、解决了什么问题、与后端概念的类比。  
> 阅读本文后，你将有能力阅读和理解本项目的全部源代码，并上手修改。

## 目录

1. [TypeScript (类型系统)](#1-typescript-类型系统)
2. [React (UI 组件框架)](#2-react-ui-组件框架)
3. [React Router (前端路由)](#3-react-router-前端路由)
4. [Vite (构建工具)](#4-vite-构建工具)
5. [Zustand (全局状态管理)](#5-zustand-全局状态管理)
6. [Dexie / IndexedDB (浏览器端持久化)](#6-dexie--indexeddb-浏览器端持久化)
7. [Tailwind CSS (样式方案)](#7-tailwind-css-样式方案)
8. [Decimal.js (金融精度计算)](#8-decimaljs-金融精度计算)
9. [Vitest (单元测试)](#9-vitest-单元测试)
10. [PWA (渐进式 Web 应用)](#10-pwa-渐进式-web-应用)
11. [两个小工具库 (lucide-react / ulid)](#11-两个小工具库-lucide-react--ulid)
12. [关键语法速查](#12-关键语法速查)
13. [5 分钟快速上手](#13-5-分钟快速上手)
14. [常见任务实操指南](#14-常见任务实操指南)

---

## 1. TypeScript (类型系统)

### 是什么
TypeScript = JavaScript + 静态类型标注。写代码时声明变量的类型，编译器在构建前检查类型错误。

### 后端类比
相当于 Java / Go / Rust 的类型系统，但编译产物仍是纯 JavaScript。

### 本项目中的关键用法

```typescript
// 1. interface — 定义数据结构（≈ Java 的 interface / Go 的 struct）
interface FeeConfig {
  commissionRate: number;      // 买入佣金率
  stampRate: number;           // 印花税率
  // ...
}

// 2. type — 类型别名（≈ typedef）
type SecurityKind = 'stock' | 'etf' | 'bond';  // 联合类型：只能是三者之一

// 3. extends — 接口继承（≈ Java extends）
interface TStreamRecord extends StockMeta {
  direction: 'buy' | 'sell';  // 联合类型，确保不会是其他值
}

// 4. generics — 泛型（≈ Java <T>）
async function safePersist(fn: () => Promise<void>): Promise<void> { ... }

// 5. as — 类型断言（≈ Java 强制转换）
const row = record as unknown as PositionRow;
```

### 与纯 JS 的区别

```javascript
// JS：运行时才暴露错误
function add(a, b) { return a.price + b.price; }  // a 缺 price → NaN

// TS：编译时就报错
function add(a: { price: number }, b: { price: number }): number {
  return a.price + b.price;
}
add({ name: "xx" }, { name: "yy" });  // ❌ 编译错误：缺少 price 属性
```

### 配置
项目根目录的 `tsconfig.json` 控制编译器行为。本项目配置了 `strict: true`（最严格模式）。
注意 `"exclude": ["src/__tests__"]` —— 单元测试目录不参与类型检查。

---

## 2. React (UI 组件框架)

### 是什么
Facebook 开源的 UI 组件框架。核心思想：**UI = f(state)** — 界面是状态的纯函数。你只需更新数据，React 自动重新渲染对应的 DOM。

### 后端类比
类似于模板引擎 (Thymeleaf / Jinja2)，但模板和数据都在前端运行，数据变化时自动局部刷新。

### JSX 语法

```tsx
// JSX = HTML 写在 JS 里（编译时转换为 createElement 调用）
function Greeting({ name }: { name: string }) {
  return <h1>你好，{name}</h1>;  // {} 内是 JS 表达式
}

// 条件渲染
{error && <div className="text-red-500">{error}</div>}

// 列表渲染（≈ 后端模板的 for 循环）
{positions.map((pos) => (
  <tr key={pos.id}>
    <td>{pos.stockName}</td>
    <td>{pos.currentAmount}</td>
  </tr>
))}
```

### 核心概念：Hooks

Hooks 是 React 16.8+ 引入的函数式 API，取代旧的 class 组件写法。**Hooks 必须在组件顶层调用，不能写在 if/for/回调里。**

| Hook | 作用 | 后端类比 |
|---|---|---|
| `useState(init)` | 组件内部状态 | 局部变量，但改后自动重渲染 |
| `useEffect(fn, deps)` | 副作用：数据获取、订阅、定时器 | `@PostConstruct` + 析构 |
| `useMemo(fn, deps)` | 缓存计算结果（只有 deps 变了才重新算） | 带缓存的 getter |
| `useCallback(fn, deps)` | 缓存函数引用（防止子组件重复渲染） | — |
| `useRef(init)` | 持有跨渲染的可变引用 | 实例字段 |

```tsx
function CostAveraging() {
  // 组件级状态：当前选中的持仓 ID
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 从全局 Store 读取数据（见下文 Zustand 章节）
  const positions = useAppStore((s) => s.positions);

  // 副作用：组件挂载时执行一次（空依赖数组）
  useEffect(() => {
    document.title = '成本摊薄';
  }, []);

  // ...
}
```

### 组件通信

| 方式 | 说明 |
|---|---|
| Props 传递 | 父→子：`<Child name={val} />`；类型安全 |
| Zustand Store | 跨组件共享状态（本项目主要方式） |
| 回调函数 | 子→父：`<Child onChange={(v) => setVal(v)} />` |

### 项目自定义 Hook 模式（按需加载）

本项目大量使用自定义 Hook 封装「数据加载」逻辑（`src/hooks/useDataLoader.ts`），页面组件一行代码即可完成按需加载：

```tsx
function CostAveraging() {
  // 挂载时只加载一次持仓数据，返回 loading 状态
  const { loading } = useLoadPositions();
  const positions = useAppStore((s) => s.positions);
  if (loading) return <div>加载中...</div>;
  return <div>{/* 渲染持仓列表 */}</div>;
}
```

---
## 3. React Router (前端路由)

### 是什么
SPA 只有一个 HTML 页面，没有传统网页跳转。路由决定「当前 URL 显示哪个组件」。

### 后端类比
≈ 后端的 URL → Controller 映射表（@RequestMapping / Flask route / Spring MVC）。

### 本项目中的使用（src/App.tsx）

```tsx
// 1. 导航配置：path → 组件（相当于路由注册表）
const NAV_ITEMS = [
  { path: '/',               label: '首页',        icon: Home },
  { path: '/change-rate',    label: '涨跌幅计算器', icon: TrendingUp },
  { path: '/t-calculator',   label: '短线交易',     icon: RefreshCw },
  { path: '/cost-averaging', label: '中长期交易',   icon: BarChart3 },
  { path: '/statistics',     label: '数据统计',     icon: PieChart },
  { path: '/fee-config',     label: '费率配置',     icon: Settings },
];

// 2. 路由分发（Routes/Route 是 v6/v7 的声明式写法）
<Routes>
  <Route path="/" element={<HomePage />} />
  <Route path="/change-rate" element={<ChangeRate />} />
  <Route path="/t-calculator" element={<TCalculator />} />
  {/* ... */}
</Routes>

// 3. 编程式跳转（≈ res.redirect）
const navigate = useNavigate();
navigate('/t-calculator');

// 4. 读取当前路径（用于导航高亮）
const location = useLocation();
location.pathname === item.path
```

### 与本项目相关的约定
- 新增页面 = 新建一个 `views/xxx.tsx` + `NAV_ITEMS` 加一行 + `<Routes>` 加一个 `<Route>`
- 本项目未启用路由懒加载（lazy），所有页面在首帧静态 import，HMR 热更新更直接

---

## 4. Vite (构建工具)

### 是什么
新一代前端构建工具，替代 Webpack。提供：
- **开发服务器**：毫秒级热更新（HMR）
- **生产构建**：Rollup 打包，产出优化后的 JS/CSS/HTML

### 后端类比
相当于 Maven / Gradle 的构建阶段，但 Vite 专注于前端资源：TypeScript → JavaScript、JSX → JS、CSS 处理、代码分块、Tree Shaking。

### 关键命令

```bash
npm run dev        # 启动开发服务器（默认 http://localhost:5173），改代码自动刷新
npm run build      # 生产构建 → dist/ 目录
npm run preview    # 本地预览生产构建
```

### 本项目配置（vite.config.ts）
- React 插件（处理 JSX/TSX）
- PWA 插件（生成 Service Worker，Workbox 运行时缓存）
- **开发代理**：`/api-gtimg` → 腾讯 Smartbox（股票搜索）、`/api/eastmoney` → 东方财富（备用搜索）
  - 作用类似后端的 Nginx 反向代理：解决浏览器跨域问题；生产环境由 `vercel.json` 的 rewrites 接管
- 构建后处理：`scripts/postbuild.js` 移除 index.html 的 crossorigin 属性（PWA 离线兼容）

---

## 5. Zustand (全局状态管理)

### 是什么
极简的全局状态管理库。一句话：**一个全局 JS 对象 + 修改它的方法 + 订阅机制**。

### 后端类比
≈ **单例模式的 Service 层** + **观察者模式**。Zustand 扮演了传统后端中「内存数据库 + Service 事务」的角色。

```
后端:  Controller → Service → Repository → Database
前端:  Component → Zustand Action → Dexie/IndexedDB
                 ↑ 这里就是 Zustand
```

### 本项目中的使用（src/store/ 三个文件）

```typescript
// types.ts —— 接口定义（≈ 后端 API 文档）
interface AppStore {
  feeConfig: FeeConfig;
  positions: Position[];
  addPosition: (pos: Position) => void;  // Action 签名
  // ... 共 31 个 Action
}

// index.ts —— Store 实现
// 约定：每个 Action = ① set() 更新内存状态 + ② safePersist() 增量写库
addPosition: (pos) => {
  set((state) => ({ positions: [...state.positions, pos] }));
  safePersist(() => putPositionWithBatches(pos, pos.batches));
},

// utils.ts —— 纯函数（generateId / useStreamResults / archiveRoundIfCleared）
```

### 在组件中使用

```tsx
function MyComponent() {
  // selector：只订阅需要的字段，避免不必要的渲染
  const positions = useAppStore((state) => state.positions);
  const addPos = useAppStore((state) => state.addPosition);

  // 或者直接调用（不订阅任何状态）
  const handleClick = () => {
    useAppStore.getState().addPosition({ ... });
  };
}
```

### 与 Redux 的对比

| | Zustand | Redux |
|---|---|---|
| 样板代码 | 几乎为零 | 大量 (actions, reducers, store, dispatch) |
| 异步处理 | 直接在 action 中 await | 需要中间件 (thunk/saga) |
| 学习曲线 | 低 | 高 |
| TypeScript | 原生支持良好 | 需要大量类型体操 |

> **持久化约定（本项目最重要的一条）**：所有写库必须经过 `safePersist()`——
> 它在冷启动装载未完成时自动跳过写库，失败时自动重试（最多 3 次，1s→2s→4s）并入队补偿。
> **严禁在组件里直接操作 `db.xxx.put()`**——必须通过 Store Action，保证内存与数据库始终一致。

---
## 6. Dexie / IndexedDB (浏览器端持久化)

### 什么是 IndexedDB
浏览器内置的事务型 NoSQL 数据库。特点：
- 键值对存储，支持索引查询
- 异步 API（Promise）
- 容量远大于 localStorage（通常几百 MB）
- 支持数据库版本迁移

### 后端类比
≈ **SQLite 但只有简单查询能力**，或**单机版 MongoDB**。介于 localStorage 和真正的 SQL 数据库之间。

### 什么是 Dexie
Dexie 是对 IndexedDB 原生 API 的封装库（≈ 简洁的 ORM）：
1. 声明式表定义（≈ JPA Entity）
2. Promise 链式调用（≈ Repository）
3. 事务支持
4. 版本升级回调

### 本项目数据库（src/db/schema.ts，共 11 张表，库名 TradingLedgerDB_v3）

| 表 | 主键 | 类比（SQL） |
|---|---|---|
| `stocks` | fullCode | 股票字典表（含 kind 费率分类） |
| `positions` | id | 持仓主表 |
| `positionBatches` | id | 持仓批次明细表（1:N） |
| `tRounds` | id | 做T战报表 |
| `tTransactions` | id | 战报成交明细表（1:N） |
| `tStreams` | id | 做T流水池（进行中） |
| `accountCash` | id=1 | 现金账户（单行） |
| `cashFlows` | id | 现金流水（预留） |
| `tradeNotes` | id | 交易笔记（预留） |
| `feeConfigs` | id=1 | 费率配置（单行） |
| `longTermRecords` | id | 中长期操作记录 |

```typescript
// 表定义（声明主键与索引）
class TradingLedgerDB extends Dexie {
  positions!: Table<PositionEntity, string>;   // 主键类型为 string
  tStreams!: Table<TStreamEntity, string>;

  constructor() {
    super('TradingLedgerDB_v3');
    this.version(2).stores({
      positions: 'id, fullCode, isClosed, [isClosed+isDeleted], ...',
      tStreams: 'id, fullCode, direction, timestamp, ...',
      // 逗号分隔的字段都会建立索引；[a+b] 表示复合索引
    });
  }
}
```

### 常见 CRUD（在 db/index.ts 中已封装成函数）

```typescript
// 插入或更新（id 存在则 update，否则 insert）
await db.positions.put({ id: 'abc', fullCode: 'sh600000', ... });

// 按主键删除
await db.positions.delete('abc');

// 按索引查询
const records = await db.tStreams.where({ fullCode: 'sh600000' }).toArray();

// 复合索引查询
await db.positions.where('[isClosed+isDeleted]').equals([0, 0]).toArray();

// 事务
await db.transaction('rw', [db.positions, db.positionBatches], async () => { ... });
```

### 版本迁移（本项目约定）
表结构变更时：
1. 在 `STORES_Vx` 常量链尾部追加增量定义（如 `STORES_V7 = { ...STORES_V6, 新表: '索引' }`）
2. `constructor` 里加 `this.version(7).stores(...)`
3. 旧数据自动保留（IndexedDB 只会迁移新增/变化的表）

---

## 7. Tailwind CSS (样式方案)

### 是什么
「工具优先」(utility-first) 的 CSS 框架。不写自定义 class，直接在 HTML 上用预设工具类组合样式。

### 后端类比
≈ 命令行 flag 组合（`ls -la --color`）vs 手动写配置文件。

### 语法示例

```tsx
// 传统 CSS 写法
<div class="card">内容</div>
// .card { padding: 16px; background: white; border-radius: 8px; box-shadow: ... }

// Tailwind 写法（所有样式写在 class 里）
<div className="p-4 bg-white rounded-lg shadow-md hover:shadow-lg transition">
  内容
</div>
```

### 常用工具类速查

| 类名 | CSS 等效 |
|---|---|
| `p-4` | `padding: 1rem` |
| `mx-auto` | `margin-left: auto; margin-right: auto` |
| `bg-slate-800` | `background-color: #1e293b`（本项目暗色主题） |
| `text-red-500` | `color: rgb(239, 68, 68)` |
| `rounded-lg` | `border-radius: 0.5rem` |
| `flex items-center justify-between` | flex 布局三件套 |
| `grid grid-cols-2` | 两列网格 |
| `md:translate-x-0` | 仅在 `md` 断点以上生效（响应式） |

> **提示**：不熟悉 Tailwind 不影响阅读业务逻辑。关注 JSX 结构和 JS 逻辑即可，`className` 只是视觉呈现。

---

## 8. Decimal.js (金融精度计算)

### 为什么需要
JavaScript 原生浮点数使用 IEEE 754 双精度，无法精确表示 0.1、0.01 等小数：

```javascript
0.1 + 0.2 === 0.3   // false（实际 0.30000000000000004）
0.015 * 100 === 1.5 // false（实际 1.4999999999999998）
```

### 后端类比
≈ Java 的 `BigDecimal` / Go 的 `decimal` / Python 的 `Decimal`。

### 基本用法

```typescript
import Decimal from 'decimal.js';

const result = new Decimal(price)
  .mul(amount)       // 乘法（链式）
  .mul(rate)
  .div(100)
  .toNumber();       // 转回 JS number

roundTo(value, 2);   // 项目封装的四舍五入工具（mathUtils.ts）
```

> 本项目所有金额计算（费率、成本、盈亏）都走 Decimal.js，中间精度 20 位，显示时 `roundTo(x, 2)`。
> 纯函数集中在 `src/utils/mathUtils.ts`（20 个导出函数），方便单元测试。

---
## 9. Vitest (单元测试)

### 是什么
专为 Vite 项目设计的单元测试框架，与 Vite 共享配置，原生支持 TypeScript 和 ESM。

### 后端类比
≈ JUnit (Java) / pytest (Python) / Go testing。

### 为什么选择 Vitest 而非 Jest
- 与 Vite 共享转换管道，无需额外配置 Webpack/babel
- 原生 ESM 支持
- 启动速度比 Jest 快 10-20 倍

### 本项目中的用法

```typescript
// src/__tests__/mathUtils.test.ts
import { describe, test, expect } from 'vitest';

describe('roundTo', () => {
  test('四舍五入到指定小数位', () => {
    expect(roundTo(3.14159, 2)).toBe(3.14);
  });
});
```

### 运行命令

```bash
npm test            # vitest run（单次运行，当前共 46 用例）
npm run test:watch  # 监听模式，文件变化自动重跑
```

### 测试文件约定
- 位于 `src/__tests__/`，以 `.test.ts` 结尾，Vitest 自动发现
- `vitest.config.ts` 中配置 `include: ['src/__tests__/**/*.test.ts']`
- **测试只覆盖纯函数**（mathUtils、tStreamEngine、store/utils.ts 中的纯函数）；
  涉及 IndexedDB 的代码难以在 node 环境直接测试，不建议新手写集成测试

---

## 10. PWA (渐进式 Web 应用)

### 是什么
让 Web 应用具备接近原生 App 体验的技术集合：

| 特性 | 说明 |
|---|---|
| **离线可用** | Service Worker 缓存静态资源 + IndexedDB 数据，断网也能用 |
| **安装到桌面** | 浏览器提示「添加到主屏幕」，像 App 一样打开 |
| **后台同步** | Service Worker 可在后台处理请求 |

### 后端类比
≈ 把 Web 页面变成一个「不需要应用商店分发的 APK/IPA」。

### 本项目实现
使用 `vite-plugin-pwa` 自动生成 Service Worker（构建产物 `dist/sw.js`），无需手写 SW 逻辑。
`vercel.json` 为 `sw.js` 设置了 `must-revalidate` 缓存头，保证应用更新即时生效。

---

## 11. 两个小工具库 (lucide-react / ulid)

| 库 | 作用 | 用法示例 |
|---|---|---|
| **lucide-react** | 开源图标库（≈ 后端的字体图标） | `import { Home, Settings } from 'lucide-react';` |
| **ulid** | 全局唯一 ID 生成（≈ UUID，但时间有序） | `import { ulid } from 'ulid'; ulid();` |

> `db/index.ts` 用 ulid 生成主键；`store/utils.ts` 的 `generateId()` 用时间戳+随机数兜底。
> 两者都用于生成 `id` 主键，保持项目内一致即可，不要混用。

---

## 12. 关键语法速查

### ES6+ 语法（与 Java 后端的对应）

```javascript
// 解构赋值（≈ record 模式匹配）
const { tStreams, feeConfig } = get();

// 展开运算符（浅拷贝）
const newArray = [...oldArray, newItem];
const merged = { ...obj1, ...obj2 };

// 箭头函数（≈ Lambda）
const doubled = items.map((item) => item * 2);

// 可选链 + 空值合并
const name = stock?.stockName ?? '未知';  // 为 null/undefined 时不报错、取默认值

// 模板字符串
const msg = `已划转 ${qty} 股 @${price.toFixed(2)} 元`;

// async/await（≈ CompletableFuture）
async function loadData() {
  const data = await fetch('/api/data');
  return data.json();
}

// Set（≈ HashSet）
const newIds = new Set(stocks.map((s) => s.fullCode));

// Promise.all（并发执行多个异步任务）
Promise.all([fetch1(), fetch2()]).then(([r1, r2]) => { ... });
```

### 导入/导出

```typescript
// 命名导出（可导出多个）
export async function putPosition(position: PositionRow): Promise<void> { ... }

// 默认导出（每个模块只有一个，React 组件常用）
export default function App() { ... }

// 导入
import { putPosition } from './db';                  // 命名导入
import App from './App';                              // 默认导入
import { useAppStore, type AppStore } from './store'; // 类型导入
```

### 项目文件路径约定

```
src/
├── db/index.ts         → 导入写 'from "../db"' 或 'from "./db"'
├── db/schema.ts        → 实体类型 'from "../db/schema"'
├── store/index.ts      → 导入写 'from "../store"'（index 会 re-export types/utils 的类型与工具）
├── store/types.ts      → 需要类型时可 'from "../store/types"'
├── store/utils.ts      → 'from "../store/utils"'
├── hooks/xxx.ts        → 'from "../hooks/xxx"'
├── services/xxx.ts     → 'from "../services/xxx"'
├── utils/xxx.ts        → 'from "../utils/xxx"'
└── __tests__/xxx.test.ts → 测试文件，Vitest 自动发现
```

> **核心建议**：无脑从 `'../store'` 导入即可（index.ts 已 re-export 全部类型与 generateId 等工具），
> 避免散乱、深层的相对路径导入。

---
## 13. 5 分钟快速上手

按这个顺序读代码，先建立整体认知：

1. **`src/main.tsx`** (38 行) — 入口，看懂启动流程
2. **`src/store/types.ts`** — AppStore 接口，相当于「后端 API 文档」
3. **`src/db/schema.ts`** — 11 张表结构
4. **`src/hooks/useDataLoader.ts`** — 数据是怎么按需加载的
5. **`src/views/TCalculator.tsx`** — 选一个页面看 JSX 结构（忽略 Tailwind className）

遇到不认识的 TS 类型、JSX 语法、Tailwind 类名时，回到本文档 Ctrl+F 查找。

---

## 14. 常见任务实操指南

### 任务 1：新增一个页面（约 30 分钟）

1. 创建 `src/views/MyPage.tsx`，参照 `ChangeRate.tsx` 的骨架：

```tsx
/**
 * @file MyPage.tsx
 * @description 页面职责说明
 * @layer UI
 * @storage_impact 读写哪些表
 * @author 你的名字
 */
import React, { useState } from 'react';
import { useAppStore } from '../store';

export default function MyPage() {
  const [local, setLocal] = useState('');
  const positions = useAppStore((s) => s.positions);
  return <div className="p-4">{/* 你的 JSX */}</div>;
}
```

2. `src/App.tsx`：import MyPage → `NAV_ITEMS` 加一行 → `<Routes>` 加 `<Route path="/my-page" element={<MyPage />} />`
3. 需要全局数据：先从 `src/store/types.ts` 确认字段存在；不存在则先加类型 + Store Action
4. 需要持久化：在 Store Action 里用 `safePersist()`，**不要**在组件里直接 `db.put()`
5. 运行 `npm run dev` 自测，最后 `npx tsc --noEmit && npm test` 验证

### 任务 2：给现有数据加一个字段（例如 Position 加 `colorTag`）

| 步骤 | 文件 | 要改什么 |
|---|---|---|
| ① 类型 | `src/store/types.ts` | `interface Position` 加 `colorTag?: string` |
| ② 表实体 | `src/db/schema.ts` | `PositionEntity` 加 `colorTag?: string` |
| ③ 写入 | `src/store/index.ts` | 相关 Action 带上新字段（`cleanUndefined` 会自动剔除 undefined） |
| ④ 读取 | `src/services/ledgerService.ts` | 映射函数把 DB 字段带到 Store 对象 |
| ⑤ 展示 | 对应 `views/*.tsx` | 渲染新字段 |
| ⑥ 测试 | `src/__tests__/*.test.ts` | 涉及纯函数计算的补用例 |

> 普通字段无需迁移数据库；只有新增索引字段才需要升级 Dexie 版本（见第 6 节「版本迁移」）。

### 任务 3：改业务计算逻辑（如费率规则）

- 纯计算集中在 `src/utils/mathUtils.ts` 与 `src/utils/tStreamEngine.ts`，它们不碰 DB、不碰 React，最容易测试
- 改完立即在 `src/__tests__/mathUtils.test.ts` 补用例，`npm run test:watch` 看效果
- 页面展示计算结果的钩子是 `useStreamResults()`（store/utils.ts）—— 改引擎后所有页面自动级联重算

### 任务 4：排查数据丢失 / Bug 的一般流程

1. 打开浏览器 DevTools → Application → IndexedDB → TradingLedgerDB_v3，直接查原始数据
2. 确认操作走的哪条 Store Action，检查对应 Action 的 DB 写入是否齐全
3. 检查是否绕过 `safePersist`（只有冷启动装载未完成时才会静默跳过写库）
4. 看控制台 `[StorePersistence]` 前缀日志（重试/失败队列都会打日志）

### 常见陷阱（务必避开）

| 陷阱 | 说明 |
|---|---|
| **在组件里直接写 DB** | 内存 Store 与数据库会不一致。必须走 Store Action |
| **`table.clear()`** | 全项目禁用（零 clear 原则），删除要精确到 id |
| **undefined 写入 IndexedDB** | 结构化克隆会抛错；写库前先过 `cleanUndefined()` |
| **Selector 返回新对象** | 如 `useAppStore((s) => ({...}))` 会导致无限重渲染；按字段逐个订阅 |
| **React StrictMode 双调用** | dev 下 useEffect 会执行两次；数据加载钩子用 `useRef` 防重 |
| **冷启动前触发 Action** | `isInitialLoadDone()` 为 false 时写库被跳过；等 `coreDataLoaded` 为 true |
| **浮点数直接比较** | 金额一律 Decimal.js，不要 `a + b === c` |

---

## 附录：完整技术栈清单

| 技术 | 版本 | 用途 | 后端类比 |
|---|---|---|---|
| React | 19 | UI 组件 | 模板引擎 + 状态驱动 |
| React Router | 7 | 前端路由 | URL → Controller 映射 |
| TypeScript | 5.8 | 静态类型 | Java / Go 类型系统 |
| Vite | 5 | 构建 / 开发服务器 | Maven / Gradle 构建 |
| Zustand | 5 | 全局状态 | 单例 Service + 观察者 |
| Dexie | 4 | IndexedDB ORM | Repository / JPA |
| Tailwind CSS | 3 | 原子化样式 | 内联样式工具 |
| Decimal.js | 10 | 金融精度 | BigDecimal |
| Vitest | 4 | 单元测试 | JUnit / pytest |
| vite-plugin-pwa | 1 | 离线 / 安装 | 原生 App 打包 |
| lucide-react | 1 | 图标 | 字体图标库 |
| ulid | 3 | 唯一 ID | UUID |
