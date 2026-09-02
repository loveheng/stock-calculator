# Context-Aware Copilot · 开发实施文档

> 版本：定稿 v1.0（2026-09-01，与 `copilot-spec.md` v1.0 决策记录一一对应）
> 范围：前端契约/状态/服务/UI 落点与骨架、后端领域包/表结构/编排/容灾实现要点、API 契约、验证清单
> 关联：`docs/copilot-spec.md`（设计决策 D1-D21）、`docs/e2ee-auth-spec.md`（鉴权）、skill `cls-article-patterns`（后端编码模板）
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
| native | 后端新代码全部进 native 二进制；yml 改动 = 全量重建（10-15 分钟/轮）；LLM 走裸 RestClient 零新增反射（D11） |
| 写入约束 | 终端命令禁含 `${...}`；单次写入过长会被截断，大文件分段写 |

---

## 1. 文件清单与分层落点

### 1.1 前端（本仓库 `stock-calculator/`）

| 文件 | 层 | 职责 | 分层护栏 |
|---|---|---|---|
| `src/types/domain.ts` | types | 追加：`CopilotMessage` / `PageContextSnapshot` / `ContextBlockSnapshot` / `COPILOT_SCOPES` 常量表 | R3 零依赖叶子 |
| `src/services/copilotService.ts` | services | 3 端点封装（复用 apiClient 底座）+ 体积护栏 + ulid 生成 | 可 import db（推荐动态）、types；禁 store |
| `src/store/slices/copilotSlice.ts` | store | 注册表 / threads / 发送 / 翻页 / 清空 / consent | 可 import db、services、types |
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
├── service/LlmChainRouter.java              # 容灾路由（D11/D12）
├── service/LlmChannelClient.java            # 单渠道 RestClient 客户端（Gemini/Groq 共用，yml 参数化）
└── util/AesGcmUtil.java                     # 加密工具（纯静态）
```

- Modulith 边界：copilot 只引用 `common` 基包（`ApiResponse`/`BusinessException`）与 auth 基包公开的认证上下文取法；**不 import 任何域的子包**（`ModulithVerifyTest` 守护）。
- 表结构落仓库根 `postgres/schema.sql`（feature-index 变更落点顺序）。
- 新增领域按 feature-index 约定登记。

## 2. 前端契约（`types/domain.ts` 追加，R3 零依赖）

```typescript
/** Copilot 作用域常量表：与路由字符串解耦（D17），路由只做映射 */
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

/** 区块级 scopeId 组合键约定：`页面:blockId`，如 home:planned_orders（V2 启用） */
export type CopilotScopeId = string;

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
2. **三个端点封装**（见 §7 API 契约）：`sendQuestion(scopeId, payload)` / `fetchMessages(scopeId, { before?, limit })` / `clearThread(scopeId)`。
3. **体积护栏**（铁律④）：`applySizeGuard(snapshot, maxBytes = 12_000)` —— JSON 序列化超限则裁行/裁字段，附 `truncated: true` + `capturedAt`（epoch 秒）。所有 scope 共用。
4. **幂等键**：`newClientMessageId()` = 项目已有 `ulid` 依赖生成（D9）。
5. **Mock 开关（P0）**：`import.meta.env.VITE_COPILOT_MOCK === '1'` 时 `sendQuestion` 返回本地假应答（延迟 600ms + 回显摘要字段名），后端未就绪也能全链路验证 UI。

## 4. `store/slices/copilotSlice.ts`

### 4.1 State 形状

```typescript
interface CopilotThreadMeta {
  hasMore: boolean;
  oldestId: number | null;
  loading: boolean;
  loadingOlder: boolean;
}

interface CopilotSliceState {
  panelOpen: boolean;
  consent: 'unknown' | 'granted' | 'declined';  // localStorage 持久化（复用 persistence 模式）
  registry: Record<string, RegisteredContext>;   // scopeId → { title, getData, owner }
  activeScopeId: CopilotScopeId | null;          // 跟随路由（最后注册者胜出）
  threads: Record<string, CopilotMessage[]>;     // 内存缓存尾部 20 条（D8）
  meta: Record<string, CopilotThreadMeta>;
  sending: boolean;
}
```

### 4.2 动作表（进 `AppStoreActions` 签名）

| 动作 | 行为 |
|---|---|
| `registerContext(ctx)` | 写 registry + 置 `activeScopeId`；同 scope 重复注册幂等覆盖（React StrictMode 双挂载安全） |
| `unregisterContext(scopeId, owner)` | 仅当 `registry[scopeId].owner === owner` 才移除，防误删后注册者 |
| `ensureThreadLoaded(scopeId)` | 有缓存则跳过；否则拉尾部 20 条**整段替换**（D8） |
| `sendMessage(question)` | 读 `activeScopeId` → registry.getData() → 护栏 → 乐观追加 pending 态 → POST；成功归位 + 追加 assistant；失败标 `failed`（保留重发）；**sending 锁防重复提交** |
| `resendMessage(clientMessageId)` | 失败重发，同 clientMessageId（服务端幂等，D9） |
| `loadOlder(scopeId)` | keyset 向前翻页，追加头部 |
| `clearCurrentThread()` | ConfirmModal 确认后 DELETE + 清本地（D18） |
| `setPanelOpen / grantConsent / declineConsent` | UI 态 |

### 4.3 发送时序（slice 内部约定）

```
sending=true → snapshot = registry[active].getData()
             → guarded = applySizeGuard(snapshot)
             → cid = newClientMessageId()
             → 乐观 append {role:'user', content:question, id:null, status:'pending'}
             → service.sendQuestion(...)   // 60s 超时
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
| `ContextCapsule` | `registry[activeScopeId].title` + 快照 keys 预览 | 预览只列字段名与条数，不展开值 |
| `MessageList` | `threads[activeScopeId]` + `meta.loadingOlder` | 纯文本渲染 + `whitespace-pre-wrap` 代码块等宽样式（D20） |
| `InputBar` | 本地 state + `sending` | Enter 发送；空串禁发 |
| 登录引导 | `useAuthStore.isAuthenticated` | 未登录点击 → `setAuthModalOpen(true)`（D19） |
| 离线 | `navigator.onLine` + 发送失败分类 | 提示「AI 助手需要网络」 |

### 6.3 路由联动

- `AppLayout` 中监听 `location.pathname`：scope 变化时调 `ensureThreadLoaded(newScope)`；前一 scope 有消息且非当前 → 顶部显示「上一页（XX）对话已归档」（spec §7.3）。
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

// Home 页示例
function buildHomeSummary(state: AppState): Record<string, unknown> {
  return {
    positionCount: state.positions.length,
    totalMarketValue: /* … */,        // 元
    activePlannedOrders: state.plannedOrders.filter((p) => p.status === 'active').length,
    // V2 预留：blocks: [{ blockId:'planned_orders', title:'计划订单', getData: … }]
  };
}
```

`_units`（D6）由 builder 附带：`{ _units: { totalRealizedPnl: '元(CNY)', winRate: '小数比例 0.12=12%' } }`；单位歧义字段必须标注，无歧义可不标（系统提示词静态词典兑底）。

## 7. 后端：表结构与持久化层

### 7.1 `postgres/schema.sql` 追加（仓库根，变更落点顺序）

```sql
CREATE TABLE IF NOT EXISTS ai_chat_session (
    id                BIGSERIAL PRIMARY KEY,
    user_id           VARCHAR(64)  NOT NULL,
    scope_id          VARCHAR(100) NOT NULL,
    title             VARCHAR(100) NOT NULL,
    encrypted_context TEXT,                       -- base64(nonce||ct||tag)
    context_ctime     BIGINT,                      -- 快照覆盖时间(秒)
    ctime             BIGINT       NOT NULL,       -- 创建时间(秒)
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_chat_session_user_scope
    ON ai_chat_session(user_id, scope_id);

CREATE TABLE IF NOT EXISTS ai_chat_message (
    id                BIGSERIAL PRIMARY KEY,
    session_id        BIGINT   NOT NULL,
    role              VARCHAR(10) NOT NULL,        -- user / assistant
    content           TEXT     NOT NULL,
    client_message_id VARCHAR(40),                 -- ulid，幂等
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    ctime             BIGINT   NOT NULL
);
-- 部分唯一索引无法用 JPA @UniqueConstraint 表达，只落 DDL
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_chat_message_client_id
    ON ai_chat_message(client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_chat_message_session_id
    ON ai_chat_message(session_id, id DESC);
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
    @Column(nullable = false, length = 100)
    private String scopeId;
    @Column(nullable = false, length = 100)
    private String title;
    @Column
    private String encryptedContext;
    @Column(name = "context_ctime")
    private Long contextCtime;
    @Column(nullable = false)
    private Long ctime;

    @CreationTimestamp
    @Column(name = "created_at", insertable = false, updatable = false,
            columnDefinition = "TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
    private OffsetDateTime createdAt;
}
// AiChatMessage 同构：sessionId 平铺 Long（不建 @ManyToOne）、role/content/
// clientMessageId/promptTokens/completionTokens/ctime；D-决策映射见 spec §0
```

- native 注意：实体 id 数组（`Long[]` 等）已由 `gen-logger-config.py` EXTRA_CLASSES 覆盖，无需手工登记。

### 7.3 Repository（keyset 查询，排序按 id 不按 created_at）

```java
public interface AiChatSessionRepository extends JpaRepository<AiChatSession, Long> {
    Optional<AiChatSession> findByUserIdAndScopeId(String userId, String scopeId);
}

public interface AiChatMessageRepository extends JpaRepository<AiChatMessage, Long> {
    List<AiChatMessage> findTop6BySessionIdOrderByIdDesc(Long sessionId);
    List<AiChatMessage> findBySessionIdAndIdLessThanOrderByIdDesc(
            Long sessionId, Long before, Pageable pageable);   // PageRequest.of(0, limit)
    Optional<AiChatMessage> findByClientMessageId(String clientMessageId);
    long deleteBySessionId(Long sessionId);
    long countBySessionId(Long sessionId);
}
```

## 8. 后端：加密与编排

### 8.1 `util/AesGcmUtil.java`（纯静态，copilot/util）

```java
public final class AesGcmUtil {
    // 纪律：GCM nonce 绝不复用——每次加密随机 12 字节，打包 base64(nonce||ct||tag)，tag 128bit
    public static String encrypt(String plaintext, SecretKey key) { /* … */ }
    public static String decrypt(String packed, SecretKey key)   { /* … */ }
    public static SecretKey loadKey(String envValue)             { /* 32 字节，hex/base64 */ }
}
```

单测：往返一致；密文相同明文两次加密结果不同（nonce 随机性）；篡改密文解密失败（AEADBadTagException）。

### 8.2 `service/AiChatOrchestrationService.java`（@Transactional 编排，流程 = spec §6.1 时序）

```java
@Slf4j @Service @RequiredArgsConstructor
public class AiChatOrchestrationService {
    private final AiChatSessionRepository sessionRepository;
    private final AiChatMessageRepository messageRepository;
    private final LlmChainRouter llmChainRouter;
    private final CopilotRateLimiter rateLimiter;
    // CopilotProperties: window-rounds / max-messages / aes-key（@ConfigurationProperties）

    public AskResponse ask(String userId, String scopeId, AskRequest req) {
        // 1. 限流（10/min + 100/day，复用 auth 域基建；超限抛 BusinessException）
        // 2. 幂等：findByClientMessageId 命中 → 直接返回已归档 assistant 回复
        // 3. get-or-create session(userId, scopeId)
        // 4. AES-GCM 加密 req.contextSummary → 覆盖 encrypted_context + context_ctime
        // 5. 写入 user message（client_message_id 落库）
        // 6. 懒清理：count > max-messages(200) 时删最旧溢出部分
        // 7. 滑动窗口：最近 window-rounds*2=6 条（id 倒序取后反转）
        // 8. 解密最新快照 → 组装 messages（分层见 spec §6.2）
        // 9. llmChainRouter.route(...) → LlmResult{content, promptTokens, completionTokens, channel}
        // 10. 归档 assistant message(tokens) → 返回 AskResponse
    }
}
```

- 日级限流如 auth 域现无实现，在 `copilot/util` 补内存计数器（重启重置可接受），键 `userId`，双窗口。
- 4 步与 5 步同事务；9 步 LLM 调用在事务外（长调用不占连接）——先提交 1-6，调用后开新事务写 10。

### 8.3 `service/LlmChainRouter.java` + `LlmChannelClient.java`（裸 RestClient + Map/JsonNode，D11/D12）

```java
// 单渠道：POST {base-url}/chat/completions，Bearer api-key，body 用 Map 构造
// 响应用 JsonNode 取 choices[0].message.content 与 usage.prompt_tokens/completion_tokens
// 错误分类：RestClientResponseException → 429/5xx 抛 RetryableLlmException；400/401 抛 FatalLlmException
// 超时：connect 5s / read 60s（yml copilot.llm.timeout-ms）

// 路由：List<LlmChannelClient> 依序尝试；Retryable → 切下一个；Fatal → 直接失败；
//       耗尽 → BusinessException(502, "AI 服务暂不可用，请稍后重试")
```

- 零新增反射元数据：请求/响应全 Map/JsonNode（crawler 同款套路），**不引入 Spring AI ChatClient**。

### 8.4 `controller/CopilotController.java` + `application.yml`

```java
@RestController @RequestMapping("/api/copilot") @RequiredArgsConstructor
public class CopilotController {
    // POST   /threads/{scopeId}/messages   → ApiResponse<AskResponse>（userId 取法与 auth 域控制器一致）
    // GET    /threads/{scopeId}/messages?before=&limit=20 → ApiResponse<ThreadPageResponse>
    // DELETE /threads/{scopeId}            → ApiResponse<Void>（删 session + messages）
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
  aes-key: "${AI_CHAT_AES_KEY:}"
  rate-limit: { per-minute: 10, per-day: 100 }
  history: { window-rounds: 3, max-messages: 200 }
```

## 9. API 契约（3 端点，信封语义与 `/api/auth` 一致：恒 200 + code 分支，未认证拦截器直写 401）

### 9.1 POST `/api/copilot/threads/{scopeId}/messages`

```json
// Request
defineRequest({
  "question": "最近做T的胜率怎么样？",
  "sessionTitle": "数据统计",
  "clientMessageId": "01J9ZK3T8Q...ulid",
  "contextSummary": {
    "data": { "totalRealizedPnl": 1234.56, "winRate": 0.62, "roundCount": 47 },
    "_units": { "totalRealizedPnl": "元(CNY)", "winRate": "小数比例 0.12=12%" },
    "capturedAt": 1756713600,
    "truncated": false
  }
})

// Response data
{ "assistantMessageId": 9102, "content": "…纯文本回答…",
  "promptTokens": 852, "completionTokens": 418, "channel": "gemini",
  "userMessageId": 9101, "ctime": 1756713601 }
```

- `scopeId` 含 `:`（如 `home:planned_orders`）在 path 段合法（RFC 3986 pchar），前端仍建议 `encodeURIComponent`。
- 幂等：同 `clientMessageId` 重发 → 返回已归档回复（不重复调 LLM、不双写）。
- 超限/渠道耗尽 → `ApiResponse.fail(...)` 信封，前端标 `failed` 可重发。

### 9.2 GET `/api/copilot/threads/{scopeId}/messages?before=&limit=20`

```json
// Response data（keyset：id < before 的前 limit 条，倒序取出后正序返回）
{ "sessionId": 12, "scopeId": "statistics", "title": "数据统计",
  "messages": [ { "id": 9098, "role": "user", "content": "…",
                  "clientMessageId": "…", "ctime": 1756710000 } ],
  "hasMore": true, "oldestId": 9098 }
```

- 首次拉取不传 `before` → 取尾部 limit 条。

### 9.3 DELETE `/api/copilot/threads/{scopeId}`

### 9.4 页面 × 接口调用矩阵（所有页面一致）

9 个页面**共用同一套 3 个端点**，页面差异只体现在 `scopeId` 与 `contextSummary` 内容，后端不为任何页面单开接口：

| 时机 | 调用 | 携带 |
|---|---|---|
| 进入页面 / 切回会话（激活即替换缓存） | `GET /threads/{scopeId}/messages` | — |
| 用户提问 | `POST /threads/{scopeId}/messages` | question + **本页 contextSummary**（§9.5 契约） + clientMessageId |
| 查看更早 / 滚动到顶部 | `GET /threads/{scopeId}/messages?before=&limit=20` | — |
| 清空会话（ConfirmModal 后） | `DELETE /threads/{scopeId}` | — |

### 9.5 各页面 contextSummary 白名单契约

通用信封（spec §3 管线产出，四键恒定）：

```json
{
  "data":       { "…本页白名单字段，见下…" },
  "_units":     { "字段": "单位说明" },
  "capturedAt": 1756713600,
  "truncated":  false
}
```

单位图例：**元** = CNY 人民币元；**比例** = 小数（0.12 = 12%）；**秒** = epoch 秒。

| 页面 | scopeId | 期 | 白名单要点 | 特殊禁入 |
|---|---|---|---|---|
| 数据统计 | `statistics` | **P0** | 时间过滤内做T盈亏/胜率/轮数/贡献 Top | — |
| 首页仪表盘 | `home` | **P0** | 持仓市值/浮动盈亏 + 活跃计划单列表 | — |
| 短线交易 | `t_calculator` | 二期 | 流水池撮合状态 + 待执行策略 | — |
| 中长期交易 | `cost_averaging` | 二期 | 实盘记录成本/现价/盈亏比例 | — |
| 沙盘复盘 | `sandbox` | 二期 | 分支对比结果 + 基线 | — |
| 涨跌幅计算器 | `change_rate` | 二期 | 当前输入与阶梯推算（无持久化） | — |
| 费率配置 | `fee_config` | 二期 | 当前费率预设 | — |
| 云端同步 | `webdav` | 二期 | 仅同步状态 | serverUrl/username/password |
| 批量导入 | `batch_import` | 二期 | 解析行数/草稿数 | OCR 原始截图文本 |

**P0 试点页完整契约：**

```json
// statistics（来源：tStreamEngine 同源重算 + ledgerService 归档轮次）
{ "data": {
    "timeFilter": "7d",
    "totalRealizedPnl": 1234.56,
    "winRate": 0.62,
    "roundCount": 47,
    "avgPnlPerRound": 26.27,
    "archivedRoundCount": 183,
    "topStocks": [ { "stockName": "中际旭创", "pnl": 402.10, "rounds": 9 } ]
  },
  "_units": { "totalRealizedPnl": "元", "winRate": "比例",
               "avgPnlPerRound": "元", "topStocks[].pnl": "元" },
  "capturedAt": 1756713600, "truncated": false }

// home（来源：positionsSlice / ordersSlice / roundsSlice）
{ "data": {
    "positionCount": 6,
    "totalMarketValue": 158234.50,
    "totalUnrealizedPnl": -1204.00,
    "totalUnrealizedPnlRate": -0.0075,
    "openRoundCount": 3,
    "activePlannedOrderCount": 4,
    "activePlannedOrders": [
      { "stockName": "中际旭创", "side": "buy",  "targetPrice": 158.00,
        "quantity": 200, "expiresAt": 1756800000 },
      { "stockName": "贵州茅台", "side": "sell", "targetPrice": 1720.00,
        "quantity": 100, "expiresAt": 1756800000 }
    ]
  },
  "_units": { "totalMarketValue": "元", "totalUnrealizedPnl": "元",
               "totalUnrealizedPnlRate": "比例", "targetPrice": "元" },
  "capturedAt": 1756713600, "truncated": false }
```

**二期页面契约模板**（铺开某页时以该页实际渲染字段为准微调——显示边界=数据边界，spec §2.1）：

```json
// t_calculator（来源：streamsSlice + tStreamEngine + tradingTime）
{ "data": {
    "tradingSession": "盘中",
    "todayBuyCount": 5, "todaySellCount": 4,
    "unmatchedPositions": 2,
    "pendingStrategies": [
      { "stockName": "中际旭创", "type": "先买后卖",
        "entryPrice": 158.20, "exitPrice": 162.00, "expectedPnlRate": 0.024 } ] },
  "_units": { "entryPrice": "元", "exitPrice": "元", "expectedPnlRate": "比例" },
  "capturedAt": 1756713600, "truncated": false }

// cost_averaging（来源：positionsSlice / 长期记录）
{ "data": {
    "recordCount": 3, "totalCost": 52000.00, "totalMarketValue": 54800.00,
    "records": [
      { "stockName": "贵州茅台", "costPrice": 1650.00, "shares": 100,
        "currentPrice": 1718.00, "pnlRate": 0.0412 } ] },
  "_units": { "totalCost": "元", "totalMarketValue": "元",
               "costPrice": "元", "currentPrice": "元", "pnlRate": "比例" },
  "capturedAt": 1756713600, "truncated": false }

// sandbox（来源：sandboxStore 分支对比结果）
{ "data": {
    "scenarioTitle": "…", "baselineName": "…", "branchCount": 3,
    "branches": [
      { "name": "分支A", "finalValue": 102300.00, "pnl": 2300.00, "tradeCount": 12 } ] },
  "_units": { "finalValue": "元", "pnl": "元" },
  "capturedAt": 1756713600, "truncated": false }

// change_rate（无持久化，快照=当前屏幕输入与推算结果）
{ "data": {
    "basePrice": 100.00, "changeRate": 0.05,
    "ladderSteps": [ { "label": "涨停1", "price": 105.00 }, { "label": "涨停2", "price": 110.25 } ] },
  "_units": { "basePrice": "元", "changeRate": "比例", "ladderSteps[].price": "元" },
  "capturedAt": 1756713600, "truncated": false }

// fee_config（无敏感数据）
{ "data": {
    "presetName": "自定义",
    "commissionRate": 0.00025, "minCommission": 5.00,
    "stampTax": 0.0005, "transferFeeRate": 0.00001 },
  "_units": { "minCommission": "元", "commissionRate": "比例",
               "stampTax": "比例", "transferFeeRate": "比例" },
  "capturedAt": 1756713600, "truncated": false }

// webdav（仅状态；serverUrl/username/password 永不进入快照，D4.2）
{ "data": {
    "configured": true, "autoSyncEnabled": false,
    "lastSyncTime": 1756651200, "lastSyncStatus": "success" },
  "_units": { "lastSyncTime": "秒" },
  "capturedAt": 1756713600, "truncated": false }

// batch_import（OCR 原始截图文本禁入，D4.2）
{ "data": {
    "activeSource": "ocr",
    "parsedRowCount": 12, "draftPendingCount": 3 },
  "_units": {},
  "capturedAt": 1756713600, "truncated": false }
```

builder 落点：纯函数统一放 `utils/copilotSnapshots.ts`（显式入参 store 切片，符合 R2）；简单页面可在视图内定义。后端对 `data` 内容**不解释不校验 schema**，加密透传（spec §4）。

## 10. 验证清单

### 10.1 前端（本仓库，每步改码后必跑）

```sh
npx tsc --noEmit        # 零错误
npm test                # pretest 自动跑 check:arch（R1/R2/R3 + madge 循环）
npm run map:features    # copilot 关键词登记后确认「未归类」为 0
```

新增测试：`copilotSlice`（注册/注销幂等、发送乐观更新与失败态、护栏）、`copilotService`（护栏截断、mock 模式）。白盒用例放 `src/__tests__/`，不受分层护栏约束。

### 10.2 后端（需切到 stock-calculator-service 工作区）

```sh
./mvnw compile -q
cat postgres/schema.sql | docker exec -i <pg容器> psql -U postgres -d stock_calculator   # 或手动执行 DDL
POSTGRES_PASS=... ./mvnw install '-Dtest=!TaskServiceTest' '-DfailIfNoTests=false'
```

新增测试：AesGcmUtil 往返/nonce 随机性/篡改失败；容灾矩阵（mock 两渠道：429 切换、400 直接失败、耗尽 Fail-Safe）；编排服务（幂等命中、滑动窗口条数、懒清理）——LLM 一律 mock，禁止打真实 API。

### 10.3 native（P3）

```sh
POSTGRES_PASS=... bash stock-calculator-main/build-native.sh   # 全量（改 yml 后必须）
# 8s 冒烟（脚本内置）→ 90s 加长 → smoke-curl.sh 403 门禁
# 额外：带 GEMINI_API_KEY 启动二进制，真实 POST /api/copilot/threads/statistics/messages 一次
```

## 11. 分期任务分解

| 期 | 任务 | 产出/验收 |
|---|---|---|
| P0 | §2 契约 + §3 service(mock) + §4 slice + §5 hook + §6 组件 + App 挂载 + Statistics/Home builder | tsc 零错、check:arch 过、新单测绿、mock 全链路可演示 |
| P1 | 后端 §7.1 DDL + §7.2 实体 + §7.3 仓储 + §8.1 AES + §8.2 编排 + Gemini 单渠道 + §8.4 Controller | mvnw test 全绿（排除 TaskServiceTest）；curl 三端点走通 |
| P2 | §8.3 Groq + 容灾 + 分页/清空/懒清理/限流/tokens 落库 + 前端联调（历史/翻页/清空/重发） | 容灾矩阵单测覆盖；全链路手工验收 |
| P3 | native 全量构建 + 冒烟 + 真实 ask + 隐私文案打磨 | spec §8 P3 验收标准 |

## 12. 维护约定

- 前端功能地图（skill `stock-calculator-frontend-dev` §2 表格）加 copilot 行；`scripts/feature-map.mjs` GROUPS 登记关键词（copilot/Copilot），跑一次确认未归类为 0。
- 后端 feature-index 表加 copilot 域行（子包 controller·dto·entity·repository·service·util）。
- scopeId 常量表为前后端共享协议：新增页面 = 常量表加一项 + view 注册 + 本文档 §1.1 表格加行。
- 本文档与 spec 的 D1-D21 决策一一对应；改行为先改 spec 决策表，再同步实现文档。
