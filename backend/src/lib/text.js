import { createHash } from 'node:crypto';

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
  return normalizeIndexed(input, true);
}

function normalizeIndexed(input, withMap) {
  const source = String(input ?? '');
  const map = [];
  const pieces = [];
  let index = 0;
  let pendingSpace = false;
  // Iterate by code point so astral characters (emoji) stay together, and
  // push one map entry per UTF-16 unit so offsets always line up with indexOf.
  for (const char of source) {
    const ch = CURLY.get(char) ?? char;
    if (MARKDOWN_MARKS.test(ch)) {
      index += char.length;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (pieces.length > 0) pendingSpace = true;
      index += char.length;
      continue;
    }
    if (pendingSpace) {
      pieces.push(' ');
      if (withMap) map.push(index);
      pendingSpace = false;
    }
    const lowered = ch.toLowerCase();
    for (let unit = 0; unit < lowered.length; unit += 1) {
      pieces.push(lowered[unit]);
      if (withMap) map.push(index);
    }
    index += char.length;
  }
  return { text: pieces.join(''), map };
}

export function normalizeForMatch(value) {
  return normalizeWithMap(String(value ?? '')).text.trim();
}

export const MAX_REDACTION_MARKERS = 6;
const MARKER_GAP = 3000;
const MARKER_BUDGET_MS = 50;
const REDACTION_MARKER = /\[REDACTED: [^\]]+\]/g;

/**
 * Locates a quote that contains redaction markers with a linear scan instead of
 * a regex. Joining fragments with lazy wildcards made a hostile document with
 * several markers backtrack for minutes; indexOf over the normalized text
 * cannot, because every fragment advances the cursor once.
 */
export function locateMarkedQuoteSpans(haystack, quote) {
  const text = String(quote ?? '');
  const markers = text.match(REDACTION_MARKER)?.length ?? 0;
  if (markers === 0) return { ok: false, reason: 'no_markers' };
  if (markers > MAX_REDACTION_MARKERS) return { ok: false, reason: 'too_many_markers' };

  const fragments = text
    .split(REDACTION_MARKER)
    .map((part) => normalizeForMatch(part))
    .filter(Boolean);
  if (fragments.length === 0) return { ok: false, reason: 'no_fragments' };

  const normalized = normalizeIndexed(haystack, false);
  const deadline = Date.now() + MARKER_BUDGET_MS;
  const first = normalized.text.indexOf(fragments[0]);
  if (first < 0) return { ok: false, reason: 'not_found' };

  let cursor = first + fragments[0].length;
  for (let index = 1; index < fragments.length; index += 1) {
    if (Date.now() > deadline) return { ok: false, reason: 'budget_exceeded' };
    const found = normalized.text.indexOf(fragments[index], cursor);
    if (found < 0) return { ok: false, reason: 'not_found' };
    if (found - cursor > MARKER_GAP) return { ok: false, reason: 'gap_too_large' };
    cursor = found + fragments[index].length;
  }

  // The index map is only needed once a match exists.
  const mapped = normalizeIndexed(haystack, true);
  return {
    ok: true,
    start: mapped.map[first],
    end: mapped.map[cursor - 1] + 1,
    fragments,
    markers,
  };
}

/**
 * Builds a comparison key that works for any script. NFKC folds full-width and
 * compatibility characters, lowercase folds case, and every letter or number
 * in any language survives. Emoji-only or punctuation-only text produces an
 * empty key, which callers replace with `fallbackKey`.
 */
export function keyOf(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable key for text whose content has no letters or numbers (for example an
 * emoji-only statement). Deterministic across runs so re-ingestion still
 * deduplicates it.
 */
export function fallbackKey(value) {
  const compact = String(value ?? '').normalize('NFKC').trim();
  return `h${createHash('sha256').update(compact).digest('hex').slice(0, 16)}`;
}

/**
 * Returns a comparison key, falling back to a hash when the text contains no
 * letters or numbers at all. Nothing is ever dropped for lacking a key.
 */
export function keyOfOrHash(value) {
  return keyOf(value) || fallbackKey(value);
}

export function truncate(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds a quote inside a document. Tries an exact substring first, then a
 * normalized match that must cover every token of the quote and respect word
 * boundaries, so a shared prefix can never stand in for an invented tail.
 * When a `within` range is given, a match inside it is preferred.
 */
export function locateQuote(haystack, quote, { within } = {}) {
  const needle = String(quote ?? '').trim();
  if (!haystack || !needle) return { ok: false };

  const direct = haystack.indexOf(needle);
  if (within) {
    const local = haystack.indexOf(needle, within.start);
    if (local >= 0 && local + needle.length <= within.end) {
      return { ok: true, start: local, end: local + needle.length, match: 'exact' };
    }
  }
  if (direct >= 0) {
    return { ok: true, start: direct, end: direct + needle.length, match: 'exact' };
  }

  const normalizedHaystack = normalizeWithMap(haystack);
  const normalizedQuote = normalizeForMatch(needle);
  if (!normalizedQuote) return { ok: false };

  const tokens = normalizedQuote.split(' ').filter(Boolean);
  if (tokens.length === 0) return { ok: false };

  let matcher;
  try {
    matcher = new RegExp(
      `(?<![\\p{L}\\p{N}])${tokens.map(escapeRegExp).join(' ')}(?![\\p{L}\\p{N}])`,
      'gu',
    );
  } catch {
    return { ok: false };
  }

  let fallback = null;
  for (const match of normalizedHaystack.text.matchAll(matcher)) {
    const start = normalizedHaystack.map[match.index];
    const end = normalizedHaystack.map[match.index + match[0].length - 1] + 1;
    if (within && start >= within.start && end <= within.end) {
      return { ok: true, start, end, match: 'normalized' };
    }
    if (!fallback) fallback = { start, end };
  }
  if (fallback) return { ok: true, ...fallback, match: 'normalized' };
  return { ok: false };
}

const VALUE_TOKEN_RE = new RegExp(
  [
    '\\b\\d[\\d.,:/-]*\\b',
    '[A-Za-z0-9-]*\\d[A-Za-z0-9-]*',
    '\\b[A-Za-z][A-Za-z0-9-]*[A-Z][A-Za-z0-9-]*\\b',
    '\\b[A-Z]{2,6}\\b',
    '"[^"]{2,40}"',
  ].join('|'),
  'gu',
);

const NORMALIZE_TOKEN = /[^\p{L}\p{N}]+/gu;

function tokenWords(text) {
  return normalizeForMatch(text).replace(NORMALIZE_TOKEN, ' ').trim().split(' ').filter(Boolean);
}

/**
 * Pulls out the parts of a statement that carry an unambiguous value: numbers,
 * product identifiers with internal capitals (MongoDB, PostgreSQL), acronyms
 * and quoted strings. Used to catch a claim whose statement names something the
 * cited quote never says.
 */
export function valueTokens(text) {
  const tokens = new Set();
  for (const match of String(text ?? '').matchAll(VALUE_TOKEN_RE)) {
    for (const word of tokenWords(match[0])) tokens.add(word);
  }
  return [...tokens];
}

/**
 * Returns the value tokens of `statement` that do not appear in `quote`. An
 * empty array means the statement agrees with the passage it cites.
 */
export function missingValueTokens(statement, quote) {
  const quoteWords = new Set(tokenWords(quote));
  return valueTokens(statement).filter((token) => !quoteWords.has(token));
}

export function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Calendar date (YYYY-MM-DD) as seen in India, for text shown to people. */
export function calendarDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function daysBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

export function unique(array) {
  return [...new Set(array)];
}
