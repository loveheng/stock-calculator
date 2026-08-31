/**
 * @file useAuthStore.ts
 * @description E2EE 鉴权全局状态机（Zustand）：会话初始化 / 注册备份闭环 / 登录 /
 *              锁屏三级兜底解锁 / 助记词找回改密 / 登出 / 设备免密滑动续期。
 *              状态机与流程规格：docs/e2ee-auth-spec.md §5.5 §6；
 *              后端契约：《E2EE 用户服务 · 接口文档 v1.0》。
 * @layer Store
 * @storage_impact 写 localStorage（会话令牌，经 authSession）、写 AuthDB_v1（设备免密与
 *                 密文缓存/待传队列，经 sessionPersistence）；严禁将 MEK raw、主密码、
 *                 助记词写入任何持久化层。
 *
 * 【与 Supabase 版规范的差异】（后端切换自建服务，决策不变）：
 * - 令牌持久化由本 store 经 authSession 负责（等价 Supabase persistSession）；
 * - hasProfile 三态替代 profile maybeSingle 探测；404 缺行为合法中间态；
 * - 档案写入带 If-Match 乐观锁，profileVersion 跟踪 GET/PUT/409 响应；
 * - 孤儿引导必须持有主密码（KEK 封装需要），故只发生在 login/unlock 流程；
 *   initSession 遇缺行且无待传队列时保持锁定，等待解锁流程引导；
 * - 找回改密依赖本地 recovery_payload 缓存（recovery 会话无档案读权限）。
 */

import { create } from 'zustand';
import type {
  AuthUser,
  PendingBackup,
  PendingProfileUpload,
  ProfilePayloads,
  ProfileResponse,
} from '../types/auth';
import { AuthApiError, SessionExpiredError } from '../services/apiClient';
import {
  getProfile,
  login as apiLogin,
  logout as apiLogout,
  putProfile,
  recoveryConfirm,
  recoveryRequest,
  recoveryVerify,
  register as apiRegister,
} from '../services/authApi';
import {
  AUTH_SESSION_STORAGE_KEY,
  clearStoredAuthSession,
  loadStoredAuthSession,
  saveStoredAuthSession,
} from '../services/authSession';
import {
  META_KEYS,
  clearSessionMEK,
  getMeta,
  loadSessionMEK,
  removeMeta,
  saveSessionMEK,
  setMeta,
  touchSession as touchDeviceSession,
} from '../services/sessionPersistence';
import {
  deriveAuthHash,
  deriveKEK,
  generateRandomMEK,
  normalizeEmail,
  unwrapMEK,
  wrapMEK,
} from '../services/cryptoService';
import {
  deriveRecoveryKey,
  generateMnemonic12,
  normalizeMnemonic,
  validateMnemonic,
} from '../services/mnemonicService';

/** 复用项目 app-toast CustomEvent 模式（前缀 ✅/❌/⚠️/📧） */
function toast(msg: string): void {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }));
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

interface AuthState {
  // ---- 状态 ----
  user: AuthUser | null;
  /** 主数据加解密密钥：运行时仅存内存，禁止明文 raw 落盘/跨业务组件传递 */
  mek: CryptoKey | null;
  /** 后端会话是否有效（等价原 Supabase JWT 语义） */
  isAuthenticated: boolean;
  /** isAuthenticated === true 且 mek === null */
  isLocked: boolean;
  /** 异步动作进行中（启动阶段不阻塞本地功能渲染） */
  isLoading: boolean;
  /** initSession 是否已跑完（防锁屏/弹窗闪烁） */
  initialized: boolean;
  /** 注册/孤儿引导待备份内存态（非 null 时 UI 打开备份弹窗） */
  pendingBackup: PendingBackup | null;
  authModalOpen: boolean;
  resetModalOpen: boolean;
  /** 档案乐观锁版本（GET/PUT/409 响应的 updatedAt 原文） */
  profileVersion: string | null;

  // ---- Actions ----
  initSession(): Promise<void>;
  register(email: string, password: string): Promise<void>;
  /** true=上传闭环；false=失败已入待传队列（弹窗仍关闭，账号可用） */
  confirmBackupMnemonic(input: string): Promise<boolean>;
  login(email: string, password: string, remember: boolean, ttlDays?: number): Promise<void>;
  /** false=主密码错误；网络/服务异常 throw（UI 区分提示） */
  unlockWithPassword(password: string): Promise<boolean>;
  requestRecoveryCode(email: string): Promise<void>;
  resetPasswordWithMnemonic(
    email: string,
    code: string,
    mnemonic: string,
    newPass: string,
  ): Promise<void>;
  logout(): Promise<void>;
  touchSession(): Promise<void>;
  setAuthModalOpen(open: boolean): void;
  setResetModalOpen(open: boolean): void;
}

/** initSession 去重守卫：挂载/storage 事件并发触发时共享同一次执行 */
let initPromise: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => {
  // ==================== 内部工具 ====================

  function payloadsOf(pending: PendingProfileUpload): ProfilePayloads {
    return {
      passwordPayload: pending.passwordPayload,
      passwordIv: pending.passwordIv,
      recoveryPayload: pending.recoveryPayload,
      recoveryIv: pending.recoveryIv,
    };
  }

  function profileMatches(server: ProfileResponse, p: ProfilePayloads): boolean {
    return (
      server.passwordPayload === p.passwordPayload &&
      server.passwordIv === p.passwordIv &&
      server.recoveryPayload === p.recoveryPayload &&
      server.recoveryIv === p.recoveryIv
    );
  }

  /** 后端错误 → 用户可读中文 Error（网络错误已自带文案，原样透传） */
  function mapApiError(e: unknown, fallback: string): Error {
    if (e instanceof AuthApiError) return new Error(e.message || fallback);
    if (e instanceof Error) return e;
    return new Error(fallback);
  }

  /** 登出/会话失效共用清理：令牌 + 设备免密 + 两份密文缓存；待传队列保留（D7） */
  async function clearLocalAuthData(): Promise<void> {
    clearStoredAuthSession();
    await clearSessionMEK().catch(() => undefined);
    await removeMeta(META_KEYS.PASSWORD_PAYLOAD_CACHE).catch(() => undefined);
    await removeMeta(META_KEYS.RECOVERY_PAYLOAD_CACHE).catch(() => undefined);
  }

  function resetState(): void {
    set({
      user: null,
      mek: null,
      isAuthenticated: false,
      isLocked: false,
      pendingBackup: null,
      profileVersion: null,
      authModalOpen: false,
      resetModalOpen: false,
    });
  }

  /** 会话失效统一处理：本地清理 + 未登录态 + 提示（转 SIGNED_OUT 语义） */
  async function handleSessionExpired(): Promise<void> {
    await clearLocalAuthData();
    resetState();
    toast('会话已失效，请重新登录');
  }

  /** GET/PUT 成功后刷新版本号与两份密文缓存（recovery 缓存是找回改密的本地依赖） */
  async function cacheProfile(profile: ProfileResponse): Promise<void> {
    set({ profileVersion: profile.updatedAt });
    await setMeta(META_KEYS.PASSWORD_PAYLOAD_CACHE, {
      payload: profile.passwordPayload,
      iv: profile.passwordIv,
    }).catch(() => undefined);
    await setMeta(META_KEYS.RECOVERY_PAYLOAD_CACHE, {
      payload: profile.recoveryPayload,
      iv: profile.recoveryIv,
    }).catch(() => undefined);
  }

  async function cacheWrappedPayloads(payloads: ProfilePayloads): Promise<void> {
    await setMeta(META_KEYS.PASSWORD_PAYLOAD_CACHE, {
      payload: payloads.passwordPayload,
      iv: payloads.passwordIv,
    }).catch(() => undefined);
    await setMeta(META_KEYS.RECOVERY_PAYLOAD_CACHE, {
      payload: payloads.recoveryPayload,
      iv: payloads.recoveryIv,
    }).catch(() => undefined);
  }

  /**
   * 待传队列补传（幂等重放）：成功清除队列；409 时以服务端版本决策——
   * 内容一致视为补传成功（首次上传部分成功的重放），不一致保留队列并提示，
   * 严禁盲目覆盖（接口文档 §5）。
   */
  async function flushPendingUpload(token: string): Promise<boolean> {
    const pending = await getMeta<PendingProfileUpload>(META_KEYS.PENDING_PROFILE_UPLOAD).catch(
      () => null,
    );
    if (!pending) return false;
    const payloads = payloadsOf(pending);
    try {
      const resp = await putProfile(token, payloads, pending.ifMatch);
      await removeMeta(META_KEYS.PENDING_PROFILE_UPLOAD).catch(() => undefined);
      set({ profileVersion: resp.updatedAt });
      await cacheWrappedPayloads(payloads);
      return true;
    } catch (e) {
      if (e instanceof AuthApiError && e.code === 409) {
        try {
          const server = await getProfile(token);
          set({ profileVersion: server.updatedAt });
          if (profileMatches(server, payloads)) {
            await removeMeta(META_KEYS.PENDING_PROFILE_UPLOAD).catch(() => undefined);
            await cacheWrappedPayloads(payloads);
            return true;
          }
          // 服务端已是其他版本（例如他端已重建档案）：不覆盖，保留队列
          toast('⚠️ 云端密文档案已存在其他版本，待传数据已保留，请以助记词恢复后决策');
        } catch {
          // 决策请求网络失败：保留队列下次再试
        }
      }
      return false;
    }
  }

  // ==================== Actions ====================

  /** 启动初始化（挂载 / storage 跨标签页同步共用；并发去重） */
  async function runInitSession(): Promise<void> {
    set({ isLoading: true });
    try {
      const stored = loadStoredAuthSession();
      if (!stored) {
        // 无会话：清本地设备密钥与密文缓存（待传队列保留，D7）
        await clearSessionMEK().catch(() => undefined);
        await removeMeta(META_KEYS.PASSWORD_PAYLOAD_CACHE).catch(() => undefined);
        await removeMeta(META_KEYS.RECOVERY_PAYLOAD_CACHE).catch(() => undefined);
        resetState();
        return;
      }
      set({ user: { id: stored.userId, email: stored.email }, isAuthenticated: true });
      // GET /profile：校验会话 + 同步档案版本与密文缓存
      try {
        const profile = await getProfile(stored.token);
        await cacheProfile(profile);
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          await handleSessionExpired();
          return;
        }
        if (e instanceof AuthApiError && e.code === 404) {
          // 档案缺行（合法中间态）：有待传队列则补传；否则保持锁定，
          // 等待解锁流程凭主密码引导（无密码无法完成 KEK 封装，见规范修订）
          await flushPendingUpload(stored.token);
        }
        // 网络错误：离线降级，直接尝试本地 MEK 恢复
      }
      const mek = await loadSessionMEK();
      if (mek) {
        set({ mek, isLocked: false });
      } else {
        set({ mek: null, isLocked: true });
      }
      await touchDeviceSession();
    } finally {
      set({ isLoading: false, initialized: true });
    }
  }

  /**
   * 档案缺行时的恢复/引导（需已持有 KEK，即调用方刚验证过主密码）：
   * 1) 待传队列 → 解封 passwordPayload 恢复原 MEK → 补传；
   * 2) 无队列/解封失败 → 孤儿引导：生成全新 MEK+助记词，双封装存内存，
   *    抽查通过后由 confirmBackupMnemonic 上传（首建无 If-Match）。
   */
  async function recoverOrBootstrap(kek: CryptoKey, token: string): Promise<CryptoKey> {
    const pending = await getMeta<PendingProfileUpload>(META_KEYS.PENDING_PROFILE_UPLOAD).catch(
      () => null,
    );
    if (pending) {
      let recovered: CryptoKey | null = null;
      try {
        recovered = await unwrapMEK(pending.passwordPayload, pending.passwordIv, kek);
      } catch {
        // 待传密文与当前密码不匹配（期间他端改密等）：作废队列，走孤儿引导
        await removeMeta(META_KEYS.PENDING_PROFILE_UPLOAD).catch(() => undefined);
      }
      if (recovered) {
        // 本地已恢复 MEK：补传失败不阻塞登录（队列保留，下次启动重试）
        try {
          const resp = await putProfile(token, payloadsOf(pending), pending.ifMatch);
          set({ profileVersion: resp.updatedAt });
          await removeMeta(META_KEYS.PENDING_PROFILE_UPLOAD).catch(() => undefined);
          await cacheWrappedPayloads(payloadsOf(pending));
        } catch {
          // 网络/409：保留队列，后续 flushPendingUpload 决策
        }
        return recovered;
      }
    }
    // 孤儿引导（全新账号无云端数据，无实际损失）
    const mek = await generateRandomMEK();
    const mnemonic = generateMnemonic12();
    const passwordPayload = await wrapMEK(mek, kek);
    const recoveryKey = await deriveRecoveryKey(mnemonic);
    const recoveryPayload = await wrapMEK(mek, recoveryKey);
    set({ pendingBackup: { mnemonic, passwordPayload, recoveryPayload } });
    return mek;
  }

  return {
    // ---- 初始状态 ----
    user: null,
    mek: null,
    isAuthenticated: false,
    isLocked: false,
    isLoading: false,
    initialized: false,
    pendingBackup: null,
    authModalOpen: false,
    resetModalOpen: false,
    profileVersion: null,

    initSession(): Promise<void> {
      if (!initPromise) {
        initPromise = runInitSession().finally(() => {
          initPromise = null;
        });
      }
      return initPromise;
    },

    /** 注册（注册即登录）：本地生成 MEK+助记词 → 双封装仅存内存 → 抽查通过后才上传（D2/D9） */
    async register(email: string, password: string): Promise<void> {
      const norm = normalizeEmail(email);
      if (!isValidEmail(norm)) throw new Error('邮箱格式不正确');
      if (password.length < 8) throw new Error('主密码至少 8 位');
      set({ isLoading: true });
      try {
        const authHash = await deriveAuthHash(password, norm);
        const resp = await apiRegister(norm, authHash).catch((e) => {
          throw mapApiError(e, '注册失败，请稍后重试');
        });
        saveStoredAuthSession({
          token: resp.token,
          userId: resp.userId,
          email: norm,
          expiresAt: resp.expiresAt,
        });
        const mek = await generateRandomMEK();
        const mnemonic = generateMnemonic12();
        const kek = await deriveKEK(password, norm);
        const passwordPayload = await wrapMEK(mek, kek);
        const recoveryKey = await deriveRecoveryKey(mnemonic);
        const recoveryPayload = await wrapMEK(mek, recoveryKey);
        // 待备份内存态先于任何上传存在；抽查通过前服务端零档案（不变量 D9）
        set({
          user: { id: resp.userId, email: norm },
          isAuthenticated: true,
          mek,
          isLocked: false,
          pendingBackup: { mnemonic, passwordPayload, recoveryPayload },
          profileVersion: null,
        });
      } finally {
        set({ isLoading: false });
      }
    },

    /**
     * 抽查通过后的上传闭环：归一化比对 → PUT（带 If-Match）→ 成功闭环；
     * 网络/系统失败入待传队列（auth_meta 密文落盘），下次启动/登录自动补传。
     * @returns true=闭环完成；false=已入待传队列（弹窗仍关闭，账号可用）
     */
    async confirmBackupMnemonic(input: string): Promise<boolean> {
      const { pendingBackup, profileVersion } = get();
      if (!pendingBackup) throw new Error('当前没有待备份的密钥状态');
      if (normalizeMnemonic(input) !== normalizeMnemonic(pendingBackup.mnemonic)) {
        throw new Error('输入与助记词不一致，请核对后重试');
      }
      const stored = loadStoredAuthSession();
      if (!stored) {
        await handleSessionExpired();
        throw new Error('会话已失效，请重新登录');
      }
      const payloads: ProfilePayloads = {
        passwordPayload: pendingBackup.passwordPayload.payload,
        passwordIv: pendingBackup.passwordPayload.iv,
        recoveryPayload: pendingBackup.recoveryPayload.payload,
        recoveryIv: pendingBackup.recoveryPayload.iv,
      };
      try {
        const resp = await putProfile(stored.token, payloads, profileVersion);
        set({ profileVersion: resp.updatedAt, pendingBackup: null });
        await removeMeta(META_KEYS.PENDING_PROFILE_UPLOAD).catch(() => undefined);
        await cacheWrappedPayloads(payloads);
        return true;
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          await handleSessionExpired();
          throw new Error('会话已失效，请重新登录');
        }
        // 409：服务端已有其他版本（如首建部分成功的重放残留）——决策而非覆盖（接口文档 §5）
        if (e instanceof AuthApiError && e.code === 409) {
          try {
            const server = await getProfile(stored.token);
            set({ profileVersion: server.updatedAt });
            if (profileMatches(server, payloads)) {
              set({ pendingBackup: null });
              await cacheWrappedPayloads(payloads);
              return true; // 幂等重放：服务端内容与本地上传意图一致
            }
          } catch {
            // 版本决策请求失败：按未决策处理，走待传队列
          }
        }
        // 入待传队列（密文安全落盘），下次登录/启动自动补传
        const pending: PendingProfileUpload = {
          ...payloads,
          ifMatch: profileVersion,
          savedAt: Date.now(),
        };
        await setMeta(META_KEYS.PENDING_PROFILE_UPLOAD, pending).catch(() => undefined);
        set({ pendingBackup: null });
        return false;
      }
    },

      /**
       * 登录：authHash 登录 → hasProfile 三态分支。
       * - true：拉档案 → KEK 解封 → 解锁；
       * - false/null：待传队列补传（本地恢复 MEK）或孤儿引导（密码刚验证过，无需再验证）。
       */
      async login(
        email: string,
        password: string,
        remember: boolean,
        ttlDays = 7,
      ): Promise<void> {
        const norm = normalizeEmail(email);
        if (!isValidEmail(norm)) throw new Error('邮箱格式不正确');
        if (!password) throw new Error('请输入主密码');
        set({ isLoading: true });
        try {
          const authHash = await deriveAuthHash(password, norm);
          const resp = await apiLogin(norm, authHash, remember ? ttlDays : 7).catch((e) => {
            throw mapApiError(e, '登录失败，请稍后重试');
          });
          saveStoredAuthSession({
            token: resp.token,
            userId: resp.userId,
            email: norm,
            expiresAt: resp.expiresAt,
          });
          set({ user: { id: resp.userId, email: norm }, isAuthenticated: true });
          const kek = await deriveKEK(password, norm);
          let mek: CryptoKey | null = null;
          if (resp.hasProfile === true) {
            const profile = await getProfile(resp.token).catch((e) => {
              if (e instanceof SessionExpiredError) throw e;
              // 登录响应 hasProfile=true 但档案实际缺行（极端不一致）：走补传/引导分支
              if (e instanceof AuthApiError && e.code === 404) return null;
              throw e;
            });
            if (profile) {
              await cacheProfile(profile);
              try {
                mek = await unwrapMEK(profile.passwordPayload, profile.passwordIv, kek);
              } catch {
                // 服务端密码已验证但密文解不开：档案与密码不匹配，禁止加载错误 MEK
                throw new Error('密钥数据异常，请使用助记词找回密码');
              }
            }
          }
          if (!mek) {
            mek = await recoverOrBootstrap(kek, resp.token);
          }
          set({ mek, isLocked: false });
          if (remember) {
            await saveSessionMEK(mek, ttlDays).catch(() =>
              toast('⚠️ 本地存储异常：免密登录未开启'),
            );
          }
          set({ authModalOpen: false });
        } finally {
          set({ isLoading: false });
        }
      },

      /**
       * 锁屏解锁（D4 三级兑底）：
       * 一级：本地 password_payload_cache 解封；
       * 二级：静默重拉服务端档案再解封（刷新过期缓存）；
       * 三级：档案 404 → 先用登录端点验证主密码（防 typo 用错误 KEK 建档）→ 孤儿引导。
       * @returns false=主密码错误（UI 摇晃+提示）；网络/服务异常 throw
       */
      async unlockWithPassword(password: string): Promise<boolean> {
        const { user, isAuthenticated } = get();
        if (!isAuthenticated || !user) return false;
        set({ isLoading: true });
        try {
          const stored = loadStoredAuthSession();
          if (!stored) {
            await handleSessionExpired();
            throw new Error('会话已失效，请重新登录');
          }
          const kek = await deriveKEK(password, user.email);
          // 一级：本地缓存
          const cache = await getMeta<{ payload: string; iv: string }>(
            META_KEYS.PASSWORD_PAYLOAD_CACHE,
          ).catch(() => null);
          if (cache) {
            try {
              const mek = await unwrapMEK(cache.payload, cache.iv, kek);
              set({ mek, isLocked: false });
              await touchDeviceSession();
              return true;
            } catch {
              // 缓存过期（他端改密）：进入二级重拉
            }
          }
          // 二级：服务端重拉
          let profile: ProfileResponse;
          try {
            profile = await getProfile(stored.token);
          } catch (e) {
            if (e instanceof SessionExpiredError) {
              await handleSessionExpired();
              throw new Error('会话已失效，请重新登录');
            }
            if (e instanceof AuthApiError && e.code === 404) {
              // 三级兑底：档案缺行 → 验证主密码后孤儿引导。
              // 用登录端点验证 authHash（防 typo 用错误 KEK 建档导致后续登录无法解封）
              const WRONG_PASSWORD = new Error('__WRONG_PASSWORD__');
              try {
                const authHash = await deriveAuthHash(password, user.email);
                const resp = await apiLogin(user.email, authHash, 7).catch((err) => {
                  if (err instanceof AuthApiError && err.code === 400) throw WRONG_PASSWORD;
                  throw mapApiError(err, '解锁失败，请稍后重试');
                });
                saveStoredAuthSession({
                  token: resp.token,
                  userId: resp.userId,
                  email: user.email,
                  expiresAt: resp.expiresAt,
                });
                const mek = await generateRandomMEK();
                const mnemonic = generateMnemonic12();
                const passwordPayload = await wrapMEK(mek, kek);
                const recoveryKey = await deriveRecoveryKey(mnemonic);
                const recoveryPayload = await wrapMEK(mek, recoveryKey);
                set({
                  mek,
                  isLocked: false,
                  pendingBackup: { mnemonic, passwordPayload, recoveryPayload },
                });
                await touchDeviceSession();
                return true;
              } catch (err) {
                if (err === WRONG_PASSWORD) return false;
                throw err;
              }
            }
            // 网络异常：与密码错误严格区分
            throw new Error(e instanceof Error ? e.message : '网络异常，无法校验主密码');
          }
          await cacheProfile(profile);
          try {
            const mek = await unwrapMEK(profile.passwordPayload, profile.passwordIv, kek);
            set({ mek, isLocked: false });
            await touchDeviceSession();
            return true;
          } catch {
            return false; // 两级均为密钥不匹配 → 主密码错误
          }
        } finally {
          set({ isLoading: false });
        }
      },

      /** 找回 Step 1：请求验证码（未知邮箱静默 200 防枚举；429/500 透传服务端文案） */
      async requestRecoveryCode(email: string): Promise<void> {
        const norm = normalizeEmail(email);
        if (!isValidEmail(norm)) throw new Error('邮箱格式不正确');
        set({ isLoading: true });
        try {
          await recoveryRequest(norm).catch((e) => {
            throw mapApiError(e, '验证码发送失败，请稍后重试');
          });
        } finally {
          set({ isLoading: false });
        }
      },

      /**
       * 找回 Step 2：本地验证助记词（OTP 单次消费，错误助记词不浪费验证码）→
       * verify 拿 recovery 会话 → confirm 原子改密（新 KEK 重封装 MEK，服务端同步
       * 更新密码密文并吊销他端全部会话）→ 全量新会话落地，进已解锁态。
       * 依赖本地 recovery_payload 缓存（recovery 会话无档案读权限，接口契约使然）。
       */
      async resetPasswordWithMnemonic(
        email: string,
        code: string,
        mnemonic: string,
        newPass: string,
      ): Promise<void> {
        const norm = normalizeEmail(email);
        if (!isValidEmail(norm)) throw new Error('邮箱格式不正确');
        const words = normalizeMnemonic(mnemonic);
        if (!validateMnemonic(words)) throw new Error('助记词格式不正确（需 12 个英文单词）');
        if (newPass.length < 8) throw new Error('新主密码至少 8 位');
        set({ isLoading: true });
        try {
          const recoveryCache = await getMeta<{ payload: string; iv: string }>(
            META_KEYS.RECOVERY_PAYLOAD_CACHE,
          ).catch(() => null);
          if (!recoveryCache) {
            throw new Error('本设备缺少恢复凭证缓存：找回密码需在曾登录过该账号的设备上进行');
          }
          const recoveryKey = await deriveRecoveryKey(words);
          let mek: CryptoKey;
          try {
            mek = await unwrapMEK(recoveryCache.payload, recoveryCache.iv, recoveryKey);
          } catch {
            throw new Error('助记词不正确，无法恢复密钥');
          }
          const verify = await recoveryVerify(norm, code.trim()).catch((e) => {
            throw mapApiError(e, '验证码错误或已过期');
          });
          const newKek = await deriveKEK(newPass, norm);
          const newPasswordPayload = await wrapMEK(mek, newKek);
          const newAuthHash = await deriveAuthHash(newPass, norm);
          const confirm = await recoveryConfirm(verify.token, newAuthHash, {
            passwordPayload: newPasswordPayload.payload,
            passwordIv: newPasswordPayload.iv,
          }).catch((e) => {
            if (e instanceof SessionExpiredError) {
              throw new Error('恢复会话已过期，请重新发起找回流程');
            }
            throw mapApiError(e, '密码重置失败，请稍后重试');
          });
          // recovery 会话换全量新会话：落地并进入已解锁态（MEK 无损恢复）
          saveStoredAuthSession({
            token: confirm.token,
            userId: confirm.userId,
            email: norm,
            expiresAt: confirm.expiresAt,
          });
          set({
            user: { id: confirm.userId, email: norm },
            isAuthenticated: true,
            mek,
            isLocked: false,
            profileVersion: null, // confirm 响应无档案版本，下次 GET 再同步
            resetModalOpen: false,
            authModalOpen: false,
          });
          // 密码缓存换新封装；recovery 缓存不变（助记词未更换）
          await setMeta(META_KEYS.PASSWORD_PAYLOAD_CACHE, newPasswordPayload).catch(() => undefined);
        } finally {
          set({ isLoading: false });
        }
      },

      /** 登出（D7）：吊销服务端会话 + 清本地密钥态；保留待传队列；本地账本数据零触碰 */
      async logout(): Promise<void> {
        const stored = loadStoredAuthSession();
        if (stored) await apiLogout(stored.token); // 幂等，内部吞错
        await clearLocalAuthData();
        resetState();
      },

      /** 滑动续期（D3）：仅刷新本地设备免密记录；服务端会话由后端自动滑动 */
      async touchSession(): Promise<void> {
        await touchDeviceSession();
      },

      setAuthModalOpen(open: boolean): void {
        set({ authModalOpen: open });
      },

      setResetModalOpen(open: boolean): void {
        set({ resetModalOpen: open });
      },
    };
  });
