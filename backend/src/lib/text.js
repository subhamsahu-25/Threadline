const MARKDOWN_MARKS = /[*_`~]/;
const CURLY = new Map([
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201c', '"'],
  ['\u201d', '"'],
  ['\u2013', '-'],
  ['\u2014', '-'],
  ['\u00a0', ' '],
]);

export function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Builds a lowercase, whitespace-collapsed, markdown-stripped version of the
 * input plus an index map back to the original string, so fuzzy quote matches
 * can still produce exact character offsets for citations.
 */
export function normalizeWithMap(input) {
  const map = [];
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    const ch = CURLY.get(raw) ?? raw;
    if (MARKDOWN_MARKS.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (out.length > 0 && out[out.length - 1] !== ' ') {
        out += ' ';
        map.push(i);
      }
      continue;
    }
    const lowered = ch.toLowerCase();
    if (lowered.length !== 1) continue;
    out += lowered;
    map.push(i);
  }
  return { text: out, map };
}

export function normalizeForMatch(value) {
  return normalizeWithMap(String(value ?? '')).text.trim();
}

export function keyOf(value) {
  return normalizeForMatch(value)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

/**
 * Finds a quote inside a document. Tries an exact substring first, then a
 * normalized match. Returns offsets relative to the haystack.
 */
export function locateQuote(haystack, quote) {
  const needle = String(quote ?? '').trim();
  if (!haystack || !needle) return { ok: false };

  const direct = haystack.indexOf(needle);
  if (direct >= 0) {
    return { ok: true, start: direct, end: direct + needle.length, match: 'exact' };
  }

  const normalizedHaystack = normalizeWithMap(haystack);
  const normalizedQuote = normalizeForMatch(needle);
  if (!normalizedQuote) return { ok: false };

  const index = normalizedHaystack.text.indexOf(normalizedQuote);
  if (index < 0) return { ok: false };

  const start = normalizedHaystack.map[index];
  const end = normalizedHaystack.map[index + normalizedQuote.length - 1] + 1;
  return { ok: true, start, end, match: 'normalized' };
}

export function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function daysBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

export function unique(array) {
  return [...new Set(array)];
}
