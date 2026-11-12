const LABELS = [
  ['decision', /decision/i],
  ['task', /action item|todo|task|next step/i],
  ['risk', /risk|concern/i],
  ['dependency', /depends on|dependency|blocked by/i],
  ['question', /open question|question|unresolved/i],
  ['milestone', /milestone/i],
  ['responsibility', /owner|responsible/i],
];

const LABEL_RE = new RegExp(
  `^\\s*(?:[-*+]\\s*)?(?:\\*\\*|__)?(${LABELS.map(([, re]) => re.source).join(
    '|',
  )})(?:\\*\\*|__)?\\s*(?::|\\u2014|\\u2013|-)\\s*(.+)$`,
  'i',
);

const CHECKBOX_RE = /^\s*[-*+]\s*\[( |x|X)\]\s*(.+)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const OWNER_RE = /\bowner\s*[:=]\s*(@?[A-Za-z][A-Za-z0-9 ._@-]{1,40}?)(?=\s*(?:[,;|)\]]|due\b|status\b|$))/i;
const DUE_RE = /\bdue\s*[:=]\s*(\d{4}-\d{2}-\d{2})/i;
const STATUS_RE = /\bstatus\s*[:=]\s*(open|active|planned|done|resolved|superseded|completed|blocked)\b/i;
const DATE_META_RE = /\bdate\s*[:=]\s*(\d{4}-\d{2}-\d{2})\b/i;
const SUPERSEDE_RE = /\b(supersed\w*|replac\w*|instead of|migrat\w*\s+(?:from|to|off))\b/i;

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
    if (/open|blocked/.test(explicit)) return 'open';
    return 'active';
  }
  if (type === 'decision' || type === 'responsibility') return 'active';
  if (type === 'milestone') return 'planned';
  return 'open';
}

/**
 * Deterministic extractor used when no LLM key is configured (and as a
 * fallback when the LLM call fails). It only reads explicit, labelled lines so
 * that every claim it produces has a verbatim quote in the source.
 */
export function heuristicExtract({ text, docTitle = '' }) {
  const items = [];
  const lines = [];
  let cursor = 0;
  for (const raw of text.split('\n')) {
    lines.push({ raw, start: cursor, end: cursor + raw.length });
    cursor += raw.length + 1;
  }

  let topic = docTitle;
  for (const line of lines) {
    const raw = line.raw;
    if (!raw.trim()) continue;

    const heading = raw.match(HEADING_RE);
    if (heading) {
      topic = heading[2].trim();
      continue;
    }

    let type = null;
    let body = '';
    let statusHint = null;

    const checkbox = raw.match(CHECKBOX_RE);
    if (checkbox) {
      type = 'task';
      body = checkbox[2];
      statusHint = checkbox[1].toLowerCase() === 'x' ? 'done' : null;
    } else {
      const labelled = raw.match(LABEL_RE);
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
    const dateMatch = body.match(DATE_RE);

    let statement = removeMetadata(body);
    if (!statement) statement = cleanStatement(body);

    const explicitStatus = statusMatch?.[1] ?? statusHint ?? null;
    const status = defaultStatus(type, explicitStatus);

    const owner = ownerMatch?.[1]?.replace(/^@/, '').replace(/[.,;:]$/, '').trim();

    items.push({
      type,
      statement,
      topic,
      status,
      owner: owner || null,
      dueDate: dueMatch?.[1] ?? null,
      occurredAt: dateMetaMatch?.[1] ?? dateMatch?.[1] ?? null,
      quote: raw.trim(),
      confidence: 0.82,
      rationale: `Explicitly labelled in the source as a ${type}.`,
      flags: SUPERSEDE_RE.test(statement) ? ['explicit_supersession'] : [],
    });

    if (items.length >= MAX_ITEMS_PER_CHUNK) break;
  }

  return items;
}
