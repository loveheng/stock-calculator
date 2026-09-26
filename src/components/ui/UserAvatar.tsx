/**
 * @file UserAvatar.tsx
 * @description 邮箱派生的可爱头像：由邮箱指纹（userIdentity 纯函数）决定色相、表情与头饰，
 *              同一邮箱恒得同一头像（唯一），不同邮箱观感各异；纯 SVG 内联渲染，
 *              无外部图片请求、无随机、无存储读写。顶部栏账户区与锁屏弹窗共用。
 * @layer UI
 * @storage_impact 纯展示组件，无存储读写。
 * @author 开发团队
 */

import { useId, useMemo } from 'react';
import { avatarPalette, deriveAvatarGene, deriveDisplayName } from '../../utils/userIdentity';

/** 五官描线色（深灰，避免纯黑在浅色底上过硬） */
const DARK = '#1f2937';
/** 腮红色 */
const BLUSH = 'hsl(352 85% 72%)';

export interface UserAvatarProps {
  /** 邮箱：唯一标识，决定头像配色 / 表情 / 头饰 */
  email: string;
  /** 边长（px），默认 28 */
  size?: number;
  /** 追加类名 */
  className?: string;
}

/** 四角星路径：用于"星星眼"表情 */
function starPath(cx: number, cy: number, r: number): string {
  const i = r * 0.34;
  return (
    `M${cx} ${cy - r} L${cx + i} ${cy - i} L${cx + r} ${cy} L${cx + i} ${cy + i}` +
    ` L${cx} ${cy + r} L${cx - i} ${cy + i} L${cx - r} ${cy} L${cx - i} ${cy - i} Z`
  );
}

/** 头饰：绘制在头部之下（只露出头顶以上的部分） */
function Decor({ variant, color }: { variant: number; color: string }) {
  switch (variant) {
    case 0: // 猫耳
      return (
        <g fill={color}>
          <path d="M10.5 13.5 L11.2 4.2 L19 9 Z" />
          <path d="M29.5 13.5 L28.8 4.2 L21 9 Z" />
        </g>
      );
    case 1: // 兔耳
      return (
        <g fill={color}>
          <ellipse cx="14.6" cy="7.4" rx="2.7" ry="6.4" transform="rotate(-12 14.6 7.4)" />
          <ellipse cx="25.4" cy="7.4" rx="2.7" ry="6.4" transform="rotate(12 25.4 7.4)" />
        </g>
      );
    case 2: // 熊耳
      return (
        <g fill={color}>
          <circle cx="11.6" cy="11.6" r="4.6" />
          <circle cx="28.4" cy="11.6" r="4.6" />
        </g>
      );
    case 3: // 头顶小芽
      return (
        <g>
          <path
            d="M20 12 C20 10 20 8.4 20 6.4"
            stroke="hsl(120 45% 42%)"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
          />
          <path d="M20 8.6 C17.6 8.6 16.2 6.6 16.2 4.8 C18.6 4.4 20 6 20 8.6 Z" fill="hsl(120 55% 52%)" />
          <path d="M20 8 C22.4 8 23.8 6.2 23.8 4.6 C21.6 4.2 20 5.8 20 8 Z" fill="hsl(120 48% 45%)" />
        </g>
      );
    default: // 呆毛
      return (
        <path
          d="M20 9.2 C19.2 6.6 21.4 5.2 22.6 3.4"
          stroke={color}
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
      );
  }
}

/** 眼睛：5 种表情变体 */
function Eyes({ variant }: { variant: number }) {
  switch (variant) {
    case 0: // 圆眼 + 高光
      return (
        <>
          <circle cx="15.4" cy="21.4" r="2.4" fill={DARK} />
          <circle cx="24.6" cy="21.4" r="2.4" fill={DARK} />
          <circle cx="16.3" cy="20.5" r="0.85" fill="#fff" />
          <circle cx="25.5" cy="20.5" r="0.85" fill="#fff" />
        </>
      );
    case 1: // 弯弯笑眼
      return (
        <g stroke={DARK} strokeWidth="1.7" fill="none" strokeLinecap="round">
          <path d="M12.6 22.2 q2.8 -3.2 5.6 0" />
          <path d="M21.8 22.2 q2.8 -3.2 5.6 0" />
        </g>
      );
    case 2: // 星星眼
      return (
        <g fill={DARK}>
          <path d={starPath(15.4, 21.2, 3.1)} />
          <path d={starPath(24.6, 21.2, 3.1)} />
        </g>
      );
    case 3: // 眨眼（左弧右圆）
      return (
        <>
          <path
            d="M12.6 22.2 q2.8 -3.2 5.6 0"
            stroke={DARK}
            strokeWidth="1.7"
            fill="none"
            strokeLinecap="round"
          />
          <circle cx="24.6" cy="21.4" r="2.3" fill={DARK} />
          <circle cx="25.5" cy="20.5" r="0.8" fill="#fff" />
        </>
      );
    default: // 大眼 + 高光
      return (
        <>
          <circle cx="15.2" cy="21.2" r="3" fill={DARK} />
          <circle cx="24.8" cy="21.2" r="3" fill={DARK} />
          <circle cx="16.3" cy="20" r="1.05" fill="#fff" />
          <circle cx="25.9" cy="20" r="1.05" fill="#fff" />
        </>
      );
  }
}

/** 嘴巴：与眼睛变体一一配对 */
function Mouth({ variant }: { variant: number }) {
  switch (variant) {
    case 0: // 微笑
      return (
        <path
          d="M17.4 26.2 q2.6 2.7 5.2 0"
          stroke={DARK}
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
      );
    case 1: // 小圆嘴
      return <circle cx="20" cy="27" r="1.6" fill={DARK} />;
    case 2: // 张嘴笑
      return <path d="M16.6 25.6 a3.4 3.6 0 0 0 6.8 0 Z" fill={DARK} />;
    case 3: // 猫嘴
      return (
        <g stroke={DARK} strokeWidth="1.4" fill="none" strokeLinecap="round">
          <path d="M20 25.6 q-2 2.5 -3.7 0.7" />
          <path d="M20 25.6 q2 2.5 3.7 0.7" />
        </g>
      );
    default: // 咧嘴笑
      return <path d="M16.4 25.4 q3.6 4.4 7.2 0 Z" fill={DARK} />;
  }
}

/**
 * 邮箱派生的可爱头像。
 *
 * @param email 用户邮箱（唯一决定头像外观）
 * @param size 边长 px，默认 28
 * @returns {JSX.Element} 圆形内联 SVG 头像
 */
export default function UserAvatar({ email, size = 28, className = '' }: UserAvatarProps) {
  const gene = useMemo(() => deriveAvatarGene(email), [email]);
  const palette = useMemo(() => avatarPalette(gene.hue), [gene.hue]);
  // useId 保证同页面多实例渐变 / 裁剪 id 不冲突（冒号在 url(#) 里不合法，需剔除）
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `ua-g-${uid}`;
  const clipId = `ua-c-${uid}`;
  const label = deriveDisplayName(email);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={`flex-shrink-0 rounded-full ${className}`}
      role="img"
      aria-label={`${label} 的头像`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.from} />
          <stop offset="100%" stopColor={palette.to} />
        </linearGradient>
        <clipPath id={clipId}>
          <circle cx="20" cy="20" r="20" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <circle cx="20" cy="20" r="20" fill={palette.bg} />
        <Decor variant={gene.decor} color={palette.decor} />
        <circle cx="20" cy="22" r="14" fill={`url(#${gradId})`} />
        <ellipse cx="11.4" cy="25.6" rx="2.6" ry="1.6" fill={BLUSH} opacity="0.55" />
        <ellipse cx="28.6" cy="25.6" rx="2.6" ry="1.6" fill={BLUSH} opacity="0.55" />
        <Eyes variant={gene.face} />
        <Mouth variant={gene.face} />
      </g>
    </svg>
  );
}
