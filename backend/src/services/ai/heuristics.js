const LABELS = [
  ['decision', /decisions?/i],
  ['task', /action items?|tasks?|to-?dos?|next steps?/i],
  ['risk', /risks?|concerns?/i],
  ['dependency', /dependenc(?:y|ies)|depends on|blocked by/i],
  ['question', /open questions?|questions?|unresolved/i],
  ['milestone', /milestones?/i],
  ['responsibility', /responsibilit(?:y|ies)|responsible/i],
];

// A label separator must be a colon or a dash surrounded by spaces. A bare
// hyphen would turn "Risk-based testing" into a claim about "based testing".
const LABEL_RE = new RegExp(
  `^\\s*(?:[-*+]\\s*)?(${LABELS.map(([, re]) => re.source).join(
    '|',
  )})\\s*(?::|\\s[\\u2013\\u2014-]\\s)\\s*(.+)$`,
  'i',
);

const CHECKBOX_RE = /^\s*[-*+]\s*\[( |x|X)\]\s*(.+)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const OWNER_LINE_RE = /^\s*(?:[-*+]\s*)?owner\s*[:=]\s*(.+)$/i;
const OWNER_RE =
  /\bowner\s*[:=]\s*(@?[\p{L}][\p{L}\p{N} ._@-]{1,40}?)(?=\s*(?:[,;|)\]]|due\b|status\b|$))/iu;
const DUE_RE = /\bdue\s*[:=]\s*(\d{4}-\d{2}-\d{2})\b/i;
const STATUS_RE =
  /\bstatus\s*[:=]\s*(open|active|planned|done|resolved|superseded|completed|blocked)\b/i;
const DATE_META_RE = /\bdate\s*[:=]\s*(\d{4}-\d{2}-\d{2})\b/i;
// Only phrases that point at a previous decision count as supersession. Plain
// "replace" or "migrate to" appear in ordinary decisions and must not hide an
// older statement.
const SUPERSEDE_RE =
  /\b(supersed\w*|replaces? the (?:old|previous|existing|earlier)\w*|replaced by|instead of|no longer (?:use|used|using|support\w*|valid)|deprecat\w*)\b/i;

const MAX_ITEMS_PER_CHUNK = 24;
const MAX_STATEMENT = 600;

function cleanStatement(value) {
  return value
    .replace(/\*\*/g, '')
    .replace(/^[\s:;,.|)\]]+/, '')
    .replace(/[\s:;,|(\[]+$/, '')
    .trim()
    .slice(0, MAX_STATEMENT);
}

/**
 * A YYYY-MM-DD value is only a real date when it survives a Date round-trip,
 * so "2026-13-45" is rejected instead of crashing the claim write.
 */
export function validDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === text ? text : null;
}

function removeMetadata(body) {
  const ranges = [];
  for (const re of [OWNER_RE, DUE_RE, STATUS_RE, DATE_META_RE]) {
    const match = body.match(re);
    if (match) ranges.push([match.index, match.index + match[0].length]);
  }
  let out = body;
  if (ranges.length > 0) {
    out = '';
    let cursor = 0;
    for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
      out += body.slice(cursor, start);
      cursor = end;
    }
    out += body.slice(cursor);
  }
  return cleanStatement(
    out
      .replace(/\(\s*(?:[,;|]\s*)*\)/g, ' ')
      .replace(/\[\s*(?:[,;|]\s*)*\]/g, ' ')
      .replace(/(?:\s*[,;|]\s*){2,}/g, ' ')
      .replace(/\s{2,}/g, ' '),
  );
}

function inferType(label) {
  const lowered = label.toLowerCase();
  for (const [type, re] of LABELS) {
    if (re.test(lowered)) return type;
  }
  return null;
}

function defaultStatus(type, explicit) {
  if (explicit) {
    if (/done|completed/.test(explicit)) return 'done';
    if (/resolved/.test(explicit)) return 'resolved';
    if (/superseded/.test(explicit)) return 'superseded';
    if (/planned/.test(explicit)) return 'planned';
    if (/blocked/.test(explicit)) return 'blocked';
    if (/open/.test(explicit)) return 'open';
    return 'active';
  }
  if (type === 'decision' || type === 'responsibility') return 'active';
  if (type === 'milestone') return 'planned';
  return 'open';
}

function cleanForMatching(line) {
  return line.replace(/\*\*|__/g, '');
}

/** True when a quoted sentence explicitly replaces an earlier decision. */
export function isExplicitSupersession(text) {
  return SUPERSEDE_RE.test(String(text ?? ''));
}

function ownerFrom(value) {
  return value.replace(/^@/, '').replace(/[.,;:]$/, '').trim();
}

/**
 * Deterministic extractor used when no LLM key is configured (and as a
 * fallback when the LLM call fails). It only reads explicit, labelled lines so
 * that every claim it produces has a verbatim quote in the source.
 *
 * Returns `{ items, warnings, truncated }`. `heuristicExtract` keeps the plain
 * array API for callers that only need the items.
 */
export function heuristicExtractWithMeta({ text, docTitle = '' }) {
  const items = [];
  const warnings = [];
  const lines = [];
  let cursor = 0;
  for (const raw of text.split('\n')) {
    lines.push({ raw, start: cursor, end: cursor + raw.length });
    cursor += raw.length + 1;
  }

  let topic = docTitle;
  let lastItem = null;
  let lastItemLineEnd = -1;
  let invalidDates = 0;

  for (const line of lines) {
    const raw = line.raw;
    if (!raw.trim()) continue;
    const matchable = cleanForMatching(raw);

    const heading = matchable.match(HEADING_RE);
    if (heading) {
      topic = heading[2].trim();
      lastItem = null;
      continue;
    }

    // "Owner: Rohan Mehta" is metadata about the previous item, not a claim of
    // its own. Attach it (and its source text) to the item directly above.
    const ownerLine = matchable.match(OWNER_LINE_RE);
    if (ownerLine && lastItem && line.start === lastItemLineEnd + 1) {
      const owner = ownerFrom(ownerLine[1]);
      if (owner) {
        lastItem.owner = owner;
        lastItem.quote = `${lastItem.quote}\n${raw.trim()}`;
      }
      lastItemLineEnd = line.end;
      continue;
    }

    let type = null;
    let body = '';
    let statusHint = null;

    const checkbox = matchable.match(CHECKBOX_RE);
    if (checkbox) {
      type = 'task';
      body = checkbox[2];
      statusHint = checkbox[1].toLowerCase() === 'x' ? 'done' : null;
    } else {
      const labelled = matchable.match(LABEL_RE);
      if (labelled) {
        type = inferType(labelled[1]);
        body = labelled[2];
      }
    }

    if (!type || !body.trim()) continue;

    const ownerMatch = body.match(OWNER_RE);
    const dueMatch = body.match(DUE_RE);
    const statusMatch = body.match(STATUS_RE);
    const dateMetaMatch = body.match(DATE_META_RE);

    const dueDate = dueMatch ? validDate(dueMatch[1]) : null;
    const occurredAt = dateMetaMatch ? validDate(dateMetaMatch[1]) : null;
    if ((dueMatch && !dueDate) || (dateMetaMatch && !occurredAt)) invalidDates += 1;

    let statement = removeMetadata(body);
    if (!statement) statement = cleanStatement(body);

    const explicitStatus = statusMatch?.[1] ?? statusHint ?? null;
    const status = defaultStatus(type, explicitStatus);
    const owner = ownerMatch ? ownerFrom(ownerMatch[1]) : null;

    const item = {
      type,
      statement,
      topic,
      status,
      owner,
      dueDate,
      occurredAt,
      quote: raw.trim(),
      confidence: 0.82,
      rationale: `Explicitly labelled in the source as a ${type}.`,
      flags: SUPERSEDE_RE.test(statement) ? ['explicit_supersession'] : [],
    };
    items.push(item);
    lastItem = item;
    lastItemLineEnd = line.end;

    if (items.length >= MAX_ITEMS_PER_CHUNK) {
      if (line.end < text.length - 1) {
        warnings.push(
          `Only the first ${MAX_ITEMS_PER_CHUNK} labelled items in this text section were extracted; the rest were not analysed.`,
        );
      }
      break;
    }
  }

  if (invalidDates > 0) {
    warnings.push(
      `${invalidDates} date value(s) on labelled lines were not real calendar dates and were left empty.`,
    );
  }

  return { items, warnings };
}

export function heuristicExtract({ text, docTitle = '' }) {
  return heuristicExtractWithMeta({ text, docTitle }).items;
}
