# 资讯搜索（News Search）· 技术实现文档（前端）

> 版本：v1.3（2026-09-19；v1.3 = 结果卡移除订阅按钮（档案卡保留）+ 追问 AI 会话按卡片隔离（copilotThreadKey 下沉线程键）；v1.2 = 列表分页续拉适配（CLS 已上线 pageSize/page/hasMore，公告端点同契约就绪前多发字段被忽略）+ F1 筛选即查交互同步；v1.1 = 采纳后端评审：fetchSubscriptions 三形状兼容与 recognized 语义、toStockId 提升至 utils/dedup、composite 流式通道镜像 copilotService、mock 错误分支与相对日期、持仓注入裁剪 ≤50）
> 范围：`/news` 搜索页的前端落点、状态设计、类型契约、服务层封装、Copilot 上下文联动、mock 策略、代理接线与实施顺序。
> 关联：`docs/news-search-spec.md`（需求，D1-D10 决策）、`后端仓 docs/news-search-api.md`（接口契约 v1.1）、`docs/copilot-implementation.md`（区块上下文机制参考）
> 状态：设计定稿，P0 可立即开工

---

## 0. 前端侧决策记录

| # | 决策点 | 结论 |
|---|--------|------|
| I1 | 功能归组 | 新建 feature 组 `search（资讯搜索）`，`scripts/feature-map.mjs` GROUPS 登记关键词 `['search', 'newssearch']`，文件按 `newsSearch*` / `search*` 命名自动归组 |
| I2 | 路由与菜单 | `App.tsx` NAV_ITEMS 增 `{ path: '/news', label: '资讯', icon: Search }`，位置排在中长期交易之后；页面标题由既有 `NAV_ITEMS.find(path === pathname)` 精确匹配机制自动生效，**不用子路由** |
| I3 | 结果状态层级 | 结果状态一律落 `store/slices/searchSlice.ts`（R2：Copilot 快照经 getState() 同源读取，严禁读视图闭包）；查询表单态（输入框草稿等纯 UI 态）留视图 useState |
| I4 | mock 策略 | `searchService` 导出统一函数签名，内部按模块常量 `USE_MOCK`（后续可改 `import.meta.env.VITE_SEARCH_MOCK`）分流到同签名的 mock 提供者；切真实接口 = 改一个常量 + 加代理，视图层零改动 |
| I5 | Copilot scope 设计 | 页面单 scope：`scopeId = 'news_search'`；每个结果卡片注册一个 block：`blockId = 'news_search:result:{resultId}'`；档案卡注册 `news_search:profile`。focusBlock 聚焦单 block，无需按查询建多 scope；**会话按 block 隔离**（V2.1：聚焦时线程键 = `copilotThreadKey(scopeId, blockId)`，每条公告/日报独立会话） |
| I6 | 订阅按钮复用 | 档案卡订阅动作复用 `components/ui/AnnouncementSubscribeButton`（接受 fullCode，内部归一化 + 共享订阅态），不新写订阅逻辑；v1.4 起结果卡不再提供订阅入口 |
| I7 | 持仓注入 | slice 的查询 action 内部从 `positions`（既有 positionsSlice 状态）取未平仓持仓的 fullCode → `normalizeCode` 归一化 → 去重 → 作为 `stockCodes` 参数；视图不手工传持仓 |
| I8 | 竞态防护 | 模块级自增 `requestSeq`，响应返回时序号不匹配即丢弃；不做请求取消（AbortController 留给超时底座） |

---

## 1. 分层落点（依赖方向遵循 R1/R2/R3 护栏）

```
types/search.ts          ← 零依赖叶子：查询/结果/档案卡契约类型（纯类型，无 import）
        ↑
utils/searchPrompts.ts   ← 预置模板常量（纯数据，不碰 store/db）
        ↑
services/searchService.ts  ← HTTP + mock 提供者（token 注入式，禁 import store）
        ↑
store/slices/searchSlice.ts ← 查询编排 + 结果状态（import service/types/utils）
        ↑
components/search/*      ← 纯展示卡片（数据全由 props 传入）
views/NewsSearch.tsx     ← 页面组装：Filter/模板/结果流/Copilot 注册
```

| 文件 | 层 | 职责 |
|------|----|------|
| `types/search.ts` | 类型 | `SearchScope` / `SearchRequest` / `AnnouncementHit` / `ClsHit` / `CompositeResult` / `StockProfile` / `SearchResultItem`（判别联合）/ `SearchPromptTemplate` |
| `utils/searchPrompts.ts` | 计算 | F3 预置模板静态清单（分组、文案、参数构造器）；P2 评估改后端下发 |
| `services/searchService.ts` | 服务 | `searchAnnouncements / searchCls / searchComposite / fetchStockProfile` + 私有 `searchRequest` 底座（镜像 announcementService）+ mock 提供者 |
| `store/slices/searchSlice.ts` | 状态 | `runSearch` / `resetSearch` 编排：形态检测、持仓注入、seq 竞态守卫、状态机流转 |
| `components/search/IntentFilterTabs.tsx` | 组件 | 三 Filter 标签（含置灰逻辑：持仓为空 / P2 未就绪项） |
| `components/search/PromptTemplates.tsx` | 组件 | 预置模板分组按钮 |
| `components/search/StockProfileCard.tsx` | 组件 | 档案卡（行情圆点/现价 + 公告摘要 + 订阅/追问按钮） |
| `components/search/ResultCardList.tsx` | 组件 | 命中卡片列表（公告行卡 / CLS 卡，展开原文、高亮、操作区） |
| `views/NewsSearch.tsx` | 视图 | 页面组装 + 搜索框（复用 `StockAutocomplete` 做代码/名称消歧）+ Copilot scope 注册 |

**接线改动（既有文件）**：`App.tsx`（NAV_ITEMS + Route）、`store/types.ts`（AppStoreActions + AppStore 字段）、`store/index.ts`（slice 组装）、`vite.config.ts` + `middleware.js`（`/api/search` 代理，与 `/api/auth` 同源）、`scripts/feature-map.mjs`（GROUPS 登记）。

## 2. 状态设计（searchSlice）

```ts
// store/slices/searchSlice.ts —— 状态字段（初值在 store/index.ts）
interface SearchSliceState {
  /** 最近一次查询关键词（驱动 Copilot scope getData 与结果头展示） */
  searchQuery: string;
  /** 当前检索范围（Filter 单选） */
  searchScope: SearchScope;                 // 'announcement' | 'cls' | 'composite'
  /** 页面状态机：idle | loading | succeeded | failed | generating（综合摘要专用） */
  searchStatus: SearchStatus;
  /** 结果列表（判别联合，按 scope 装载 announcement / cls 命中；composite 时为空） */
  searchResults: SearchResultItem[];
  /** 综合摘要（scope=composite 时装载） */
  compositeResult: CompositeResult | null;
  /** 股票档案卡（形态检测命中具体股票时装载；null = 关键词形态） */
  stockProfile: StockProfile | null;
  /** 失败文案（信封 message 直出或网络异常文案） */
  searchError: string | null;
  /** 结果计数（已加载条数口径：列表分页后随续拉累加） */
  searchTotal: number;
  /** 分页游标：已加载页数（下一页请求页码，0 起翻页） */
  searchPage: number;
  /** 分页：是否还有下一页（后端多取 1 条精确判定；公告端点上分页前缺省 false） */
  searchHasMore: boolean;
  /** 续拉进行中（观察器/连点防重；status 保持 succeeded，列表不闪） */
  searchLoadingMore: boolean;
  /** 续拉请求基座（不含分页字段；翻页复用 query/dateRange/stockCodes） */
  lastSearchRequest: SearchRequest | null;
}
```

**Actions 契约**（登记 `AppStoreActions`）：

```ts
runSearch: (input: { query: string; scope: SearchScope; dateRange?: DateRange }) => Promise<void>;
resetSearch: () => void;
/** 列表续拉下一页（无限滑动）：按 lastSearchRequest 翻页追加去重；非 succeeded/hasMore=false 时幂等空操作 */
loadMore: () => Promise<void>;
```

`runSearch` 编排顺序：
1. 归一化 query（trim）；空 → `resetSearch` 直接回初始态。
2. 形态检测：6 位数字码 / Smartbox 已选股票 → 并行装载 `stockProfile`（P0 mock；P1 走聚合接口），并**放宽持仓限定**（该股票不在持仓也检索）。
3. `scope=announcement` 时收集持仓代码（I7）：`positions.filter((p) => !p.isClosed)` → `toStockId(fullCode)`（`utils/dedup.ts` 共享纯函数，announcementSlice / AnnouncementSubscribeButton / 搜索页三处同源）→ 去重 → **上限 50 截断**（配合后端 stockCodes 校验建议）；为空 → 置引导空态并 return（不发请求，spec F1）。全程读同 store 内存状态，**不读 db**（R 层护栏）；模板常量只含 query/scope/dateRange 静态部分，持仓集合在 dispatch 时注入（R2：utils 禁 import store）。
4. `seq = ++requestSeq`；置 `loading`（composite 置 `generating`）。
5. 调 service；返回后 `seq` 校验，不匹配丢弃；匹配则按 scope 装载结果 / 综合摘要，置 `succeeded`。列表范围（cls/announcement）统一分页取数：首页 `page=0` + `pageSize=10`，`hasMore` 驱动 `loadMore` 无限滑动续拉（追加按 resultId 去重）；公告端点上分页前 `hasMore` 缺省 false，多发分页字段被后端忽略。
6. 失败：`searchError` = `e.message`（SessionExpiredError 的会话文案同样直出），置 `failed`。

---

## 3. 类型契约（types/search.ts，与接口文档字段一一对应）

```ts
export type SearchScope = 'announcement' | 'cls' | 'composite';

export interface DateRange { start: string; end: string; }  // 'YYYY-MM-DD'

export interface SearchRequest {
  query: string;
  stockCodes?: string[];   // 6 位数字码；announcement/composite 范围下为持仓过滤（D4）
  dateRange?: DateRange;
  topK?: number;           // 缺省 10，上限 50
}

/** 公告命中（scope=announcement） */
export interface AnnouncementHit {
  kind: 'announcement';
  resultId: string;        // 后端 annId 或前端稳定派生 id（驱动 blockId 与 key）
  stockId: string;         // 6 位码
  stockName: string;
  annDate: string;         // 'YYYY-MM-DD'
  title: string;
  summary: string;         // 2~3 句提炼（不做长文展现）
  sourceUrl?: string;      // 巨潮原文外链
}

/** CLS 命中（scope=cls，P2） */
export interface ClsHit {
  kind: 'cls';
  resultId: string;
  publishedAt: string;     // 'YYYY-MM-DD HH:mm'
  edition: 'morning' | 'evening' | 'telegraph';
  summary: string;
  mentions: Array<{ stockId: string; stockName: string }>;
}

export type SearchResultItem = AnnouncementHit | ClsHit;

/** AI 综合摘要（scope=composite，P2） */
export interface CompositeResult {
  summary: string;         // LLM 串联摘要（支持流式分片追加）
  citations: Array<{ kind: 'announcement' | 'cls'; resultId: string; stockId?: string; date: string; title: string }>;
}

/** 股票确定性档案卡 */
export interface StockProfile {
  stockId: string;
  stockName: string;
  latestAnnouncements: Array<{ annId: string; annDate: string; title: string; summary: string }>;
  clsMention?: { count7d: number; items: Array<{ publishedAt: string; summary: string }> };  // P2
}

/** 预置模板（utils/searchPrompts.ts 静态清单） */
export interface SearchPromptTemplate {
  id: string;
  group: 'holding-risk' | 'market-flash';
  label: string;           // 展示文案
  buildRequest: (ctx: { holdingCodes: string[]; today: Date }) => { query: string; scope: SearchScope; dateRange?: DateRange };
  requiresHoldings: boolean;  // 持仓为空时置灰
  availableFrom: 'P0' | 'P2'; // CLS 类模板在 CLS 就绪前置灰
}
```

## 4. 服务层（searchService.ts）

- 底座 `searchRequest<T>`：镜像 `announcementService.announcementRequest`——`SEARCH_API_BASE_URL = '/api/search'`、Bearer 注入、15s 超时、恒解析信封、401 → `SessionExpiredError`、信封非 200 → `AuthApiError`（message 用户可读直出）、非信封 → httpStatusError。**不 import store**（R 层护栏），token 由 slice 注入（`loadStoredAuthSession()?.token`）。
- 四个导出函数与接口文档 §2-§5 一一对应：`searchAnnouncements(token, req)` / `searchCls(token, req)` / `searchComposite(token, req)` / `fetchStockProfile(token, stockId)`。
- **composite 通道例外（不走上面的 15s 底座）**：`apiClient` 的 `REQUEST_TIMEOUT_MS = 15_000` 是无条件 AbortController，会掐断 SSE 长流（方案 B 的后端 30s 也会被砍）。composite 客户端镜像 `copilotService.streamAsk` 模式：`fetch` + `Accept: text/event-stream` + `getReader()` 渐进解析 + **内容协商回落**（Content-Type 非 event-stream → 按同步 JSON 信封解析）。SSE 与同步 JSON 双解析都实现，API 文档 Q2（方案 A/B）不再阻塞前端；超时改为**空闲超时**（两个数据块间隔超阈值才 abort），不沿用固定 15s。
- **N5 竞态守卫覆盖流**：`requestSeq` 过期时除丢弃回调外，还要 `reader.cancel()` + abort 底层 fetch，防止旧流继续写状态。
- **防御性检查**：service 层对 `token` 缺省快速抛「请先登录」（仅参数校验，不 import store）；未登录门控主判断在 slice（D10）。
- 复用既有约定：`announcementService.fetchSubscriptions` 已按后端实际形状 `{items: [{stockId, orgId, createdAt}]}` 兼容解析，并区分「形状不识别（recognized=false，不置 loaded，保留重试）」与「服务端确实为空（recognized=true 且空列表）」。
- **mock 提供者（P0）**：同签名的 `searchMock.ts` 放 `services/` 下，按 query 关键词规则生成确定性假数据（含「对赌」「减持」命中、档案卡样本）；`USE_MOCK = true` 常量分流。**resultId 必须稳定**（同 query 同结果——Copilot blockId 锚点依赖它，A9）。
- **mock 错误分支（A8 可测）**：内置触发词——特定 query 触发信封 400（业务错误文案）、触发 429（带 retryAfterSeconds）、触发 401（会话失效）；stock-profile 对未知 6 位码返 400（验证降级路径，spec A10）。**日期字段相对「今天」生成**（今天/昨天/7 天前），dateRange 筛选在开发期真实生效。

## 5. 关键实现

### 5.1 形态检测与搜索框

- 视图搜索框 = 受控 input + `StockAutocomplete`（下拉消歧）。用户选中候选 → 以该 `fullCode` 发起档案卡查询；直接输入 6 位码 → 同样走档案卡；其余为关键词。
- 检测函数 `detectQueryIntent(query): { kind: 'stock'; stockId: string } | { kind: 'keyword' }` 放 `utils/`（纯函数，`/^\d{6}$/` 命中即 stock 形态），单测覆盖。

### 5.2 Copilot 上下文注册（复用 usePageContext 模式）

- `views/NewsSearch.tsx` 顶层注册 scope：

```ts
usePageContext(useMemo(() => ({
  scopeId: 'news_search',
  title: '资讯搜索',
  getData: () => buildSearchContext(useAppStore.getState()),   // 从 searchSlice 同源读取（I3/D5）
  blocks: results.map((r) => ({
    blockId: 'news_search:result:' + r.resultId,
    title: blockTitleOf(r),            // 如「600745 闻泰科技 · 2026-09-01 公告摘要」
    getData: () => buildBlockContext(useAppStore.getState(), r.resultId),
    suggestedPrompts: ['这条公告对股价有什么影响？', '帮我梳理这条快讯的时间线', '这和我持仓里哪只股票相关？'],
  })),
}), [results]))
```

- `buildSearchContext / buildBlockContext` 为 `utils/searchCopilot.ts` 纯函数：入参整棵 store state，输出摘要文本 + 元信息；**严禁闭包捕获视图局部变量**（R2）。
- 卡片「追问 AI」按钮 = 直接复用 `components/copilot/BlockFocusButton`（`scopeId='news_search'`，`blockId` 如上）；档案卡用 `blockId='news_search:profile'`。
- 查询切换时旧 blocks 随重渲染替换、组件卸载自动注销——与 CurrentProjectCard 的挂载/结清语义一致。

### 5.3 档案卡组合策略

- P0：mock 全量返回 `StockProfile`。
- P1：优先 `fetchStockProfile`（后端聚合，接口文档 §5）；若后端排期不及，前端降级组合 = `searchAnnouncements({ query: stockId, stockCodes: [stockId], topK: 3 })` + 本地订阅态 + `useLiveQuotes` 行情，字段拼装为同一 `StockProfile` 类型——两种来源对视图透明。
- 行情圆点/现价：`useLiveQuotes([stockId])`，红涨绿跌沿用全局色彩约定。

### 5.4 订阅与追问按钮（零新逻辑）

- 订阅（v1.4 修订）：仅档案卡保留 `<AnnouncementSubscribeButton fullCode={profile.stockId} />`；**结果卡（公告/CLS）不再提供订阅入口**（订阅仍在短线/中长期交易卡片与档案卡提供）。CLS 卡无订阅，仅追问。
- 追问：见 5.2；按钮样式沿用 BlockFocusButton 胶囊态，卡片操作区不再引入其他动作（D2：无写账本入口）。会话按卡片隔离——线程键经 `copilotThreadKey` 下沉为 `scopeId:blockId`（V2.1 区块独立会话，copilotSlice/GlobalCopilot 共用），每条公告/日报问答互不叠加。

## 6. 代理与菜单接线

1. `vite.config.ts`：`server.proxy` 增 `'/api/search': { target: devUpstreams.auth, changeOrigin: true }`（与 /api/auth 同源同后端），文件头注释同步补「资讯搜索」。
2. `middleware.js`：UPSTREAMS 增 `'/api/search'` 条目（`base: PROXY_UPSTREAMS.online.auth`，`stripPrefix: false`）+ matcher 增 `'/api/search/:path*'`。
3. PWA `navigateFallbackDenylist` 已含 `/^\/api($|\/)/`，无需改动。
4. `App.tsx`：NAV_ITEMS + Route（I2）；`Search` 图标来自 lucide-react。
5. `scripts/feature-map.mjs`：GROUPS 增 `['search（资讯搜索）', ['search', 'newssearch']]`；跑 `npm run map:features` 确认「未归类」为 0。

## 7. 测试计划（`src/__tests__/`）

| 文件 | 覆盖 |
|------|------|
| searchService.test.ts | 四函数的路径/方法/body/Bearer 头；信封 200/400/401 语义；composite 内容协商（event-stream vs JSON 信封）与空闲超时；429 retryAfterSeconds 类型守卫（data 缺省兑底）；mock 确定性 + 错误分支触发词 |
| `searchSlice.test.ts` | runSearch 状态机（loading→succeeded/failed）；形态检测分流；持仓为空短路不发请求；seq 竞态（慢的旧响应被丢弃） |
| `searchPrompts.test.ts` | 模板 buildRequest 参数正确（日期范围边界、持仓代码透传）；requiresHoldings 置灰条件 |
| `searchCopilot.test.ts` | buildBlockContext 输出含摘要全文 + 元信息；store 无该 resultId 时安全降级 |

护栏：`npx tsc --noEmit` → `npm run check:arch` → `npm test` → `npm run map:features`，四步全绿为准出。

## 8. 实施顺序（P0 步骤清单）

1. `types/search.ts` + `utils/searchPrompts.ts`（含 `detectQueryIntent`）+ 单测。
2. `services/searchMock.ts` → `searchService.ts`（USE_MOCK 分流）+ 单测。
3. `searchSlice` + `store/types.ts` / `store/index.ts` 接线 + 单测。
4. `components/search/*` 三组件 + `views/NewsSearch.tsx` 组装（含 Copilot 注册）。
5. `App.tsx` 菜单/路由 + feature-map 登记 + `map:features` 校验。
6. 走查 A1-A9 验收清单（mock）。
7. P1 切真实接口：`USE_MOCK=false` + vite/middleware 代理 + 联调（对照接口文档 §7 用例）。
