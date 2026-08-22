import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(here, 'wt_qfq.json'), 'utf8'));
const node = raw && raw.data && raw.data['sh600745'];
const rows = (node && node.qfqday) || [];
const START = '2025-12-01';
const END = '2026-08-20';
const klines = rows
  .filter((r) => r && r.length >= 6)
  .map((r) => ({
    date: String(r[0]),
    open: Number(r[1]),
    close: Number(r[2]),
    high: Number(r[3]),
    low: Number(r[4]),
    volume: Number(r[5]),
  }))
  .filter((k) => k.date >= START && k.date <= END)
  .sort((a, b) => a.date.localeCompare(b.date));
const out = path.join(here, 'wt-kline.json');
fs.writeFileSync(out, JSON.stringify(klines));
const last = klines[klines.length - 1];
console.log('bars=' + klines.length, 'first=' + (klines[0] && klines[0].date), 'last=' + (last && last.date), 'lastClose=' + (last && last.close));