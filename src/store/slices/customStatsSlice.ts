/**
 * @file customStatsSlice.ts
 * @description 自定义统计编排切片：run_custom_stat 动作 → 夹具预跑 → 全量 ctx 组装 →
 *              沙箱执行 → 结果入草稿（单槽位覆盖语义）→ 用户拍板保存/迭代/丢弃；
 *              画廊加载、批量刷新（SWR：1× ctx 注入 + N× 执行，分批让出）、
 *              钉选/收藏/软删/重新生成等编排动作。
 *              关键约束：
 *              - 编排在此层（store 允许依赖 db/services/types/utils），service 只做数据读写；
 *              - 「保存」是唯一信任写动作，必须由用户显式触发（spec D6）；
 *              - 全量数据只进沙箱，sampleRows（≤3 行/集合）是唯一进 LLM prompt 的数据。
 * @layer Store (Slice)
 * @storage_impact 经 customStatsService 读写 customStats 表；草稿与 attempt 为内存态，刷新即失。
 * @author 开发团队
 */

import type { StateCreator } from 'zustand';
import type { AppStore } from '../types';
import type { CopilotRunStatPayload, CustomStatDefinition } from '../../types/domain';
import { CUSTOM_STAT_SCHEMA_VERSION } from '../../types/domain';
import { generateId } from '../utils';
import {
  buildFullContext,
  buildPromptContext,
  deleteCustomStatById,
  hardDeleteCustomStatById,
  listCustomStatDefs,
  listCustomStatDefsIncludingDeleted,
  putCustomStatDef,
  recordCustomStatRun,
  replaceCustomStatDef,
  saveCustomStatDef,
  setCustomStatFavorite,
  setCustomStatPinned,
} from '../../services/customStatsService';
import {
  deleteServerCustomStat,
  fetchServerCustomStats,
  putServerCustomStat,
} from '../../services/customStatsSyncService';
import { loadStoredAuthSession } from '../../services/authSession';
import {
  injectStatContext,
  prewarmSandbox,
  runStatCode,
  runStatFixtures,
} from '../../utils/customStats/client';
import type { CustomStatsContextWire } from '../../types/domain';

/** 批量刷新单批上限（批间让出宏任务，长列表刷新不积压主线程） */
const REFRESH_BATCH_SIZE = 6;

/** 批次注入幂等：同一 ctx 不重复传输（JSON 签名对比略重，P0 用批次自增 id 对齐） */
let batchSeq = 0;

/** 重新生成来源登记（regenerateCustomStatDef → startCustomStatDraft 消费，内存态） */
let pendingOriginDefId: string | null = null;

const LAST_SEEN_KEY = 'customStatsLastSeenAt';

function loadLastSeenAt(): string {
  try {
    return localStorage.getItem(LAST_SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistLastSeenAt(iso: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, iso);
  } catch {
    // 隐私模式等 localStorage 不可用：仅内存态降级
  }
}

/** 轻提示（复用 copilotNotice 全局弹窗槽位：后到覆盖先到） */
function notice(get: () => AppStore, title: string, message: string): void {
  get().setCopilotNotice({ title, message, severity: 'info' });
}

export type CustomStatsSlice = Pick<
  AppStore,
  | 'startCustomStatDraft'
  | 'iterateCustomStatDraft'
  | 'clearCustomStatDraft'
  | 'saveCustomStatDraft'
  | 'toggleCustomStatPin'
  | 'toggleCustomStatFavorite'
  | 'deleteCustomStatDef'
  | 'syncCustomStatsFromServer'
  | 'loadCustomStatsGallery'
  | 'refreshLoadedCustomStats'
  | 'runCustomStatDef'
  | 'regenerateCustomStatDef'
  | 'markCustomStatsSeen'
  | 'buildCustomStatPromptContext'
>;

export const createCustomStatsSlice: StateCreator<AppStore, [], [], CustomStatsSlice> = (set, get) => ({
  startCustomStatDraft: async (payload) => {
    const prev = get().customStatDraft;
    if (prev && !prev.running) {
      // 单槽位覆盖规则（FR3）：旧草稿未保存被新草稿替换，轻提示不拦截
      notice(get, '已加载新生成的统计草稿', '未保存的旧草稿已丢弃');
    }
    const originDefId = pendingOriginDefId ?? undefined;
    pendingOriginDefId = null;
    set({
      customStatDraft: {
        code: payload.code,
        name: payload.name,
        description: payload.description,
        prompt: payload.prompt,
        originDefId,
        attempt: prev ? prev.attempt + 1 : 1,
        running: true,
      },
    });

    // ① 夹具预跑（空数组 + 样例）：任一失败不进结果面板，转「一键 AI 修复」
    const fixtureOut = await runStatFixtures(payload.code);
    if (fixtureOut.error) {
      set((s) => ({
        customStatDraft: s.customStatDraft
          ? { ...s.customStatDraft, running: false, error: fixtureOut.error, errorLine: fixtureOut.line }
          : null,
      }));
      return;
    }

    // ② 全量 ctx 组装（一次性）→ 批次注入 → 执行（结果已在 client 侧过 Guard）
    try {
      const ctx = await buildFullContext(get().feeConfig);
      const batchId = `draft-${++batchSeq}`;
      injectStatContext(batchId, ctx);
      const out = await runStatCode(batchId, payload.code);
      if (out.error) {
        set((s) => ({
          customStatDraft: s.customStatDraft
            ? { ...s.customStatDraft, running: false, error: out.error, errorLine: out.line }
            : null,
        }));
        return;
      }
      set((s) => ({
        customStatDraft: s.customStatDraft
          ? { ...s.customStatDraft, running: false, lastResult: out.result }
          : null,
      }));
      // 连续 ≥5 版不收敛：轻提示建议换个描述或先保存最接近版本（FR3）
      const attempt = get().customStatDraft?.attempt ?? 1;
      if (attempt >= 5) {
        notice(get, '已连续多版未收敛', '建议换个描述重新生成，或先保存最接近的版本');
      }
    } catch (e) {
      set((s) => ({
        customStatDraft: s.customStatDraft
          ? { ...s.customStatDraft, running: false, error: e instanceof Error ? e.message : String(e) }
          : null,
      }));
    }
  },

  iterateCustomStatDraft: async (feedback) => {
    const draft = get().customStatDraft;
    if (!draft || !feedback.trim()) return;
    void get()
      .buildCustomStatPromptContext()
      .then((sampleRows) =>
        get().sendMessage(feedback.trim(), {
          taskType: 'custom_stat',
          extraDetail: {
            sampleRows,
            draftContext: { prompt: draft.prompt, code: draft.code, feedback: feedback.trim() },
          },
        }),
      );
  },

  clearCustomStatDraft: () => set({ customStatDraft: null }),

  saveCustomStatDraft: async (option, overrides) => {
    const draft = get().customStatDraft;
    if (!draft?.lastResult || draft.running) return;
    const now = new Date().toISOString();
    const def: CustomStatDefinition = {
      id: generateId(),
      name: overrides?.name?.trim() || draft.name,
      description: overrides?.description?.trim() || draft.description,
      prompt: draft.prompt,
      code: draft.code,
      schemaVersion: CUSTOM_STAT_SCHEMA_VERSION,
      kind: draft.lastResult.kind,
      lastResult: draft.lastResult,
      lastRunAt: now,
      runCount: 1,
      createdAt: now,
      updatedAt: now,
      isDeleted: 0,
    };
    if (option === 'replace') {
      if (!draft.originDefId) return; // 无来源不可替换（UI 不出现该选项，此处兜底）
      await replaceCustomStatDef(draft.originDefId, def);
    } else {
      await saveCustomStatDef(def);
    }
    set({ customStatDraft: null });
    await get().loadCustomStatsGallery();
    notice(get, '统计已保存', `「${def.name}」已加入画廊钉选展示`);
    // 保存即备份：新定义尽快到达服务端（失败静默，下次同步兕底）
    void get().syncCustomStatsFromServer();
  },

  toggleCustomStatPin: async (id, pinned) => {
    await setCustomStatPinned(id, pinned);
    await get().loadCustomStatsGallery();
  },

  toggleCustomStatFavorite: async (id, favorite) => {
    await setCustomStatFavorite(id, favorite);
    await get().loadCustomStatsGallery();
  },

  deleteCustomStatDef: async (id) => {
    await deleteCustomStatById(id);
    await get().loadCustomStatsGallery();
    // 删除传播到服务端（含其他设备）；失败静默，下次同步以本地墓碑重试
    void get().syncCustomStatsFromServer();
  },

  /**
   * 服务端同步（登录即备份；未登录静默跳过）：
   * ① 拉取合并：服务端较新 → 覆盖本地，本地缺失 → 插入（未知 schemaVersion 跳过不落库）；
   * ② 推送：本地较新或服务端缺失的活跃定义整体 upsert；
   * ③ 删除传播：本地墓碑 → 服务端幂等 delete → 确认后物理清理本地墓碑。
   * 全程按 updatedAt LWW（写入侧保留原值，见 db/index.ts toCustomStatEntity），
   * 删除优先于远端较新版本（用户显式删除的意图不被其他设备的编辑复活）。
   * 任何失败静默降级为本地态，下次打开画廊重试。
   */
  syncCustomStatsFromServer: async () => {
    const idle = { pulled: 0, pushed: 0, deleted: 0 };
    if (get().customStatsSyncing) return idle;
    const token = loadStoredAuthSession()?.token;
    if (!token) return idle; // 未登录：功能保持纯本地
    set({ customStatsSyncing: true });
    const counts = { ...idle };
    try {
      const [serverDefs, localDefs] = await Promise.all([
        fetchServerCustomStats(token),
        listCustomStatDefsIncludingDeleted(),
      ]);
      const serverById = new Map(serverDefs.map((d) => [d.id, d]));
      const localById = new Map(localDefs.map((d) => [d.id, d]));

      // ① 拉取合并（墓碑本地行不参与覆盖，删除归 ③ 处理）
      for (const serverDef of serverDefs) {
        if (serverDef.schemaVersion !== CUSTOM_STAT_SCHEMA_VERSION) continue;
        const local = localById.get(serverDef.id);
        if (local && (local.isDeleted === 1 || Date.parse(serverDef.updatedAt) <= Date.parse(local.updatedAt))) {
          continue;
        }
        await putCustomStatDef(serverDef);
        counts.pulled++;
      }

      // ② 推送本地较新 / 服务端缺失的活跃定义（单条失败不阻断：超限/瞬时错误只跳过该条，下次对账重试）
      for (const localDef of localDefs) {
        if (localDef.isDeleted === 1) continue;
        const serverDef = serverById.get(localDef.id);
        if (serverDef && Date.parse(localDef.updatedAt) <= Date.parse(serverDef.updatedAt)) continue;
        try {
          await putServerCustomStat(token, localDef);
          counts.pushed++;
        } catch (e) {
          console.warn(`[customStatsSync] 定义 ${localDef.id} 推送失败，已跳过`, e);
        }
      }

      // ③ 删除传播 + 本地墓碑物理清理（服务端确认成功才清理，失败保留墓碑下次重试）
      for (const localDef of localDefs) {
        if (localDef.isDeleted !== 1) continue;
        try {
          await deleteServerCustomStat(token, localDef.id);
        } catch (e) {
          console.warn(`[customStatsSync] 墓碑 ${localDef.id} 删除传播失败，保留墓碑下次重试`, e);
          continue;
        }
        await hardDeleteCustomStatById(localDef.id);
        counts.deleted++;
      }
    } catch (e) {
      console.warn('[customStatsSync] 同步失败，已降级为本地数据', e);
    } finally {
      set({ customStatsSyncing: false });
    }
    await get().loadCustomStatsGallery();
    return counts;
  },

  loadCustomStatsGallery: async () => {
    const defs = await listCustomStatDefs();
    set({ customStatsGallery: defs });
  },

  refreshLoadedCustomStats: async () => {
    if (get().customStatsRefreshing) return;
    const defs = get().customStatsGallery;
    if (defs.length === 0) return;
    set({ customStatsRefreshing: true });
    try {
      // 1× 全量 ctx 组装与注入，批次内 N 条复用（1× parse + N× 毫秒级执行）
      const ctx = await buildFullContext(get().feeConfig);
      const batchId = `gallery-${++batchSeq}`;
      injectStatContext(batchId, ctx);
      const runnable = defs.filter((d) => d.schemaVersion === CUSTOM_STAT_SCHEMA_VERSION);
      for (let i = 0; i < runnable.length; i += REFRESH_BATCH_SIZE) {
        const batch = runnable.slice(i, i + REFRESH_BATCH_SIZE);
        // 批内串行（Worker 单实例天然串行），批间让出宏任务间隙
        for (const def of batch) {
          const out = await runStatCode(batchId, def.code);
          if (!out.result) continue; // 单条失败不阻断整批（缓存值继续展示）
          await recordCustomStatRun(def.id, out.result, (def.runCount ?? 0) + 1);
          set((s) => ({
            customStatsGallery: s.customStatsGallery.map((d) =>
              d.id === def.id
                ? { ...d, lastResult: out.result, lastRunAt: new Date().toISOString(), runCount: (d.runCount ?? 0) + 1 }
                : d,
            ),
          }));
        }
        if (i + REFRESH_BATCH_SIZE < runnable.length) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    } finally {
      set({ customStatsRefreshing: false });
    }
  },

  runCustomStatDef: async (id) => {
    const def = get().customStatsGallery.find((d) => d.id === id);
    if (!def) return;
    prewarmSandbox();
    const ctx = await buildFullContext(get().feeConfig);
    const batchId = `single-${++batchSeq}`;
    injectStatContext(batchId, ctx);
    const out = await runStatCode(batchId, def.code);
    if (!out.result) {
      notice(get, '运行失败', out.error ?? '统计代码执行异常，可尝试重新生成');
      return;
    }
    await recordCustomStatRun(id, out.result, (def.runCount ?? 0) + 1);
    set((s) => ({
      customStatsGallery: s.customStatsGallery.map((d) =>
        d.id === id
          ? { ...d, lastResult: out.result, lastRunAt: new Date().toISOString(), runCount: (d.runCount ?? 0) + 1 }
          : d,
      ),
    }));
  },

  regenerateCustomStatDef: async (id, extraRequest) => {
    const def = get().customStatsGallery.find((d) => d.id === id);
    if (!def?.prompt) return;
    pendingOriginDefId = id;
    prewarmSandbox();
    const sampleRows = await get().buildCustomStatPromptContext();
    const question = extraRequest?.trim()
      ? `${def.prompt}\n\n修改要求：${extraRequest.trim()}`
      : def.prompt;
    await get().sendMessage(question, {
      taskType: 'custom_stat',
      extraDetail: { sampleRows },
    });
  },

  markCustomStatsSeen: () => {
    const iso = new Date().toISOString();
    persistLastSeenAt(iso);
    set({ customStatsLastSeenAt: iso });
  },

  buildCustomStatPromptContext: async () => {
    const promptCtx = await buildPromptContext(get().feeConfig);
    return promptCtx as unknown as Record<string, unknown>;
  },
});
