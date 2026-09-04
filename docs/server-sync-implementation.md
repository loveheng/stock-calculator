# 服务端密文同步（登录即备份）· 开发实施文档

> 版本：定稿 v1.3（2026-09-05；v1.1 = 后端事实核对修正 E1-E9；v1.2 = §5.3 补 42901 重调度约束，与 spec v1.2 对应；v1.3 = 信封 v1 内嵌 deflate-raw 压缩，与 spec v1.3 对应）
> 范围：后端领域包/表结构/CAS 写入/频控/校验实现要点、前端服务/状态/UI 落点与骨架、测试计划、里程碑与上线回滚
> 关联：`docs/server-sync-spec.md`（设计决策 D1-D15）、`docs/e2ee-auth-spec.md`（MEK 体系）、`docs/copilot-implementation.md`（apiClient 底座与 Modulith 约定）、skill `cls-article-patterns`（后端编码模板）、skill `stock-calculator-frontend-dev`（分层护栏）
> 状态：待开发启动

---

## 0. 前置事实（技术栈基线与环境约束）

| 项 | 事实 |
|---|---|
| 前端 | React 19 + zustand 5（slices 模式）+ Dexie 4.4 + TypeScript + Vite + vitest；仓库根即前端根 |
| 后端 | stock-calculator-service（**独立仓库，不在当前工作区**）：Spring Boot 4.1.1 + Java 21 + JPA(Hibernate 6) + PostgreSQL，包根 `com.zzh.stock_calculator`，单模块 `stock-calculator-main`，Maven Wrapper |
| 鉴权 | Bearer + 恒 200 信封（`ApiResponse{code,message,data}`）；401 由既有拦截器统一处理；userId 取认证上下文（与 CopilotController 同法） |
| 后端验证 | `./mvnw compile -q`；`./mvnw test '-Dtest=!TaskServiceTest' '-DfailIfNoTests=false'`（TaskServiceTest 打真实 API 必挂）；ModulithVerifyTest 守护模块边界 |
| native | 后端新代码全部进 native 二进制；**yml 改动 = 全量重建（10-15 分钟/轮）** → 本方案默认参数全部写死在 `@Value` defaultValue，零 yml 改动 |
| 表结构 | 落仓库根 `postgres/schema.sql`（增量追加） |
| 前端验证 | `npx tsc --noEmit`；`npm test`（pretest 自动 `check:arch`）；`npm run check:arch` |
| 写入约束 | 终端命令禁含 `${...}` 形式字符串；大文件分段写入 |

## 1. 文件清单与分层落点

### 1.1 后端（stock-calculator-service，新领域包 sync/）

```
stock-calculator-main/src/main/java/com/zzh/stock_calculator/sync/
├── controller/SyncBackupController.java    # 3 端点，恒 200 信封
├── dto/SyncDtos.java                       # SyncMetaDto / SyncPullDto / SyncPushRequest / SyncPushResultDto
├── entity/UserSyncData.java                # 主表：每用户一行
├── entity/UserSyncHistory.java             # 历史表：被替换版本
├── repository/UserSyncDataRepository.java  # 含 CAS native upsert（本方案核心）
├── repository/UserSyncHistoryRepository.java
└── service/SyncBackupService.java          # 校验/去重/频控/CAS/历史裁剪
```

- Modulith 边界：sync 只引用 `common` 基包（ApiResponse / BusinessException）与 auth 基包公开的认证上下文取法；**不 import 任何域的子包**（ModulithVerifyTest 守护）
- 表结构增量追加到仓库根 `postgres/schema.sql`

### 1.2 前端（本仓库）

| 文件 | 层 | 职责 | 护栏 |
|---|---|---|---|
| `src/services/cryptoService.ts` | services | 增量：`encryptText` / `decryptText`（字符串级 GCM，内部复用既有 helper）+ v1.3 压缩对 `encryptDeflateText` / `decryptInflateText`（deflate-raw → GCM，服务端同步通道专用；现有函数零改动） | services |
| `src/services/snapshotService.ts` | services | 新增：从 webdavSync 提取 `serializeSnapshot` / `deserializeSnapshot`（webdavSync 保留 re-export 兼容既有调用与测试） | services，动态 import db |
| `src/services/serverSync.ts` | services | 新增：syncRequest 底座 + meta/pull/push + 信封 build/parse + sha256Hex + 设备 meta 读写 + scheduleServerBackup 防抖管线 | services；**禁 import store**：mek/token 一律由调用方传参注入 |
| `src/store/slices/ioSlice.ts` | store | 增量：serverSync 状态 + pushServerSnapshot / restoreFromServer / resolveServerConflict / startupServerSyncCheck actions | store 可 import services / db / auth store |
| `src/store/index.ts` | store | `initAutoSync` 双通道接线 + `AppStoreActions` 增签名 | — |
| `src/views/WebDAVConfig.tsx` | views | 「服务端备份」区块 UI + 冲突/回退卡 | 禁 db（R1） |
| `src/__tests__/serverSync.test.ts` | test | 服务层与编排单测（不受护栏约束） | — |

依赖方向：`types ← services ← store ← views`；R1/R2/R3 全部满足。

## 2. 数据库变更（postgres/schema.sql 增量追加）

```sql
-- ============================================================
-- 服务端密文同步（server-sync-spec §5 / D5 / D8 / D11）
-- ============================================================
CREATE TABLE IF NOT EXISTS user_sync_data (
    user_id           VARCHAR(64) PRIMARY KEY,       -- E1：后端 UserEntity.id 为 UUID 字符串（copilot 先例 varchar(64)）；平铺不建物理外键
    encrypted_payload TEXT NOT NULL,                 -- 密文信封 JSON（spec §4.1）
    version           BIGINT NOT NULL,               -- 服务端单调自增，首传为 1
    payload_hash      VARCHAR(64),                   -- 信封 SHA-256（小写 hex），去重比对
    payload_bytes     INT  NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sync_history (
    id                BIGSERIAL PRIMARY KEY,
    user_id           VARCHAR(64) NOT NULL,          -- E1：UUID 字符串
    version           BIGINT NOT NULL,               -- 被替换时的云端版本号
    encrypted_payload TEXT NOT NULL,
    payload_bytes     INT  NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_sync_history UNIQUE (user_id, version)
);

-- 回滚：DROP TABLE IF EXISTS user_sync_history; DROP TABLE IF EXISTS user_sync_data;
-- 历史裁剪规则（service 层）：成功写入 newVersion 后 DELETE version <= newVersion - 5（spec D8）
```

## 3. 后端实现要点

### 3.1 Entity（Lombok 三件套，按 cls-article-patterns）

```java
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "user_sync_data")
public class UserSyncData {

    /** 外部ID（auth 用户表主键，UUID 字符串，E1），手动写入 */
    @Id
    @Column(name = "user_id", nullable = false, length = 64)
    private String userId;

    @Column(name = "encrypted_payload", nullable = false, columnDefinition = "TEXT")
    private String encryptedPayload;

    @Column(name = "version", nullable = false)
    private Long version;

    @Column(name = "payload_hash", length = 64)
    private String payloadHash;

    @Column(name = "payload_bytes", nullable = false)
    private Integer payloadBytes;

    @CreationTimestamp
    @Column(name = "created_at", updatable = false)
    private OffsetDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at")
    private OffsetDateTime updatedAt;
}
```

```java
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "user_sync_history",
       uniqueConstraints = @UniqueConstraint(name = "uq_user_sync_history",
               columnNames = {"user_id", "version"}))
public class UserSyncHistory {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false, length = 64)
    private String userId;

    @Column(name = "version", nullable = false)
    private Long version;

    @Column(name = "encrypted_payload", nullable = false, columnDefinition = "TEXT")
    private String encryptedPayload;

    @Column(name = "payload_bytes", nullable = false)
    private Integer payloadBytes;

    @CreationTimestamp
    @Column(name = "created_at", updatable = false)
    private OffsetDateTime createdAt;
}
```

### 3.2 Repository（CAS 核心）

```java
@Repository
public interface UserSyncDataRepository extends JpaRepository<UserSyncData, Long> {

    /**
     * 乐观 CAS upsert（spec §7.2，防并发竞态的关键单语句）。
     * 首传（baseVersion=0）：行不存在 → INSERT 直接成功；并发首传落入 ON CONFLICT
     * 且 version(1) != 0 → 0 行受影响。
     * 覆盖：仅当现库 version == baseVersion 才写，version 原子 +1。
     * 注意：云端为空时任何 baseVersion 都会按 INSERT 成功（v1），
     * 由客户端回退检测（D14）自然收敛。
     *
     * @return 受影响行数：1 = 写入成功；0 = 冲突
     */
    @Modifying
    @Query(value = """
            INSERT INTO user_sync_data (user_id, encrypted_payload, version, payload_hash, payload_bytes)
            VALUES (:userId, :payload, 1, :hash, :bytes)
            ON CONFLICT (user_id) DO UPDATE SET
                encrypted_payload = EXCLUDED.encrypted_payload,
                version           = user_sync_data.version + 1,
                payload_hash      = EXCLUDED.payload_hash,
                payload_bytes     = EXCLUDED.payload_bytes,
                updated_at        = NOW()
            WHERE user_sync_data.version = :baseVersion
            """, nativeQuery = true)
    int casUpsert(@Param("userId") String userId,
                  @Param("payload") String payload,
                  @Param("hash") String hash,
                  @Param("bytes") Integer bytes,
                  @Param("baseVersion") Long baseVersion);
}
```

```java
@Repository
public interface UserSyncHistoryRepository extends JpaRepository<UserSyncHistory, Long> {

    /** E7：整库回滚后重推可能撞 (user_id, version) 唯一约束 → 幂等吸收 */
    @Modifying
    @Query(value = """
            INSERT INTO user_sync_history (user_id, version, encrypted_payload, payload_bytes)
            VALUES (:userId, :version, :payload, :bytes)
            ON CONFLICT (user_id, version) DO NOTHING
            """, nativeQuery = true)
    int insertIgnoreConflict(@Param("userId") String userId, @Param("version") Long version,
                             @Param("payload") String payload, @Param("bytes") Integer bytes);

    void deleteByUserIdAndVersionLessThanEqual(String userId, Long version);
}
```

> ⚠️ `casUpsert` 是 @Modifying，必须在 `@Transactional` 内调用（service 层已保证）。

### 3.3 Service（SyncBackupService）

```java
@Slf4j
@Service
@RequiredArgsConstructor
public class SyncBackupService {

    private static final long RATE_LIMIT_MILLIS = 5_000L;      // D10
    private static final int HISTORY_KEEP = 5;                 // D8
    private static final long EMPTY_BASE_VERSION = 0L;         // baseVersion=0 = 云端应为空（D5）
    private static final int MAX_ENVELOPE_BYTES = 2_000_000;   // D11（不进 yml，避免 native 全量重建）

    private final UserSyncDataRepository dataRepository;
    private final UserSyncHistoryRepository historyRepository;

    /** 元信息对账（D13 轻量轮询的基础） */
    @Transactional(readOnly = true)
    public SyncMetaDto meta(String userId) {
        return dataRepository.findById(userId)
                .<SyncMetaDto>map(e -> SyncMetaDto.of(e))
                .orElseGet(SyncMetaDto::empty);
    }

    /** 拉取密文（原样透传，不解密） */
    @Transactional(readOnly = true)
    public SyncPullDto pull(String userId) {
        UserSyncData e = dataRepository.findById(userId)
                .orElseThrow(() -> new BusinessException(40401, "云端暂无备份"));
        return SyncPullDto.of(e);
    }

    /**
     * 上传：校验 → 去重 → 频控 → CAS → 历史（spec §6.4 顺序）。
     * E4 定案：返回 PushOutcome（成功 / 冲突+latestMeta / 频控），Controller 组装信封；
     * 40001/40002/40003 无 data，仍直接抛 BusinessException。
     */
    @Transactional
    public PushOutcome push(String userId, SyncPushRequest req) {
        validateEnvelope(req);
        UserSyncData current = dataRepository.findById(userId).orElse(null);

        // 去重（D7 两分支，先于频控）：(a) version==base 且 hash 同；(b) version==base+1 且 hash 同（响应丢失重试）
        if (current != null && req.getPayloadHash() != null
                && req.getPayloadHash().equals(current.getPayloadHash())) {
            long v = current.getVersion();
            if (v == req.getBaseVersion() || v == req.getBaseVersion() + 1) {
                return SyncPushResultDto.deduped(v);
            }
        }

        // 频控（D10）
        if (current != null && current.getUpdatedAt() != null
                && current.getUpdatedAt().toInstant().toEpochMilli()
                        > System.currentTimeMillis() - RATE_LIMIT_MILLIS) {
            return PushOutcome.rateLimited(RATE_LIMIT_MILLIS / 1000);   // E4：频控带 retryAfter
        }

        // CAS 写入（D5）；云端为空时 INSERT 路径不校验 baseVersion（spec §7.2）
        int affected = dataRepository.casUpsert(userId, req.getEnvelope(),
                req.getPayloadHash(), req.getPayloadBytes(), req.getBaseVersion());
        if (affected == 0) {
            int code = (req.getBaseVersion() == EMPTY_BASE_VERSION) ? 40902 : 40901;
            return PushOutcome.conflict(code, meta(userId));   // E4：data 携带最新 meta
        }
        // E2：回读实际 version，不用 base+1 推算（「云端空但 base=5」实际写入 v1）
        long newVersion = dataRepository.findById(userId)
                .map(UserSyncData::getVersion)
                .orElseThrow(() -> new IllegalStateException("CAS succeeded but row missing"));

        // 历史（D8）：CAS 成功才落；CAS 前读到的旧行即被替换行
        if (current != null) {
            historyRepository.insertIgnoreConflict(userId, current.getVersion(),
                    current.getEncryptedPayload(), current.getPayloadBytes());   // E7：幂等吸收
            historyRepository.deleteByUserIdAndVersionLessThanEqual(userId, newVersion - HISTORY_KEEP);
        }
        log.info("sync push ok, userId={}, base={}, new={}, bytes={}",
                userId, req.getBaseVersion(), newVersion, req.getPayloadBytes());
        return PushOutcome.ok(newVersion);
    }

    /**
     * 信封结构校验（D2：只验结构不碰内容）
     * 0) payloadHash 为空 → 40003；baseVersion 为空或 < 0 → 40001（E8）
     * 1) envelope 反序列化为对象：v==1、alg=="A256GCM"、iv/ct 非空字符串
     * 2) envelope UTF-8 字节数 <= MAX_ENVELOPE_BYTES（40002）
     * 3) payloadHash 匹配 64 位小写 hex（40003）
     * 4) payloadBytes 声明值与 envelope 实际字节数一致（40001）
     */
    private void validateEnvelope(SyncPushRequest req) { /* 见上注释，逐项抛 BusinessException */ }
}
```

> E4 定案：`BusinessException` 无 data 字段，故带 data 的业务错误（40901/40902/42901）不走异常通道——
> Service 返回 `PushOutcome`，Controller 组装 `ApiResponse.fail(code, message, data)`；40001/40002/40003 无 data，直接抛异常。

### 3.4 Controller

```java
@Slf4j
@RestController
@RequestMapping("/api/sync/backup")
@RequiredArgsConstructor
public class SyncBackupController {

    private final SyncBackupService syncBackupService;

    @GetMapping("/meta")
    public ApiResponse<SyncMetaDto> meta() {
        return ApiResponse.success(syncBackupService.meta(currentUserId()));
    }

    @GetMapping
    public ApiResponse<SyncPullDto> pull() {
        return ApiResponse.success(syncBackupService.pull(currentUserId()));
    }

    @PutMapping
    public ApiResponse<SyncPushResultDto> push(@RequestBody SyncPushRequest request) {
        PushOutcome outcome = syncBackupService.push(currentUserId(), request);
        if (outcome.isOk()) {
            return ApiResponse.success(SyncPushResultDto.of(outcome));
        }
        return ApiResponse.fail(outcome.getCode(), outcome.getMessage(), outcome.getData());   // E4
    }

    /** 复用 auth 基包认证上下文取法（与 CopilotController 同法）。⚠️ 落地时按现状适配 */
    private String currentUserId() {
        // 同 CopilotController 的取法；401 由拦截器先行保证
        return null; // placeholder
    }
}
```

> ⚠️ **E3（高）**：`WebConfig` 的拦截路径白名单必须登记 `/api/sync/**`——拦截器只挂已注册路径，
> 漏登记 = 端点无鉴权裸奔。上线验收补一条：无 token 请求 /api/sync/backup/meta 必须 401。

### 3.5 DTO（dto/SyncDtos.java，Lombok 三件套）

| DTO | 字段 | 静态工厂 |
|---|---|---|
| SyncMetaDto | hasData / version / updatedAt / payloadHash / payloadBytes | empty() / of(UserSyncData) |
| SyncPullDto | version / updatedAt / payloadHash / envelope | of(UserSyncData) |
| SyncPushRequest | baseVersion / envelope / payloadHash / payloadBytes | — |
| SyncPushResultDto | version / deduped | of(v) / deduped(v) |
| PushOutcome（service 内部） | ok / code / message / data（冲突=latest meta，频控=retryAfterSeconds） | ok(v) / conflict(code, meta) / rateLimited(sec) |

## 4. 后端测试（SyncBackupServiceTest + ModulithVerifyTest）

| 用例 | 期望 |
|---|---|
| 首传（base=0，云端空） | version=1，历史空 |
| 并发首传（同 base=0 两线程） | 一胜一 40902（CAS 单语句保证） |
| 正常覆盖 base=6 | version=7，历史新增 version=6 |
| base 落后（base=5，云端 6） | 40901 |
| base=0 但云端已有 | 40902 |
| version==base 且 hash 同 | deduped=true 未写库 |
| version==base+1 且 hash 同 | deduped=true（丢失响应重试） |
| 信封畸形（缺 ct / v=2 / iv 空串） | 40001 |
| 信封 > 2MB | 40002 |
| hash 非 64 hex | 40003 |
| payloadBytes 声明与实际不符 | 40001 |
| 5s 内连续 PUT | 42901 |
| 7 次覆盖后 | 历史恰好保留 5 份 |
| 云端空但 base=5 | 成功且返回 version=1（E2 回读，非 6）；客户端 lastSeen 收敛 |
| 整库回滚后同版本重推（E7） | 历史插入被 ON CONFLICT DO NOTHING 吸收，不报错 |
| 合并重推距他设备写入 < 5s（E9） | 42901 + retryAfterSeconds |
| 无 token 请求 meta（E3 回归） | 401（拦截器白名单已登记 /api/sync/**） |
| ModulithVerifyTest | sync 包仅依赖 common + auth 基包 |

测试基建随仓库现状（Testcontainers / DataJpaTest / 既有 service 测试模式均可）。

## 5. 前端实现

### 5.1 cryptoService 增量（现有函数零改动）

```ts
/** 字符串级加密：内部复用既有 AES-GCM helper，随机 96-bit IV；返回 base64 */
export async function encryptText(plaintext: string, mek: CryptoKey):
  Promise<{ iv: string; ct: string }>;

/** 解密回明文字符串；篡改/错钥抛错（GCM 认证失败） */
export async function decryptText(iv: string, ct: string, mek: CryptoKey): Promise<string>;

/** v1.3 压缩级加密（服务端同步通道专用）：deflate-raw 压缩 → AES-GCM(MEK) → base64。
 *  必须先压缩后加密（GCM 输出高熵不可压）；iv/ct 返回结构与 encryptText 完全一致，信封零格式分支。
 *  依赖 Blob/Response/CompressionStream（Node 18+ 与现代浏览器原生可用，零新依赖）。 */
export async function encryptDeflateText(plaintext: string, mek: CryptoKey):
  Promise<{ iv: string; ct: string }>;

/** v1.3 压缩级解密：base64 → AES-GCM 解密 → inflate-raw 解压 → 明文。
 *  GCM 认证失败先于解压抛出；解压失败（数据损坏）抛 TypeError，调用方同路 catch。 */
export async function decryptInflateText(iv: string, ct: string, mek: CryptoKey): Promise<string>;
```

> 服务端同步推送/拉取管线一律使用压缩对（ioSlice 仅 import 这两个函数）；
> `encryptText` / `decryptText` 保留为通用工具（已有单测覆盖，未来网盘备份通道可复用）。

> 不用既有 `encryptPayload(data, mek)`：它接收对象并内部 JSON.stringify，
> 而快照已是字符串，包一层会双重编码膨胀体积。字符串级 API 各加约 10 行。

### 5.2 serverSync.ts（新服务，管道纯净：mek/token 全部传参注入，禁 import store）

```ts
export const SYNC_API_BASE_URL = '/api/sync';

export interface ServerSyncMeta {
  hasData: boolean; version: number;
  updatedAt?: string; payloadHash?: string; payloadBytes?: number;
}

export interface BackupEnvelopeV1 { v: 1; alg: 'A256GCM'; iv: string; ct: string; }

export type ServerPushResult =
  | { ok: true; version: number; deduped: boolean }
  | { ok: false; reason: 'conflict' | 'empty-conflict' | 'rate' | 'invalid' | 'network';
      latest?: ServerSyncMeta; retryAfterSeconds?: number };

// ---- 信封与校验和 ----
export function buildBackupEnvelope(iv: string, ct: string): BackupEnvelopeV1;
export function envelopeToString(env: BackupEnvelopeV1): string;
export function parseBackupEnvelope(raw: string): BackupEnvelopeV1 | null;  // 结构校验，失败 null
export async function sha256Hex(text: string): Promise<string>;             // crypto.subtle.digest

// ---- API 封装（syncRequest 仿 copilotService 底座：Bearer 注入 + ApiEnvelope code 分支 + SessionExpiredError 透传）----
export async function fetchSyncMeta(token: string): Promise<ServerSyncMeta>;
export async function pullBackupEnvelope(token: string):
  Promise<{ version: number; envelope: string }>;
export async function pushBackup(token: string, baseVersion: number, env: BackupEnvelopeV1):
  Promise<ServerPushResult>;

// ---- 设备本地账本（localStorage 'server_sync_meta_v1'）----
export interface ServerSyncDeviceMeta { lastSeenCloudVersion: number; enabled: boolean; }
export function readServerSyncMeta(): ServerSyncDeviceMeta;                 // 默认 {0, true}
export function writeServerSyncMeta(patch: Partial<ServerSyncDeviceMeta>): void;
```

pushBackup 错误码映射：200→ok（E5：成功信封 code 恒 200，沿用 apiClient 判定）；40901→conflict（data=latest meta）；40902→empty-conflict；
42901→rate（data.retryAfterSeconds）；40001/2/3→invalid；网络失败/非信封响应→network——
其中 **HTTP 413 单独识别（E6）**：文案提示「代理体积限制」，指向反代 client_max_body_size 配置。

另含防抖管线（镜像 webdavSync 模式）：

```ts
export function scheduleServerBackup(snapshot: string, gate: ServerSyncGate): void;  // 800ms 防抖
export function cancelServerBackup(): void;
// gate = { canPush(): boolean; doPush(): Promise<void> }
// 锁内顺序：门控 → 空快照守卫（D9）→ 10s 冷却 → Promise 互斥 → Web Locks('server-sync-push') → doPush
```

### 5.3 ioSlice 增量（状态 + actions）

```ts
interface ServerSyncSliceState {
  serverSyncing: boolean;
  serverLastVersion: number | null;   // lastSeenCloudVersion 镜像（UI 显示）
  serverLastError: string | null;     // 冲突/回退/连续失败提示
}
// actions（签名进 AppStoreActions）：
pushServerSnapshot(opts?: { force?: boolean }): Promise<void>;
restoreFromServer(): Promise<void>;   // 拉取→解密→deserializeSnapshot→importData（isSyncingFromRemote 防回环）
resolveServerConflict(mode: 'merge-cloud' | 'overwrite-cloud'): Promise<void>;
startupServerSyncCheck(): Promise<void>;   // §7.3 决策树 + visibilitychange/15min 对账注册
```

关键接线点：

1. **MEK/Token 获取**：ioSlice 属 store 层，可 `useAuthStore.getState()` 取 token 与会话 MEK。
   ⚠️ 确认点：auth store 是否暴露会话 MEK 只读 getter；若无则补一个（不落盘、不可序列化）。
2. **推送流程**：exportData → serializeSnapshot（经 snapshotService）→ encryptDeflateText(mek)
   → buildBackupEnvelope → pushBackup(token, readServerSyncMeta().lastSeenCloudVersion)
   → ok：写 lastSeen=version → 409：restoreFromServer 合并后重推一轮——重推若 42901 按 retryAfter
   等待后重试（E9，不计失败退避）→ 仍冲突则置 serverLastError 交 UI。
   ⚠️ E9 等待**不得在 Web Locks 锁内 sleep**：释放 'server-sync-push' 锁 → 以 delay=retryAfter
   重新注入调度器（迷你重防抖）→ 到点重新抢锁重试；期间其他标签页推送不被空占阻塞
   （后端已确认 retryAfterSeconds = 剩余毫秒向上取整、最小 1，经原生 selectVersion 通道回传）。
3. **空快照守卫**（D9）：force 之外一律跳过空快照。
4. **启动对账**：登录完成（MEK 可用）后调 `startupServerSyncCheck()`；挂 visibilitychange + 15min interval（卸载清理）。

### 5.4 initAutoSync 双通道接线（store/index.ts，示意——按现状微调）

```ts
// ⑤ 导出当前快照并调度双通道备份
const snapshot = useAppStore.getState().exportData();
scheduleBackup(snapshot);                    // WebDAV（原逻辑不动）
scheduleServerBackup(snapshot, {             // 服务端（新增）
  canPush: () => 已登录 && MEK 可用 && readServerSyncMeta().enabled,
  doPush: () => useAppStore.getState().pushServerSnapshot(),
});
```

既有守卫（coreDataLoaded / isSyncingFromRemote / 引用比较）对双通道同时生效，无需重复实现。

### 5.5 UI（WebDAVConfig.tsx 增「服务端备份」区块）

- 状态行：`云端 v7 · 2026-09-04 11:02 · 上次推送成功`（serverLastVersion + serverLastError + 冷却态）
- 按钮：[立即备份]（pushServerSnapshot({force:true})）/ [从云端恢复]（确认弹窗：提示智能合并不覆盖本地）
- 冲突卡（409 后显示）：云端 vX vs 本地待推送 → [合并云端数据]（resolveServerConflict('merge-cloud')）
  / [以本地覆盖云端]（'overwrite-cloud' = 合并后 force 重推）
- 回退告警卡：version < lastSeen → [以本地覆盖云端] / [忽略]
- 说明文案：「端到端加密，服务器仅存储密文；云端保留最近 5 个历史版本；清空本地数据不会自动清空云端」
- 未登录：区块显示「登录后可用」，按钮禁用（D15）

## 6. 前端测试（src/__tests__/serverSync.test.ts）

| 用例组 | 用例 |
|---|---|
| 信封 | build/parse/envelopeToString 往返一致；畸形 JSON / 缺字段 / v!=1 / iv/ct 空串 → parse null |
| sha256Hex | 已知向量；空串 |
| pushBackup（mock fetch） | code 0→ok；40901→conflict 且 latest 正确；40902→empty-conflict；42901→rate+retryAfter；40001→invalid；fetch reject / 非信封响应→network |
| 加密回环 | encryptText/decryptText 往返；错 MEK 拒绝（GCM）；篡改 ct 拒绝；encryptDeflateText/decryptInflateText 往返（中文+重复 JSON）、压缩有效性（ct < 明文）、错 MEK / 篡改 ct 拒绝 |
| 设备 meta | 读写回环；默认值 {lastSeen:0, enabled:true} |
| 推送编排（ioSlice） | 空快照跳过（force 例外）；冷却拦截；409→自动拉取合并→重推一轮；isSyncingFromRemote 期间不推送；lastSeen 更新；42901→锁已释放、按 retryAfter 重调度（不持锁等待） |
| 决策树 | §7.3 七分支逐一覆盖（mock fetchSyncMeta） |

⚠️ 时序类用例沿用 webdavSync.test.ts 既定模式：真实定时器（防抖 50ms 量级）+ `vi.waitFor`；
describe 开头 `vi.restoreAllMocks()` + `vi.unstubAllGlobals()` 防在途请求泄漏污染后续用例
（先例：MKCOL 纳入跨标签页写锁后，固定冲刷微任务的假设失效）。

## 7. 里程碑与验证

| 里程碑 | 内容 | 完成标准 |
|---|---|---|
| M1 后端 | schema.sql + sync 领域包全量 + 单测 | `./mvnw compile -q` 零错误；`./mvnw test '-Dtest=!TaskServiceTest' '-DfailIfNoTests=false'` 全绿（含 ModulithVerify） |
| M2 前端服务层 | cryptoService 增量 + snapshotService 提取 + serverSync.ts + 单测 | `npx tsc --noEmit` 零错误；webdavSync 既有用例零回归；`npm test` 全绿 |
| M3 状态接线 | ioSlice + initAutoSync 双通道 + 启动对账 | `npm test` 全绿；`npm run check:arch` 通过 |
| M4 UI | 同步页区块 + 冲突/回退卡 | §9 手动清单通过 |
| M5 联调上线 | 部署 + 双设备真机验证 | §8 验收项全过 |

后端命令（在 stock-calculator-service 工作区执行）：

```sh
./mvnw compile -q
./mvnw test '-Dtest=!TaskServiceTest' '-DfailIfNoTests=false'
```

前端命令（本仓库）：

```sh
npx tsc --noEmit
npm test
npm run check:arch
```

## 8. 上线与回滚

| 步骤 | 内容 | 注意 |
|---|---|---|
| 1 | postgres/schema.sql 增量执行（两表） | 先于后端发布；IF NOT EXISTS 幂等 |
| 2 | 后端部署（含 native 重建） | 零 yml 改动；新包进 native 需全量构建 |
| 3 | 反代暴露 /api/sync → :18080（Nginx location 或平台 rewrite，与 /api/auth 同法），**client_max_body_size 2m**（E6：默认 1m 会 413） | 未配置前前端自动退避不报错 |
| 4 | 前端发布 | SW 缓存：提示用户强刷或等 autoUpdate 自愈 |

验收清单：

1. 设备 A 修改 → 10s 内云端 v+1；设备 B 刷新 → 拉到并合并
2. 双设备并发编辑 → 一方 409 → 合并 → 重推成功，无数据丢失
3. 断网推送 → 静默退避，本地功能不受影响
4. 数据库直查 user_sync_data → 只有密文信封，无明文
5. 未登录用户看不到可用入口（D15）
6. 无 token 请求 /api/sync/backup/meta → 401（E3：拦截器白名单已登记）
7. 推送 1.5MB+ 信封不 413（E6：client_max_body_size ≥ 2m）

回滚：前端关 `server_sync_meta_v1.enabled`（或回退前端版本）；表保留不删（数据无损）；后端可独立回滚。

## 9. 边界情况清单（开发自测）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 未登录打开同步页 | 区块提示「登录后可用」，按钮禁用 |
| 2 | 会话过期（401） | SessionExpiredError 走既有统一处理；通道静默停 |
| 3 | 双标签页同时推送 | Web Locks 串行；后至者走 409 合并 |
| 4 | localStorage meta 被清 | lastSeen=0 → 云端有数据则静默合并 |
| 5 | 明文快照 > 1.5MB | 40002 → UI 引导清理沙盘归档。v1.3 注：40002/2MB 上限按**压缩后**信封体积判定，明文余量扩约 5-10× |
| 6 | 推送响应丢失重试 | dedup 分支 (b) 命中（version==base+1 且 hash 同） |
| 7 | 清空本地数据 | 不自动上传；显式清空流程推墓碑（D9） |
| 8 | 其他设备推墓碑后本机对账 | 合并结果 = 清空，与用户意图一致 |
| 9 | 服务端回滚（version < lastSeen） | 回退告警卡，不自动动作（D14） |
| 10 | 后端未部署 /api/sync（404） | network 失败退避；WebDAV 通道不受影响 |
| 11 | MEK 不在会话中 | 门控拦截，静默跳过，不报错 |
| 12 | 改密码后恢复 | MEK 不变 → 历史密文仍可解（spec §3.1） |
| 13 | 反代仍为默认 1m 限制（部署遗漏） | 413 → network 文案指向 client_max_body_size（E6），通道退避不阻塞 |
| 14 | 409 合并重推撞频控 | retryAfter 等待后重试一次（E9），不向 UI 报错 |
