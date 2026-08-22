/**
 * @file fetch.mjs
 * @description C2 沙盘审计用真实行情落盘脚本：通过腾讯 ifzq 前复权日 K 接口抓取
 *              闻泰科技 600745 固定窗口（2025-12-01 → 2026-08-20）的 K 线，
 *              解析为 `{ date, open, close, high, low, volume }` 数组，
 *              写入 `data/audit-wt/wt-kline.json` 供单测本地读取（测试零网络）。
 *
 * 【用法】
 *   node data/audit-wt/fetch.mjs            # 走默认代理 /api-kline（生产/Vite）
 *   OFFSET_PROXY=0 node data/audit-wt/fetch.mjs   # 直连腾讯 ifzq 上游（绕过本地代理）
 *
 * 【字段序】上游返回 qfqday 数组：[日期, 开盘, 收盘, 最高, 最低, 成交量, ...]
 *           （收盘位于最高/最低之前——与 klineService.ts 实测一致）
 * @storage_impact 仅写本目录 wt-kline.json，无其他副作用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FULL_CODE = 'sh600745'; // 闻泰生物（前复权）
const START = '2025-12-01';
const END = '2026-08-20';
const OUT = path.join(here, 'wt-kline.json');

/** 解析腾讯 qfqday 载荷 → KlineItem[] */
function parseKlines(raw, code) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!json || json.code !== 0 || !json.data) return [];
  const rows = (json.data[code] && json.data[code].qfqday) || [];
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const date = String(r[0]);
    const open = Number(r[1]);
    const close = Number(r[2]);
    const high = Number(r[3]);
    const low = Number(r[4]);
    const volume = Number(r[5]);
    if (!date || !Number.isFinite(open) || open <= 0 || !Number.isFinite(close)) continue;
    out.push({
      date,
      open,
      close,
      high,
      low,
      volume,
    });
  }
  return out;
}

/** 从上游抓取 qfqday K 线（按 START~END 单年窗口，覆盖所需区间） */
async function fetchRange() {
  // 先抓全量（含窗口前后各一年的余量，保证 MA 等指标前视历史够用），再按窗口过滤
  const year = Number(START.slice(0, 4));
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const suffix = `appstock/app/fqkline/get?param=${FULL_CODE},day,${start},${end},640,qfq`;
  const base = useOffsetProxy ? '/api-kline' : 'https://ifzq.gtimg.cn';
  const url = `${base}/${suffix}`;
  const res = await fetch(url, { headers: { Referer: 'https://finance.qq.com/' } });
  if (!res.ok) throw new Error(`K 线请求失败: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const all = parseKlines(text, FULL_CODE);
  return all
    .filter((k) => k.date >= START && k.date <= END)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const useOffsetProxy = process.env.OFFSET_PROXY !== '0';
async function main() {
  const klines = await fetchRange();
  if (klines.length === 0) {
    console.error('[fetch] 未取到任何 K 线，可能网络被阻断或上游返回异常');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(klines));
  const last = klines[klines.length - 1];
  console.log(`[ok] bars=${klines.length} first=${klines[0].date} last=${last.date} lastClose=${last.close}`);
}
main();