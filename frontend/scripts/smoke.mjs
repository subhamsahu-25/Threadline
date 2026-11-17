import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.cwd(), 'dist');
const indexPath = resolve(dist, 'index.html');

if (!existsSync(indexPath)) {
  console.error('smoke: dist/index.html is missing — run npm run build first');
  process.exit(1);
}

const html = readFileSync(indexPath, 'utf8');
const checks = [
  ['root mount', /<div id="root"><\/div>/.test(html)],
  ['page title', /<title>Threadline<\/title>/.test(html)],
  ['bundled stylesheet', /<link[^>]+href="\/assets\/index-[^"]+\.css"/.test(html)],
  ['bundled module script', /<script[^>]+type="module"[^>]+src="\/assets\/index-[^"]+\.js"/.test(html)],
];

const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
for (const asset of assets) {
  checks.push([`asset exists ${asset}`, existsSync(resolve(dist, asset.slice(1)))]);
}

const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log(`${ok ? 'ok' : 'FAIL'}  ${label}`);

if (failed.length > 0) {
  console.error(`smoke: ${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`smoke: ${checks.length} checks passed`);
