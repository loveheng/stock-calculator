/**
 * @file CustomStatCharts.tsx
 * @description 自定义统计图表渲染（recharts 三组件映射，React.lazy 独立 chunk 懒加载）：
 *              bar → 纵向布局排行（降序，AI 生成数据已按口径给出）；line → 趋势；
 *              pie → 占比（≤8 片）。固定调色板对齐现有主题，AI 不控制颜色；
 *              tone 色彩映射红涨绿跌（A 股习惯，good=红，D16-⑤）。
 * @layer Components —— 只依赖 utils/types，禁碰 db（R1）
 * @storage_impact 纯渲染，无存储。
 * @author 开发团队
 */

import React from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import type { CustomStatChartPoint, CustomStatsResult } from '../../types/domain';

/** 固定调色板（对齐主题色板：蓝为主，灰阶辅助；AI 不控制颜色） */
const PALETTE = ['#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316', '#ec4899', '#64748b'];

/** 图表高度（数值卡区内嵌紧凑，图表区完整展示） */
const CHART_HEIGHT = 220;

const tooltipStyle = {
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  fontSize: 12,
  color: '#e2e8f0',
};

/** bar 排行：layout=vertical（横向条），易读性优先 */
function BarRank({ data }: { data: CustomStatChartPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
        <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="label"
          width={88}
          tick={{ fill: '#94a3b8', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip cursor={{ fill: 'rgba(148,163,184,0.08)' }} contentStyle={tooltipStyle} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={14}>
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** line 趋势 */
function LineTrend({ data }: { data: CustomStatChartPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
        <Tooltip contentStyle={tooltipStyle} />
        <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** pie 占比（≤8 片） */
function PieShare({ data }: { data: CustomStatChartPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <PieChart>
        <Tooltip contentStyle={tooltipStyle} />
        <Pie data={data} dataKey="value" nameKey="label" innerRadius={46} outerRadius={80} paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

/** 结果 → 图表分派（仅 chart 类进入本组件；渲染层傻瓜化，零转换） */
export function CustomStatChartView({ result }: { result: CustomStatsResult }) {
  if (result.kind !== 'chart') return null;
  const { chart } = result;
  if (chart.data.length === 0) {
    return (
      <div className="h-[220px] flex flex-col items-center justify-center text-slate-500 text-sm gap-1">
        <span>暂无可统计的数据</span>
        <span className="text-xs text-slate-600">录入并归档做T记录后即可生成图表</span>
      </div>
    );
  }
  return chart.type === 'bar' ? <BarRank data={chart.data} /> : chart.type === 'line' ? <LineTrend data={chart.data} /> : <PieShare data={chart.data} />;
}

export default CustomStatChartView;
