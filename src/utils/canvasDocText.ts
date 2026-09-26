/**
 * @file canvasDocText.ts
 * @description 画布文档区块正文摘录（AI 上下文专用）：预取文本类文档正文前 2000 字进内存缓存，
 *              供 useCanvasContext 同步拼进 Copilot 快照 detail（区块级 Click-to-Focus 给全文 2000 字，
 *              整页快照按总预算汇总）。
 *              分层纪律：getData 契约同步 → 正文只能预取缓存（不能 await），故此处维护 blockId → 摘录
 *              的模块级缓存；dataRef 变化即失效重取。二进制读经 canvasService.getBlob（Dexie canvasBlobs）。
 *              前端不可解析的格式（PDF/图片/Office）不产摘录，仅回一句「正文不可提取」占位。
 * @layer Utils (Canvas Doc)
 * @storage_impact 只读 canvasBlobs（getBlob）；摘录仅内存缓存，不落库。
 * @author 开发团队
 */

import type { CanvasBlock, CanvasBlockData } from '../types/domain';
import { getBlob } from '../services/canvasService';

/** 单文档摘录字符上限（用户定案：正文前 2000 字） */
export const DOC_CONTEXT_CHARS = 2000;

/**
 * 整页汇总摘录总预算（字符）：中文 1 字 ≈ 3 字节，4000 字 ≈ 12KB，对齐
 * copilotSnapshots.COPILOT_MAX_BYTES（applySizeGuard 只裁数组/对象，不裁字符串标量——
 * 超长字符串会整条穿过护栏，故此处自限总量，防请求体膨胀）。
 */
export const DOC_CONTEXT_TOTAL_CHARS = 4000;

/** 预览形态（与 CanvasDocBlock 渲染分派同源，避免两处判定漂移） */
export type DocPreviewKind = 'pdf' | 'text' | 'image' | 'none';

/** 由文件名 + MIME 判定文档形态：text = 前端可提取正文，其余不可 */
export function docPreviewKind(fileName: string, mime: string): DocPreviewKind {
  const lower = fileName.toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)) return 'image';
  if (
    mime.startsWith('text/') ||
    /\b(json|xml|csv)\b/.test(mime) ||
    /\.(txt|md|markdown|csv|json|log|ini|ya?ml|xml|html?)$/.test(lower)
  ) {
    return 'text';
  }
  return 'none';
}

interface ExcerptEntry {
  /** 摘录对应的 Blob 引用（变化即失效） */
  dataRef: string;
  /** 正文前 N 字（≤DOC_CONTEXT_CHARS） */
  text: string;
}

/** blockId → 摘录（模块级缓存；页面卸载不清理也无害，随 dataRef 失效更新） */
const excerptCache = new Map<string, ExcerptEntry>();

/** 可提取正文判定：file 块 + 已上传 + 文本类 */
function excerptTarget(b: CanvasBlock): { dataRef: string } | null {
  if (b.type !== 'file') return null;
  const d = b.data as CanvasBlockData['file'];
  if (!d.dataRef) return null;
  return docPreviewKind(d.fileName || '', d.fileType || '') === 'text' ? { dataRef: d.dataRef } : null;
}

/**
 * 预取全部文档块正文摘录（幂等；dataRef 变化才重取）。
 * 失败/非文本/未上传 → 不写入缓存（降级为「无摘录」，不阻塞上下文组装）。
 */
export async function prefetchDocExcerpts(blocks: CanvasBlock[]): Promise<void> {
  const alive = new Set<string>();
  await Promise.all(
    blocks.map(async (b) => {
      alive.add(b.blockId);
      const target = excerptTarget(b);
      if (!target) {
        // 换成不可提取格式 / 清空文档 → 旧摘录立即失效，防 AI 拿到过期正文
        excerptCache.delete(b.blockId);
        return;
      }
      if (excerptCache.get(b.blockId)?.dataRef === target.dataRef) return;
      try {
        const entity = await getBlob(target.dataRef);
        if (!entity) return;
        const raw = await entity.data.text();
        excerptCache.set(b.blockId, { dataRef: target.dataRef, text: raw.slice(0, DOC_CONTEXT_CHARS) });
      } catch {
        // Blob 读取失败 = 静默降级不提供摘录（上下文其余部分照常）
      }
    }),
  );
  // 区块已删除 → 清缓存
  for (const key of excerptCache.keys()) {
    if (!alive.has(key)) excerptCache.delete(key);
  }
}

/** 单块摘录（未预取/不可提取返回 null） */
export function getDocExcerpt(blockId: string): string | null {
  return excerptCache.get(blockId)?.text ?? null;
}

/**
 * 单文档块 → 给 AI 的摘录段（带标号 + 文件名锚点，便于 AI 与标号摘要互引）。
 * 不可提取格式返回一句占位说明（不静默省略，避免 AI 误以为文档为空）。
 */
export function buildDocExcerptText(b: CanvasBlock): string | null {
  if (b.type !== 'file') return null;
  const d = b.data as CanvasBlockData['file'];
  const name = d.fileName || '未命名文档';
  const cached = getDocExcerpt(b.blockId);
  if (cached !== null) {
    return `${b.blockId}《${name}》正文前 ${cached.length} 字摘录：\n"""\n${cached}\n"""`;
  }
  if (!d.dataRef) return `${b.blockId}《${name}》：尚未上传文档`;
  const kind = docPreviewKind(name, d.fileType || '');
  const why = kind === 'pdf' ? 'PDF 正文前端不可提取' : kind === 'image' ? '图片无正文' : '该格式正文不可提取';
  return `${b.blockId}《${name}》：${why}（AI 仅见文件名）`;
}

/**
 * 整页快照用：汇总全部文档块摘录（按标号顺序填至总预算，超出注明省略条数）。
 * 画布无文档块返回 null（调用方据此省略该 detail 键，零 token 开销）。
 */
export function buildDocExcerptSection(blocks: CanvasBlock[]): string | null {
  const parts = blocks.map(buildDocExcerptText).filter((s): s is string => s !== null);
  if (!parts.length) return null;
  const picked: string[] = [];
  let used = 0;
  for (const p of parts) {
    if (used + p.length > DOC_CONTEXT_TOTAL_CHARS) continue;
    picked.push(p);
    used += p.length;
  }
  const omitted = parts.length - picked.length;
  return [
    '## 画布文档正文摘录（单文档前 2000 字，AI 可直接引用）',
    ...picked,
    ...(omitted > 0 ? [`…其余 ${omitted} 个文档摘录因总预算省略，聚焦对应标号可取全文摘录`] : []),
  ].join('\n');
}
