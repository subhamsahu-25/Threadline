/**
 * Replaces obvious secrets and personal identifiers with a typed marker.
 * The goal is to keep sensitive values out of a shared handover while
 * leaving enough context for a reviewer to see that something was removed.
 */
const RULES = [
  {
    kind: 'private key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'api key',
    pattern: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    kind: 'bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  },
  {
    kind: 'credential',
    // The value may not already be a marker, or an earlier rule's output gets wrapped twice.
    pattern:
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b(\s*[:=]\s*)(["']?)(?!\[REDACTED:)([^\s"',;]{6,})\3/gi,
    replace: (_match, label, separator) => `${label}${separator}[REDACTED: credential]`,
  },
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: 'phone',
    pattern: /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g,
  },
  {
    kind: 'national id',
    pattern: /\b(?:\d{4}[\s-]){2}\d{4}\b|\b\d{12}\b/g,
  },
];

export function redactText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { text: value, count: 0, kinds: [] };
  }

  let text = value;
  let count = 0;
  const kinds = new Set();

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args) => {
      count += 1;
      kinds.add(rule.kind);
      return rule.replace ? rule.replace(...args) : `[REDACTED: ${rule.kind}]`;
    });
  }

  return { text, count, kinds: [...kinds] };
}

export function createRedactionTally() {
  const kinds = new Set();
  return {
    count: 0,
    add(result) {
      if (!result || !result.count) return;
      this.count += result.count;
      for (const kind of result.kinds) kinds.add(kind);
    },
    toJSON() {
      return { count: this.count, kinds: [...kinds] };
    },
  };
}
