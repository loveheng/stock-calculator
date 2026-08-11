# 技术栈说明 —— 面向后端开发者

> 本文档面向**熟悉 JS/CSS/HTML 但不熟悉前端框架的后端开发者**，逐一解释本项目中用到的每项技术是什么、解决了什么问题、与后端概念的类比。  
> 阅读本文后，你将有能力阅读和理解本项目的全部源代码。

---

## 目录

1. [TypeScript (类型系统)](#1-typescript-类型系统)
2. [React (UI 组件框架)](#2-react-ui-组件框架)
3. [Vite (构建工具)](#3-vite-构建工具)
4. [Zustand (全局状态管理)](#4-zustand-全局状态管理)
5. [Dexie / IndexedDB (浏览器端持久化)](#5-dexie--indexeddb-浏览器端持久化)
6. [Tailwind CSS (样式方案)](#6-tailwind-css-样式方案)
7. [Decimal.js (金融精度计算)](#7-decimaljs-金融精度计算)
8. [PWA (渐进式 Web 应用)](#8-pwa-渐进式-web-应用)
9. [关键语法速查](#9-关键语法速查)

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
  brokerageBuy: number;      // 买入佣金率
  stampDuty: number;         // 印花税率
  // ...
}

// 2. type — 类型别名（≈ typedef）
type StockMeta = {
  fullCode: string;          // 如 "sh600000"
  stockName: string;
  market: 'sh' | 'sse';     // 联合类型：只能是这两个字符串之一
};

// 3. extends — 接口继承（≈ Java extends）
interface TStreamRecord extends StockMeta {
  id: string;
  direction: 'buy' | 'sell';  // 联合类型，确保不会是其他值
  price: number;
  amount: number;
}

// 4. generics — 泛型（≈ Java <T>）
async function safePersist(fn: () => Promise<void>): Promise<void> {
  await fn();
}

// 5. as — 类型断言（≈ Java 强制转换）
const row = record as unknown as PositionRow;
```

### 与纯 JS 的区别

```javascript
// JS：运行时才暴露错误
function add(a, b) {
  return a.price + b.price;  // 如果 a 没有 price，运行时 NaN
}

// TS：编译时就报错
function add(a: { price: number }, b: { price: number }): number {
  return a.price + b.price;
}
add({ name: "xx" }, { name: "yy" });  // ❌ 编译错误：缺少 price 属性
```

### 配置
项目根目录的 `tsconfig.json` 控制编译器行为。本项目配置了 `strict: true`（最严格模式）。

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

Hooks 是 React 16.8+ 引入的函数式 API，取代旧的 class 组件写法。

| Hook | 作用 | 后端类比 |
|---|---|---|
| `useState(init)` | 组件内部状态 | 局部变量，但改后自动重渲染 |
| `useEffect(fn, deps)` | 副作用：数据获取、订阅、定时器 | `@PostConstruct` + 析构 |
| `useMemo(fn, deps)` | 缓存计算结果（只有 deps 变了才重新算） | 带缓存的 getter |
| `useCallback(fn, deps)` | 缓存函数引用 | — |
| `useRef(init)` | 持有跨渲染的可变引用 | 实例字段 |

```tsx
function CostAveraging() {
  // 组件级状态：当前选中的持仓 ID
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 从全局 Store 读取数据（见下文 Zustand 章节）
  const positions = useAppStore((s) => s.positions);

  // 副作用：组件挂载时执行一次
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

---

## 3. Vite (构建工具)

### 是什么
新一代前端构建工具，替代 Webpack。提供：
- **开发服务器**：毫秒级热更新（HMR）
- **生产构建**：Rollup 打包，产出优化后的 JS/CSS/HTML

### 后端类比
相当于 Maven / Gradle 的构建阶段，但 Vite 专注于前端资源：将 TypeScript → JavaScript、JSX → JS、CSS 处理、代码分块、Tree Shaking。

### 关键概念

```bash
npm run dev        # 启动开发服务器，修改代码自动刷新浏览器
npm run build      # 生产构建 → dist/ 目录
npx vite preview   # 本地预览生产构建
```

### 本项目配置
`vite.config.ts` 中配置了：
- React 插件（处理 JSX/TSX）
- PWA 插件（生成 Service Worker）
- 路径别名 (无，使用相对导入)

---

## 4. Zustand (全局状态管理)

### 是什么
极简的全局状态管理库。一句话：**一个全局 JS 对象 + 修改它的方法 + 订阅机制**。

### 后端类比
≈ **单例模式的 Service 层** + **观察者模式**。Zustand 扮演了传统后端中「内存数据库 + Service 事务」的角色。

```
后端:  Controller → Service → Repository → Database
前端:  Component → Zustand Action → Dexie/IndexedDB
                  ↑ 这里就是 Zustand
```

### 本项目中的使用

```typescript
// 1. 创建 Store（单例）
export const useAppStore = create<AppStore>()((set, get) => ({
  // 状态（≈ 类的字段）
  positions: [],
  feeConfig: { ...DEFAULT_FEE_CONFIG },

  // Action（≈ 类的方法）
  addPosition: (pos) => {
    // set() 更新状态，所有订阅此状态的组件自动重渲染
    set((state) => ({
      positions: [...state.positions, pos],
    }));
    // 同时写 DB（v5 增量模式）
    safePersist(() => putPosition(pos as any));
  },

  removePosition: (id) => {
    set((state) => ({
      positions: state.positions.filter((p) => p.id !== id),
    }));
    safePersist(() => deletePositionWithBatches(id));
  },
}));
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

---

## 5. Dexie / IndexedDB (浏览器端持久化)

### 什么是 IndexedDB
浏览器内置的事务型 NoSQL 数据库。特点：
- 键值对存储，支持索引查询
- 异步 API（回调/Promise）
- 容量远大于 localStorage（通常几百 MB）
- 支持数据库版本迁移

### 后端类比
≈ **SQLite 但只有简单查询能力** 或 **单机版的 MongoDB**。功能介于 localStorage 和真正的 SQL 数据库之间。

### 什么是 Dexie
Dexie 是对 IndexedDB 原生 API 的封装库，提供：
1. 声明式表定义（≈ JPA Entity / SQLAlchemy Model）
2. Promise 链式调用（≈ 简洁的 ORM）
3. 事务支持
4. 版本升级回调

### 本项目中的使用

**表定义 (`src/db/schema.ts`)：**

```typescript
// 定义数据库
class StockDB extends Dexie {
  positions!: Table<PositionEntity, string>;   // 主键类型为 string
  positionBatches!: Table<PositionBatchEntity, string>;
  tStreams!: Table<TStreamEntity, string>;
  // ... 共 10 张表

  constructor() {
    super('StockCalculatorDB');
    this.version(1).stores({
      // 用 '+' 标记自增主键，用 '' 标记索引字段
      positions: 'id, fullCode, stockName',
      positionBatches: 'id, positionId',
      tStreams: 'id, fullCode, direction, timestamp',
    });
  }
}
```

**CRUD 操作：**

```typescript
// 插入或更新（id 存在则 update，否则 insert）
await db.positions.put({ id: 'abc', fullCode: 'sh600000', ... });

// 按主键删除
await db.positions.delete('abc');

// 按索引查询
const records = await db.tStreams
  .where({ fullCode: 'sh600000' })
  .toArray();

// 批量操作
db.transaction('rw', [db.positions, db.positionBatches], async () => {
  await db.positions.delete(id);
  await db.positionBatches.where({ positionId: id }).delete();
});
```

### v5 增量持久化策略

```
旧方案 (v4):  清空整张表 → 把新数据全部写进去
新方案 (v5):  只修改变化的行 (put / bulkPut / delete)

类比:
  旧 = DELETE FROM table; INSERT INTO table VALUES (...);
  新 = UPSERT / DELETE WHERE id = ?;
```

---

## 6. Tailwind CSS (样式方案)

### 是什么
「工具优先」(utility-first) 的 CSS 框架。不写自定义 class，直接在 HTML 上用预设的工具类组合样式。

### 后端类比
≈ 命令行中的 flag 组合 (`ls -la --color`) vs 手动写配置文件。

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
| `bg-white` | `background-color: white` |
| `text-red-500` | `color: rgb(239, 68, 68)` |
| `rounded-lg` | `border-radius: 0.5rem` |
| `flex` | `display: flex` |
| `items-center` | `align-items: center` |
| `justify-between` | `justify-content: space-between` |
| `grid grid-cols-2` | `display: grid; grid-template-columns: repeat(2, 1fr)` |
| `hover:bg-blue-100` | `:hover { background-color: ... }` |
| `md:w-1/2` | 仅在 `md` 断点以上 `width: 50%` |

> **提示**：不熟悉 Tailwind 不影响阅读业务逻辑。关注组件中的 JSX 结构和 JS 逻辑即可，`className` 只是视觉呈现。

---

## 7. Decimal.js (金融精度计算)

### 为什么需要
JavaScript 原生浮点数使用 IEEE 754 双精度，无法精确表示 0.1、0.01 等小数：

```javascript
0.1 + 0.2 === 0.3   // false (实际结果是 0.30000000000000004)
0.015 * 100 === 1.5 // false (实际结果是 1.4999999999999998)
```

对于涉及金钱的计算，这是不可接受的。

### 后端类比
≈ Java 的 `BigDecimal` / Go 的 `decimal` 库 / Python 的 `Decimal`。

### 基本用法

```typescript
import Decimal from 'decimal.js';

// 运算
const result = new Decimal(price)
  .mul(amount)           // 乘法
  .mul(rate)             // 再乘费率
  .div(100)              // 除以百分比
  .toNumber();           // 转回 JS number

// 四舍五入
roundTo(value, 2);       // 保留 2 位小数
```

---

## 8. PWA (渐进式 Web 应用)

### 是什么
让 Web 应用具备接近原生 App 体验的技术集合：

| 特性 | 说明 |
|---|---|
| **离线可用** | Service Worker 缓存静态资源 + IndexedDB 数据，断网也能用 |
| **安装到桌面** | 浏览器提示「添加到主屏幕」，像 App 一样打开 |
| **后台同步** | Service Worker 可在后台处理请求 |
| **推送通知** | Web Push API（本项目未使用） |

### 后端类比
≈ 把 Web 页面变成一个「不需要应用商店分发的 APK/IPA」。

### 本项目实现
使用 `vite-plugin-pwa` 自动生成 Service Worker，无需手写 SW 逻辑。构建时自动将静态资源列表注入 SW，实现离线缓存策略。

---

## 9. 关键语法速查

### ES6+ 语法（与 Java 后端的对应）

```javascript
// 解构赋值  ≈ Java record 的模式匹配
const { tStreams, feeConfig } = get();

// 展开运算符  ≈ 浅拷贝
const newArray = [...oldArray, newItem];
const merged = { ...obj1, ...obj2 };

// 箭头函数  ≈ Java Lambda / Go 匿名函数
const doubled = items.map((item) => item * 2);
setTimeout(() => { doSomething(); }, 1000);

// 可选链  ≈ Kotlin/Swift 的 ?.
const name = stock?.stockName ?? '未知';  // stock 为 null/undefined 时不报错

// 模板字符串  ≈ 字符串格式化
const msg = `已划转 ${qty} 股 @${price.toFixed(2)} 元`;

// async/await  ≈ Java CompletableFuture / Go goroutine
async function loadData() {
  const data = await fetch('/api/data');
  return data.json();
}

// 空值合并
const value = input ?? defaultValue;  // input 为 null/undefined 时取默认值

// Set：唯一值集合（≈ Java HashSet）
const newIds = new Set(stocks.map((s) => s.fullCode));

// Promise：异步计算容器（≈ Java Future）
Promise.all([fetch1(), fetch2()]).then(([r1, r2]) => { ... });
```

### 导入/导出

```typescript
// 命名导出（可导出多个）
export async function putPosition(position: PositionRow): Promise<void> { ... }
export const DEFAULT_FEE_CONFIG = { ... };

// 默认导出（每个模块只有一个）
export default function App() { ... }

// 导入
import { putPosition } from './db';              // 命名导入
import App from './App';                          // 默认导入
import { useAppStore, type AppStore } from './store';  // 类型导入
```

### 项目文件路径约定

```
src/
├── db/index.ts       → 导入写 'from './db'' 或 'from '../db''
├── store/index.ts    → 导入写 'from './store'' 或 'from '../store''
├── utils/xxx.ts      → 导入写 'from '../utils/xxx''
```

---

## 附录：5 分钟快速上手

如果你只想快速理解代码，按这个顺序看：

1. **`main.tsx`** (42 行) — 入口，看懂启动流程
2. **`store/index.ts` 类型定义区** (行 1-260) — 理解 AppStore 接口，相当于「API 文档」
3. **`db/schema.ts`** — 理解数据库表结构
4. **`db/index.ts` 函数注释** — 只看函数名和 JSDoc 注释即可
5. **`views/TCalculator.tsx`** — 选一个页面看 JSX 结构（忽略 Tailwind className）

遇到不认识的 TS 类型、JSX 语法、Tailwind 类名时，回到本文档 Ctrl+F 查找。
