/**
 * @file App.tsx
 * @description 应用根组件与主布局：React Router SPA 壳层 —— 侧边栏（桌面可折叠 / 移动抽屉）、
 *              顶部标题栏、路由分发，并挂载 PWA 安装引导与全局 Toast 宿主。
 *              扩展新页面：① 在 NAV_ITEMS 增条目 ② 在 <Routes> 增 <Route>。
 * @layer UI
 * @storage_impact 本文件不直接读写 IndexedDB；数据持久化由 Store Action 完成。
 * @author 骨架模板
 */

import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Home, Menu, PanelLeftClose, PanelLeftOpen, LayoutGrid } from 'lucide-react';
import InstallPrompt from './components/ui/InstallPrompt';
import Toast from './components/ui/Toast';
import { useLoadCoreData } from './hooks/useDataLoader';
import HomePage from './views/Home';

/** 导航菜单项：path / label / icon */
const NAV_ITEMS = [{ path: '/', label: '首页', icon: Home }] as const;

/** 侧边栏折叠态的本地持久化键 */
const SIDEBAR_COLLAPSED_KEY = 'ui.sidebarCollapsed';

function Sidebar({ onNavigate, collapsed }: { onNavigate: () => void; collapsed: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className={`flex items-center border-b border-slate-700 ${
          collapsed ? 'justify-center px-0 py-5' : 'gap-2 px-5 py-6'
        }`}
      >
        <LayoutGrid className="w-5 h-5 text-blue-500 flex-shrink-0" />
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-white truncate">应用骨架</h1>
            <p className="text-xs text-slate-500 mt-1">PWA Starter</p>
          </div>
        )}
      </div>

      <nav className={`flex-1 py-4 space-y-1 overflow-y-auto overflow-x-hidden ${collapsed ? 'px-2' : 'px-3'}`}>
        {NAV_ITEMS.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              onClick={() => {
                navigate(item.path);
                onNavigate();
              }}
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

function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
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

  // 冷启动仅加载设置；业务数据在此按需异步加载
  useLoadCoreData();

  const currentPage = NAV_ITEMS.find((item) => item.path === location.pathname);
  const pageTitle = currentPage?.label ?? '应用骨架';

  return (
    <div className="flex min-h-screen bg-slate-900">
      {sidebarOpen && (
        <div
          className="sidebar-overlay fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`sidebar fixed md:sticky top-0 left-0 z-50 h-screen bg-slate-800/95 backdrop-blur-xl border-r border-slate-700 transition-all duration-300 ease-in-out w-[260px] ${
          sidebarCollapsed ? 'md:w-[72px]' : 'md:w-[260px]'
        } ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
      >
        <Sidebar onNavigate={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} />
      </aside>

      <InstallPrompt />
      <Toast />

      <main className="main-area flex-1 min-w-0 min-h-screen w-full">
        <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur-xl border-b border-slate-800 px-4 py-2 flex items-center gap-3 md:px-6">
          <button
            className="menu-btn md:hidden p-2 rounded-lg hover:bg-slate-800 text-slate-400 transition-colors"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开菜单"
          >
            <Menu className="w-5 h-5" />
          </button>
          <button
            className="hidden md:inline-flex p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
            onClick={toggleSidebarCollapsed}
            title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </button>
          <h2 className="text-sm font-semibold text-slate-200">{pageTitle}</h2>
        </header>

        <div className="p-4 md:p-6 w-full max-w-5xl mx-auto lg:max-w-none">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}
