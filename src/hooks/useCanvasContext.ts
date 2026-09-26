/**
 * @file useCanvasContext.ts
 * @description 画布 AI 上下文桥接（spec §6.2 标号取数协议）：把画布区块按标号摘要注册进
 *              Copilot Registry（scopeId=canvas 独立线程），AI 可引用标号回答区块内容、
 *              经区块级快照（Click-to-Focus）聚焦单个标号取数。
 *              getData 一律 getState() 现场重算（命令式快照纪律），禁闭包捕获渲染态。
 * @layer Hook
 * @storage_impact 纯内存注册，不读写任何存储。
 * @author 开发团队
 */

import { useEffect } from 'react';
import { useAppStore } from '../store';
import { usePageContext } from './usePageContext';
import { CANVAS_SCOPE_ID, buildCanvasSummary, blockDataSummary, blockSummaryLine } from '../utils/canvasSummary';
import { getCanvasTemplate } from '../utils/canvasTemplates';
import { prefetchDocExcerpts, buildDocExcerptText, buildDocExcerptSection } from '../utils/canvasDocText';
import type {
  CanvasBlock,
  CanvasBlockData,
  PageContextSnapshot,
  CopilotContextData,
  CopilotTimeAnchor,
  ContextBlockSnapshot,
  CopilotQuickAction,
} from '../types/domain';

// 摘要协议与 scopeId 常量已下沉 utils/canvasSummary（纯函数层）——brokerChatSlice（store 层）
// 复用时不引入 hooks 循环依赖；此处 re-export 保持既有引用路径兼容。
export { CANVAS_SCOPE_ID, buildCanvasSummary };

/** 快照时间截面（now 语义：采集时刻 + 即时范围标记） */
function nowAnchor(): CopilotTimeAnchor {
  return { asOf: Math.floor(Date.now() / 1000), range: 'now' };
}

/** 单区块 → 区块级快照（Click-to-Focus：AI 聚焦标号取数） */
function toBlockSnapshot(b: CanvasBlock): ContextBlockSnapshot {
  return {
    blockId: `${CANVAS_SCOPE_ID}:${b.blockId}`,
    title: `${b.blockId}[${b.type}] ${blockDataSummary(b)}`,
    suggestedPrompts:
      b.type === 'kline'
        ? [`分析 ${b.blockId} 的 K 线形态`, `给 ${b.blockId} 加一条支撑位备注`]
        : b.type === 'file'
          ? [`总结 ${b.blockId} 文档的要点`, `基于 ${b.blockId} 文档给出结论`]
          : [`总结 ${b.blockId} 的内容`, `给 ${b.blockId} 加备注`],
    getData: () => {
      // 命令式快照：getState() 现场取最新区块（禁闭包捕获渲染态）
      const cur = useAppStore.getState().canvasBlocks.find((x) => x.blockId === b.blockId);
      const overview: Record<string, string | number | boolean> = cur
        ? { 标号: cur.blockId, 类型: cur.type, 备注数: cur.notes.length }
        : { 标号: b.blockId, 已删除: true };
      // 文档块：正文前 2000 字摘录（预取缓存同步读；不可提取格式回一句占位说明）
      const excerpt = cur ? buildDocExcerptText(cur) : null;
      return {
        overview,
        timeAnchor: nowAnchor(),
        detail: {
          block: cur ?? null,
          摘要: cur ? blockSummaryLine(cur) : '区块已删除',
          ...(excerpt ? { 文档正文摘录: excerpt } : {}),
        },
        units: {},
      };
    },
  };
}

/**
 * 画布上下文注册 Hook：StockCanvas 挂载时调用。
 * 整页快照 = 标号摘要（detail.canvasBlocks）；区块级快照逐标号注册（AI 按标号聚焦取数）；
 * quickActions = 快捷按钮条（local 纯前端直执行不经 AI；draft 填草稿；send 直发走动作管线）。
 */
export function useCanvasContext(): void {
  const canvasBlocks = useAppStore((s) => s.canvasBlocks);

  // 文档正文预取：getData 契约同步 → 摘录必须先落内存缓存（区块变化/换文档即重取）
  useEffect(() => {
    void prefetchDocExcerpts(canvasBlocks);
  }, [canvasBlocks]);

  // 快捷按钮条（画布首批配置）：local 类按钮闭包读 getState()（命令式纪律，禁捕获渲染态）
  const quickActions: CopilotQuickAction[] = [
    // -- local：纯前端操作，本地拦截直执行（不经 AI，零 token） --
    { label: '加K线', mode: 'local', handler: () => useAppStore.getState().addCanvasBlock('kline') },
    { label: '加表格', mode: 'local', handler: () => useAppStore.getState().addCanvasBlock('table') },
    { label: '加图表', mode: 'local', handler: () => useAppStore.getState().addCanvasBlock('chart') },
    { label: '加指标', mode: 'local', handler: () => useAppStore.getState().addCanvasBlock('metric') },
    { label: '加文本', mode: 'local', handler: () => useAppStore.getState().addCanvasBlock('text') },
    { label: '加图片', mode: 'local', handler: () => useAppStore.getState().addCanvasBlock('image') },
    { label: '加文档', mode: 'local', handler: () => useAppStore.getState().addCanvasBlock('file') },
    {
      label: '刷新行情',
      mode: 'local',
      handler: () => {
        void useAppStore.getState().refreshCanvasKlines();
      },
    },
    // -- draft：带占位话术，填入草稿供用户改后发送（AI 理解后下发 canvas_* 动作） --
    { label: '对比两只K线', mode: 'draft', prompt: '帮我加两只 K 线对比 sh600519 和 sh000858' },
    { label: '加支撑位', mode: 'draft', prompt: '给 A1 加一条支撑位水平线' },
    // -- 自定义动态面板（D33 条件携带入口）：触发词取注册表 widget.aiTriggers 首词，
    //    预填触发词草稿供用户补全；发送命中触发词后该轮才携带图纸 schema --
    { label: '自定义面板', mode: 'draft', prompt: `${getCanvasTemplate('widget')?.aiTriggers?.[0] ?? '自定义面板'}：帮我做一张面板，展示` },
    // -- send：一句话意图明确，直接发送（confirm 动作照常出确认卡） --
    { label: '总结画布', mode: 'send', prompt: '总结画布上所有区块的分析结论' },
  ];

  const snapshot: PageContextSnapshot = {
    scopeId: CANVAS_SCOPE_ID,
    title: 'AI 选股台 · 自由画布',
    quickActions,
    getData: () => {
      // 命令式快照：getState() 现场重算（spec §6.2 摘要协议硬限内）
      const blocks = useAppStore.getState().canvasBlocks;
      const klineCount = blocks.filter((b) => b.type === 'kline').length;
      const noteCount = blocks.reduce((n, b) => n + b.notes.length, 0);
      // 文档正文摘录汇总（无文档块 = 省略该键，零额外 token；总量自限见 canvasDocText）
      const docExcerpts = buildDocExcerptSection(blocks);
      return {
        overview: {
          区块数: blocks.length,
          K线区块数: klineCount,
          备注总数: noteCount,
        },
        timeAnchor: nowAnchor(),
        detail: {
          canvasBlocks: buildCanvasSummary(blocks),
          units: { 区块数: '个', 备注总数: '条' },
          ...(docExcerpts ? { 文档正文摘录: docExcerpts } : {}),
        },
        units: {},
      };
    },
    blocks: canvasBlocks.map(toBlockSnapshot),
  };

  usePageContext(snapshot);
}
