/**
 * @file canvasTemplates.ts
 * @description 画布模板注册表（docs/free-canvas-template-registry.md §二）：模板的单一事实源——
 *              label/icon/默认尺寸/初始 data/受限取数词表/后处理操作元数据/AI 能力提示全部收编于此，
 *              新增模板 = 注册一个对象（八类手动模板 + aiOnly 的 widget DSL 动态模板）。
 *              分层纪律（check-layers R2）：本文件为 utils 纯函数层，**禁 import store**——
 *              操作元数据（op/tier/guard/summarize）在此登记，exec 闭包由 copilotActionSlice
 *              （slice 层）在分发时绑定（get/set 由 zustand 注入，store 访问不出 slice）；
 *              fetchData/dataFetcher 仅依赖 services（brokerService/authSession），状态合并由调用方完成。
 * @layer Utils (Registry)
 * @storage_impact 无持久化读写；取数经 brokerService 内存缓存/代理。
 * @author 开发团队
 */

import type { ReactNode } from 'react';
import {
  CandlestickChart,
  Table2,
  ChartLine,
  Gauge,
  Image as ImageIcon,
  FileText,
  Type as TypeIcon,
  LayoutTemplate,
  UserSearch,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CanvasBlock, CanvasBlockData, CanvasBlockType } from '../types/domain';
import {
  asCanvasAddBlockPayload,
  asCanvasAddWidgetPayload,
  asCanvasSetStockPayload,
  asCanvasUpdateTextPayload,
  asCanvasSetMetricPayload,
  asCanvasUpdateTablePayload,
  asCanvasAddHLinePayload,
  asCanvasAddTrendlinePayload,
  asCanvasRemoveBlockPayload,
  asCanvasRefreshPayload,
  type SanitizedCopilotPayload,
} from './copilotActions';
import { getBrokerKlines, getCachedBrokerKlines, BrokerUnavailableError, type BrokerKline } from '../services/brokerService';
import { fetchStockBrief } from '../services/guideService';
import { loadStoredAuthSession } from '../services/authSession';

// ============================================================
// 数据卡片（受限取数产物：对话流渲染 + LLM messages 同源）
// ============================================================

/** 数据卡片内容（docs/free-canvas-template-registry.md §二：用户所见与 AI 所得同源） */
export interface CanvasDataCard {
  /** 卡片标题（如「A1 腾讯控股 · 收盘价」） */
  title: string;
  /** 键值行（只读展示） */
  rows: { label: string; text: string; raw: number | string }[];
  /** 取数时间（ISO，卡片注明时效） */
  asOf: string;
  /** 拼入 LLM 的纯文本形态：`[系统获取] A1 (腾讯控股) 收盘价: 310.40` 逐行拼接 */
  toPromptText: () => string;
}

/** 组装数据卡片（toPromptText 与 rows 单次成型，杜绝双源漂移） */
export function buildDataCard(title: string, rows: CanvasDataCard['rows']): CanvasDataCard {
  return {
    title,
    rows,
    asOf: new Date().toISOString(),
    toPromptText: () =>
      [`[系统获取] ${title}`, ...rows.map((r) => `${r.label}: ${r.text}`)].join('\n'),
  };
}

// ============================================================
// 模板操作元数据（exec 由 slice 层绑定，见 copilotActionSlice.dispatchCanvasAction）
// ============================================================

/**
 * 模板后处理操作元数据（一期 = 现有 canvas_* 动作的注册表映射）。
 * guard 引用 copilotActions.ts 集中守卫（不复制逻辑，白名单安全纪律保持单点）；
 * tier 沿用 copilotActions 分级纪律；exec 在 slice 层按 op 名绑定。
 */
export interface CanvasOperationMeta {
  /** 操作名 = canvas_ 动作后缀（如 'set_stock'） */
  op: string;
  tier: 'auto' | 'confirm';
  /** 载荷守卫（集中守卫引用；null = 整条丢弃）。返回具体载荷类型（SanitizedCopilotPayload 联合成员） */
  guard: (p: unknown) => SanitizedCopilotPayload | null;
  /** 确认卡/人话摘要（可选，缺省用通用模板） */
  summarize?: (p: Record<string, unknown>) => string;
}

// ============================================================
// 取数接口
// ============================================================

/** fetchData 结果：data 增量（调用方 updateCanvasBlockData 合并）+ kline 序列（组件态消费，不入块 data） */
export interface CanvasFetchResult {
  data?: Partial<CanvasBlockData[CanvasBlockType]>;
  klines?: BrokerKline[];
}

/** 会话 token 获取（无登录即视为取数不可用——画布数据需登录，产品定案） */
function requireToken(): string {
  const token = loadStoredAuthSession()?.token;
  if (!token) throw new BrokerUnavailableError('登录后可获取行情数据');
  return token;
}

/** 代理缓存优先取 K 线序列（未命中拉代理；force 绕过缓存） */
async function fetchKlineSeries(fullCode: string, force = false): Promise<BrokerKline[]> {
  if (!force) {
    const cached = getCachedBrokerKlines(fullCode);
    if (cached) return cached;
  }
  return getBrokerKlines({ fullCode }, requireToken(), { force });
}

// ============================================================
// 模板注册表条目
// ============================================================

/**
 * 画布模板注册表条目：可选成员允许缺省（text/image/file 等静态模板无 initData/fetchData）。
 * renderCustom 为二期动态模板（run_custom_stat 类）预留位，一期不实现任何调用点。
 */
export interface CanvasTemplate {
  type: CanvasBlockType;
  label: string;
  icon: LucideIcon;
  /** RGL 默认尺寸（canvasLayout.DEFAULT_LAYOUT 由此派生，单一事实源） */
  defaultSize: { w: number; h: number };
  /** 建块默认 data（canvasSlice.addCanvasBlock 收编；缺省 = 空对象兜底） */
  initData?: (params?: { stockCode?: string; content?: string }) => CanvasBlockData[CanvasBlockType];
  /**
   * 统一取数接口（组件挂载/刷新行情共用）：返回 data 增量与/或 K 线序列；
   * null = 该模板不取数；抛错 = 取数失败（调用方转占位/toast，错误分类沿用现有异常体系）。
   * params.force = 绕过缓存强拉（「刷新行情」语义）。二期可扩展 AI 动态参数。
   */
  fetchData?: (block: CanvasBlock, params?: { force?: boolean }) => Promise<CanvasFetchResult> | null;
  /** 本模板可接受的后处理操作元数据（copilotActions 白名单/分级由此派生；exec 在 slice 绑定） */
  operationsMeta: readonly CanvasOperationMeta[];
  /** 受限取数词表（「<标号> <数据词>」精确匹配；空数组 = 不支持取数） */
  dataVocab: readonly string[];
  /** 词表项取数执行：返回数据卡片（缓存优先，未命中走 fetchData 通道） */
  dataFetcher?: (block: CanvasBlock, term: string) => Promise<CanvasDataCard>;
  /** 二期预留：动态模板自定义渲染钩子；一期不实现 */
  renderCustom?: (block: CanvasBlock) => ReactNode;
  /**
   * AI 专属模板（一期：widget）——只允许经 canvas_add_widget 动作创建，
   * 手动入口（工具条「+ 添加」下拉 / 空态模板网格 / canvas_add_block 八类守卫）不暴露。
   */
  aiOnly?: boolean;
  /**
   * AI 能力提示·模板专属段（可选，copilot-spec D33 条件携带）：本模板 canvas_* 写操作的
   * 深规格（载荷示例/格式约束），内容必须与本模板 operationsMeta 引用的守卫一字不差地对齐
   * （同仓同 PR 演进，漂移后果 = LLM 产出被守卫静默丢弃）；无写操作的模板（chart/image/file）不设。
   */
  aiPrompt?: string;
  /** 触发词（可选）：用户消息包含任一词 → 该模板 aiPrompt 随请求携带（buildCanvasPromptHints 组装） */
  aiTriggers?: readonly string[];
}

// ============================================================
// kline 模板共享取数实现
// ============================================================

/** kline 区块有效标的（无码 = 不可取数） */
function klineFullCode(block: CanvasBlock): string | null {
  const d = block.data as CanvasBlockData['kline'];
  return d.fullCode || null;
}

/** 单值卡片（取序列最后一根） */
function klineLastCard(block: CanvasBlock, term: string, pick: (k: BrokerKline) => number): Promise<CanvasDataCard> {
  const fullCode = klineFullCode(block);
  if (!fullCode) return Promise.reject(new BrokerUnavailableError(`${block.blockId} 尚未选择股票`));
  return fetchKlineSeries(fullCode).then((series) => {
    if (!series.length) throw new BrokerUnavailableError(`${fullCode} 无行情数据`);
    const last = series[series.length - 1];
    const v = pick(last);
    const name = (block.data as CanvasBlockData['kline']).stockName || fullCode;
    return buildDataCard(`${block.blockId} ${name} · ${term}`, [
      { label: term, text: v.toLocaleString('zh-CN'), raw: v },
      { label: '日期', text: last.date, raw: last.date },
      { label: '数据根数', text: String(series.length), raw: series.length },
    ]);
  });
}

/** 「最近N天」序列卡片（词表精确串：最近10/20/30/60/120天） */
const RECENT_DAYS_RE = /^最近(\d+)天$/;

function klineRecentCard(block: CanvasBlock, term: string): Promise<CanvasDataCard> {
  const fullCode = klineFullCode(block);
  if (!fullCode) return Promise.reject(new BrokerUnavailableError(`${block.blockId} 尚未选择股票`));
  const n = Number(RECENT_DAYS_RE.exec(term)?.[1] ?? 0);
  return fetchKlineSeries(fullCode).then((series) => {
    const slice = series.slice(-n);
    if (!slice.length) throw new BrokerUnavailableError(`${fullCode} 无行情数据`);
    const name = (block.data as CanvasBlockData['kline']).stockName || fullCode;
    const first = slice[0];
    const last = slice[slice.length - 1];
    const chg = first.open ? ((last.close - first.open) / first.open) * 100 : 0;
    return buildDataCard(`${block.blockId} ${name} · ${term}`, [
      { label: '区间', text: `${first.date} ~ ${last.date}`, raw: `${first.date}~${last.date}` },
      { label: '根数', text: String(slice.length), raw: slice.length },
      { label: '区间涨跌', text: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, raw: Number(chg.toFixed(4)) },
      { label: '最新收盘', text: last.close.toFixed(2), raw: last.close },
    ]);
  });
}

// ============================================================
// AI 能力提示（copilot-spec D33 条件携带；prompt 与守卫同仓同 PR 演进）
// ============================================================

/**
 * widget 模板专属段（canvas_add_widget 图纸 schema 用法说明）。
 * 体积纪律：≤8192 UTF-8 字节（单测守护）；硬约束（各字段上限/类型/空串/未知字段）与正例不可省——
 * 约束缺失引发的守卫静默丢弃比省 token 更贵；压文案不压字节（gzip 对 LLM 无意义）。
 */
const WIDGET_AI_PROMPT = `## canvas_add_widget 动态面板（AI 选股台画布）

你可自主创建动态面板：输出受 schema 约束的 JSON 图纸，校验通过即落画布（auto 级，不弹确认卡）。全链路不执行任何代码，只能声明静态内容；面板为静态快照，不随行情刷新（要实时数据改用 K 线/metric 区块）。

何时用：多条静态信息聚合（速览卡/清单/对比结论/检查清单）。不用：单指标 canvas_set_metric；可编辑表格 canvas_update_table；行情 canvas_add_block 建 K 线；长文 canvas_add_block 建 text。

数据纪律（最重要）：数值与结论只能来自本轮取数数据卡片、画布区块摘要或用户消息中的事实，严禁编造行情数字；缺数据先发「标号 数据词」取数，拿到卡片再出图。

动作：canvas_add_widget 的 payload = {"dsl":<图纸>}（动作外壳与输出位置遵循系统动作输出规范，严禁在正文书写动作描述）；一次响应全部动作合计 ≤5 条；标号由系统分配，不可指定 blockId；只能新增，改内容 = canvas_remove_block 删旧标号 + 重新出图，勿重复创建已有面板。

图纸顶层仅 3 字段（多一字段整份作废）："kind"="stack"(纵排)|"grid"(两列)；"title" 非空 ≤40 字；"nodes" 1~8 个叶子，扁平单层禁嵌套。
通用规则：任何层级出现 schema 外字段（嵌套容器/事件属性/样式键）整份作废；字符串非空，超长被静默截断；"tone" 可选 info|warn|danger（危险下跌=danger，警示波动=warn，普通省略）；图纸序列化 ≤8KB；校验失败整条静默丢弃（用户无感知），输出前逐项自检。

8 种叶子（c=种类名，载荷键与种类同名）：
1 {"c":"text","text":{"content":"非空≤200字"}}
2 {"c":"metric","metric":{"label":"≤40字","value":"字符串≤60"}} ← value 必须字符串，写 "310.40" 别写 310.40
3 {"c":"kv","kv":{"rows":[{"label":"≤20字","value":"≤40字"}]}} 1~8 行，行内仅 label/value
4 {"c":"list","list":{"title":"可选≤40字","items":[{"text":"≤60字"}]}} 1~8 项；tone 只能写在 item 上
5 {"c":"table","table":{"columns":["≤20字"],"rows":[["≤30字"]]}} 1~10 列 1~10 行，每行格数=列数，禁空列名/空单元格
6 {"c":"progress","progress":{"label":"≤40字","value":65}} value 必须数字，自动收敛 0~100
7 {"c":"tag","tag":{"tags":["各≤20字"]}} 1~8 个
8 {"c":"divider"} 不带任何载荷

正例（数值须替换为真实取数）：
{"type":"canvas_add_widget","payload":{"dsl":{"kind":"stack","title":"腾讯控股速览","nodes":[{"c":"metric","metric":{"label":"最新收盘","value":"310.40"}},{"c":"kv","kv":{"rows":[{"label":"代码","value":"sh00700"}]}},{"c":"text","text":{"content":"缩量回踩20日线，支撑305。","tone":"warn"}}]}}}

高频错误：metric.value 写成数字；progress.value 写成字符串；nodes 内嵌 nodes；载荷夹带 href/onclick/样式键；table 行格数与列数不符；空串。
`;

// ============================================================
// 注册表（八类手动模板 + widget 动态模板）
// ============================================================

export const CANVAS_TEMPLATES: Readonly<Record<CanvasBlockType, CanvasTemplate>> = {
  kline: {
    type: 'kline',
    label: 'K 线',
    icon: CandlestickChart,
    defaultSize: { w: 6, h: 8 },
    initData: (params) => ({
      fullCode: params?.stockCode ?? '',
      stockName: params?.stockCode ?? '',
      trendLines: [],
      hLines: [],
      maVisible: true,
    }),
    fetchData: (block, params) => {
      const fullCode = klineFullCode(block);
      if (!fullCode) return null;
      return fetchKlineSeries(fullCode, params?.force).then((klines) => ({ klines }));
    },
    operationsMeta: [
      { op: 'set_stock', tier: 'confirm', guard: asCanvasSetStockPayload },
      { op: 'add_hline', tier: 'confirm', guard: asCanvasAddHLinePayload },
      { op: 'add_trendline', tier: 'confirm', guard: asCanvasAddTrendlinePayload },
    ],
    dataVocab: ['收盘价', '开盘价', '成交量', '最近10天', '最近20天', '最近30天', '最近60天', '最近120天'],
    dataFetcher: (block, term) => {
      if (term === '收盘价') return klineLastCard(block, term, (k) => k.close);
      if (term === '开盘价') return klineLastCard(block, term, (k) => k.open);
      if (term === '成交量') return klineLastCard(block, term, (k) => k.volume);
      if (RECENT_DAYS_RE.test(term)) return klineRecentCard(block, term);
      return Promise.reject(new BrokerUnavailableError(`不支持的取数词：${term}`));
    },
    aiPrompt: `## K 线区块专属动作
- canvas_set_stock 换股 {"blockId":"A1","fullCode":"sh600519","stockName"?:"贵州茅台"}——fullCode 必须腾讯形态：2 位市场前缀(sh/sz/bj)+6 位数字，小写。
- canvas_add_hline 水平线 {"blockId":"A1","price":310.5,"label"?:"支撑"}——price 为 JSON 数字；支撑/压力位价格只用取数数据或用户给的数字。
- canvas_add_trendline 趋势线 {"blockId":"A1","startTime":"2026-01-05","startPrice":305.2,"endTime":"2026-02-10","endPrice":318.0}——日期 YYYY-MM-DD 字符串，价格为数字，起点须早于终点。
先从标号摘要确认目标标号是 K 线区块再下发；价格/日期格式不合法整条静默丢弃。`,
    aiTriggers: ['水平线', '趋势线', '支撑位', '压力位', '划线', '换股'],
  },
  table: {
    type: 'table',
    label: '表格',
    icon: Table2,
    defaultSize: { w: 6, h: 6 },
    initData: () => ({
      columns: [
        { key: 'c1', title: '列 1' },
        { key: 'c2', title: '列 2' },
        { key: 'c3', title: '列 3' },
      ],
      rows: [{ c1: '', c2: '', c3: '' }, { c1: '', c2: '', c3: '' }, { c1: '', c2: '', c3: '' }, { c1: '', c2: '', c3: '' }],
    }),
    operationsMeta: [{ op: 'update_table', tier: 'confirm', guard: asCanvasUpdateTablePayload }],
    dataVocab: ['全表'],
    dataFetcher: (block) => {
      const d = block.data as CanvasBlockData['table'];
      // 卡片行数硬限（防大表刷屏；LLM 摘要同样受限）
      const rows: CanvasDataCard['rows'] = d.rows.slice(0, 20).map((row, i) => ({
        label: `第${i + 1}行`,
        text: d.columns.map((c) => row[c.key] ?? '').join(' | '),
        raw: d.columns.map((c) => row[c.key] ?? '').join('|'),
      }));
      if (d.rows.length > 20) {
        rows.push({ label: '截断', text: `其余 ${d.rows.length - 20} 行略`, raw: d.rows.length - 20 });
      }
      return Promise.resolve(buildDataCard(`${block.blockId} 表格（${d.columns.length}列×${d.rows.length}行）`, rows));
    },
    aiPrompt: `## 表格区块专属动作
- canvas_update_table 覆写 {"blockId":"B1","columns":[{"key":"c1","title":"日期"},...],"rows":[{"c1":"09-25",...}]}——columns ≤10 列（key 唯一非空），rows ≤50 行，每格字符串 ≤100 字且键必须是已定义列 key；整块覆写非追加。`,
    aiTriggers: ['写表格', '表格加', '填表'],
  },
  chart: {
    type: 'chart',
    label: '简单图表',
    icon: ChartLine,
    defaultSize: { w: 4, h: 6 },
    initData: () => ({ seriesType: 'line', points: [] }),
    fetchData: (block, params) => {
      const d = block.data as CanvasBlockData['chart'];
      if (!d.sourceBlockId) return null;
      // 绑定 K 线区块的序列读取依赖 store（找 sourceBlockId 区块）——R2 禁 utils→store，
      // 故绑定取数保留在组件侧（ChartContent 经 useAppStore + fetchKlineSeries 同款缓存语义）；
      // 此处仅处理未绑定态：null = 无需取数
      void params;
      return null;
    },
    operationsMeta: [],
    dataVocab: ['数据点'],
    dataFetcher: (block) => {
      const d = block.data as CanvasBlockData['chart'];
      const last = d.points[d.points.length - 1];
      return Promise.resolve(
        buildDataCard(`${block.blockId} 图表数据`, [
          { label: '数据点', text: `${d.points.length} 个`, raw: d.points.length },
          ...(last ? [{ label: '最新', text: `${last.label}=${last.value}`, raw: last.value }] : []),
          { label: '来源', text: d.sourceBlockId ?? '手动录入', raw: d.sourceBlockId ?? 'manual' },
        ]),
      );
    },
  },
  metric: {
    type: 'metric',
    label: '单指标',
    icon: Gauge,
    defaultSize: { w: 3, h: 3 },
    initData: () => ({ label: '指标' }),
    operationsMeta: [{ op: 'set_metric', tier: 'confirm', guard: asCanvasSetMetricPayload }],
    dataVocab: ['当前值'],
    aiPrompt: `## 指标区块专属动作
- canvas_set_metric 设置 {"blockId":"A3","label":"距支撑","value":12.5} 或 {"blockId":"A3","label":"仓位差","calc":"(310.4-300)*100"}——label 必填；value 为有限数字，或 calc 为常量四则表达式（仅数字与 + - * / ( ) . 空格，禁字母变量），二者至少一项。`,
    aiTriggers: ['指标表达式', '设指标', '加指标', '算指标'],
    dataFetcher: (block) => {
      const d = block.data as CanvasBlockData['metric'];
      const v = d.value ?? (d.agent && d.agent.value !== null ? d.agent.value : undefined);
      return Promise.resolve(
        buildDataCard(`${block.blockId} ${d.label}`, [
          {
            label: '当前值',
            text: v !== undefined ? Number(v).toFixed(2) : d.calc ? `表达式 ${d.calc}（未求值）` : '暂无数据',
            raw: v !== undefined ? v : (d.calc ?? ''),
          },
          ...(d.agent ? [{ label: '来源', text: `${d.agent.label}（${d.agent.sourceBlockId}）`, raw: d.agent.sourceBlockId }] : []),
        ]),
      );
    },
  },
  text: {
    type: 'text',
    label: '文本区域',
    icon: TypeIcon,
    defaultSize: { w: 4, h: 4 },
    initData: () => ({ content: '' }),
    operationsMeta: [{ op: 'update_text', tier: 'confirm', guard: asCanvasUpdateTextPayload }],
    dataVocab: [],
    aiPrompt: `## 文本区块专属动作
- canvas_update_text 覆写 {"blockId":"A2","content":"≤500字"}——整块覆写非追加。`,
    aiTriggers: ['写文本', '改文字'],
  },
  image: {
    type: 'image',
    label: '图片',
    icon: ImageIcon,
    defaultSize: { w: 3, h: 4 },
    initData: () => ({}) as CanvasBlockData['image'],
    operationsMeta: [],
    dataVocab: [],
  },
  // 文档区块：对外文案「文档」（工具条添加下拉 / 空态模板网格 / 区块徽标同源）。
  // type key 保持 'file' 不动——存量画布已落库该 type，且 canvas_add_block 守卫白名单与
  // AI 标号摘要（blockSummaryLine 输出 [file]）同此字符串，改名 = 存量块失效 + LLM 载荷被静默丢弃。
  file: {
    type: 'file',
    label: '文档',
    icon: FileText,
    defaultSize: { w: 4, h: 6 },
    initData: () => ({ fileName: '', fileType: '' }),
    operationsMeta: [],
    dataVocab: [],
  },
  // 选股引导档案块（guide-spec v1.1 G2/G3）：确认后的关注对象持久快照；只读无 canvas_* 写操作，
  // 取数词一期仅数字词「提及数」精确直出（防幻觉），列表词待 CanvasDataCard 形状评估后二期登记。
  brief: {
    type: 'brief',
    label: '个股档案',
    icon: UserSearch,
    defaultSize: { w: 4, h: 5 },
    initData: (params) => ({
      stockId: params?.stockCode ?? '',
      stockName: params?.stockCode ?? '',
      days: 7,
      mention: { count: 0, articles: [] },
      subjects: [],
      announcements: [],
    }),
    fetchData: (block) => {
      const d = block.data as CanvasBlockData['brief'];
      if (!d.stockId) return null;
      return fetchStockBrief(d.stockId, d.days).then((resp) => ({
        data: {
          stockName: resp.stockName || d.stockName,
          mention: resp.clsMention,
          subjects: resp.subjects,
          announcements: resp.announcements,
        },
      }));
    },
    operationsMeta: [],
    dataVocab: ['提及数'],
    dataFetcher: (block) => {
      const d = block.data as CanvasBlockData['brief'];
      if (!d.stockId) return Promise.reject(new Error(`${block.blockId} 尚未选择股票`));
      // 直取不缓存：响应为轻量聚合（≤5 文章头/≤5 题材/≤3 公告），每次取词保新鲜
      return fetchStockBrief(d.stockId, d.days).then((resp) =>
        buildDataCard(`${block.blockId} ${resp.stockName || d.stockName} · 提及数`, [
          { label: '提及数', text: String(resp.clsMention.count), raw: resp.clsMention.count },
          { label: '时间窗', text: `近 ${d.days} 天`, raw: d.days },
        ]),
      );
    },
  },
  // DSL 动态模板（aiOnly）：LLM 经 canvas_add_widget 输出 JSON 图纸落块，
  // 无 initData（data 由校验通过的 DSL 注入）/无取数/无后处理操作（拍板：改 = 删旧 + 加新）。
  widget: {
    type: 'widget',
    label: '动态面板',
    icon: LayoutTemplate,
    defaultSize: { w: 6, h: 6 },
    operationsMeta: [],
    dataVocab: [],
    aiOnly: true,
    aiPrompt: WIDGET_AI_PROMPT,
    aiTriggers: ['自定义面板'],
  },
};

// ============================================================
// 通用操作（不属单一模板：remove_block / refresh_klines）
// ============================================================

/** 通用操作元数据（dispatch 分发时与模板操作合并；不属单一模板：add_block / add_widget / remove_block / refresh_klines） */
export const COMMON_OPERATION_META: readonly CanvasOperationMeta[] = [
  { op: 'add_block', tier: 'auto', guard: asCanvasAddBlockPayload },
  // add_widget（DSL 动态模板，auto 级只新增不覆盖）：guard 内经 validateWidgetDsl 单一入口校验图纸
  { op: 'add_widget', tier: 'auto', guard: asCanvasAddWidgetPayload },
  { op: 'remove_block', tier: 'confirm', guard: asCanvasRemoveBlockPayload },
  { op: 'refresh_klines', tier: 'auto', guard: asCanvasRefreshPayload },
];

/** 按 type 查模板（未知 type 返回 undefined，调用方兜底） */
export function getCanvasTemplate(type: CanvasBlockType): CanvasTemplate | undefined {
  return CANVAS_TEMPLATES[type];
}

/** 全量操作元数据（模板操作 + 通用操作；copilotActionSlice 分发绑定 exec 的派生源） */
export function allCanvasOperationMeta(): ReadonlyMap<string, CanvasOperationMeta> {
  const map = new Map<string, CanvasOperationMeta>();
  for (const meta of COMMON_OPERATION_META) map.set(meta.op, meta);
  for (const tpl of Object.values(CANVAS_TEMPLATES)) {
    for (const meta of tpl.operationsMeta) map.set(meta.op, meta);
  }
  return map;
}

// ============================================================
// AI 能力提示组装（copilot-spec D33 条件携带：公共段 + 命中触发词的模板专属段）
// ============================================================

/** 公共段（命中任一模板触发词时随专属段一起携带）：通用动作 + 标号约定 + 数据纪律 */
const CANVAS_PROMPT_COMMON = `## 画布操作能力（AI 选股台）

画布由区块组成，每区块有标号（A1、B2…，删除不复用；现有区块见标号摘要）。通用动作：
- canvas_add_block（自动执行）新建区块 {"type":"kline|table|chart|metric|text|image|file|brief","stockCode"?:"sh600519","content"?:"text 初始内容≤500字"}——brief 为个股档案块：把标的放上画布建档用它，自动聚合近窗口电报提及/题材归属/公告
- canvas_remove_block 删除区块 {"blockId":"A1"}
- canvas_refresh_klines 刷新全部 K 线行情（无参数）
- annotate_block 给区块写备注 {"blockId":"A1","content":"≤200字"}
各模板专属动作（换股/划线/指标/表格/动态面板等）见对应段落；载荷不合法整条静默丢弃（用户无感知），输出前逐项自检。价格等数字只用取数数据或用户给的数字，严禁编造。`;

/**
 * 组装画布能力提示（D33 v1.6 修订）：公共段**必带**，模板专属段按触发词条件携带。
 * 修订动因（2026-09-26 联调事故）：v1.5 未命中触发词返回 undefined——用户「把茅台放上画布」
 * 不含任何已登记触发词，LLM 看不到 canvas_add_block，误用语义相近的 MCP 读工具
 * fetch_kline（只回数据不落画布）并幻觉成功。公共段 ~0.3KB/消息远低于一次误用工具的
 * 代价，「宁多带勿静默失败」升级为公共段无条件在场；scope（canvas）门控仍由调用方负责。
 * 触发词用 includes 宽匹配；跨模板多命中时逐段拼接。
 */
export function buildCanvasPromptHints(question: string): string {
  const sections = Object.values(CANVAS_TEMPLATES)
    .filter((t) => t.aiPrompt && t.aiTriggers?.some((w) => question.includes(w)))
    .map((t) => t.aiPrompt!);
  return [CANVAS_PROMPT_COMMON, ...sections].join('\n\n');
}
