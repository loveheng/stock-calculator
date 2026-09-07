# Context-Aware Copilot · 开发实施文档

> 版本：定稿 v1.4（2026-09-02，与 `copilot-spec.md` v1.4 决策记录一一对应；纠正 v1.3 传输/存储混淆：恢复 ephemeral contextSummary + 新增墓碑对账/竞态防御/级联触发白名单/实体键命名空间规范）
> 范围：前端契约/状态/服务/UI 落点与骨架、后端领域包/表结构/编排/容灾实现要点、API 契约、验证清单
> 关联：`docs/copilot-spec.md`（设计决策 D1-D32）、`docs/e2ee-auth-spec.md`（鉴权）、skill `cls-article-patterns`（后端编码模板）
> 状态：待 P0 开发启动

---

## 0. 前置事实（技术栈基线与环境约束）

| 项 | 事实 |
|---|---|
| 前端 | React 19 + zustand 5（slices 模式）+ react-router-dom 7 + Dexie 4.4 + Tailwind 3.4 + TypeScript + Vite + vitest（基线 472/472） |
| 后端 | stock-calculator-service：Spring Boot 4.1.1 + Java 21 + Jakarta + PostgreSQL + Spring Data JPA（Hibernate），Maven Wrapper，单模块 `stock-calculator-main` |
| 鉴权 | 前端 `services/apiClient.ts` 走 Spring Boot `:18080/api/auth`，Bearer 注入 + 恒 200 信封（code 分支）+ 拦截器 401 例外；Copilot 复用同一底座与令牌 |
| 前端执行环境 | 仓库根 `stock-calculator/`；验证命令 `npx tsc --noEmit` / `npm test`（pretest 自动跑 `check:arch`） |
| 后端执行环境 | **不在当前工作区**，需切换到 stock-calculator-service 工作区；`./mvnw test '-Dtest=!TaskServiceTest' '-DfailIfNoTests=false'`（TaskServiceTest 打真实 API 必挂） |
| native | 后端新代码全部进 native 二进制；yml 改动 = 全量重建（10-15 分钟/轮）；LLM 复用 spring-ai-openai（D11 v1.1 修订），首次真实调用可能需补 DTO 反射元数据（迭代法，P3 预留预算） |
| 写入约束 | 终端命令禁含 `${...}`；单次写入过长会被截断，大文件分段写 |

---

## 1. 文件清单与分层落点

### 1.1 前端（本仓库 `stock-calculator/`）

| 文件 | 层 | 职责 | 分层护栏 |
|---|---|---|---|
| `src/types/domain.ts` | types | 追加：`CopilotMessage` / `PageContextSnapshot` / `ContextBlockSnapshot` / `COPILOT_SCOPES` 常量表 | R3 零依赖叶子 |
| `src/services/copilotService.ts` | services | 3 端点封装（复用 apiClient 底座）+ 体积护栏（ephemeral 明细 12KB，D28）+ ulid 生成 + 级联清理钩子 | 可 import db（推荐动态）、types；禁 store |
| `src/store/slices/copilotSlice.ts` | store | 注册表 / threads / 发送 / 翻页 / 清空 / consent / 明细重放元数据 | 可 import db、services、types |
| `src/store/types.ts` + `src/store/index.ts` | store | `AppStoreActions` 增签名 + slices 组装 | — |
| `src/hooks/usePageContext.ts` | hooks | 页面注册 hook（mount 注册 / unmount 注销） | 可 import store |
| `src/components/copilot/GlobalCopilot.tsx` | components | 浮窗 UI（胶囊/预览/列表/输入/同意弹窗/登录引导） | 禁 import db（R1），走 store/hooks |
| `src/App.tsx` | views | `AppLayout` 挂载 `<GlobalCopilot />` | — |
| `src/views/Statistics.tsx`、`src/views/Home.tsx` | views | P0 试点：`usePageContext({ scopeId, title, getData })` | 禁 db |

依赖方向单向：`types ← utils/services ← store ← hooks ← views/components`，R1/R2/R3 全部满足。

### 1.2 后端（stock-calculator-service，需切工作区）

```
stock-calculator-main/src/main/java/com/zzh/stock_calculator/copilot/
├── controller/CopilotController.java        # 3 端点，恒 200 信封
├── dto/CopilotDtos.java                     # AskRequest / AskResponse / ThreadPageResponse（record 或 Lombok 三件套，随域内现状）
├── entity/AiChatSession.java
├── entity/AiChatMessage.java
├── repository/AiChatSessionRepository.java
├── repository/AiChatMessageRepository.java
├── service/AiChatOrchestrationService.java  # 编排（spec §6 时序）
├── service/LlmChainRouter.java              # 容灾路由（D11 修订/D12）
├── service/LlmChannelClient.java            # 单渠道 OpenAiChatModel 封装（Gemini/Groq，yml 参数化）
├── config/CopilotLlmConfig.java             # 手动构造各渠道 OpenAiChatModel（消费 CopilotProperties）

```

- Modulith 边界：copilot 只引用 `common` 基包（`ApiResponse`/`BusinessException`）与 auth 基包公开的认证上下文取法；**不 import 任何域的子包**（`ModulithVerifyTest` 守护）。
- 表结构落仓库根 `postgres/schema.sql`（feature-index 变更落点顺序）。
- 新增领域按 feature-index 约定登记。

## 2. 前端契约（`types/domain.ts` 追加，R3 零依赖）

```typescript
#### fix ① scopeId 格式约定：`页面[:实体主键]`

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
 *  实体主键 = 页面上**可切换的顶级业务实体 Key**：
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
  getData: () => Record<string, unknown>; // 命令式快照（铁律①②）
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

1. **底座复用**：从 `apiClient.ts` 抽出泛化的 `requestJson(baseUrl, path, init)`（恒 200 信封解析 + Bearer 注入 + 超时 + 统一错误类型），auth 与 copilot 共用；copilot 侧超时 **60_000ms**（D13）。
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
  deletedScopes: string[];                       // 墓碑集合（D29，localStorage 持久化）：离线级联删除失败待补发的 scopeId
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
| `registerContext(ctx)` | 写 registry + 置 `activeScopeId`；同 scope 重复注册幂等覆盖（React StrictMode 双挂载安全） |
| `unregisterContext(scopeId, owner)` | 仅当 `registry[scopeId].owner === owner` 才移除，防误删后注册者 |
| `ensureThreadLoaded(scopeId)` | **墓碑对账（D29）**：scopeId ∈ deletedScopes → 拦截加载，先补发 `DELETE /threads/{scopeId}`，成功后注销墓碑再正常拉取（补发仍失败则保留墓碑下次重试）；无墓碑时同前——有缓存跳过，否则拉尾部 20 条**整段替换**（D8） |
| `sendMessage(question)` | 读 `activeScopeId` → registry.getData() → 护栏 → 乐观追加 pending 态 → POST（携带 ephemeral contextSummary + 落库用 overview/anchor）；成功归位 + 追加 assistant；失败标 `failed`（保留重发）；**sending 锁防重复提交** |
| `resendMessage(clientMessageId)` | 失败重发，同 clientMessageId（服务端幂等，D9） |
| `loadOlder(scopeId)` | keyset 向前翻页，追加头部 |
| `clearCurrentThread()` | ConfirmModal 确认后 DELETE + 清本地（D18）；**DELETE 失败（离线）→ 写入 deletedScopes 墓碑（D29），下次激活补发** |
| `purgeScopeOnEntityDelete(scopeId)` | 业务实体删除钩子（触发源白名单 D31，见 §9.3）：DELETE + 清本地 threads/meta 缓存；失败写墓碑 |
| `setPanelOpen / grantConsent / declineConsent` | UI 态 |

### 4.3 发送时序（slice 内部约定）

```
sending=true → snapshot = registry[active].getData()
             → guarded = applySizeGuard(snapshot)      // ephemeral 明细 12KB 护栏（D28）
             → cid = newClientMessageId()
             → 乐观 append {role:'user', content:question, id:null, status:'pending'}
             → service.sendQuestion(...)   // 60s 超时；payload = contextSummary(ephemeral) + contextOverview/timeAnchor(落库)
             ├─ ok:    user 消息归位(ok, id 回填) + append assistant(ok) + tokens 落 meta
             └─ fail:  user 消息标 failed（内容保留，可重发）
             → sending=false（finally）
```

## 5. `hooks/usePageContext.ts`

```typescript
/**
 * 页面上下文注册 hook：视图挂载时注册自身快照，卸载时注销。
 * 铁律①：getData 必须是命令式快照，请传 () => build(getState()) 形态。
 */
export function usePageContext(snapshot: PageContextSnapshot): void {
  const ownerRef = useRef<PageContextSnapshot>(snapshot);
  ownerRef.current = snapshot;

  const registerContext = useAppStore((s) => s.registerContext);
  const unregisterContext = useAppStore((s) => s.unregisterContext);

  useEffect(() => {
    registerContext({ ...snapshot, getData: ownerRef.current.getData });
    return () => unregisterContext(snapshot.scopeId, ownerRef.current);
  }, [snapshot.scopeId]);  // 仅 scopeId 变化触发重注册
}
```

- 注册即置 `activeScopeId`（路由切换 = 旧视图卸载 + 新视图挂载，状态机自动流转）。
- StrictMode 下双挂载：注册幂等覆盖，注销按 owner 引用比对（slice 动作已约定，§4.2）。

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
      <ContextCapsule />      {/* 📎 已关联: {title} · 点开预览字段 · 返回整页(V2) */}
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
| 离线 | `navigator.onLine` + 发送失败分类 | 提示「AI 助手需要网络」；DELETE 失败 → 写 `deletedScopes` 墓碑（D29），恢复联网后由 ensureThreadLoaded 自动补发 |

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
    // 白名单外字段一律不出现——serialize 整页 state 是禁止行为
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

**快照铁律（v1.4 / D28 一次产出、两路分发）**：
1. **落库路（标量）**：`contextOverview` 仅标量（数字/字符串），<255 字符，严禁明细数组——供历史卡片回放。
2. **Prompt 路（ephemeral 明细）**：`contextSummary.data` 可含白名单明细行（如最近 N 笔轮次），经 `applySizeGuard ≤12KB` 护栏，仅内存组装 Prompt、不落库不打日志。
3. 两路同源一次计算，严禁口径漂移；历史明细回放仍通过 `time_anchor` 从 Dexie 重算（P2/V2，D32）。

## 7. 后端：表结构与持久化层

### 7.1 `postgres/schema.sql` 追加（仓库根，变更落点顺序）

```sql
-- v1.2：移除加密管线，改用轻量持久化（context_overview + time_anchor）+ 级联生命周期
-- 会话表：仅存储元数据，不存完整快照
CREATE TABLE IF NOT EXISTS ai_chat_session (
    id                BIGSERIAL PRIMARY KEY,
    user_id           VARCHAR(64)  NOT NULL,
    scope_id          VARCHAR(100) NOT NULL,       -- 页面级（statistics）或 页面:实体ID（cost_averaging:600519）
    title             VARCHAR(100) NOT NULL,
    last_message_at   BIGINT,                      -- 最后一次互动时间戳（秒）
    ctime             BIGINT       NOT NULL,       -- 创建时间（秒）
    deleted_at        BIGINT       DEFAULT 0       -- 软删除标记（0:未删，>0:删除时间戳）
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_chat_session_user_scope
    ON ai_chat_session(user_id, scope_id) WHERE deleted_at = 0;

-- 消息表：每条消息独立携带轻量概览与时间锚点，支持无原始快照的回放
CREATE TABLE IF NOT EXISTS ai_chat_message (
    id                BIGSERIAL PRIMARY KEY,
    session_id        BIGINT       NOT NULL,
    role              VARCHAR(10)  NOT NULL,       -- 'user' | 'assistant'
    content           TEXT         NOT NULL,
    client_message_id VARCHAR(40),                 -- ulid，幂等
    status            VARCHAR(20)  DEFAULT 'ok',   -- 'ok' | 'failed' | 'pending'
    context_overview  VARCHAR(255),                 -- 极简指标 JSON（标量，无明细数组）{"pnl":1234.5,"winRate":0.62}
    time_anchor       VARCHAR(100),                 -- 时间截面标记 JSON（{"asOf":1756713600,"range":"7d"}）
    channel           VARCHAR(30),                 -- 'gemini' | 'groq'
    model             VARCHAR(50),
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    ctime             BIGINT       NOT NULL,
    deleted_at        BIGINT       DEFAULT 0       -- 级联软删除标记（父级 session 软删时同步更新）
);
-- 幂等索引：仅约束非 null 且未软删的行（软删后同 client_message_id 可重发，改动点⑦）
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_chat_message_client_id
    ON ai_chat_message(client_message_id) WHERE client_message_id IS NOT NULL AND deleted_at = 0;
-- 分页/滑动窗口查询索引
CREATE INDEX IF NOT EXISTS idx_ai_chat_message_session_id
    ON ai_chat_message(session_id, id DESC) WHERE deleted_at = 0;
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

// AiChatMessage：轻量持久化（v1.2）
// context_overview = 提问时核心标量概览（JSON 字符串，<255 字符）
// time_anchor = 时间截面标记（{"asOf":epochSec,"range":"7d"} 等）
// deleted_at = 级联软删除标记，session 被删时同步设为当前时间戳
- native 注意：实体 id 数组（`Long[]` 等）已由 `gen-logger-config.py` EXTRA_CLASSES 覆盖，无需手工登记。

### 7.3 Repository（keyset 查询，排序按 id 不按 created_at）

```java
public interface AiChatSessionRepository extends JpaRepository<AiChatSession, Long> {
    // 仅查活跃 session（排除 deletedAt > 0 的记录）
    @Query("SELECT s FROM AiChatSession s WHERE s.userId = :uid AND s.scopeId = :sid AND s.deletedAt = 0")
    Optional<AiChatSession> findActiveByUserIdAndScopeId(@Param("uid") String uid, @Param("sid") String sid);
    @Query("SELECT COUNT(s) > 0 FROM AiChatSession s WHERE s.userId = :uid AND s.scopeId = :sid AND s.deletedAt = 0")
    boolean existsActiveByUserIdAndScopeId(@Param("uid") String uid, @Param("sid") String sid);
    long countByUserIdAndDeletedAtGreaterThan(@Param("uid") String uid, @Param("d") Long d);
    // 级联清理：查找某 scopeId 下所有已软删的 session（用于清理入口扫描）
    @Query("SELECT s.id FROM AiChatSession s WHERE s.userId = :uid AND s.scopeId = :sid AND s.deletedAt > 0")
    List<Long> findDeletedSessionIdsByUserIdAndScopeId(@Param("uid") String uid, @Param("sid") String sid);
}

public interface AiChatMessageRepository extends JpaRepository<AiChatMessage, Long> {
    // 滑动窗口：最近 window-rounds*2=6 条（排除已软删，倒序取后反转正序返回）
    List<AiChatMessage> findFirst6BySessionIdAndDeletedAtOrderByIdDesc(
            Long sessionId);
    // keyset 翻页：id < before 的前 limit 条（排除已软删）
    @Query(value = "SELECT * FROM ai_chat_message WHERE session_id = :sessionId " +
                   "AND id < :before AND deleted_at = 0 ORDER BY id DESC LIMIT :limit", nativeQuery = true)
    List<AiChatMessage> findBeforeKeyset(@Param("sessionId") Long sessionId,
                                          @Param("before") Long before,
                                          @Param("limit") int limit);
    // 幂等检查
    Optional<AiChatMessage> findByClientMessageIdAndDeletedAt(String clientMessageId);
    // 懒清理：删除最旧的超出容量部分
    @Modifying
    @Query("UPDATE AiChatMessage m SET m.deletedAt = :now WHERE m.id IN " +
           "(SELECT m2.id FROM AiChatMessage m2 WHERE m2.sessionId = :sessionId " +
           "ORDER BY m2.id ASC LIMIT :overflow)")
    int softDeleteOverflow(@Param("sessionId") Long sessionId,
                           @Param("now") Long now,
                           @Param("overflow") int overflow);
    // 级联软删除：当 session 被软删时，将关联 messages 也标记 deleted_at
    @Modifying
    @Query("UPDATE AiChatMessage m SET m.deletedAt = :now WHERE m.sessionId = :sessionId AND m.deletedAt = 0")
    int cascadeDeleteBySessionId(@Param("sessionId") Long sessionId, @Param("now") Long now);
    long countBySessionIdAndDeletedAt(Long sessionId, Long deletedAt);
}
```

## 8. 后端：编排与容灾路由

### 8.1 `service/AiChatOrchestrationService.java`（@Transactional 编排，流程 = spec §6.1 时序）

```java
@Slf4j @Service @RequiredArgsConstructor
public class AiChatOrchestrationService {
    private final AiChatSessionRepository sessionRepository;
    private final AiChatMessageRepository messageRepository;
    private final LlmChainRouter llmChainRouter;
    private final CopilotRateLimiter rateLimiter;
    // CopilotProperties: window-rounds / max-messages（@ConfigurationProperties）

/** v1.2：移除 AES 加解密管线；context_overview/time_anchor 直接落库；新增级联生命周期 */
public AskResponse ask(String userId, String scopeId, AskRequest req) {
    // 1. 限流检查（同前）
    // 2. 幂等：findByClientMessageIdAndDeletedAt(req.clientMessageId) 命中 → 返回已归档回复
    // 3. 获取或创建 session：findActiveByUserIdAndScopeId → 不存在则新建（ctime=nowSec()）
    //    并发防御（改动点②）：双端/双 Tab 同时首发撞 uq_ai_chat_session_user_scope 时
    //    catch DataIntegrityViolationException → 回退重查 findActiveByUserIdAndScopeId 复用既有 session，避免 500
    // 4. 写 user message：存入 context_overview + time_anchor（轻量，不加密）
    // 5. 懒清理：countBySessionIdAndDeletedAt(count, 0) > max-messages → softDeleteOverflow()
    // 6. 滑动窗口：findFirst6BySessionIdAndDeletedAtOrderByIdDesc → 反转得到正序
    // 7. 组装 Prompt：system(词典+声明) + contextSummary 完整白名单明细（ephemeral，D28） + 历史纯文本交替 + 提问
    try {
        // 8. LLM 调用在事务外（长调用不占数据库连接）
        LlmResult result = llmChainRouter.route(messages);
        // 9. 归档 assistant message（status='ok', channel, model, tokens）
        AiChatMessage assistant = AiChatMessage.builder()
                .sessionId(session.getId())
                .role("assistant")
                .content(result.content())
                .status("ok")
                .channel(result.channel())
                .model(result.model())
                .promptTokens(result.promptTokens())
                .completionTokens(result.completionTokens())
                .ctime(nowSec())
                .build();
        messageRepository.save(assistant);
        // 同步更新会话 last_message_at
        session.setLastMessageAt(nowSec());
        sessionRepository.save(session);
        return toAskResponse(userMsg.getId(), assistant.getId(), result);
    } catch (RetryableLlmException e) {
        // 路由已耗尽所有渠道 → UPSTREAM_ERROR
        throw new BusinessException(503, "AI 服务暂不可用", "UPSTREAM_ERROR");
    }
}

/** 级联软删除：当业务实体被删除时，清理对应的 Copilot 会话及所有消息（触发源白名单见 §9.3 / D31） */
@Transactional
public void cascadeDeleteByScopeId(String userId, String scopeId) {
    // 1. 软删 session
    Optional<AiChatSession> sessionOpt = sessionRepository.findActiveByUserIdAndScopeId(userId, scopeId);
    if (sessionOpt.isPresent()) {
        AiChatSession session = sessionOpt.get();
        session.setDeletedAt(nowSec());
        sessionRepository.save(session);
        // 2. 级联软删该 session 下的所有 message
        messageRepository.cascadeDeleteBySessionId(session.getId(), nowSec());
    }
}
```

- 日级限流如 auth 域现无实现，在 `copilot/util` 补内存计数器（重启重置可接受），键 `userId`，双窗口。
- 4 步与 5 步同事务；8 步 LLM 调用在事务外（长调用不占连接）——先提交 1-6，调用后开新事务写 9（7 为纯内存组装）。
- **get-or-create 并发防御（改动点②）**：双端或双 Tab 同时首发提问 → 撞 `uq_ai_chat_session_user_scope` 抛 `DataIntegrityViolationException` → catch 后回退重查 `findActiveByUserIdAndScopeId` 复用既有 session，对用户恒为 200。
- contextSummary 全程仅在内存组装 Prompt，**不落库、不打日志**（ephemeral，D28）；落库仅为 User 消息行的 context_overview/time_anchor。

### 8.3 `service/LlmChainRouter.java` + `LlmChannelClient.java`（复用 spring-ai-openai，D11 v1.1 修订/D12）

```java
// 渠道构造（copilot/config/CopilotLlmConfig）：按 copilot.llm.* 自有属性手动构造两个 OpenAiChatModel
//   OpenAiApi api = OpenAiApi.builder().baseUrl(ch.baseUrl()).apiKey(ch.apiKey()).build();
//   OpenAiChatModel model = OpenAiChatModel.builder().openAiApi(api)
//           .defaultOptions(OpenAiChatOptions.builder().model(ch.model()).build()).build();
//   注意：不复用 spring.ai.openai auto-config 单例——那是 vision OCR 的调优配置，跨域耦合

// 单渠道调用：chatModel.call(new Prompt(...)) → ChatResponse
//   文本：response.getResult().getOutput().getText()
//   tokens：response.getMetadata().getUsage().getPromptTokens()/getCompletionTokens()
//   （API 方法名以项目实际 Spring AI 版本与 vision 域既有用法为准）
// 消息构造：SystemMessage / UserMessage / AssistantMessage —— 与 spec §6.2 分层一一对应
// 超时：copilot.llm.timeout-ms=60000（经 OpenAiApi 的 RestClient/WebClient 定制，随 vision 既有模式）

// 错误分类：按调用异常携带的 HTTP 状态判定——429/5xx/IO 超时 → RetryableLlmException；400/401 → FatalLlmException
// （异常类型以 vision 域既有处理为准，如 NonTransientAiException.getStatusCode()）

// 路由：List<LlmChannelClient> 依序尝试；Retryable → 切下一个；Fatal → 直接失败；
//       耗尽 → BusinessException(502, "AI 服务暂不可用，请稍后重试")
```

- **native 已知代价**（替代原“零反射”结论）：spring-ai-openai 的请求/响应 DTO 不带 native 元数据，首次真实 LLM 调用可能报反射缺失（vision OCR 同款已知残留缺口）——按报错类名补 `gen-logger-config.py` EXTRA_CLASSES → `--no-pkg` 重建迭代；P3 预留 1-2 轮构建预算。
- 收益：pom 零新增、消息类型与 Prompt 分层天然对齐、与 vision 同栈可复用既有异常/超时处理经验。

### 8.4 `controller/CopilotController.java` + `application.yml`

```java
@RestController @RequestMapping("/api/copilot") @RequiredArgsConstructor
public class CopilotController {
    // POST   /threads/{scopeId}/messages   → ApiResponse<AskResponse>（userId 取法与 auth 域控制器一致）
    // GET    /threads/{scopeId}/messages?before=&limit=20 → ApiResponse<ThreadPageResponse>
    // DELETE /threads/{scopeId}            → ApiResponse<Void>（级联软删：session + 所有 messages 标记 deleted_at = nowSec()；同 scopeId 可复用）
}
```

```yaml
copilot:
  llm:
    timeout-ms: 60000
    gemini: { base-url: "https://generativelanguage.googleapis.com/v1beta/openai",
              api-key: "${GEMINI_API_KEY:}", model: "<以实际配置为准>" }
    groq:   { base-url: "https://api.groq.com/openai/v1",
              api-key: "${GROQ_API_KEY:}", model: "<以实际配置为准>" }
  rate-limit: { per-minute: 10, per-day: 100 }
  history: { window-rounds: 3, max-messages: 200 }
```

以上属性由 `CopilotProperties` 消费，用于**手动构造**各渠道 `OpenAiChatModel`（§8.3）；不触碰 `spring.ai.openai.*` 既有配置，避免与 vision 的 OCR 调优漂移耦合。

## 9. API 契约（3 端点，信封语义与 `/api/auth` 一致：恒 200 + code 分支，未认证拦截器直写 401）

### 9.1 POST `/api/copilot/threads/{scopeId}/messages`

**v1.4 纠偏（D28 传输/存储分离）**：请求同时携带两组语义不同的字段——`contextSummary`（ephemeral 阅后即焚：当前屏幕白名单明细 + 单位字典，仅在内存组装 Prompt，不落库不打日志）与 `contextOverview`/`timeAnchor`（落库概览，供历史卡片回放）。v1.3 曾把“存储不落库”误扩大为“传输不携带”，导致 LLM 失去完整明细输入，本轮恢复传输期瞬时上下文。

```json
// Request
defineRequest({
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
})

// Response data
{ "assistantMessageId": 9102, "content": "…纯文本回答…",
  "promptTokens": 852, "completionTokens": 418, "channel": "gemini",
  "userMessageId": 9101, "userContextOverview": "{\"pnl\":1234.56,…}",
  "userTimeAnchor": "{\"asOf\":1756713600,…}", "ctime": 1756713601 }
```

- `scopeId` 含 `:`（如 `cost_averaging:600519`）在 path 段合法（RFC 3986 pchar），前端仍建议 `encodeURIComponent`。
- 幂等：同 `clientMessageId` 重发 → 返回已归档回复（不重复调 LLM、不双写）。
- 超限/渠道耗尽 → 恒 200 信封 `ApiResponse.fail(...)`（见 §9.6），前端标 `failed` 可重发。
- **持久化边界（D28）**：仅 `contextOverview`/`timeAnchor` 写入 ai_chat_message（User 行）；`contextSummary` 为 ephemeral——不落库、不打日志、响应后即释放。
- **context_overview 仅 User 消息行记录**，Assistant 消息无此字段。

### 9.2 GET `/api/copilot/threads/{scopeId}/messages?before=&limit=20`

```json
// Response data（keyset：id < before 的前 limit 条，倒序取出后正序返回）
{ "sessionId": 12, "scopeId": "statistics", "title": "数据统计",
  "messages": [
    { "id": 9098, "role": "user", "content": "…",
      "contextOverview": "{\"pnl\":1234.56,\"winRate\":0.62}",
      "timeAnchor": "{\"asOf\":1756710000,\"range\":\"7d\"}",
      "clientMessageId": "…", "ctime": 1756710000 }
  ],
  "hasMore": true, "oldestId": 9098 }
```

- 首次拉取不传 `before` → 取尾部 limit 条。
- **历史卡片渲染（D32，V1 降级）**：仅展示 `contextOverview` 概览 + `timeAnchor` 标签（如「7 天前快照」）；基于 `timeAnchor` 的 Dexie 明细重放为 P2/V2 任务（见 §11），V1 不交付「展开明细」。
- 已软删的消息不在响应中。

### 9.3 DELETE `/api/copilot/threads/{scopeId}`（级联生命周期）

**v1.2 新增级联软删除**：
1. 将对应 `ai_chat_session.deleted_at` 设为当前时间戳秒
2. 级联将该 session 下所有 `ai_chat_message.deleted_at` 设为当前时间戳秒
3. **不清除 content / context_overview**——保留排障追溯能力
4. 同 `(user_id, scope_id)` 可复用唯一索引创建新会话

Response：`ApiResponse<Void>`。

前端调用此接口由业务实体删除事件自动触发，或用户手动清空会话时经 ConfirmModal 二次确认（D18）。

**级联清理触发源白名单（D31）**——仅以下三类事件触发 DELETE，其余一律不触发：

| 触发源 | 清理目标 scopeId | 说明 |
|---|---|---|
| 持仓管理删除某标的 | `cost_averaging:{symbol}` | 该标的全部 Copilot 会话级联软删 |
| 做T记录删除某标的 / 清空流水 | `t_calculator:{symbol}` | 按标的清理；清空流水时逐标的批量调用 |
| 全局重置 / 一键清库 | 全量 | 前端按已知 scopeId 集合批量循环调用（预留后端全量清理端点） |

- **不触发清单**：卖出/清仓/归档/批次合并等正常业务生命周期动作一律不触发级联删除（历史会话仍可作复盘资料）。
- **墓碑补发（D29）**：弱网/离线删除时 DELETE 可能未送达——前端本地持久化 `deletedScopes` 墓碑集合，下次 `ensureThreadLoaded` 命中墓碑时拦截历史加载并补发 DELETE，成功后注销墓碑，防止旧历史“复活”。

### 9.4 页面 × 接口调用矩阵（所有页面一致）

9 个页面**共用同一套 3 个端点**，页面差异只体现在 `scopeId` 和轻量级元数据内容，后端不为任何页面单开接口：

| 时机 | 调用 | 携带 |
|---|---|---|
| 进入页面 / 切回会话 | `GET /threads/{scopeId}/messages` | — |
| 用户提问 | `POST /threads/{scopeId}/messages` | question + contextSummary（ephemeral 明细，D28） + **contextOverview + timeAnchor**（落库标量，见 §9.5） + clientMessageId |
| 查看更早 / 滚动到顶部 | `GET /threads/{scopeId}/messages?before=&limit=20` | — |
| 手动清空会话 | `DELETE /threads/{scopeId}` | — |
| **业务实体被删除时自动触发** | `DELETE /threads/{scopeId}` | 前端监听实体删除事件 → 调此接口（级联清理） |

### 9.5 各页面 contextSummary（ephemeral 明细）+ contextOverview/timeAnchor（落库概览）白名单契约

**核心原则（v1.4 / D28 一次产出、两路分发）**：builder 单次计算同时产出——白名单明细 `data` + 单位字典 `_units` 组装为 `contextSummary` 进 Prompt（ephemeral，不落库）；其标量子集序列化为 `contextOverview`（JSON 字符串，<255 字符）与 `timeAnchor`（时间截面标记）随请求落库，供历史卡片回放。两组字段同源，避免口径漂移。

**落库字段示意（`contextSummary` 完整请求结构见 §9.1）：**

```json
{
  "question":      "最近做T的胜率怎么样？",
  "sessionTitle":  "数据统计",
  "clientMessageId": "01J9ZK3T8Q...ulid",
  "contextOverview": "{\"pnl\":1234.56,\"winRate\":0.62,\"roundCount\":47}",
  "timeAnchor":    "{\"asOf\":1756713600,\"range\":\"7d\"}"
}
```

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

**二期页面契约要点**（builder 一次产出两路分发，详见 §6b 快照铁律：落库路仅标量，Prompt 路白名单明细 ephemeral）。
builder 落点：纯函数统一放 `utils/copilotSnapshots.ts`（显式入参 store 切片，符合 R2）。服务端对 `contextOverview` 仅作直接存储、不复用为 Prompt 素材——Prompt 明细来自请求携带的 `contextSummary`（ephemeral，见 §9.1）。

### 9.6 标准化错误子码（FIX ⑤：交互闭环，恒 200 信封）

**与 `/api/auth` 底座一致：HTTP 状态码恒为 200（仅未认证拦截器直写 401），业务异常全部走信封字段**——v1.3 表中的 413/429/503/504 一律是信封 `code` 字段值，**不是 HTTP 状态码**：

```json
{ "code": 429, "subCode": "RATE_LIMIT_EXCEEDED", "message": "今日 AI 调用已达上限，明日再试", "data": null }
```

| subCode | 信封 code | 含义 | 用户提示 | 前端操作 |
|---|---|---|---|---|
| `CONTEXT_TOO_LARGE` | 413 | 摘要体量超过 LLM 输入上限 | “当前数据量较大，请缩小时间筛选范围后再试” | 标 failed；禁用重发（同数据同样报错）；引导缩时 |
| `RATE_LIMIT_EXCEEDED` | 429 | 今日调用额度已耗尽 | “今日 AI 调用已达上限，明日再试” | 禁发送按钮 + 倒计时提示 |
| `UPSTREAM_ERROR` | 503 | 上游渠道全部故障 / 超时 / IO 异常 | “AI 服务暂不可用，请稍后重试” | 标 failed + 高亮「重发」（同 clientMessageId 幂等重试） |
| `SESSION_NOT_FOUND` | 404 | scopeId 无有效会话（如墓碑未对账完成即提问） | “会话已清理，请重新提问” | 本地重置线程状态后自动重试一次 |

> **v1.4 废弃 `RETRYABLE_ERROR`（改动点⑤）**：v1.3 将“可重试超时”单列为 504 子码，与 `UPSTREAM_ERROR` 语义重叠且易被误读为 HTTP 状态码。现并入 `UPSTREAM_ERROR`——路由器已内置渠道内重试，全部渠道耗尽后统一归为上游故障。

前端映射约定：`UPSTREAM_ERROR` → 高亮重发（同 `clientMessageId` 幂等）；`RATE_LIMIT_EXCEEDED` → 禁发送；其余子码仅展示 UI 反馈。

### 10. 验证清单

### 10.1 前端（本仓库，每步改码后必跑）

```sh
npx tsc --noEmit        # 零错误
npm test                # pretest 自动跑 check:arch（R1/R2/R3 + madge 循环）
npm run map:features    # copilot 关键词登记后确认「未归类」为 0
```

新增测试：`copilotSlice`（注册/注销幂等、发送乐观更新与失败态、级联清理钩子触发、deletedScopes 墓碑对账补发）；`copilotService`（mock 模式、级联清理端点）。白盒用例放 `src/__tests__/`，不受分层护栏约束。
新增前端行为单测：消息卡片渲染——默认展示 contextOverview 概览 + timeAnchor 标签（D32：明细重放属 P2/V2，V1 单测仅覆盖概览渲染，不测「展开明细」）。

### 10.2 后端（需切到 stock-calculator-service 工作区）

```sh
./mvnw compile -q
cat postgres/schema.sql | docker exec -i <pg容器> psql -U postgres -d stock_calculator   # 或手动执行 DDL
POSTGRES_PASS=... ./mvnw install '-Dtest=!TaskServiceTest' '-DfailIfNoTests=false'
```

新增测试：容灾矩阵（mock 两个 ChatModel 实例：429 切换、400 直接失败、耗尽 Fail-Safe）；编排服务（幂等命中、滑动窗口条数、懒清理、context_overview/time_anchor 轻量字段落库正确性、级联软删除 cascadeDeleteByScopeId 语义、get-or-create 并发竞态撞索引后回退复用既有 session）；错误子码（信封恒 200：CONTEXT_TOO_LARGE→code 413、RATE_LIMIT_EXCEEDED→code 429、UPSTREAM_ERROR→code 503、SESSION_NOT_FOUND→code 404）——LLM 一律 mock ChatModel 接口，禁止打真实 API。

### 10.3 native（P3）

```sh
POSTGRES_PASS=... bash stock-calculator-main/build-native.sh   # 全量（改 yml 后必须）
# 8s 冒烟（脚本内置）→ 90s 加长 → smoke-curl.sh 403 门禁
# 额外：带 GEMINI_API_KEY 启动二进制，真实 POST /api/copilot/threads/statistics/messages 一次
# 若真实 ask 报 spring-ai DTO 反射缺失：按报错类名补 gen-logger-config.py EXTRA_CLASSES
#   → --no-pkg 重建（迭代法，预留 1-2 轮）
# 架构迁移验证：确保 AesGcmUtil.java 已移除，无遗留 import/aes-key 引用
```

## 11. 分期任务分解

| 期 | 任务 | 产出/验收 |
|---|---|---|
| P0 | §2 契约 + §3 service(mock) + §4 slice + §5 hook + §6 组件 + App 挂载 + Statistics/Home builder | tsc 零错、check:arch 过、新单测绿、mock 全链路可演示 |
| P1 | 后端 §7.1 DDL + §7.2 实体 + §7.3 仓储 + §8.2 编排(Gemini 单渠道) + §8.4 Controller | mvnw test 全绿（排除 TaskServiceTest）；curl 三端点走通（含级联 DELETE）；软删后旧 scopeId 可复用验证；get-or-create 并发竞态单测绿 |
| P2 | §8.3 Groq + 容灾 + 分页/清空/懒清理/限流/tokens 落库 + 前端联调（历史/翻页/级联清理触发/错误子码反馈）+ 墓碑对账补发（D29）+ 明细重放纯函数（基于 Dexie 历史切片，可顺延 V2） | 容灾矩阵单测覆盖；全链路手工验收（含 entity-deletion → cascade delete 端到端场景、离线删除 → 墓碑补发场景） |
| P3 | native 全量构建 + 冒烟 + 真实 ask（含 spring-ai DTO 元数据迭代预算）+ 隐私文案打磨 | spec §8 P3 验收标准 |

## 12. 维护约定

- 前端功能地图（skill `stock-calculator-frontend-dev` §2 表格）加 copilot 行；`scripts/feature-map.mjs` GROUPS 登记关键词（copilot/Copilot），跑一次确认未归类为 0。
- 后端 feature-index 表加 copilot 域行（子包 controller·dto·entity·repository·service·util）。
- scopeId 常量表为前后端共享协议：新增页面 = 常量表加一项 + view 注册 + 本文档 §1.1 表格加行。
- 本文档与 spec 的 D1-D32 决策一一对应；改行为先改 spec 决策表，再同步实现文档。
- scopeId 格式变更（`页面[:实体主键]`）→ 所有视图注册时动态拼接实体主键；新表按新格式创建，软删后索引自动释放旧条目。
- v1.2 架构迁移：移除 AES / encryptedContext / contextCtime / AesGcmUtil.java —— 任何遗留导入或引用需全部清理；context_overview/time_anchor/deleted_at 为新增必填字段。
