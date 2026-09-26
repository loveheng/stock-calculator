// @vitest-environment jsdom
/**
 * @file monitorPanel.ui.test.tsx
 * @description 通知管理面板 UI 冒烟：列表渲染（触发边界 / 已提醒 n/3 次 / 结束态区分）、
 *              新建表单挂载与常驻说明（30 分钟节奏 + 3 次封顶 + 剩余额度）。
 *              服务层与鉴权 store 全部打桩，只验证组件可挂载与契约文案落地。
 * @layer Test
 * @storage_impact 无存储读写（listMonitor / getKline 均为桩）。
 * @author 开发团队
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MonitorPanel from '../components/monitor/MonitorPanel';

// vi.mock 工厂被提升到文件顶部：桩函数须经 vi.hoisted 声明，否则引用早于初始化
const { listMonitorMock, stopMonitorMock } = vi.hoisted(() => ({
  listMonitorMock: vi.fn(),
  stopMonitorMock: vi.fn(async () => undefined),
}));

vi.mock('../services/monitorService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/monitorService')>();
  return { ...actual, listMonitor: listMonitorMock, stopMonitor: stopMonitorMock };
});

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ isAuthenticated: true, setAuthModalOpen: vi.fn() }),
}));

/** 列表样例：一条追踪中（BUY 区间）+ 一条满 3 次自动结束 */
const SAMPLE = {
  runningCount: 1,
  tasks: [
    {
      taskId: 12,
      fullCode: 'sh600519',
      stockCode: '600519',
      alertType: 'PRICE_NEAR',
      direction: 'BUY',
      threshold: 1450,
      band: 20,
      status: 'RUNNING',
      alertCount: 1,
      lastAlertAt: '2026-09-26T14:32:11+08:00',
      createdAt: '2026-09-25T10:00:00+08:00',
      updatedAt: '2026-09-26T14:32:11+08:00',
    },
    {
      taskId: 9,
      fullCode: 'sz000001',
      stockCode: '000001',
      alertType: 'PRICE_BELOW',
      direction: 'BUY',
      threshold: 10.5,
      band: null,
      status: 'STOPPED',
      alertCount: 3,
      lastAlertAt: '2026-09-24T11:05:00+08:00',
      createdAt: '2026-09-22T09:30:00+08:00',
      updatedAt: '2026-09-24T11:05:00+08:00',
    },
  ],
};

beforeEach(() => {
  listMonitorMock.mockReset();
  listMonitorMock.mockResolvedValue(SAMPLE);
});

describe('MonitorPanel 通知管理', () => {
  it('渲染列表：单边触发边界、已提醒次数、结束态区分（自动停 / 手动停）', async () => {
    render(<MonitorPanel />);

    await waitFor(() => expect(listMonitorMock).toHaveBeenCalled());

    // 追踪中卡片：触发边界按 BUY 取上沿 1450 + 20 = 1470
    expect(await screen.findByText(/触发 ≤ 1470\.00/)).toBeTruthy();
    expect(screen.getByText(/已提醒 1\/3 次/)).toBeTruthy();
    expect(screen.getAllByText('追踪中').length).toBe(1);

    // 满 3 次自动停 vs 手动停：此处唯一 STOPPED 条目为满 3 次
    expect(screen.getByText('已提醒 3/3 次 · 自动结束')).toBeTruthy();
  });

  it('新建表单挂载并常驻说明：30 分钟节奏 + 3 次封顶 + 剩余额度', async () => {
    render(<MonitorPanel />);
    await waitFor(() => expect(listMonitorMock).toHaveBeenCalled());

    expect(screen.getByText('新建价格提醒')).toBeTruthy();
    expect(screen.getByText(/交易时段内每 30 分钟检查一次/)).toBeTruthy();
    expect(screen.getByText(/最多提醒 3 次/)).toBeTruthy();
    // runningCount=1 → 剩余 4 条
    expect(screen.getByText(/当前剩余 4 条额度/)).toBeTruthy();
  });

  it('加载失败 → 展示重试入口，不白屏', async () => {
    listMonitorMock.mockRejectedValue(new Error('boom'));
    render(<MonitorPanel />);

    expect(await screen.findByText('预告单加载失败')).toBeTruthy();
    expect(screen.getByText('重试')).toBeTruthy();
  });
});
