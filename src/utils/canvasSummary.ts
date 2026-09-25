/**
 * @file canvasSummary.ts
 * @description 画布标号摘要纯函数（spec §6.2 摘要协议）：从 useCanvasContext 下沉至此，
 *              供 hook 与 brokerChatSlice（store 层）共用——slice 禁 import hooks（R 层护栏，
 *              hooks→store 单向），纯函数落 utils 是斩断循环依赖的中立叶子。
 * @layer Utils (Pure)
 * @storage_impact 无。
 * @author 开发团队
 */

import type { CanvasBlock, CanvasBlockData } from '../types/domain';

/** 画布 Copilot 线程 scopeId（独立会话，与公告/日报区块互不叠加；对接文档 §2.2） */
export const CANVAS_SCOPE_ID = 'canvas';

/** 摘要协议硬限（spec §6.2）：每区块 ≤2 行、总 ≤30 行，超出截断 */
const SUMMARY_MAX_BLOCKS = 30;

/** 文本截断（摘要行内防膨胀） */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 单区块数据摘要（≤1 行，类型分派；kline 含划线标签价位；导出供 useCanvasContext 区块级快照复用） */
export function blockDataSummary(b: CanvasBlock): string {
  switch (b.type) {
    case 'kline': {
      const d = b.data as CanvasBlockData['kline'];
      if (!d.fullCode) return '未选股票（可对话下发 canvas_add_block/canvas_set_stock）';
      const hLabels = d.hLines.length ? `，水平线[${d.hLines.map((l) => `${l.label}@${l.price.toFixed(2)}`).join(' ')}]` : '';
      return `${d.stockName || d.fullCode}（${d.fullCode}）日K，划线：水平线${d.hLines.length}条 趋势线${d.trendLines.length}条${hLabels}`;
    }
    case 'text': {
      const d = b.data as CanvasBlockData['text'];
      return d.content ? `「${clip(d.content, 40)}」` : '空';
    }
    case 'metric': {
      const d = b.data as CanvasBlockData['metric'];
      const calc = d.calc ? `（表达式 ${d.calc}）` : '';
      return d.value !== undefined ? `${d.label} 当前值 ${d.value}${calc}` : `${d.label} ${d.calc ? `表达式 ${d.calc}` : '未取值'}`;
    }
    case 'table': {
      const d = b.data as CanvasBlockData['table'];
      return `${d.columns.length}列×${d.rows.length}行`;
    }
    case 'chart': {
      const d = b.data as CanvasBlockData['chart'];
      return `${d.seriesType === 'line' ? '折线' : '柱状'} ${d.points.length}点${d.sourceBlockId ? `（绑定${d.sourceBlockId}）` : ''}`;
    }
    case 'image': {
      const d = b.data as CanvasBlockData['image'];
      return d.imageRef ? '已上传' : '空占位';
    }
    case 'file': {
      const d = b.data as CanvasBlockData['file'];
      return d.fileName || '空占位';
    }
    case 'widget': {
      const d = b.data as CanvasBlockData['widget'];
      const kinds = d.dsl?.nodes?.map((n) => n.c) ?? [];
      const kindText = kinds.length ? `，节点[${kinds.join(',')}]` : '';
      return d.dsl ? `动态面板「${d.dsl.title}」${d.dsl.kind}/${kinds.length}项${kindText}` : '空面板';
    }
  }
}

/** 标号摘要行（区块 ≤2 行协议：标题行 + 数据行；导出供 useCanvasContext 复用） */
export function blockSummaryLine(b: CanvasBlock): string {
  return `${b.blockId}[${b.type}] ${blockDataSummary(b)}（备注${b.notes.length}条）`;
}

/** 画布全量标号摘要（总 ≤30 行，超出截断并提示） */
export function buildCanvasSummary(blocks: CanvasBlock[]): string {
  if (!blocks.length) return '画布为空（尚无区块）';
  const lines = blocks.slice(0, SUMMARY_MAX_BLOCKS).map(blockSummaryLine);
  if (blocks.length > SUMMARY_MAX_BLOCKS) {
    lines.push(`…其余 ${blocks.length - SUMMARY_MAX_BLOCKS} 个区块略`);
  }
  return lines.join('\n');
}
