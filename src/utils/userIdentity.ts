/**
 * @file userIdentity.ts
 * @description 用户身份视觉标识纯函数：由邮箱稳定派生「显示名（邮箱名前三位）」与
 *              「可爱头像基因（色相 + 表情 + 头饰）」。同一邮箱恒得同一结果，
 *              无随机数、无存储读写，供顶部栏账户区与锁屏弹窗复用（R2：放 utils 纯函数层）。
 * @layer Utility
 * @storage_impact 纯函数，无存储读写。
 * @author 开发团队
 */

/** 显示名截取长度：取邮箱名（@ 之前）的前三位 */
export const DISPLAY_NAME_LENGTH = 3;

/** 表情变体总数（眼睛 + 嘴巴组合） */
export const FACE_VARIANT_COUNT = 5;

/** 头饰变体总数（兽耳 / 呆毛 / 小芽等） */
export const DECOR_VARIANT_COUNT = 5;

/** 头像基因：决定一颗头像的全部观感 */
export interface AvatarGene {
  /** 主色相，0-359 */
  hue: number;
  /** 表情变体索引，0..FACE_VARIANT_COUNT-1 */
  face: number;
  /** 头饰变体索引，0..DECOR_VARIANT_COUNT-1 */
  decor: number;
}

/** 头像配色：由主色相派生的 HSL 字符串组 */
export interface AvatarPalette {
  /** 圆形底板色（浅色） */
  bg: string;
  /** 头部渐变起始色 */
  from: string;
  /** 头部渐变结束色 */
  to: string;
  /** 头饰/耳朵色 */
  decor: string;
}

/**
 * 邮箱指纹：FNV-1a 32 位无符号哈希。
 *
 * 先 trim + 小写归一，保证同一邮箱（大小写差异）恒定映射到同一头像。
 * 空串返回 0，作为未登录/未知用户的兜底基因。
 */
export function hashEmail(email: string): number {
  const s = String(email ?? '').trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 由邮箱派生显示名：取邮箱名（@ 之前）前三位，首字母大写。
 *
 * 'zhangsan@example.com' → 'Zha'；邮箱名不足三位时按实际长度返回；
 * 空邮箱（理论上仅未登录时出现）兜底为 '用户'。
 */
export function deriveDisplayName(email: string): string {
  const raw = String(email ?? '').trim();
  const local = raw.split('@')[0] ?? '';
  const picked = (local || raw).slice(0, DISPLAY_NAME_LENGTH);
  if (!picked) return '用户';
  return picked.charAt(0).toUpperCase() + picked.slice(1);
}

/**
 * 由邮箱派生头像基因：色相取哈希低位，表情/头饰取高位分段，
 * 三者互不干扰且分布均匀 → 不同邮箱得到不同（唯一）的头像。
 */
export function deriveAvatarGene(email: string): AvatarGene {
  const h = hashEmail(email);
  return {
    hue: h % 360,
    face: Math.floor(h / 360) % FACE_VARIANT_COUNT,
    decor: Math.floor(h / (360 * FACE_VARIANT_COUNT)) % DECOR_VARIANT_COUNT,
  };
}

/**
 * 由主色相派生头像配色。色相非法/越界时先归一到 0-359。
 */
export function avatarPalette(hue: number): AvatarPalette {
  const h = ((Math.round(Number(hue) || 0) % 360) + 360) % 360;
  return {
    bg: `hsl(${h} 62% 87%)`,
    from: `hsl(${h} 82% 72%)`,
    to: `hsl(${(h + 38) % 360} 74% 56%)`,
    decor: `hsl(${(h + 14) % 360} 66% 58%)`,
  };
}
