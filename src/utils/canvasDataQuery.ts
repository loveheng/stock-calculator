/**
 * @file canvasDataQuery.ts
 * @description 受限取数语法拦截器（docs/free-canvas-template-registry.md §三）：
 *              「<标号> <数据词>」精确串匹配（无模糊/NLP），词表来自模板注册表 dataVocab。
 *              三分支：命中 → 返回数据卡片 Promise（本地直出，零 token）；标号不存在 /
 *              词未命中 / 非该形态 → null（调用方原样发 AI，自然语言兜底）。
 *              R2 护栏：本文件为 utils 纯函数层，禁 import store——区块清单由 slice 传参。
 * @layer Utils (Pure)
 * @storage_impact 无持久化读写；取数经模板 dataFetcher（brokerService 缓存/代理）。
 * @author 开发团队
 */

import type { CanvasBlock } from '../types/domain';
import { getCanvasTemplate, type CanvasDataCard } from './canvasTemplates';

/** 标号形态：字母列 + 1~2 位序号（与 canvasLayout 分配器同源：A1/B12） */
const BLOCK_QUERY_RE = /^([A-Z]\d{1,2})\s+(.+)$/;

/**
 * 尝试拦截「<标号> <数据词>」形态的提问。
 *
 * @param {string} question - 用户输入（原始文本，内部 trim）
 * @param {CanvasBlock[]} canvasBlocks - 画布区块清单（slice 层 getState() 传入，命令式纪律）
 * @returns {Promise<CanvasDataCard> | null} 命中词表 → 数据卡片 Promise（dataFetcher 异步取数，
 *          缓存未命中走代理，失败 reject 由调用方转失败卡片）；未命中 → null
 */
export function tryInterceptDataQuery(question: string, canvasBlocks: CanvasBlock[]): Promise<CanvasDataCard> | null {
  const m = BLOCK_QUERY_RE.exec(question.trim());
  if (!m) return null;
  const [, blockId, term] = m;
  const block = canvasBlocks.find((b) => b.blockId === blockId);
  if (!block) return null; // 标号不存在 → 原样发 AI（用户可能想聊这个标号而非取数）
  const tpl = getCanvasTemplate(block.type);
  // 词未命中或模板不支持取数 → 原样发 AI（自然语言兜底，两条腿并存）
  if (!tpl?.dataFetcher || !tpl.dataVocab.includes(term)) return null;
  return tpl.dataFetcher(block, term);
}
