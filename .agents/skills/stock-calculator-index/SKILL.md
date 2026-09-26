---
name: stock-calculator-index
description: stock-calculator 前端（React+TS+Vite+Dexie+zustand）的「功能 → 代码落点 + 文档落点」归属索引。修改、新增、排查前端功能前，先用本表定位 store/service/view 锚点，再用 map:features 脚本展开实时文件触点，避免全仓扫描。机制与维护协议见 project-index。
---

# stock-calculator 前端功能索引

机制/格式/维护协议见全局 skill `project-index`。本表只存功能级锚点（低频变化）；文件级实时明细以脚本输出为准，表与脚本冲突时脚本胜。

## 实时触点脚本（首选）

```sh
npm run map:features            # 全量分组输出
npm run map:features -- <域>    # 单域展开（L2），如：-- ledger；可多个：-- ledger kline
```

- `scripts/feature-map.mjs` 按功能分组实时输出视图/状态/服务/计算/测试（含测试文件）。
- 域参数按组名/中文名子串匹配（不区分大小写，如 `做t`、`ledger`）；不存在的域会报 `⚠ 未匹配到功能组`。
- 新文件按功能词命名自动归组；特例在脚本内 GROUPS 登记关键词，跑一次确认「未归类」为 0。
- 锚点按真实职责登记，不看文件名字面义（CostAveraging 实为实盘账本视图，Statistics 实为做T统计页）。

## 归属表

| 领域 | 状态（store） | 服务/计算 | 视图/UI | 文档落点 | 一句话 |
|---|---|---|---|---|---|
| auth（E2EE 认证） | useAuthStore | authApi · cryptoService · apiClient · sessionPersistence · mnemonicService | AuthGate · AuthModal · MnemonicBackupModal 等（components/ui/） | docs/e2ee-auth-spec.md | 会话初始化/注册备份闭环/登录/设备免密 |
| sandbox（沙盘推演） | sandboxStore | sandboxEngine · baselineExtractor · metricsEngine · presetAudit | SandboxPlayback + components/sandbox/* | docs/sandbox-replay-spec.md · sandbox-replay-implementation.md | 事后复盘 What-if：三类分支对比 + 基线重演 |
| tstrategy（做T策略） | streamsSlice | tStreamEngine · strategyGenerators · shortTermTrial · tradingTime · positionAdjustmentPort · useStreamResults(hooks) | TCalculator · Statistics | docs/strategy-generators-review.md | 做T流水撮合派生/策略生成/做T↔中长线衔接 |
| ledger（持仓/账本） | coreSlice · homeSlice · positionsSlice · ordersSlice · roundsSlice | calculator（核心算法）· ledgerService（门面）· store/reconcile | Home（仪表盘）· CostAveraging · PlanOrderCard | docs/position-ledger-spec.md · planned-orders-spec.md | 持仓批次全生命周期/对账/保本价与收益统计 |
| kline（K线/行情） | — | klineService · priceCache（risk/）· useLiveQuotes(hooks) | KlineChart（components/sandbox/） | — | 腾讯前复权日K三级缓存 + A股时段实时行情轮询 |
| stock（股票元数据） | — | stockService | StockAutocomplete（components/ui/） | — | Smartbox 搜索/实时行情/选股元数据落库 |
| import（批量导入） | — | importAdapter · ocrService · importMerger · dedup | views/BatchImport/* | docs/batch-import.md · batch-import-vue.md | 手动填表/剪贴板/OCR 原始数据归一化导入 |
| sync（WebDAV 同步/备份） | ioSlice | webdavSync | WebDAVConfig | — | 多端同步与云端备份 + 全量导入导出 |
| serversync（服务端密文同步） | ioSlice（编排/gate） | serverSync · snapshotService（双通道共用快照格式） | —（initServerSync 启动对账，无专属视图） | docs/server-sync-spec.md · server-sync-implementation.md | 登录即备份：meta 对账/拉取密文/CAS 上传 + 防抖推送管线 |
| fee（费率） | — | feePresets · mathUtils（calcTradeFees） | FeeConfig | — | 规费预设与统一费率计算 |
| risk（风控规则） | — | riskController · validator · auditLogger（src/risk/） | — | docs/risk-module-doc.md | 平仓阻断/规则校验/审计落库；views 直调属有意设计 |
| calc（涨跌幅计算器） | — | —（mathUtils 纯函数） | ChangeRate | — | 涨跌幅↔目标价换算 + 涨跌停阶梯推算 |
| copilot（AI 助手） | copilotSlice · copilotActionSlice | copilotService · copilotActions · copilotSnapshots · usePageContext(hooks) | GlobalCopilot + components/copilot/* | docs/copilot-spec.md · copilot-implementation.md | AI 助手：页面上下文采集 → 动作卡片执行/快照回放 |
| guide（选股引导） | —（canvasSlice 承载，零新 slice） | guideService · canvasTemplates（brief 块条目）· CanvasBriefCard（components/canvas/） | docs/guide-spec.md | 选股引导：确认后的关注对象以画布 brief 块持久承载（提及/题材/公告聚合 + dataVocab「提及数」标号取数）；契约=后端仓 docs/guide/api.md，向导页为可选二期 |
| canvas（自由画布/AI 选股台） | canvasSlice | canvasService · brokerService（K线代理唯一通道）· canvasTemplates（模板注册表：initData/fetchData/dataVocab/操作元数据）· canvasDataQuery（受限取数拦截）· canvasLayout（utils）· canvasExpr（utils）· canvasSummary（utils）· useCanvasContext(hooks) | StockCanvas + components/canvas/*（区块外框/内容/K线划线） | docs/free-canvas-spec.md · free-canvas-backend-integration.md · free-canvas-template-registry.md | 自由画布：八类区块 RGL 布局（注册表驱动）+ K线划线 + canvas_* 动作（注册表分发）+ 受限取数语法（数据卡片）+ 标号取数 AI 上下文 |
| announcement（公告订阅） | announcementSlice | announcementService | AnnouncementSubscribeButton（components/ui/） | — | 公告订阅入口：订阅按钮与订阅状态管理 |
| monitor（价格预告单监控/通知管理） | —（服务端持有，无本地 slice） | monitorService · monitorRule（utils：单边触发边界/建单风险判定） | Settings 页级「通知管理」子菜单 + components/monitor/*（MonitorPanel/MonitorCreateForm/MonitorTaskCard） | docs/monitor/api.md · docs/monitor/design.md | 价格提醒：方向+容差单边判定、30 分钟检查、3 次封顶自动结束、建单提示（触发边界/建单即触发/容差过窄） |
| customstat（自定义统计） | customStatsSlice | customStatsService · customStatsSyncService · utils/customStats/*（vm/worker/dictionary/guard/protocol/client） | CustomStatsPanel + components/customStats/* | docs/custom-stats-spec.md · custom-stats-implementation.md · custom-stats-server-sync.md | 自定义统计指标：字典定义 + VM 沙箱计算 + 图表渲染 + 定义云同步 |
| search（资讯搜索） | searchSlice | searchService · searchPrompts（utils） | NewsSearch + components/search/*（意图过滤/结果卡片/股票档案等） | docs/news-search-spec.md · news-search-implementation.md | 资讯搜索页：意图过滤/结果展示/提示词模板 |
| kg（新闻联播图谱） | kgSlice | kgService · kgText（utils，高亮/时间兜底） | NewsSearch 页级「图谱」模式 + components/kg/*（KgPanel/KgTimeline/KgEntityCard/KgEventDrawer/KgShared） | docs/news-kg-spec.md | 新闻联播事件时间轴：默认浏览/keyword·entityId 检索/热榜与共现漫游/事件详情抽屉 |
| shared（公共 UI/共享资产） | — | toast（utils，全局 Toast 唯一入口）· planFilter（utils，计划单展示窗口口径）· usePlanExecutor（hooks，计划单执行链路） | ModeTabs · EmptyState · Toast 宿主（components/ui/）· PlanOrderList + PlanOrderCard（components/plan/，业务职责仍属 ledger） | — | 跨页复用资产：Tab/分段切换条、空态、全局 Toast、计划单列表容器与执行链路（复用优先与抽取阈值见 frontend-ui-standards §5） |
| app（应用骨架/通用） | index（组装）· bootstrap · types · utils | db/index+schema · persistence（落库队列，utils/ 中立叶子）· idGenerator（utils/ 中立叶子）· useDataLoader(hooks) | App · main · ConfirmModal · InstallPrompt | — | Store 组装/冷启动/落库队列/schema 迁移/domain 权威类型 |

未挂域文档（校准后可补列）：behavior-spec.md · db-schema.png/puml · cloud-run-deploy.md · OcrImportPage.vue（疑似误入 docs）。

## 业务别名映射

口语词/业务说法/易错代码名 → 归属表领域。**失配驱动**：检索脱靶一次补一个，不预罗列同义词。

- **auth**：登录、注册、认证、助记词、设备免密、会话锁
- **sandbox**：沙盘、推演、复盘、What-if、基线重演、分支对比
- **tstrategy**：做T、做T策略、日内、策略生成、统计页；易错代码名：Statistics（实为做T统计页）
- **ledger**：持仓、账本、实盘、保本价、对账、计划单、补仓分摊、扣费重算；易错代码名：CostAveraging（实为实盘账本视图）、PlanOrderCard
- **kline**：行情、K线、日K、实时报价、前复权
- **stock**：选股、股票搜索、Smartbox、股票元数据
- **import**：批量导入、剪贴板导入、OCR 导入、去重
- **sync**：WebDAV、云端备份、多端同步、导入导出
- **serversync**：登录即备份、密文同步、快照对账、CAS 上传
- **fee**：费率、规费、手续费、佣金
- **risk**：风控、平仓阻断、规则校验、审计
- **calc**：涨跌幅、目标价、涨跌停、换算、ChangeRate
- **copilot**：AI 助手、AI 聊天、动作卡片、页面上下文、快照回放
- **announcement**：公告、公告订阅、订阅按钮
- **monitor**：价格提醒、价格预告单、预告单、通知管理、到价提醒、低吸、高抛；易混：`Settings` 视图含费率配置与通知管理两个子菜单（费率仍归 fee） |
- **customstat**：自定义统计、统计指标、指标定义、VM 沙箱、图表
- **search**：资讯搜索、新闻搜索、搜索页、意图过滤
- **kg**：新闻联播图谱、图谱、联播、时间轴、事件抽取、实体热榜、新闻联播；易混：NewsSearch 页内的模式 Tab，非独立路由
- **shared**：公共组件、复用、Tab 条、切换条、分段、空态、胶囊、Toast、计划单列表、执行链路；易混：`ModeTabs` / `EmptyState` 属 shared（跨 search/canvas/ledger 复用）而非某页专属；`PlanOrderList` / `PlanOrderCard` 的实时触点归 ledger（关键词 planorder），但作为可复用容器在 shared 行同步登记
- **app**：冷启动、落库队列、schema 迁移、应用骨架、domain 类型

## 命令速查（跨 skill 指针）

| 场景 | 去处 |
|---|---|
| 改码后验证：类型检查（tsc --noEmit）/ 单测（npm test，pretest 自动先跑 check:arch）/ 护栏单跑（check:arch = check:layers + check:circular） | stock-calculator-frontend-dev §5「验证命令」 |
| 功能触点实时展开（全量/单域/多域） | 本索引「实时触点脚本」（npm run map:features） |
| 终端命令与长文件写入限制 | stock-calculator-workflow「环境限制」 |

## 维护约定

- 新增功能 → 本表加一行 + `scripts/feature-map.mjs` 的 GROUPS 登记关键词（跑一次 `npm run map:features` 确认「未归类」为 0）。
- 新增**跨页复用资产**（UI 组件 / hook / utils）→ 登记进 `shared` 行 + GROUPS 关键词；仅单域使用的仍挂该业务域行（如 `components/plan/*` 触点归 ledger）。
- 锚点改名/拆分/换层 → 同步本表；文档落点按 docs/ 文件名对应，错漏随手修。
- **禁止把文件级触点清单写进本表**（脚本实时输出代替）。
- 关联 skill：stock-calculator-frontend-dev（分层护栏 R1/R2/R3 与写法规范）、project-index（机制）、stock-calculator-workflow（终端命令与写入限制）。
