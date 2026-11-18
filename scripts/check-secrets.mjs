#!/usr/bin/env node
// Scans tracked files for high-confidence credential patterns. Test fixtures
// are excluded because they deliberately contain sample keys to exercise the
// redaction pipeline; every other tracked file is in scope.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SKIP_PATH = [
  /(^|\/)node_modules\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)tests?\//,
  /\.test\.[cm]?[jt]sx?$/,
];
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|pdf|docx|pptx|xlsx|zip|gz|mp4|mov)$/i;

const PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Stripe live key', re: /sk_live_[0-9A-Za-z]{20,}/ },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'MongoDB URI with credentials', re: /mongodb(?:\+srv)?:\/\/[^\s/@:]+:[^\s/@]+@/ },
];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const findings = [];
const trackedEnv = files.filter((file) => {
  const name = file.split('/').pop();
  return name.startsWith('.env') && !name.endsWith('.example');
});
for (const file of trackedEnv) {
  findings.push({ file, line: 0, kind: 'tracked environment file' });
}

for (const file of files) {
  if (trackedEnv.includes(file)) continue;
  if (SKIP_EXT.test(file) || SKIP_PATH.some((re) => re.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (const pattern of PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.re.test(lines[index])) {
        findings.push({ file, line: index + 1, kind: pattern.name });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`Secret scan failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} — ${finding.kind}`);
  }
  process.exit(1);
}

console.log(`Secret scan clean: ${files.length} tracked files checked, test fixtures excluded.`);
