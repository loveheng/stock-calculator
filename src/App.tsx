/**
 * @file App.tsx
 * @description 应用根组件与主布局：基于 React Router 的 SPA 壳层，
 *              负责装配侧边栏导航、顶部标题栏、移动端抽屉菜单与
 *              六个功能页面（首页/涨跌幅/做T计算器/成本摊薄/统计/费率配置）的路由分发；
 *              同时挂载 PWA 安装引导组件。
 * @layer UI
 * @storage_impact 本文件不直接读写 IndexedDB；页面数据持久化由各视图组件
 *                 （views/*）通过 store 完成。
 * @author 开发团队
 */

import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import {
  Home,
  BarChart3,
  RefreshCw,
  TrendingUp,
  PieChart,
  Settings,
  Menu,
  X,
} from 'lucide-react';
import InstallPrompt from './components/ui/InstallPrompt';

// --- Lazy loaded views ---
import HomePage from './views/Home';
import ChangeRate from './views/ChangeRate';
import TCalculator from './views/TCalculator';
import CostAveraging from './views/CostAveraging';
import Statistics from './views/Statistics';
import FeeConfig from './views/FeeConfig';

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
  { path: '/change-rate', label: '涨跌幅计算', icon: TrendingUp },
  { path: '/t-calculator', label: '做T计算器', icon: RefreshCw },
  { path: '/cost-averaging', label: '成本摊薄', icon: BarChart3 },
  { path: '/statistics', label: '数据统计', icon: PieChart },
  { path: '/fee-config', label: '费率配置', icon: Settings },
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
function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();

  const handleClick = (path: string) => {
    navigate(path);
    onNavigate();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-6 border-b border-slate-700">
        <h1 className="text-lg font-bold text-white flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-blue-500" />
          股票计算助手
        </h1>
        <p className="text-xs text-slate-500 mt-1">A股交易工具</p>
      </div>

      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              onClick={() => handleClick(item.path)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t border-slate-700">
        <p className="text-xs text-slate-600">v1.0.0</p>
      </div>
    </div>
  );
}

/**
 * 主布局组件。
 *
 * @description 桌面端展示固定侧边栏，移动端展示抽屉式侧边栏（含遮罩）；
 *              顶部为 sticky 标题栏，内容区通过 <Routes> 分发各页面组件；
 *              同时挂载 PWA 安装引导。
 * @returns {JSX.Element} 应用主布局视图
 * @note 本组件为静态壳层，不含业务数据读写
 */
// ---- 主布局 ----
function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

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

      {/* 侧边栏 */}
      <aside
        className={`sidebar fixed md:sticky top-0 left-0 z-50 w-[260px] h-screen bg-slate-800/95 backdrop-blur-xl border-r border-slate-700 transform transition-transform duration-300 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } md:translate-x-0`}
      >
        <Sidebar onNavigate={() => setSidebarOpen(false)} />
      </aside>

      {/* 安装引导 */}
      <InstallPrompt />

      {/* 主内容区 */}
      <main className="main-area flex-1 min-h-screen w-full">
        {/* 顶部栏 */}
        <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur-xl border-b border-slate-800 px-4 py-3 flex items-center gap-3 md:px-6">
          <button
            className="menu-btn p-2 rounded-lg hover:bg-slate-800 text-slate-400 transition-colors"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-5 h-5" />
          </button>
          <h2 className="text-base font-semibold text-slate-200">{pageTitle}</h2>
        </header>

        {/* 页面内容 */}
        <div className="p-4 md:p-6 max-w-5xl mx-auto">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/change-rate" element={<ChangeRate />} />
            <Route path="/t-calculator" element={<TCalculator />} />
            <Route path="/cost-averaging" element={<CostAveraging />} />
            <Route path="/statistics" element={<Statistics />} />
            <Route path="/fee-config" element={<FeeConfig />} />
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