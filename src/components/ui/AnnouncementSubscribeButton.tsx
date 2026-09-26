/**
 * @file AnnouncementSubscribeButton.tsx
 * @description 公告订阅切换按钮（铃铛）：供短线交易（CurrentProjectCard）与
 *              中长期交易（持仓卡片头）复用。点击 → 订阅/取消订阅公告摘要，
 *              订阅态来自 announcementSlice（服务端镜像，两视图同源）。
 *              fullCode 归一化失败（非 6 位数字码）时整体不渲染（旧存量持仓无标的身份）。
 *              结果反馈走全局 app-toast（AuthGate 内置宿主）；首次订阅后端异步
 *              全量首拉（数分钟渐进入库），成功文案已向用户说明，无需等待。
 * @layer UI
 * @storage_impact 无本地持久化读写；订阅关系经 store action 同步至服务端。
 * @author 开发团队
 */

import { useEffect, useMemo, useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import { useAppStore } from '../../store';
import { useAuthStore } from '../../store/useAuthStore';
import { toStockId } from '../../utils/dedup';
import { showToast } from '../../utils/toast';

interface AnnouncementSubscribeButtonProps {
  /** 标的 fullCode（如 sh600745 / 600745 / SZ000001），组件内归一化为 6 位码 */
  fullCode: string | undefined | null;
}


export default function AnnouncementSubscribeButton({ fullCode }: AnnouncementSubscribeButtonProps) {
  const subscribedStockIds = useAppStore((s) => s.subscribedStockIds);
  const loadSubs = useAppStore((s) => s.loadAnnouncementSubscriptions);
  const subscribeAction = useAppStore((s) => s.subscribeAnnouncement);
  const unsubscribeAction = useAppStore((s) => s.unsubscribeAnnouncement);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [pending, setPending] = useState(false);

  const stockId = useMemo(() => toStockId(fullCode ?? ''), [fullCode]);

  // 按钮挂载时拉取订阅列表（slice 内防重防并发）；未登录时静默跳过
  useEffect(() => {
    if (stockId && isAuthenticated) void loadSubs();
  }, [stockId, isAuthenticated, loadSubs]);

  if (!stockId) return null;
  const sid: string = stockId;

  const subscribed = subscribedStockIds.includes(sid);

  async function handleToggle(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      const result = subscribed
        ? await unsubscribeAction(sid)
        : await subscribeAction(sid);
      if (result.ok) {
        showToast(
          subscribed
            ? '已取消订阅 ' + sid + ' 的公告摘要'
            : '订阅成功，' + sid + ' 的公告数据将在几分钟内陆续同步',
        );
      } else {
        showToast(result.message ?? '操作失败，请稍后重试');
      }
    } finally {
      setPending(false);
    }
  }

  const title = subscribed ? '取消订阅公告摘要' : '订阅公告摘要';
  const cls = [
    'tap-target flex flex-shrink-0 items-center justify-center w-9 h-9 rounded-lg transition-colors',
    subscribed
      ? 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
      : 'text-slate-500 hover:text-slate-200 hover:bg-slate-800',
    pending ? 'opacity-50 cursor-not-allowed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      onClick={(e) => {
        // 阻断冒泡：账本持仓行头部点击展开不应被订阅按钮误触
        e.stopPropagation();
        void handleToggle();
      }}
      title={title}
      aria-pressed={subscribed}
      disabled={pending}
      className={cls}
    >
      {subscribed ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
    </button>
  );
}
