import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, '..', 'dist', 'index.html');
const html = readFileSync(htmlPath, 'utf-8');
// Remove crossorigin attributes (both boolean form and with value)
const modified = html.replace(/\s+crossorigin(?:="[^"]*")?/g, '');
writeFileSync(htmlPath, modified, 'utf-8');
console.log('[postbuild] Removed crossorigin attributes from index.html');