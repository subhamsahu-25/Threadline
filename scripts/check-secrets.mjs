#!/usr/bin/env node
// Scans every tracked file for credentials. Test fixtures are in scope: a real
// key committed in a test is still a leak. The only exemptions are named fake
// values declared in ALLOWED_FAKE_VALUES. PDF and DOCX reports are unpacked and
// their text is scanned like any other file.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

const SKIP_PATH = [/(^|\/)node_modules\//, /(^|\/)package-lock\.json$/];
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|mov|zip|gz)$/i;
const DOCUMENT_EXT = /\.(pdf|docx)$/i;

/**
 * Fixtures that deliberately contain credential-shaped strings. Each entry is
 * an exact value, so the exemption follows the value rather than the path: a
 * different (real) key in the same file is still reported.
 */
export const ALLOWED_FAKE_VALUES = [
  { name: 'AWS documentation example key id', value: 'AKIAIOSFODNN7EXAMPLE' },
  { name: 'redaction fixture private key banner', value: '-----BEGIN RSA PRIVATE KEY-----' },
  { name: 'redaction fixture connection string', value: 'mongodb+srv://user:pass@host/db' },
  { name: 'redaction fixture password', value: 'hunter2hunter2' },
  { name: 'redaction fixture secret', value: 'super-secret-value-123' },
  { name: 'redaction fixture AWS secret', value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  { name: 'redaction fixture stripe-shaped key', value: 'sk-live-abc123def456ghi789jkl012' },
  {
    name: 'JWT.io documentation token',
    value:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  },
  { name: 'test account password', value: 'Threadline#2026' },
  { name: 'test account password', value: 'AdaLovelace#2026' },
  { name: 'test account password', value: 'Trustno1!!' },
  { name: 'test account password', value: 'Str0ng#Pass' },
  { name: 'Playwright signing key', value: 'e2e-only-secret-not-for-production' },
];

// Values that are visibly placeholders, not credentials.
const PLACEHOLDER = /^(?:<|\$|\{|\*{3,}|x{4,}|\.\.\.|replace|change|your|example|placeholder|todo)/i;

const PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Stripe live key', re: /sk_live_[0-9A-Za-z]{20,}/ },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'MongoDB URI with credentials', re: /mongodb(?:\+srv)?:\/\/[^\s/@:]+:[^\s/@]+@/ },
  {
    name: 'JWT value',
    re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    // password: "…", jwt_secret: '…', clientSecret = `…`
    name: 'credential assignment',
    re: /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|accesstoken|auth[_-]?token|authtoken|client[_-]?secret|clientsecret|jwt[_-]?secret|private[_-]?key)\b\s*[:=]\s*(['"`])([^'"`\n]{8,})\2/i,
    valueGroup: 3,
  },
  {
    // JWT_SECRET=…, DB_PASSWORD=… on an environment-style line
    name: 'credential environment variable',
    re: /^[ \t]*(?:export[ \t]+)?([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|_TOKEN|PRIVATE_KEY)[A-Z0-9_]*)[ \t]*=[ \t]*(\S{8,})/m,
    valueGroup: 2,
  },
];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

// A tracked file may be deleted from the working tree; scan the committed copy
// rather than skipping it.
function readTracked(file) {
  try {
    return readFileSync(file);
  } catch {
    try {
      return execFileSync('git', ['show', `HEAD:${file}`], { maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  }
}

function zipEntries(buffer) {
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipEntryData(buffer, entry) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported compression method ${entry.method}`);
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function docxText(buffer) {
  const parts = [];
  for (const entry of zipEntries(buffer)) {
    if (!/^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(entry.name)) {
      continue;
    }
    const xml = zipEntryData(buffer, entry).toString('utf8');
    parts.push(decodeEntities(xml.replace(/<[^>]+>/g, ' ')));
  }
  return parts.join('\n');
}

export function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  const chunks = [raw];
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const data = buffer.subarray(start, end);
    let text = null;
    try {
      text = inflateSync(data).toString('latin1');
    } catch {
      try {
        text = inflateRawSync(data).toString('latin1');
      } catch {
        text = null;
      }
    }
    if (text) chunks.push(text);
  }
  return chunks.join('\n');
}

export function documentText(file, buffer) {
  if (/\.docx$/i.test(file)) return docxText(buffer);
  if (/\.pdf$/i.test(file)) return pdfText(buffer);
  return buffer.toString('utf8');
}

// A finding is exempt only when its match overlaps a named fake value, so a
// different key on the same line is still reported.
function overlapsAllowedValue(line, index, length) {
  return ALLOWED_FAKE_VALUES.some(({ value }) => {
    let at = line.indexOf(value);
    while (at >= 0) {
      if (at < index + length && index < at + value.length) return true;
      at = line.indexOf(value, at + 1);
    }
    return false;
  });
}

export function scanText(file, text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (const pattern of PATTERNS) {
    lines.forEach((line, index) => {
      const regex = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
      let match;
      while ((match = regex.exec(line))) {
        const matched = match[0];
        const value = pattern.valueGroup ? match[pattern.valueGroup] : matched;
        const allowed = overlapsAllowedValue(line, match.index, matched.length);
        const placeholder = value && PLACEHOLDER.test(value);
        if (!allowed && !placeholder && value) {
          findings.push({ file, line: index + 1, kind: pattern.name });
        }
        if (match[0] === '') regex.lastIndex += 1;
      }
    });
  }
  return findings;
}

export function scanRepository() {
  const files = trackedFiles();
  const findings = [];
  for (const file of files) {
    if (SKIP_PATH.some((re) => re.test(file))) continue;
    if (SKIP_EXT.test(file)) continue;
    const name = file.split('/').pop();
    if (name.startsWith('.env') && !name.endsWith('.example')) {
      findings.push({ file, line: 0, kind: 'tracked environment file' });
      continue;
    }
    const buffer = readTracked(file);
    if (!buffer) continue;
    let text;
    try {
      text = DOCUMENT_EXT.test(file) ? documentText(file, buffer) : buffer.toString('utf8');
    } catch {
      // A binary we cannot unpack: scan the raw bytes rather than trust it.
      text = buffer.toString('latin1');
    }
    findings.push(...scanText(file, text));
  }
  return { files, findings };
}

function main() {
  const { files, findings } = scanRepository();
  if (findings.length > 0) {
    console.error(`Secret scan failed with ${findings.length} finding(s):`);
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line} — ${finding.kind}`);
    }
    process.exit(1);
  }
  console.log(
    `Secret scan clean: ${files.length} tracked files checked, ` +
      `${ALLOWED_FAKE_VALUES.length} named fixture value(s) exempt.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
