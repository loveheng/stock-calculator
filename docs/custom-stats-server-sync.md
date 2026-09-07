# 自定义统计 · 服务端持久化契约（D17）

> 版本：v1.0（2026-09-07）
> 面向：后端实现者。前端已按本契约实现完毕（`services/customStatsSyncService.ts` + `customStatsSlice.syncCustomStatsFromServer`），后端就绪即可联调。
> 关联：需求 D17（`docs/custom-stats-spec.md`）、实现 §8（`docs/custom-stats-implementation.md`）、后端仓 `docs/custom-stats-api.md`（AI 生成动作契约）。

## 1. 定位与边界

- 自定义统计定义（名称 / 口径说明 / 提示词种子 / JS 代码 / 缓存结果）是**非用户核心数据**：不含账本流水与任何行情明细，明文 JSONB 直存服务端即可。
- **不进 E2EE 快照通道**：与 `/api/sync` 的密文备份互不相干，无需 MEK，登录（持有 Bearer token）即可用。
- 服务端只做存储，不参与计算：代码执行始终在端上沙箱；服务端不理解也不校验 code 语义。
- 粒度为单条定义 upsert/delete，无全量快照、无 CAS 版本冲突；客户端按 `updatedAt` LWW 对账，服务端不做仲裁。

## 2. 表结构（Postgres）

```sql
CREATE TABLE user_custom_stat (
  id                BIGSERIAL PRIMARY KEY,
  user_id           VARCHAR(64) NOT NULL,       -- 登录用户主键（UUID 文本；沿 server-sync 设计 E1 先例：user_sync_data / ai_chat_session 同为 varchar(64)）
  def_id            VARCHAR(64) NOT NULL,       -- 客户端生成的定义 id（uuid 形态字符串）
  payload           JSONB NOT NULL,             -- 完整定义 DTO（§3）
  updated_at_client VARCHAR(40) NOT NULL,       -- 客户端 updatedAt ISO 串：LWW 排序键，原样存储、原样回传
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, def_id)
);
CREATE INDEX idx_user_custom_stat_user ON user_custom_stat (user_id);
```

实现注意：

- payload 内所有时间戳（`createdAt/updatedAt/pinnedAt/lastRunAt`）**必须原样存储原样回传**，服务端不得用自身 `now()` 改写任何业务时间戳——否则客户端 LWW 对账失真（表现为 A 设备保存的内容在 B 设备反复来回覆盖）。
- 防滥用上限建议：单用户行数 ≤ 200；单行 payload ≤ 32KB（其中 code ≤ 16KB、prompt ≤ 2KB 已由前端守卫保证，服务端兜底校验）。
- **限长口径**（前后端一致，前端 `asRunStatPayload` 同口径预检）：`name`/`description` 按**字符数**（40/200），`prompt`/`code` 按 **UTF-8 字节**（2048/16384）——AI 生成代码常带中文注释，字符数与字节数差异是真实场景。
- 删除即物理 `DELETE`（端上才存在软删墓碑，用于删除传播）。

## 3. DTO（= 前端 `CustomStatDefinition`，即 payload JSONB 内容）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | string | ✓ | 与路径 defId 一致 |
| name | string | ✓ | ≤ 40 字符 |
| description | string | – | ≤ 200 字符 |
| prompt | string | – | 需求种子快照，≤ 2048 UTF-8 字节 |
| code | string | ✓ | 沙箱执行代码，≤ 16384 UTF-8 字节 |
| schemaVersion | number | ✓ | 当前恒为 1；原样存储 |
| kind | string | ✓ | `'card'` \| `'chart'` |
| lastResult | object | – | Guard 归一后的结果缓存（kpi 卡或图表数据） |
| lastRunAt | string | – | ISO |
| favorite / pinned | boolean | – | 用户标记 |
| pinnedAt | string | – | ISO，钉选排序键 |
| runCount | number | – | 累计执行次数 |
| originMessageId | string | – | 溯源（设备本地 copilot 消息 id，跨设备无意义但无害，原样存取） |
| createdAt / updatedAt | string | ✓ | ISO，客户端时钟 |

- **上行载荷不含 `isDeleted`**：软删只存在于端上（墓碑），服务端只有存在/不存在两种状态。

## 4. 接口（鉴权与既有 API 一致：`Authorization: Bearer <token>`；统一 `ApiResponse{code, message, data}` 信封）

| 方法 / 路径 | 语义 | 成功 data |
|---|---|---|
| `GET /api/custom-stats` | 当前用户全部定义，按 `updated_at_client` 倒序 | `{ list: DefDTO[] }`（空库返回空数组，非 404） |
| `PUT /api/custom-stats/{defId}` | upsert 单条（按 `(userId, defId)` 幂等覆盖） | `null` |
| `DELETE /api/custom-stats/{defId}` | 幂等删除：**不存在也返回 200** | `null` |

约束与错误码：

- PUT：路径 `defId` 与 `body.id` 不一致 → `40001`；超限（行数/体积/长度，按 §2 限长口径）→ `40001`；
- 401 未认证 / 会话过期 → 走全局会话过期语义（前端对同步失败一律静默降级，不弹窗）；
- P0 无需频控与版本 CAS；如需加频控沿用 `42901`；
- 客户端对非 200 与网络失败统一静默重试（下次打开画廊对账），后端无需补偿机制。

## 5. 客户端合并语义（后端只需知晓，无需实现）

| 规则 | 行为 |
|---|---|
| LWW | 比较各端 `updatedAt`（客户端时钟）：远端较新 → 覆盖本地；本地较新 → 推送远端；相等 → 双向跳过 |
| 删除优先 | 端上墓碑无条件 `DELETE` 远端该条（即使远端版本较新），成功后本地物理清理墓碑 |
| 幂等对账 | 打开画廊即对账（1× GET + 少量 PUT/DELETE），重复执行无副作用；保存/删除后亦即时补推一次 |
| 前向兼容 | `schemaVersion` 未知（本端更高版本产生）的条目跳过不落库，服务端原样存取即可 |

## 6. 联调清单

- [ ] `GET` 空库：`{code:200, data:{list:[]}}`（前端 gallery 正常显示空态）
- [ ] `PUT` 后 `GET`：字段逐项一致，**尤其 `updatedAt` 逐字节回传**
- [ ] `DELETE` 后 `GET` 不再出现；重复 `DELETE` 返回 200
- [ ] 未登录 / 过期 token：`GET/PUT/DELETE` 均 401，前端静默跳过、本地功能不受影响
- [ ] 两台浏览器同账号：A 保存 → B 打开画廊出现该统计（带 NEW 角标）；B 删除 → A 再开画廊该条消失
- [ ] 断网时保存/删除：本地功能正常；恢复网络后重开画廊，变更自动补传
