/**
 * @file App.tsx
 * @description 应用根组件与主布局：基于 React Router 的 SPA 壳层，
 *              负责装配侧边栏导航、顶部标题栏、移动端抽屉菜单与
 *              八个功能页面（首页/涨跌幅/短线交易/中长期交易/数据统计/费率配置/云端同步/沙盘复盘）的路由分发；
 *              同时挂载 PWA 安装引导组件。
 * @layer UI
 * @storage_impact 本文件不直接读写 IndexedDB；页面数据持久化由各视图组件
 *                 （views/*）通过 store 完成。
 * @author 开发团队
 */

import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  Home,
  BarChart3,
  RefreshCw,
  TrendingUp,
  PieChart,
  Settings,
  Cloud,
  Menu,
  X,
  FlaskConical,
  ClipboardList,
  LogIn,
  LogOut,
  Search,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import InstallPrompt from './components/ui/InstallPrompt';
import AuthGate from './components/ui/AuthGate';
import UserAvatar from './components/ui/UserAvatar';
import Toast from './components/ui/Toast';
import GlobalCopilot from './components/copilot/GlobalCopilot';
import CopilotNoticeModal from './components/copilot/CopilotNoticeModal';
import { useLoadCoreData } from './hooks/useDataLoader';
import { useAppStore } from './store';
import { useAuthStore } from './store/useAuthStore';
import { deriveDisplayName } from './utils/userIdentity';

// --- 页面视图导入（静态导入，非懒加载） ---
import HomePage from './views/Home';
import ChangeRate from './views/ChangeRate';
import TCalculator from './views/TCalculator';
import CostAveraging from './views/CostAveraging';
import Statistics from './views/Statistics';
import SettingsPage from './views/Settings';
import WebDAVConfig from './views/WebDAVConfig';
import SandboxPlayback from './views/SandboxPlayback';
import BatchImport from './views/BatchImport';
import NewsSearch from './views/NewsSearch';
import StockCanvas from './views/StockCanvas';

/**
 * 导航菜单配置项。
 *
 * @property {string} path - 路由路径
 * @property {string} label - 菜单显示文案
 * @property {React.ElementType} icon - lucide 图标组件
 */
// ---- 导航菜单项 ----
const NAV_ITEMS = [
  { path: '/', label: '首页', icon: Home },
  { path: '/change-rate', label: '涨跌幅计算器', icon: TrendingUp },
  { path: '/t-calculator', label: '短线交易', icon: RefreshCw },
  { path: '/cost-averaging', label: '中长期交易', icon: BarChart3 },
  { path: '/news', label: '资讯', icon: Search },
  { path: '/sandbox', label: '沙盘复盘', icon: FlaskConical },
  { path: '/statistics', label: '数据统计', icon: PieChart },
  { path: '/settings', label: '设置', icon: Settings },
  { path: '/webdav', label: '云端同步', icon: Cloud },
  { path: '/batch-import', label: '批量导入', icon: ClipboardList },
  { path: '/stock-canvas', label: 'AI 选股台', icon: LayoutDashboard },
];

/**
 * 侧边栏导航组件。
 *
 * @description 渲染应用 Logo、导航菜单列表（高亮当前路由）与版本号；
 *              点击菜单项调用 navigate 跳转并通知父组件关闭移动端抽屉。
 * @param {{ onNavigate: () => void }} props - onNavigate：导航后回调（用于移动端收起侧边栏）
 * @returns {JSX.Element} 侧边栏视图
 */
// ---- 侧边栏导航 ----
/**
 * 侧边栏导航组件。
 *
 * @description 支持两种形态：展开态（260px，图标 + 文案）与折叠态（72px，仅图标 + 悬浮提示）。
 *              折叠态仅在桌面端生效，移动端抽屉始终为展开态。
 * @param {{ onNavigate: () => void; collapsed: boolean }} props
 * @returns {JSX.Element} 侧边栏视图
 */
function Sidebar({ onNavigate, collapsed }: { onNavigate: () => void; collapsed: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();

  // 首页菜单上的「待执行计划」角标：未过期且状态为 active 的计划单数量
  const activePlannedCount = useAppStore((s) => {
    const now = Date.now();
    return s.plannedOrders.filter((p) => p.status === 'active' && new Date(p.expiresAt).getTime() > now).length;
  });

  const handleClick = (path: string) => {
    navigate(path);
    onNavigate();
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className={`flex items-center border-b border-slate-700 ${
          collapsed ? 'justify-center px-0 py-5' : 'gap-2 px-5 py-6'
        }`}
      >
        <BarChart3 className="w-5 h-5 text-blue-500 flex-shrink-0" />
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-white truncate">股票计算助手</h1>
            <p className="text-xs text-slate-500 mt-1">股票交易工具</p>
          </div>
        )}
      </div>

      <nav className={`flex-1 py-4 space-y-1 overflow-y-auto overflow-x-hidden ${collapsed ? 'px-2' : 'px-3'}`}>
        {NAV_ITEMS.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;
          const activeCount = item.path === '/' ? activePlannedCount : 0;
          return (
            <button
              key={item.path}
              onClick={() => handleClick(item.path)}
              title={collapsed ? item.label : undefined}
              aria-label={item.label}
              className={`relative w-full flex items-center rounded-lg text-sm font-medium transition-all duration-200 ${
                collapsed ? 'justify-center px-0 py-3' : 'gap-3 px-4 py-3'
              } ${
                isActive
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && <span>{item.label}</span>}
              {!collapsed && activeCount > 0 && (
                <span className="ml-auto bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {activeCount}
                </span>
              )}
              {collapsed && activeCount > 0 && (
                <span className="absolute top-1.5 right-2.5 bg-amber-500 w-1.5 h-1.5 rounded-full" />
              )}
            </button>
          );
        })}
      </nav>

      <div className={`border-t border-slate-700 ${collapsed ? 'px-0 py-4 text-center' : 'px-5 py-4'}`}>
        <p className="text-xs text-slate-600">{collapsed ? 'v1' : 'v1.0.0'}</p>
      </div>
    </div>
  );
}

/**
 * 顶部栏右侧账户入口（E2EE 鉴权 D6）。
 *
 * @description 未登录 → "登录"按钮打开 AuthModal；已登录 → 邮箱派生头像（显示名默认收拢、
 *              悬停展开）+ 圆形退出按钮。initialized 前渲染同宽占位，避免会话恢复期间闪烁。
 *              登出仅销毁会话与密钥缓存，本地 Dexie 账本数据保留。
 */
// ---- 顶部栏账户区 ----
function AccountArea() {
  const initialized = useAuthStore((s) => s.initialized);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const email = useAuthStore((s) => s.user?.email ?? '');
  const setAuthModalOpen = useAuthStore((s) => s.setAuthModalOpen);
  const logout = useAuthStore((s) => s.logout);

  if (!initialized) return <div className="ml-auto w-[66px]" aria-hidden="true" />;

  if (!isAuthenticated) {
    return (
      <button
        onClick={() => setAuthModalOpen(true)}
        className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium transition-colors"
      >
        <LogIn className="w-3 h-3" />
        登录
      </button>
    );
  }

  return (
    <div className="ml-auto flex items-center gap-1.5 min-w-0">
    {/* 头像常驻；显示名改为悬停展开（默认收拢，不占顶部栏空间），完整邮箱走 title 悬浮提示 */}
    <div className="group flex items-center min-w-0 cursor-default" title={email}>
      <UserAvatar email={email} size={22} />
      <span className="ml-0 max-w-0 overflow-hidden whitespace-nowrap text-[11px] text-slate-300 opacity-0 transition-all duration-200 group-hover:ml-1.5 group-hover:max-w-[80px] group-hover:opacity-100">
        {deriveDisplayName(email)}
      </span>
    </div>
    <button
      onClick={() => void logout()}
      className="tap-target flex items-center justify-center w-7 h-7 rounded-full border border-slate-700 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-400 text-slate-400 text-[11px] transition-colors"
      title="退出登录（本地账本数据保留）"
      aria-label="退出登录（本地账本数据保留）"
    >
      <LogOut className="w-3 h-3" />
      </button>
    </div>
  );
}

/** 侧边栏折叠态的本地持久化键 */
const SIDEBAR_COLLAPSED_KEY = 'ui.sidebarCollapsed';

/**
 * 主布局组件。
 *
 * @description 桌面端展示常驻侧边栏（可折叠为图标栏），移动端展示抽屉式侧边栏（含遮罩）；
 *              顶部为 sticky 标题栏，内容区铺满侧边栏之外的剩余宽度并通过 <Routes> 分发各页面组件；
 *              同时挂载 PWA 安装引导与 E2EE 认证门控（AuthGate）。
 * @returns {JSX.Element} 应用主布局视图
 * @note 本组件为静态壳层，不含业务数据读写
 */
// ---- 主布局 ----
function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 桌面端侧边栏折叠态（持久化，刷新后保持）；移动端抽屉不使用该状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const location = useLocation();

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* 隐私模式 / 存储不可用时忽略 */
      }
      return next;
    });
  };

  // 按需加载核心数据（tRounds（OPENED 含流水池）/ positions）
  // 冷启动时仅加载 feeConfig，核心数据在首次渲染后异步加载，降低首屏等待时间
  useLoadCoreData();

  // 获取当前页面标题
  const currentPage = NAV_ITEMS.find((item) => item.path === location.pathname);
  const pageTitle = currentPage?.label || '股票计算助手';

  return (
    <div className="flex min-h-screen bg-slate-900">
      {/* 移动端遮罩 */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 侧边栏：移动端为抽屉（固定 260px），桌面端常驻并支持折叠为图标栏 */}
      <aside
        className={`sidebar fixed md:sticky top-0 left-0 z-50 h-screen bg-slate-800/95 backdrop-blur-xl border-r border-slate-700 transition-all duration-300 ease-in-out w-[260px] ${
          sidebarCollapsed ? 'md:w-[72px]' : 'md:w-[260px]'
        } ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
      >
        <Sidebar onNavigate={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
      </aside>

      {/* 安装引导 */}
      <InstallPrompt />

      {/* E2EE 认证门控：initSession / 锁屏 / 登录注册 / 助记词备份 / 找回密码 / 全局 Toast */}
      <AuthGate />

      {/* Context-Aware Copilot 全局浮窗（P0：mock 全链路，试点页 statistics/home） */}
      <GlobalCopilot />

      {/* AI 动作全局强制提醒弹窗（V1 Action Pipeline：notify 动作落地态） */}
      <CopilotNoticeModal />

      {/* 全局 Toast 宿主（app-toast CustomEvent 消费端，全页面共用） */}
      <Toast />

      {/* 主内容区 */}
      <main className="main-area flex-1 min-w-0 min-h-screen w-full">
        {/* 顶部栏 */}
        <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur-xl border-b border-slate-800 px-4 py-2 flex items-center gap-3 md:px-6">
          {/* 移动端：打开抽屉 */}
          <button
            className="menu-btn md:hidden p-2 rounded-lg hover:bg-slate-800 text-slate-400 transition-colors"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开菜单"
          >
            <Menu className="w-5 h-5" />
          </button>
          {/* 桌面端：折叠 / 展开侧边栏 */}
          <button
            className="hidden md:inline-flex p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
            onClick={toggleSidebarCollapsed}
            title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="w-5 h-5" />
            ) : (
              <PanelLeftClose className="w-5 h-5" />
            )}
          </button>
          <h2 className="text-sm font-semibold text-slate-200">{pageTitle}</h2>
          <AccountArea />
        </header>

        {/* 页面内容：桌面端铺满侧边栏之外的剩余区域 */}
        <div className="p-4 md:p-6 w-full max-w-5xl mx-auto lg:max-w-none">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/change-rate" element={<ChangeRate />} />
            <Route path="/t-calculator" element={<TCalculator />} />
            <Route path="/cost-averaging" element={<CostAveraging />} />
            <Route path="/news" element={<NewsSearch />} />
            <Route path="/sandbox" element={<SandboxPlayback />} />
            <Route path="/statistics" element={<Statistics />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* 旧入口兼容：费率配置已并入设置页子菜单 */}
            <Route path="/fee-config" element={<Navigate to="/settings" replace />} />
            <Route path="/webdav" element={<WebDAVConfig />} />
            <Route path="/batch-import" element={<BatchImport />} />
            <Route path="/stock-canvas" element={<StockCanvas />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

/**
 * 应用根组件。
 *
 * @description 以 BrowserRouter 包裹主布局，启动整个 SPA 应用。
 * @returns {JSX.Element} 应用根视图
 */
// ---- 根组件 ----
export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}