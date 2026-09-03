# Context-Aware Copilot · 开发实施文档

> 版本：v1.5.1（2026-09-02 代码审查补丁；v1.5 收录版 = v1.4 定稿按 `docs/copilot-design.md` §8 差异清单修订后入库）
> 范围：前端契约/状态/服务/UI 落点与骨架、后端领域包/表结构/编排/容灾实现要点、API 契约、验证清单
> 关联：`docs/copilot-spec.md`（决策 D 编号总表，v1.5 重建版）、`docs/copilot-design.md`（C1-C17 设计基线）、`docs/e2ee-auth-spec.md`（鉴权）、skill `cls-article-patterns`（后端编码模板）
> 状态：待 P0 开发启动

**v1.5 修订摘要**（相对 v1.4，逐项对应 design §8 差异清单 #1-#13）：

1. 删除 copilot 域自建 `LlmChainRouter`/`LlmChannelClient`/`CopilotLlmConfig`，改为复用 llm 域 + 向后兼容扩展（§1.2/§8.3）
2. 幂等改**两段式**：cid 命中 user 行后查后续 assistant 行，无则续跑不重写（§8.1）
3. 幂等先于限流；user 行落库即更新 `last_message_at`（§8.1）
4. `usePageContext` cleanup 捕获本次注册对象，修注册泄漏（§5）
5. 限流改 Redis 双窗口 `CopilotRateLimiter` + `app.copilot.enabled` 开关（§8.1/§8.4）
6. 错误子码经 `ApiResponse` 新增可空 `subCode` 字段承载（§9.6）
7. 渠道配置沿用 `llm.*`，删除 `copilot.llm.*`（§8.4）
8. Fatal（400/401）维持流转下一渠道语义（§8.3）
9. DDL 加 `public.` 前缀对齐 schema.sql 现状（§7.1）
10. P1 即含双渠道容灾（复用链），P2 收敛为 llm 扩展单测 + 联调（§11）

**v1.5.1 补丁摘要**（2026-09-02 代码实现审查，修复 4 处底层语法与并发机制缺陷）：

1. §7.3 Repository：`softDeleteOverflow` 子查询 `LIMIT` 非标准 JPQL → 改原生 SQL（顺带补 `deleted_at = 0` 过滤）；`findByClientMessageIdAndDeletedAt` 衍生名两属性一参数（编译期错误）→ 显式 JPQL `findActiveByClientMessageId`
2. §8.1 步骤 3：主事务内 catch `DataIntegrityViolationException` 会把事务标记 RollbackOnly，commit 必抛 `UnexpectedRollbackException` → `getOrCreateSession` 抽 `REQUIRES_NEW` 独立事务（独立 Bean/TransactionTemplate，防自调用绕过代理）；备选 `INSERT ... ON CONFLICT ... DO NOTHING`
3. §5 hook：`getData: () => ownerRef.current.getData` 误返回函数引用 → 改为调用 `ownerRef.current.getData()`
4. §8.1 步骤 1：幂等两段式增加 pending 状态互斥——user 行初始 `status='pending'`；在窗（60s）pending → `409 ASK_IN_PROGRESS`；failed / 超窗 pending → 续跑；归档成功回写 `ok`、失败收尾置 `failed`（§7.1/§7.3/§8.1/§9.2/§9.6/§10.2 同步）

---

## 0. 前置事实（技术栈基线与环境约束）

| 项 | 事实 |
|---|---|
| 前端 | React 19 + zustand 5（slices 模式）+ react-router-dom 7 + Dexie 4.4 + Tailwind 3.4 + TypeScript + Vite + vitest（基线 472/472） |
| 后端 | stock-calculator-service：Spring Boot 4.1.1 + Java 21 + Jakarta + PostgreSQL + Spring Data JPA（Hibernate），Maven Wrapper，单模块 `stock-calculator-main` |
| 鉴权 | 前端 `services/apiClient.ts` 走 Spring Boot `:18080/api/auth`，Bearer 注入 + 恒 200 信封（code 分支）+ 拦截器 401 例外；Copilot 复用同一底座与令牌 |
| 前端执行环境 | 前端仓库根（stock-calculator/）；验证命令 `npx tsc --noEmit` / `npm test`（pretest 自动跑 `check:arch`） |
| 后端执行环境 | 本仓库；`./mvnw test '-Dtest=!TaskServiceTest' '-DfailIfNoTests=false'`（TaskServiceTest 打真实 API 必挂） |
| LLM 基建 | **复用 llm 域既有双渠道责任链**（`LlmChainRouter` + `GeminiLlmService`/`GroqLlamaService` + `LlmConfig` 全局 Bean，`llm.*` 配置，native OCR 已验证主路径）；copilot 仅做向后兼容扩展（§8.3），首次真实调用若 usage 反序列化报 native 反射缺口，按报错类名补 `gen-logger-config.py` EXTRA_CLASSES 迭代（P3 预留 1 轮） |
| 写入约束 | 终端命令禁含占位符展开形式；单次写入过长会被截断，大文件分段写 |

## 1. 文件清单与分层落点

### 1.1 前端（前端仓库）

| 文件 | 层 | 职责 | 分层护栏 |
|---|---|---|---|
| `src/types/domain.ts` | types | 追加：`CopilotMessage` / `PageContextSnapshot` / `ContextBlockSnapshot` / `COPILOT_SCOPES` 常量表 | R3 零依赖叶子 |
| `src/services/copilotService.ts` | services | 3 端点封装（复用 apiClient 底座）+ 体积护栏（ephemeral 明细 12KB，D28）+ ulid 生成 + 级联清理钩子 | 可 import db（推荐动态）、types；禁 store |
| `src/store/slices/copilotSlice.ts` | store | 注册表 / threads / 发送 / 翻页 / 清空 / consent / 明细重放元数据 / 墓碑 | 可 import db、services、types |
| `src/store/types.ts` + `src/store/index.ts` | store | `AppStoreActions` 增签名 + slices 组装 | — |
| `src/hooks/usePageContext.ts` | hooks | 页面注册 hook（mount 注册 / unmount 注销，§5 修正版） | 可 import store |
| `src/components/copilot/GlobalCopilot.tsx` | components | 浮窗 UI（胶囊/预览/列表/输入/同意弹窗/登录引导） | 禁 import db（R1），走 store/hooks |
| `src/App.tsx` | views | `AppLayout` 挂载 `<GlobalCopilot />` | — |
| `src/views/Statistics.tsx`、`src/views/Home.tsx` | views | P0 试点：`usePageContext({ scopeId, title, getData })` | 禁 db |

依赖方向单向：`types ← utils/services ← store ← hooks ← views/components`，R1/R2/R3 全部满足。

### 1.2 后端（本仓库，v1.5 修订）

```
stock-calculator-main/src/main/java/com/zzh/stock_calculator/copilot/
├── controller/CopilotController.java        # 3 端点，恒 200 信封；userId = @RequestAttribute("authUserId") UUID
├── dto/CopilotDtos.java                     # AskRequest / AskResponse / ThreadPageResponse（record 或 Lombok 三件套，随域内现状）
├── entity/AiChatSession.java
├── entity/AiChatMessage.java
├── repository/AiChatSessionRepository.java
├── repository/AiChatMessageRepository.java
├── service/AiChatOrchestrationService.java  # 编排（spec §6.1 时序）
├── service/CopilotRateLimiter.java          # Redis 双窗口限流（C7）
└── config/CopilotProperties.java            # copilot.* 前缀（rate-limit / history）
```

**llm 域扩展落点（C1/C2，vision 零改动，勿在 copilot 重建）：**

| 落点 | 内容 |
|---|---|
| `llm/service/LlmTurn.java` | `record LlmTurn(Role role, String content)`，Role ∈ system/user/assistant |
| `llm/service/LlmConversation.java` | `record LlmConversation(String systemPrompt, List<LlmTurn> turns)` |
| `llm/service/LlmChatResult.java` | `record LlmChatResult(String content, String provider, String model, Integer promptTokens, Integer completionTokens)` |
| `llm/service/LlmService.java` | 增 `default LlmChatResult chat(LlmConversation c)`：委托旧单轮 `chat`（拼文本），旧实现未覆写也能走通 |
| `llm/service/impl/AbstractOpenAiCompatibleLlmService.java` | 覆写 `chat(LlmConversation)`：turns 映射 SystemMessage/UserMessage/AssistantMessage → `chatModel.call(new Prompt(...))`，从 ChatResponse metadata 提取 usage；异常分类复用既有 `com.openai.errors.*` 映射 |
| `llm/LlmChainRouter.java` | 增 `chatDetailed(LlmConversation)`：与 `chat` 同构责任链循环，复用 maxAttempts/backoff/failures 汇总/降级模板；全链失败抛 BusinessException(503) |

**common 域微扩展（C6）：** `ApiResponse` 增可空 `subCode`（`@JsonInclude(NON_NULL)`）+ `fail(code, message, subCode)` 重载；`BusinessException` 增可选 subCode 构造器；`GlobalExceptionHandler` 透传。

- Modulith 边界：copilot 只引用 `common` 基包与 llm **基包**公开类型（LlmChainRouter / LlmConversation / LlmChatResult）；**不 import 任何域的子包**（`ModulithVerifyTest` 守护）。
- 表结构落 `postgres/schema.sql`（feature-index 变更落点顺序）；新增领域按 feature-index 约定登记。

## 2. 前端契约（`types/domain.ts` 追加，R3 零依赖）

#### scopeId 格式约定：`页面[:实体主键]`（D30）

```typescript
/** Copilot 作用域常量表与复合 scopeId 协议 */
export const COPILOT_SCOPES = {
  HOME: 'home',
  CHANGE_RATE: 'change_rate',
  T_CALCULATOR: 't_calculator',
  COST_AVERAGING: 'cost_averaging',
  SANDBOX: 'sandbox',
  STATISTICS: 'statistics',
  FEE_CONFIG: 'fee_config',
  WEBDAV: 'webdav',
  BATCH_IMPORT: 'batch_import',
} as const;

/** scopeId 协议（D30）：`页面标识[:实体主键]`，冒号分隔；无实体不加冒号。
 *  实体主键 = 页面上可切换的顶级业务实体 Key：
 *  - cost_averaging / t_calculator：统一且仅为股票代码（如 `t_calculator:600519`）；
 *  - round / 持仓批次 / 订单等子级数据一律不作顶层 scopeId；
 *  - 全局聚合页（home / statistics）保持纯字符串，无实体段。 */
export type CopilotScopeId = string;

/** 辅助函数：从路由 slug + 可选实体主键构造 scopeId */
export function composeScopeId(pageSlug: string, entityKey?: string): string {
  return entityKey ? `${pageSlug}:${entityKey}` : pageSlug;
}

/** 页面上下文快照契约：统一在 types 定义，各页面在 view 层实现（D2/D5） */
export interface ContextBlockSnapshot {
  blockId: string;
  title: string;
  getData: () => Record<string, unknown>;
}

export interface PageContextSnapshot {
  scopeId: CopilotScopeId;
  title: string;                          // 页面可读标题，作会话 title
  getData: () => Record<string, unknown>; // 命令式快照（铁律①②，D5）
  blocks?: ContextBlockSnapshot[];        // V1 不建 UI，仅契约占位（D2）
}

/** 消息（前端形态；后端 ai_chat_message 行映射） */
export interface CopilotMessage {
  id: number | null;          // 后端 id；乐观追加期为 null
  clientMessageId: string;    // ulid，幂等键（D9）
  role: 'user' | 'assistant';
  content: string;            // 纯文本（D20）
  status: 'pending' | 'ok' | 'failed';
  ctime: number;              // epoch 秒
}
```

## 3. `services/copilotService.ts`

```typescript
/** 基地址：默认本地后端；Vercel 部署时以 VITE_COPILOT_API_BASE_URL 覆盖 */
export const COPILOT_API_BASE_URL: string =
  import.meta.env.VITE_COPILOT_API_BASE_URL ?? 'http://localhost:18080/api/copilot';
```

要点：

1. **底座复用**：从 `apiClient.ts` 抽出泛化的 `requestJson(baseUrl, path, init)`（恒 200 信封解析 + Bearer 注入 + 超时 + 统一错误类型），auth 与 copilot 共用；copilot 侧超时 **60_000ms**（D13）；信封 `subCode` 字段透出（v1.5，§9.6）。
2. **三个端点封装**（见 §9 API 契约）：`sendQuestion(scopeId, payload)` / `fetchMessages(scopeId, { before?, limit })` / `clearThread(scopeId)`。
3. **体积护栏**（铁律④/D28，作用于 **ephemeral 明细**）：`applySizeGuard(snapshot, maxBytes = 12_000)` —— JSON 序列化超限则裁行/裁字段，附 `truncated: true` + `capturedAt`（epoch 秒）。所有 scope 共用；护栏仅约束 `contextSummary.data`，不触碰落库的 `contextOverview`/`timeAnchor`。
4. **幂等键**：`newClientMessageId()` = 项目已有 `ulid` 依赖生成（D9）。
5. **Mock 开关（P0）**：`import.meta.env.VITE_COPILOT_MOCK === '1'` 时 `sendQuestion` 返回本地假应答（延迟 600ms + 回显摘要字段名），后端未就绪也能全链路验证 UI。

## 4. `store/slices/copilotSlice.ts`

### 4.1 State 形状

```typescript
/** 单条消息的轻量快照元数据（回看预览 + 明细重放用） */
interface CopilotSnapshotMeta {
  contextOverview?: string;   // 极简指标 JSON（{ pnl:1234.5, winRate:0.62 }）
  timeAnchor?: string;        // 时间截面标记（{"asOf":1756713600,"range":"7d"}）
}

interface CopilotThreadMeta {
  hasMore: boolean;
  oldestId: number | null;
  loading: boolean;
  loadingOlder: boolean;
}

interface CopilotSliceState {
  panelOpen: boolean;
  consent: 'unknown' | 'granted' | 'declined';  // localStorage 持久化（复用 persistence 模式）
  deletedScopes: string[];                       // 墓碑集合（D29，localStorage 持久化）
  registry: Record<string, RegisteredContext>;   // scopeId → { title, getData, owner }
  activeScopeId: CopilotScopeId | null;          // 跟随路由（最后注册者胜出）
  threads: Record<string, CopilotMessage[]>;     // 内存缓存尾部 20 条（D8）
  meta: Record<string, CopilotThreadMeta & CopilotSnapshotMeta>;
  sending: boolean;
}
```

### 4.2 动作表（进 `AppStoreActions` 签名）

| 动作 | 行为 |
|---|---|
| `registerContext(ctx)` | 写 registry + 置 `activeScopeId`；同 scope 重复注册幂等覆盖（StrictMode 双挂载安全） |
| `unregisterContext(scopeId, owner)` | 仅当 `registry[scopeId].owner === owner` 才移除，防误删后注册者 |
| `ensureThreadLoaded(scopeId)` | **墓碑对账（D29）**：scopeId ∈ deletedScopes → 拦截加载，先补发 `DELETE /threads/{scopeId}`，成功后注销墓碑再正常拉取（补发仍失败则保留墓碑下次重试）；无墓碑时——有缓存跳过，否则拉尾部 20 条**整段替换**（D8） |
| `sendMessage(question)` | 读 `activeScopeId` → registry.getData() → 护栏 → 乐观追加 pending 态 → POST（携带 ephemeral contextSummary + 落库用 overview/anchor）；成功归位 + 追加 assistant；失败标 `failed`（保留重发）；**sending 锁防重复提交** |
| `resendMessage(clientMessageId)` | 失败重发，同 clientMessageId（服务端幂等两段式，D9/C9） |
| `loadOlder(scopeId)` | keyset 向前翻页，追加头部 |
| `clearCurrentThread()` | ConfirmModal 确认后 DELETE + 清本地（D18）；**DELETE 失败（离线）→ 写入 deletedScopes 墓碑（D29）** |
| `purgeScopeOnEntityDelete(scopeId)` | 业务实体删除钩子（触发源白名单 D31）：DELETE + 清本地 threads/meta 缓存；失败写墓碑 |
| `setPanelOpen / grantConsent / declineConsent` | UI 态 |

### 4.3 发送时序（slice 内部约定）

```
sending=true → snapshot = registry[active].getData()
             → guarded = applySizeGuard(snapshot)      // ephemeral 明细 12KB 护栏（D28）
             → cid = newClientMessageId()
             → 乐观 append {role:'user', content:question, id:null, status:'pending'}
             → service.sendQuestion(...)   // 60s 超时；payload = contextSummary(ephemeral) + contextOverview/timeAnchor(落库)
             ├─ ok:    user 消息归位(ok, id 回填) + append assistant(ok) + tokens 落 meta
             └─ fail:  user 消息标 failed（内容保留，可重发；UPSTREAM_ERROR 高亮重发，
             │         RATE_LIMIT_EXCEEDED 禁发送，CONTEXT_TOO_LARGE 禁重发并引导缩范围）
             → sending=false（finally）
```

## 5. `hooks/usePageContext.ts`（v1.5 修正版）

```typescript
/**
 * 页面上下文注册 hook：视图挂载时注册自身快照，卸载时注销。
 * 铁律①（D5）：getData 必须是命令式快照，请传 () => build(getState()) 形态。
 * v1.5 修正：cleanup 必须注销**本次注册的同一引用**——若读 ownerRef.current，
 * scope 切换时 ref 已指向新页面快照，owner 比对永不匹配，旧注册永不注销（registry 泄漏）。
 */
export function usePageContext(snapshot: PageContextSnapshot): void {
  const ownerRef = useRef<PageContextSnapshot>(snapshot);
  ownerRef.current = snapshot;

  const registerContext = useAppStore((s) => s.registerContext);
  const unregisterContext = useAppStore((s) => s.unregisterContext);

  useEffect(() => {
    const registered = { ...snapshot, getData: () => ownerRef.current.getData() };
    registerContext(registered);                                    // 同 scope 幂等覆盖
    return () => unregisterContext(registered.scopeId, registered); // 注销本次注册的同一引用
  }, [snapshot.scopeId]);  // 仅 scopeId 变化触发重注册
}
```

- 注册即置 `activeScopeId`（路由切换 = 旧视图卸载 + 新视图挂载，状态机自动流转）。
- getData 仍经 ownerRef 保命令式新鲜度；注销按注册时引用比对（slice 动作 owner 校验不变）。
- StrictMode 下双挂载：注册幂等覆盖，注销按 owner 引用比对（§4.2）。

## 6. `components/copilot/GlobalCopilot.tsx`

### 6.1 挂载与结构

```tsx
// App.tsx → AppLayout 内，与 AuthGate 同层
<GlobalCopilot />

// 组件内部骨架（Tailwind，深色系与全站一致 slate-800/900）
<div className="fixed bottom-6 right-6 z-40">
  {!panelOpen && <FloatingButton onClick={...} />}          {/* 折叠态悬浮按钮 */}
  {panelOpen && (
    <div className="w-[380px] max-h-[70vh] flex flex-col rounded-xl
                    bg-slate-800 border border-slate-700 shadow-2xl">
      <ContextCapsule />      {/* 已关联: {title} · 点开预览字段 · 返回整页(V2) */}
      <MessageList />         {/* 查看更早 / 消息 / 失败重发 / 空态引导 */}
      <InputBar />            {/* Enter 发送 / Shift+Enter 换行 / sending 禁用 */}
    </div>
  )}
  <ConsentModal />            {/* 首次使用知情同意（D4） */}
</div>
```

### 6.2 组件职责边界

| 子块 | 数据来源 | 备注 |
|---|---|---|
| `ContextCapsule` | `registry[activeScopeId].title` | 胶囊展示当前关联页面标题 |
| `MessageList` | `threads[activeScopeId]` + `meta` | **V1 仅渲染概览（D32）**：user 消息卡片显示 `contextOverview` 概览 + `timeAnchor` 标签（如「数据截至 09-01 · 近7天」）；「基于 Dexie 历史切片的明细重放」归入 P2/V2 |
| `InputBar` | 本地 state + `sending` | Enter 发送；空串禁发 |
| 登录引导 | `useAuthStore.isAuthenticated` | 未登录点击 → `setAuthModalOpen(true)`（D19） |
| 离线 | `navigator.onLine` + 发送失败分类 | 提示「AI 助手需要网络」；DELETE 失败 → 写 `deletedScopes` 墓碑（D29） |

### 6.3 路由联动

- `AppLayout` 中监听 `location.pathname`：scope 变化时调 `ensureThreadLoaded(newScope)`（内置墓碑对账，D29）；前一 scope 有消息且非当前 → 顶部显示「上一页（XX）对话已归档」（spec §7.3）。
- 移动端：`md:` 断点以下浮窗改全宽半屏抽屉（spec §7.4）。

## 6b. 试点页快照 builder（白名单模板）

快照 builder 是 P0 真正的工作量所在（铁律②：store + 纯引擎重建）。落点：各视图文件内定义，或复杂时放 `utils/copilotSnapshots.ts`（纯函数，显式入参 store 切片，符合 R2）。

```typescript
// Statistics 页示例：useStreamResults/useArchivedRounds 是组件态派生，
// 快照必须用同一套纯引擎从 store/db 重算（不得读组件闭包）
function buildStatisticsSummary(state: AppState): Record<string, unknown> {
  const entries = tStreamEngine.match(state.streams /* … */);   // 与视图同源纯函数
  return {
    totalRealizedPnl: entries.reduce((s, e) => s + e.pnl, 0),   // 元
    winRate: computeWinRate(entries),                            // 小数比例
    roundCount: entries.length,
    archivedRounds: state.archivedRounds.length,
    // 白名单外字段一律不出现——serialize 整页 state 是禁止行为（铁律③）
  };
}

// Home 页示例：一次产出两路分发（D28）——标量子集落库 + 白名单明细进 ephemeral Prompt
function buildHomeSummary(state: AppState): Record<string, unknown> {
  return {
    positionCount: state.positions.length,
    totalMarketValue: /* … */,
    totalUnrealizedPnl: /* … */,
    totalUnrealizedPnlRate: /* … */,
  };
}
```

**快照铁律（D28 一次产出、两路分发）**：
1. **落库路（标量）**：`contextOverview` 仅标量（数字/字符串），<255 字符，严禁明细数组——供历史卡片回放；
2. **Prompt 路（ephemeral 明细）**：`contextSummary.data` 可含白名单明细行（如最近 N 笔轮次），经 `applySizeGuard ≤12KB` 护栏，仅内存组装 Prompt、不落库不打日志；
3. 两路同源一次计算，严禁口径漂移；历史明细回放仍通过 `time_anchor` 从 Dexie 重算（P2/V2，D32）。

## 7. 后端：表结构与持久化层

### 7.1 `postgres/schema.sql` 追加（v1.5：对齐现状加 `public.` 前缀）

```sql
-- 会话表：仅存储元数据，不存完整快照
CREATE TABLE IF NOT EXISTS public.ai_chat_session (
    id              BIGSERIAL PRIMARY KEY,
    user_id         VARCHAR(64)  NOT NULL,       -- auth UUID 字符串
    scope_id        VARCHAR(100) NOT NULL,       -- 页面级（statistics）或 页面:实体ID（cost_averaging:600519）
    title           VARCHAR(100) NOT NULL,
    last_message_at BIGINT,                      -- 最后互动时间戳（秒）；user 行落库即更新（v1.5）
    ctime           BIGINT       NOT NULL,       -- 创建时间（秒）；epoch 秒与前端直通（C8 取舍见 design §0）
    deleted_at      BIGINT       DEFAULT 0       -- 软删除标记（0:未删，>0:删除时间戳）
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_chat_session_user_scope
    ON public.ai_chat_session (user_id, scope_id) WHERE deleted_at = 0;

-- 消息表：user 行携带轻量概览与幂等键；assistant 行携带渠道与 tokens
CREATE TABLE IF NOT EXISTS public.ai_chat_message (
    id                BIGSERIAL PRIMARY KEY,
    session_id        BIGINT       NOT NULL,
    role              VARCHAR(10)  NOT NULL,      -- 'user' | 'assistant'
    content           TEXT         NOT NULL,
    client_message_id VARCHAR(40),                -- ulid，仅 user 行携带（C9）
    status            VARCHAR(20)  DEFAULT 'pending',  -- user 行初始 pending；assistant 行显式 'ok'；失败收尾显式 'failed'（v1.5.1）
    context_overview  VARCHAR(255),               -- 标量 JSON（仅 user 行）
    time_anchor       VARCHAR(100),               -- 时间锚 JSON（仅 user 行）
    channel           VARCHAR(30),                -- 仅 assistant 行
    model             VARCHAR(50),
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    ctime             BIGINT       NOT NULL,
    deleted_at        BIGINT       DEFAULT 0      -- 级联软删除标记
);
-- 幂等索引：仅约束非 null 且未软删的行（软删后同 cid 可在 新会话 重发）
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_chat_message_client_id
    ON public.ai_chat_message (client_message_id)
    WHERE client_message_id IS NOT NULL AND deleted_at = 0;
-- 分页/滑动窗口查询索引
CREATE INDEX IF NOT EXISTS idx_ai_chat_message_session_id
    ON public.ai_chat_message (session_id, id DESC) WHERE deleted_at = 0;
```

### 7.2 Entity 要点（严格按 cls-article-patterns 模板）

```java
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@Entity
@Table(name = "ai_chat_session", uniqueConstraints =
        @UniqueConstraint(name = "uq_ai_chat_session_user_scope",
                          columnNames = {"user_id", "scope_id"}))
public class AiChatSession {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(nullable = false, length = 64)
    private String userId;
    // scopeId：页面级（statistics）或 页面:实体主键（cost_averaging:600519）
    @Column(nullable = false, length = 100)
    private String scopeId;
    @Column(nullable = false, length = 100)
    private String title;
    @Column(name = "last_message_at")
    private Long lastMessageAt;
    @Column(nullable = false)
    private Long ctime;
    @Column(name = "deleted_at")
    private Long deletedAt;
}

// AiChatMessage：轻量持久化
// client_message_id 仅 user 行携带（C9）；context_overview <255 标量 JSON；
// deleted_at 级联软删标记，session 被删时同步设为当前时间戳；
// status 状态机（v1.5.1）：user 行 pending →(归档成功) ok / →(失败收尾) failed →(重试续跑) 置回 pending；
// assistant 行恒为 ok
```

- native 注意：实体 id 数组（`Long[]` 等）已由 `gen-logger-config.py` EXTRA_CLASSES 覆盖；usage 反序列化若报反射缺口按报错类名补（P3 迭代 1 轮）。

### 7.3 Repository（keyset 按 id 排序；幂等两段式与状态机 v1.5.1）

```java
public interface AiChatSessionRepository extends JpaRepository<AiChatSession, Long> {
    @Query("SELECT s FROM AiChatSession s WHERE s.userId = :uid AND s.scopeId = :sid AND s.deletedAt = 0")
    Optional<AiChatSession> findActiveByUserIdAndScopeId(@Param("uid") String uid, @Param("sid") String sid);
    @Query("SELECT COUNT(s) > 0 FROM AiChatSession s WHERE s.userId = :uid AND s.scopeId = :sid AND s.deletedAt = 0")
    boolean existsActiveByUserIdAndScopeId(@Param("uid") String uid, @Param("sid") String sid);
    @Query("SELECT s.id FROM AiChatSession s WHERE s.userId = :uid AND s.scopeId = :sid AND s.deletedAt > 0")
    List<Long> findDeletedSessionIdsByUserIdAndScopeId(@Param("uid") String uid, @Param("sid") String sid);
}

public interface AiChatMessageRepository extends JpaRepository<AiChatMessage, Long> {
    // 滑动窗口：最近 window-rounds*2 条（倒序取后反转正序返回）
    List<AiChatMessage> findFirst6BySessionIdAndDeletedAtOrderByIdDesc(Long sessionId);
    // keyset 翻页：id < before 的前 limit 条
    @Query(value = "SELECT * FROM ai_chat_message WHERE session_id = :sessionId " +
                   "AND id < :before AND deleted_at = 0 ORDER BY id DESC LIMIT :limit", nativeQuery = true)
    List<AiChatMessage> findBeforeKeyset(@Param("sessionId") Long sessionId,
                                          @Param("before") Long before, @Param("limit") int limit);
    // 幂等两段式（C9/v1.5.1）：第一步按 cid 查活跃 user 行；第二步查其后首条 assistant 行。
    // v1.5.1：原 findByClientMessageIdAndDeletedAt 衍生名含两属性却只传一参（编译期错误），改显式 JPQL
    @Query("SELECT m FROM AiChatMessage m WHERE m.clientMessageId = :cid AND m.deletedAt = 0")
    Optional<AiChatMessage> findActiveByClientMessageId(@Param("cid") String cid);
    Optional<AiChatMessage> findFirstBySessionIdAndIdGreaterThanAndRoleAndDeletedAtOrderByIdAsc(
            Long sessionId, Long idGreaterThan, String role);
    // user 行状态机翻转（v1.5.1）：pending→ok（归档成功）/ pending→failed（失败收尾）/ failed→pending（重试重挂互斥）
    @Modifying
    @Query("UPDATE AiChatMessage m SET m.status = :status WHERE m.id = :id")
    int updateStatus(@Param("id") Long id, @Param("status") String status);
    // 懒清理：软删最旧的超出容量部分。
    // v1.5.1：JPQL 子查询不支持 LIMIT（且原写法漏了 deleted_at=0 过滤）→ 改原生 SQL
    @Modifying
    @Query(value = "UPDATE ai_chat_message SET deleted_at = :now WHERE id IN " +
                   "(SELECT id FROM ai_chat_message WHERE session_id = :sessionId " +
                   "AND deleted_at = 0 ORDER BY id ASC LIMIT :overflow)", nativeQuery = true)
    int softDeleteOverflow(@Param("sessionId") Long sessionId, @Param("now") Long now,
                           @Param("overflow") int overflow);
    // 级联软删除：session 被软删时同步标记其下全部消息
    @Modifying
    @Query("UPDATE AiChatMessage m SET m.deletedAt = :now WHERE m.sessionId = :sessionId AND m.deletedAt = 0")
    int cascadeDeleteBySessionId(@Param("sessionId") Long sessionId, @Param("now") Long now);
    long countBySessionIdAndDeletedAt(Long sessionId, Long deletedAt);
}
```

## 8. 后端：编排与容灾路由

### 8.1 `service/AiChatOrchestrationService.java`（@Transactional 编排，v1.5.1 修订）

```java
@Slf4j @Service @RequiredArgsConstructor
public class AiChatOrchestrationService {
    private final AiChatSessionRepository sessionRepository;
    private final AiChatMessageRepository messageRepository;
    private final LlmChainRouter llmChainRouter;      // llm 基包公开 API（C1）
    private final CopilotRateLimiter rateLimiter;     // Redis 双窗口（C7）
    private final AiChatSessionStore sessionStore;    // 独立 Bean：getOrCreate REQUIRES_NEW（v1.5.1，C10）
    // CopilotProperties: per-minute / per-day / window-rounds / max-messages / pending-window(60s)

public AskResponse ask(String userId, String scopeId, AskRequest req) {
    // 1. 幂等两段式 + pending 互斥（v1.5.1，先于限流：重放不消耗配额）
    //    ① userRow = findActiveByClientMessageId(req.clientMessageId)
    //    ② 未命中 → 全新提问，继续 2
    //    ③ 命中 → reply = findFirstBySessionIdAndIdGreaterThanAndRole...Asc(
    //         userRow.sessionId, userRow.id, "assistant")
    //         ├─ reply 存在 → 直接回放已归档回复（不重复调 LLM、不双写）
    //         └─ reply 不存在 → 状态门控（v1.5.1）：
    //            userRow.status='pending' 且 now-userRow.ctime < pending-window(60s)
    //              → 抛 BusinessException(409, "上一次提问仍在处理中", "ASK_IN_PROGRESS")
    //                防长调用未完成时同 cid 并发击穿；不耗限流配额
    //            userRow.status='failed' 或 pending 已超 60s 窗口（陈旧残留，如重启丢现场）
    //              → 续跑：主事务内 updateStatus(userRow.id, "pending") 重挂互斥，
    //                复用 userRow.sessionId，跳过写 user 行
    // 2. 限流：rateLimiter.check(userId)（新提问与续跑路径；Redis 双窗口，fail-open）
    // 3. get-or-create session：sessionStore.getOrCreate(userId, scopeId, sessionTitle)
    //    —— REQUIRES_NEW 独立事务（C10/v1.5.1）：撞 uq_ai_chat_session_user_scope 时仅回滚
    //    该内部小事务，catch DataIntegrityViolationException 后回退重查复用既有 session；
    //    主事务不被标记 RollbackOnly（否则 commit 必抛 UnexpectedRollbackException → 500）
    // 4. 写 user message（status='pending'；context_overview + time_anchor 直接落库；
    //    >255 或 contextSummary>16KB → CONTEXT_TOO_LARGE/413 兜底校验）
    //    + 同步更新 session.lastMessageAt（v1.5：不等到 assistant）
    // 5. 懒清理：countBySessionIdAndDeletedAt > max-messages → softDeleteOverflow()
    // 6. 滑动窗口：findFirst6BySessionIdAndDeletedAtOrderByIdDesc → 反转正序
    // 7. 组装 Prompt：spec §6.2 分层（contextSummary 仅内存，不落库不打日志，@ToString.Exclude）
    try {
        // 8. LLM 调用在事务外（长调用不占数据库连接）
        LlmChatResult result = llmChainRouter.chatDetailed(conversation);
        if (llmChainRouter.isDegradedResponse(result.content())) {
            throw new BusinessException(503, "AI 服务暂不可用，请稍后重试", "UPSTREAM_ERROR");
        }
        // 9. 归档 assistant message（新事务：status='ok', channel, model, tokens）
        //    + 同事务回写 userRow.status='ok'（v1.5.1 状态机收口）
        AiChatMessage assistant = AiChatMessage.builder()
                .sessionId(session.getId()).role("assistant")
                .content(result.content()).status("ok")
                .channel(result.provider()).model(result.model())
                .promptTokens(result.promptTokens()).completionTokens(result.completionTokens())
                .ctime(nowSec()).build();
        messageRepository.save(assistant);
        messageRepository.updateStatus(userMsg.getId(), "ok");   // v1.5.1：user 行收口为 ok
        return toAskResponse(userMsg.getId(), assistant.getId(), result);
    } catch (BusinessException e) {
        if (e.getCode() == 503) {
            // 失败收尾（v1.5.1）：独立小事务立即提交 user 行 status='failed'，
            // 放行下次同 cid 重发；任何 LLM 失败路径（含未分类异常兜底）都必须收口到这里
            messageRepository.updateStatus(userMsg.getId(), "failed");
            throw new BusinessException(503, "AI 服务暂不可用，请稍后重试", "UPSTREAM_ERROR");
        }
        throw e; // 其余异常原样透传（413/429/409 在 try 之前抛出，不经过本 catch）
    }
}

/** 级联软删除（触发源白名单 D31，后端入口幂等） */
@Transactional
public void cascadeDeleteByScopeId(String userId, String scopeId) {
    // findActiveByUserIdAndScopeId → 命中则 session.deletedAt=nowSec() +
    // cascadeDeleteBySessionId(session.getId(), nowSec())；不存在/已删 → no-op
}
}
```

**`AiChatSessionStore`（v1.5.1 新增，独立事务封装）**：

```java
/**
 * v1.5.1：get-or-create 独立事务封装。必须独立 Bean——同类自调用会绕过代理使 REQUIRES_NEW 失效；
 * 也可用 TransactionTemplate(PROPAGATION_REQUIRES_NEW) 等价实现。
 */
@Service @RequiredArgsConstructor
public class AiChatSessionStore {
    // @Transactional(propagation = Propagation.REQUIRES_NEW)
    public AiChatSession getOrCreate(String userId, String scopeId, String title) {
        // findActiveByUserIdAndScopeId 命中 → 返回；
        // 未命中 → save 新 session（ctime=nowSec()）；撞 uq_ai_chat_session_user_scope 抛
        // DataIntegrityViolationException 时仅回滚本小事务，外层 catch 后回退重查复用。
        // 备选方案（无异常路径，同样不污染主事务）：原生
        // INSERT ... ON CONFLICT (user_id, scope_id) WHERE deleted_at = 0 DO NOTHING
        // + 受影响行数为 0 时回查复用（注意部分索引冲突目标必须带 WHERE 谓词）
    }
}
```

- 事务边界（C11/v1.5.1）：1/4/5/6 的库操作同主事务；3 为 REQUIRES_NEW 独立事务（先提交，主事务随后引用）；8 在事务外；9 开新事务（归档 + user 行置 ok）；失败收尾（user 行置 failed）为独立小事务立即提交。
- 同 cid 并发双击：前端 sending 锁 + 服务端 pending 窗口互斥（409 ASK_IN_PROGRESS）双保险；assistant 行不加唯一约束，残余竞态（pending 超窗后的迟到重复）接受。
- sessionTitle 变化时同步更新 session.title（页面标题/实体切换后保持会话列表可读）。
- contextSummary 全程仅在内存组装 Prompt，**不落库、不打日志**（D28）；DTO 字段标 `@ToString.Exclude` 防误打印。

### 8.3 LLM 接入（v1.5 重写：复用 llm 域，勿自建）

- **复用**：`llm.LlmChainRouter` 责任链（Gemini → Groq → fallback，`llm.*` 配置 Bean）+ `AbstractOpenAiCompatibleLlmService` 既有异常分类（`com.openai.errors.*` → `LlmProviderException(retryable)`）。
- **扩展**（落点见 §1.2 表）：`chat(LlmConversation)` 默认方法 + 覆写实现多轮 Prompt 与 usage 提取；`chatDetailed` 路由方法复用既有重试/流转/降级语义。
- **Fatal 语义（C4，v1.5 修订）**：确定性失败（400/401/403）与可重试失败一样**流转下一渠道**——单渠道 Key 失效时直接失败会放大不可用面；耗尽后统一 `UPSTREAM_ERROR`。
- **降级识别（C3）**：fallback 渠道返回模板文本（无 tokens），编排层以 `isDegradedResponse` 判定后按 `UPSTREAM_ERROR` 处理，**不归档** assistant 消息。
- usage 提取 API 名（`getMetadata().getUsage()` 等）以项目实际 Spring AI 版本为准；native 下若 usage DTO 反序列化报反射缺口 → 按 `gen-logger-config.py` EXTRA_CLASSES 迭代（预留 1 轮）。

### 8.4 `controller/CopilotController.java` + `application.yml`

```java
@RestController @RequestMapping("/api/copilot") @RequiredArgsConstructor
public class CopilotController {
    // POST   /threads/{scopeId}/messages   → ApiResponse<AskResponse>（userId 取法与 auth 域控制器一致）
    // GET    /threads/{scopeId}/messages?before=&limit=20 → ApiResponse<ThreadPageResponse>
    // DELETE /threads/{scopeId}            → ApiResponse<Void>（级联软删，幂等：不存在也 200）
}
```

```yaml
# v1.5：渠道连接配置沿用现有 llm.gemini.* / llm.groq.*（含 env 注入占位），零新增渠道配置
copilot:
  rate-limit: { per-minute: 10, per-day: 100 }
  history: { window-rounds: 3, max-messages: 200 }

app:
  copilot:
    enabled: true   # 条件装配开关（C7）；关闭时 Controller 返回信封 fail(404, "功能未开启")
```

以上属性由 `CopilotProperties` 消费；`CopilotRateLimiter` 用 `StringRedisTemplate` INCR+EXPIRE 固定双窗口（键前缀 `rl:copilot:`），模式对齐 auth 域 RateLimitService 但不 import auth 子包；Redis 不可用 fail-open 放行 + 告警日志。

## 9. API 契约（3 端点，信封语义与 `/api/auth` 一致：恒 200 + code 分支，未认证拦截器直写 401）

### 9.1 POST `/api/copilot/threads/{scopeId}/messages`

**传输/存储分离（D28）**：请求同时携带两组语义不同的字段——`contextSummary`（ephemeral 阅后即焚：当前屏幕白名单明细 + 单位字典，仅在内存组装 Prompt，不落库不打日志）与 `contextOverview`/`timeAnchor`（落库概览，供历史卡片回放）。

```json
// Request
{
  "question": "最近做T的胜率怎么样？",
  "sessionTitle": "数据统计",
  "clientMessageId": "01J9ZK3T8Q...ulid",
  "contextSummary": {
    "capturedAt": 1756713600,
    "truncated": false,
    "_units": { "pnl": "CNY", "winRate": "0-1小数", "roundCount": "笔" },
    "data": { "pnl": 1234.56, "winRate": 0.62, "roundCount": 47, "avgPnlPerRound": 26.27, "recentRounds": "…白名单字段（经 applySizeGuard ≤12KB，D28）…" }
  },
  "contextOverview": "{\"pnl\":1234.56,\"winRate\":0.62,\"roundCount\":47}",
  "timeAnchor": "{\"asOf\":1756713600,\"range\":\"7d\"}"
}

// Response data
{ "assistantMessageId": 9102, "content": "…纯文本回答…",
  "promptTokens": 852, "completionTokens": 418, "channel": "gemini",
  "userMessageId": 9101, "userContextOverview": "{\"pnl\":1234.56,…}",
  "userTimeAnchor": "{\"asOf\":1756713600,…}", "ctime": 1756713601 }
```

- `scopeId` 含 `:`（如 `cost_averaging:600519`）在 path 段合法（RFC 3986 pchar），前端仍建议 `encodeURIComponent`。
- 幂等（C9 两段式）：同 `clientMessageId` 重发 → 命中已归档回复则直接回放（不重复调 LLM、不双写）；上次失败则续跑归档。失败后重发**不消耗限流配额**。
- 超限/渠道耗尽 → 恒 200 信封 `ApiResponse.fail(...)`（见 §9.6），前端标 `failed` 可重发。
- **持久化边界（D28）**：仅 `contextOverview`/`timeAnchor` 写入 ai_chat_message（User 行）；`contextSummary` 为 ephemeral——不落库、不打日志、响应后即释放；仅 User 消息行记录，Assistant 行无此字段。

### 9.2 GET `/api/copilot/threads/{scopeId}/messages?before=&limit=20`

```json
// Response data（keyset：id < before 的前 limit 条，倒序取出后正序返回）
{ "sessionId": 12, "scopeId": "statistics", "title": "数据统计",
  "messages": [
    { "id": 9098, "role": "user", "content": "…",
      "contextOverview": "{\"pnl\":1234.56,\"winRate\":0.62}",
      "timeAnchor": "{\"asOf\":1756710000,\"range\":\"7d\"}",
      "clientMessageId": "…", "status": "ok", "ctime": 1756710000 }
  ],
  "hasMore": true, "oldestId": 9098 }
```

- 首次拉取不传 `before` → 取尾部 limit 条；无会话 → 空页（sessionId=null, hasMore=false），不报错。
- `status` 字段（v1.5.1）：user 行含 'pending'（处理中，前端渲染进行中样式）/ 'ok' / 'failed'；assistant 行恒 'ok'。
- **历史卡片渲染（D32，V1 降级）**：仅展示 `contextOverview` 概览 + `timeAnchor` 标签（如「7 天前快照」）；基于 `timeAnchor` 的 Dexie 明细重放为 P2/V2 任务，V1 不交付「展开明细」。
- 已软删的消息不在响应中。

### 9.3 DELETE `/api/copilot/threads/{scopeId}`（级联生命周期）

1. 对应 `ai_chat_session.deleted_at` 设为当前时间戳秒
2. 级联将该 session 下所有 `ai_chat_message.deleted_at` 设为当前时间戳秒
3. **不清除 content / context_overview**——保留排障追溯能力
4. 同 `(user_id, scope_id)` 可复用唯一索引创建新会话

Response：`ApiResponse<Void>`；幂等：会话不存在/已删也 200。

前端调用由业务实体删除事件自动触发，或用户手动清空会话时经 ConfirmModal 二次确认（D18）。

**级联清理触发源白名单（D31）**——仅以下三类事件触发 DELETE，其余一律不触发：

| 触发源 | 清理目标 scopeId | 说明 |
|---|---|---|
| 持仓管理删除某标的 | `cost_averaging:{symbol}` | 该标的全部 Copilot 会话级联软删 |
| 做T记录删除某标的 / 清空流水 | `t_calculator:{symbol}` | 按标的清理；清空流水时逐标的批量调用 |
| 全局重置 / 一键清库 | 全量 | 前端按已知 scopeId 集合批量循环调用（预留后端全量清理端点） |

- **不触发清单**：卖出/清仓/归档/批次合并等正常业务生命周期动作一律不触发（历史会话仍可作复盘资料）。
- **墓碑补发（D29）**：弱网/离线删除时 DELETE 可能未送达——前端本地持久化 `deletedScopes` 墓碑集合，下次 `ensureThreadLoaded` 命中墓碑时拦截历史加载并补发 DELETE，成功后注销墓碑，防止旧历史「复活」。

### 9.4 页面 × 接口调用矩阵（所有页面一致）

9 个页面**共用同一套 3 个端点**，页面差异只体现在 `scopeId` 和轻量级元数据内容，后端不为任何页面单开接口：

| 时机 | 调用 | 携带 |
|---|---|---|
| 进入页面 / 切回会话 | `GET /threads/{scopeId}/messages` | — |
| 用户提问 | `POST /threads/{scopeId}/messages` | question + contextSummary（ephemeral 明细，D28） + contextOverview + timeAnchor（落库标量） + clientMessageId |
| 查看更早 / 滚动到顶部 | `GET /threads/{scopeId}/messages?before=&limit=20` | — |
| 手动清空会话 | `DELETE /threads/{scopeId}` | — |
| 业务实体被删除时自动触发 | `DELETE /threads/{scopeId}` | 前端监听实体删除事件 → 调此接口（级联清理） |

### 9.5 各页面 contextSummary（ephemeral 明细）+ contextOverview/timeAnchor（落库概览）白名单契约

**核心原则（D28 一次产出、两路分发）**：builder 单次计算同时产出——白名单明细 `data` + 单位字典 `_units` 组装为 `contextSummary` 进 Prompt（ephemeral，不落库）；其标量子集序列化为 `contextOverview`（JSON 字符串，<255 字符）与 `timeAnchor` 随请求落库，供历史卡片回放。两组字段同源，避免口径漂移。服务端对 `contextOverview` 仅作直接存储、不复用为 Prompt 素材。

| 页面 | scopeId | 期 | contextOverview 要点（标量） | timeAnchor 示例 | 特殊禁入 |
|---|---|---|---|---|---|
| 数据统计 | `statistics` | **P0** | pnl/winRate/roundCount/avgPnlPerRound | `{"asOf":...,"range":"7d"}` | — |
| 首页仪表盘 | `home` | **P0** | positionCount/marketValue/unrealizedPnl/rate | `{"asOf":...}` | — |
| 短线交易 | `t_calculator` | 二期 | tradingSession/todayBuySellCount/unmatchedPositions | `{"asOf":...,"range":"today"}` | — |
| 中长期交易 | `cost_averaging:{code}` | 二期 | recordCount/totalCost/marketValue/unrealizedPnlRate | `{"asOf":...,"range":"all"}` | — |
| 沙盘复盘 | `sandbox` | 二期 | scenarioTitle/baselineName/branchCount | `{"asOf":...}` | — |
| 涨跌幅计算器 | `change_rate` | 二期 | basePrice/changeRate/ladderStepsCount | N/A（无持久化） | — |
| 费率配置 | `fee_config` | 二期 | presetName/commissionRate/stampTax | N/A | — |
| 云端同步 | `webdav` | 二期 | configured/autoSyncEnabled/syncStatus | N/A | serverUrl/username/password |
| 批量导入 | `batch_import` | 二期 | activeSource/parsedRowCount/draftPendingCount | N/A | OCR 原始截图文本 |

**P0 试点页落库字段示意（contextOverview/timeAnchor 为 contextSummary 的标量子集；完整请求含 contextSummary，见 §9.1）：**

```json
// statistics 提问请求
{
  "question": "最近做T的胜率怎么样？",
  "sessionTitle": "数据统计",
  "clientMessageId": "01J9ZK3T8Q...ulid",
  "contextOverview": "{\"pnl\":1234.56,\"winRate\":0.62,\"roundCount\":47,\"avgPnlPerRound\":26.27}",
  "timeAnchor": "{\"asOf\":1756713600,\"range\":\"7d\"}"
}

// home 提问请求
{
  "question": "当前持仓浮动盈亏多少？",
  "sessionTitle": "首页仪表盘",
  "clientMessageId": "01J9ZK3T9R...ulid",
  "contextOverview": "{\"positionCount\":6,\"marketValue\":158234.50,\"unrealizedPnl\":-1204.00,\"unrealizedPnlRate\":-0.0075}",
  "timeAnchor": "{\"asOf\":1756713600}"
}
```

二期页面 builder 落点：纯函数统一放 `utils/copilotSnapshots.ts`（显式入参 store 切片，符合 R2）。

### 9.6 标准化错误子码（信封语义，恒 200）

**与 `/api/auth` 底座一致：HTTP 状态码恒为 200（仅未认证拦截器直写 401），业务异常全部走信封字段**——表中 413/429/503/409/404 一律是信封 `code` 字段值，**不是 HTTP 状态码**。

**v1.5（C6）**：信封新增可空 `subCode` 字段承载机器可读子码——`ApiResponse` 加 `subCode`（`@JsonInclude(NON_NULL)`，缺省时序列化形状与现状完全一致）+ `fail(code, message, subCode)` 重载；`BusinessException` 加可选 subCode 构造器；`GlobalExceptionHandler` 透传：

```json
{ "code": 429, "subCode": "RATE_LIMIT_EXCEEDED", "message": "今日 AI 调用已达上限，明日再试", "data": null }
```

| subCode | 信封 code | 含义 | 用户提示 | 前端操作 |
|---|---|---|---|---|
| `CONTEXT_TOO_LARGE` | 413 | 概览/摘要体量超限（后端兜底：overview>255 或 summary>16KB） | “当前数据量较大，请缩小时间筛选范围后再试” | 标 failed；禁用重发（同数据同样报错）；引导缩时 |
| `RATE_LIMIT_EXCEEDED` | 429 | 分钟/今日调用额度已耗尽 | “今日 AI 调用已达上限，明日再试” | 禁发送按钮 + 倒计时提示 |
| `UPSTREAM_ERROR` | 503 | 上游渠道全部故障 / 超时 / 降级模板 | “AI 服务暂不可用，请稍后重试” | 标 failed + 高亮「重发」（同 clientMessageId 幂等重试，不耗配额） |
| `ASK_IN_PROGRESS` | 409 | 同 cid 上一次提问仍在处理中（user 行 pending 且在 60s 窗口内，v1.5.1） | “上一次提问仍在处理中，请稍候” | 不标 failed；保留 pending 态；稍后可重试（窗口过后自动放行） |
| `SESSION_NOT_FOUND` | 404 | 防御性：会话在请求中途被并发软删等窄场景 | “会话已清理，请重新提问” | 本地重置线程状态后自动重试一次 |

> v1.4 已废弃 `RETRYABLE_ERROR`（504）：渠道内重试已内置于 llm 路由器，全部渠道耗尽后统一归为 `UPSTREAM_ERROR`。

前端映射约定：`UPSTREAM_ERROR` → 高亮重发（同 `clientMessageId` 幂等）；`RATE_LIMIT_EXCEEDED` → 禁发送；`CONTEXT_TOO_LARGE` → 禁重发；`ASK_IN_PROGRESS` → 提示处理中（不标 failed）；其余仅展示 UI 反馈。

## 10. 验证清单

### 10.1 前端（前端仓库，每步改码后必跑）

```sh
npx tsc --noEmit        # 零错误
npm test                # pretest 自动跑 check:arch（R1/R2/R3 + madge 循环）
npm run map:features    # copilot 关键词登记后确认「未归类」为 0
```

新增测试：`copilotSlice`（注册/注销幂等与泄漏回归（含 §5 修正场景：scope 切换后旧注册被注销）、发送乐观更新与失败态、级联清理钩子触发、deletedScopes 墓碑对账补发）；`copilotService`（mock 模式、级联清理端点、subCode 透传）。白盒用例放 `src/__tests__/`，不受分层护栏约束。

新增前端行为单测：消息卡片渲染——默认展示 contextOverview 概览 + timeAnchor 标签（D32：明细重放属 P2/V2，V1 单测仅覆盖概览渲染）。

### 10.2 后端（本仓库）

```sh
./mvnw compile -q
cat postgres/schema.sql | docker exec -i <pg容器> psql -U postgres -d stock_calculator   # 或手动执行 DDL
POSTGRES_PASS=... ./mvnw install '-Dtest=!TaskServiceTest' '-DfailIfNoTests=false'
```

新增测试：

- **llm 扩展**（mock ChatModel，禁真实 API）：多轮 Prompt 组装（system/上下文/历史交替/提问映射）、usage 提取、`chatDetailed` 容灾矩阵（429 切换、400 流转、耗尽 Fail-Safe、降级模板识别）；vision 旧链路回归（旧 `chat(String,String)` 不变）。
- **编排服务**：幂等两段式（命中归档回放 / failed 续跑且不重写 user 行 / pending 在窗 → 409 ASK_IN_PROGRESS / pending 超窗自愈续跑）、状态机翻转（归档→ok、失败收尾→failed、重试→重挂 pending）、滑动窗口条数、懒清理、context_overview/time_anchor 轻量字段落库正确性、级联软删除语义、get-or-create 并发竞态撞索引后回退复用（REQUIRES_NEW 仅回滚内部事务，主事务可正常提交）、413 兜底校验（overview>255）。
- **限流**：双窗口计数、fail-open（Redis 不可用放行）。
- **错误子码**：信封恒 200（CONTEXT_TOO_LARGE→413、RATE_LIMIT_EXCEEDED→429、UPSTREAM_ERROR→503、SESSION_NOT_FOUND→404），subCode 字段缺省时不影响既有响应形状。

### 10.3 native（P3）

```sh
POSTGRES_PASS=... bash stock-calculator-main/build-native.sh   # 全量（改 yml 后必须）
# 8s 冒烟（脚本内置）→ 90s 加长 → smoke-curl.sh 403 门禁
# 额外：带 GEMINI_API_KEY 启动二进制，真实 POST /api/copilot/threads/statistics/messages 一次
# 若真实 ask 报 usage/DTO 反射缺失：按报错类名补 gen-logger-config.py EXTRA_CLASSES
#   → --no-pkg 重建（迭代法，预留 1 轮；OCR 链路已验证 spring-ai 主路径）
# 架构迁移验证：确保 AesGcmUtil.java 已移除，无遗留 import/aes-key 引用
```

## 11. 分期任务分解（v1.5 修订）

| 期 | 任务 | 产出/验收 |
|---|---|---|
| P0 | §2 契约 + §3 service(mock) + §4 slice + §5 hook（修正版）+ §6 组件 + App 挂载 + Statistics/Home builder | tsc 零错、check:arch 过、新单测绿、mock 全链路可演示 |
| P1 | §7.1 DDL + §7.2 实体 + §7.3 仓储 + **§1.2 llm/common 扩展** + §8.1 编排 + §8.3 接入 + §8.4 Controller + CopilotRateLimiter | mvnw test 全绿（排除 TaskServiceTest）；curl 三端点走通（含级联 DELETE）；软删后旧 scopeId 可复用验证；get-or-create 竞态单测绿（REQUIRES_NEW）；幂等两段式与 pending 互斥单测绿；双渠道容灾由复用链天然具备 |
| P2 | 前后端联调（历史/翻页/级联清理触发/错误子码反馈）+ 墓碑对账补发（D29）端到端 + 明细重放纯函数占位（基于 Dexie 历史切片，可顺延 V2） | 全链路手工验收（含 entity-deletion → cascade delete、离线删除 → 墓碑补发场景）；tokens 落库核对 |
| P3 | native 全量构建 + 冒烟 + 真实 ask（含 usage 反射元数据迭代预算 1 轮）+ 隐私文案打磨 | spec §8 P3 验收标准 |

## 12. 维护约定

- 前端功能地图（skill `stock-calculator-frontend-dev` §2 表格）加 copilot 行；`scripts/feature-map.mjs` GROUPS 登记关键词（copilot/Copilot），跑一次确认未归类为 0。
- 后端 feature-index 表加 copilot 域行（子包 controller·dto·entity·repository·service·config）。
- scopeId 常量表为前后端共享协议：新增页面 = 常量表加一项 + view 注册 + 本文档 §1.1 表格加行。
- **文档链**：改行为先改 `docs/copilot-spec.md` 决策表（或 `docs/copilot-design.md` §0 C 决策），再同步本文；spec 缺失编号（D1/D3/D6/D7/D10/D14-D17/D21-D27）待原稿补录。
- scopeId 格式变更 → 所有视图注册时动态拼接实体主键；新表按新格式创建，软删后索引自动释放旧条目。
- v1.2 架构迁移遗留：移除 AES / encryptedContext / contextCtime / AesGcmUtil.java——任何遗留导入或引用需全部清理；context_overview/time_anchor/deleted_at 为新增必填字段。
