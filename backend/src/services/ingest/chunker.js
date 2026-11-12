export const DEFAULT_CHUNK_CHARS = 2000;
export const MAX_CHUNKS = 250;

function trimRange(text, start, end) {
  let left = start;
  let right = end;
  while (left < right && /\s/.test(text[left])) left += 1;
  while (right > left && /\s/.test(text[right - 1])) right -= 1;
  return { start: left, end: right };
}

function splitBlock(text, start, end, maxChars, out) {
  let cursor = start;
  while (cursor < end) {
    let limit = Math.min(cursor + maxChars, end);
    if (limit < end) {
      const window = text.slice(cursor, limit);
      const candidates = [
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
      ].filter((index) => index > maxChars * 0.45);
      if (candidates.length > 0) limit = cursor + Math.max(...candidates) + 1;
    }
    const range = trimRange(text, cursor, limit);
    if (range.end > range.start) out.push(range);
    cursor = Math.max(limit, cursor + 1);
  }
}

function blockRanges(text, maxChars) {
  const out = [];
  const separator = /\n[ \t]*\n+/g;
  let cursor = 0;
  for (;;) {
    const match = separator.exec(text);
    const end = match ? match.index : text.length;
    const range = trimRange(text, cursor, end);
    if (range.end > range.start) {
      if (range.end - range.start <= maxChars) out.push(range);
      else splitBlock(text, range.start, range.end, maxChars, out);
    }
    if (!match) break;
    cursor = match.index + match[0].length;
  }
  return out;
}

/**
 * Paragraph-aware chunker that preserves absolute character offsets into the
 * source text so every extracted claim can be re-validated against the exact
 * span it came from.
 */
export function chunkText(text, { maxChars = DEFAULT_CHUNK_CHARS, maxChunks = MAX_CHUNKS } = {}) {
  const normalized = String(text ?? '');
  if (!normalized.trim()) return [];

  const segments = blockRanges(normalized, maxChars);
  const ranges = [];
  let current = null;

  for (const segment of segments) {
    if (!current) {
      current = { start: segment.start, end: segment.end };
      continue;
    }
    if (segment.end - current.start <= maxChars) {
      current.end = segment.end;
    } else {
      ranges.push(current);
      current = { start: segment.start, end: segment.end };
    }
  }
  if (current) ranges.push(current);

  return ranges.slice(0, maxChunks).map((range, index) => ({
    index,
    text: normalized.slice(range.start, range.end),
    start: range.start,
    end: range.end,
  }));
}

export function contextBefore(text, start, size = 240) {
  return String(text ?? '').slice(Math.max(0, start - size), start);
}
