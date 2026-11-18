/**
 * Replaces obvious secrets and personal identifiers with a typed marker.
 * The goal is to keep sensitive values out of a shared handover while
 * leaving enough context for a reviewer to see that something was removed.
 *
 * Order matters: structured secrets are removed before generic ones, and
 * connection-string credentials run before the email rule (which would
 * otherwise consume `pass@host`).
 */

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const PROVIDER_KEY =
  /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|whsec_[A-Za-z0-9]{16,})\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g;
const CONNECTION_STRING =
  /\b([a-z][a-z0-9+.-]*):\/\/([^\s:@/]+):([^\s@/]+)@/gi;
const WEBHOOK =
  /https?:\/\/(?:hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\/|hooks\.stripe\.com\/|[^\s"'<>]+\/webhooks?\/)[A-Za-z0-9/_?.=&%-]{6,}/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Key names are judged word by word instead of with one huge prefix regex, so
// DB_PASSWORD, MY_API_KEY, AWS_SECRET_ACCESS_KEY and accessToken all count as
// secret-bearing names while prose labels such as "Decision:" do not.
const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'passphrase', 'pass', 'secret', 'token']);
const SECRET_PAIRS = new Set([
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'accesstoken',
  'authtoken',
  'apitoken',
]);

function keyWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSecretKey(name) {
  const words = keyWords(name);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  return words.some((word, index) => SECRET_PAIRS.has(word + (words[index + 1] || '')));
}

function isPasswordKey(name) {
  return keyWords(name).some((word) =>
    ['password', 'passwd', 'pwd', 'passphrase', 'pass'].includes(word),
  );
}

// Quoted values are removed whole; an unquoted secret ends at whitespace so a
// following sentence is not swallowed.
const QUOTED_OR_WORD = '(?:"[^"\\n]*"|\'[^\'\\n]*\'|`[^`\\n]*`|[^\\s,;]+)';
const SECRET_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_.-]*)(\\s*[:=]\\s*)(${QUOTED_OR_WORD})`,
  'g',
);
// Passwords are the one case where "correct horse battery staple" is a single
// value, so the unquoted form runs to the end of the line.
const PASSWORD_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_.-]*)(\\s*[:=]\\s*)(?:"[^"\\n]*"|\'[^\'\\n]*\'|\`[^\`\\n]*\`|[^\\n]+)`,
  'g',
);

const PHONE =
  /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b|\b91[6-9]\d{9}\b/;
const PHONE_GLOBAL = new RegExp(PHONE.source, 'g');
const AADHAAR = /\b(?:\d{4}[\s-]){2}\d{4}(?![\s-]?\d)\b|\b\d{12}\b/;
const AADHAAR_GLOBAL = new RegExp(AADHAAR.source, 'g');
const CARD = /\b(?:\d[ -]?){12,18}\d\b/;
const CARD_GLOBAL = new RegExp(CARD.source, 'g');
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;

const PHONE_LABELS = ['phone', 'mobile', 'call', 'tel', 'whatsapp', 'cell', 'contact'];
const AADHAAR_LABELS = ['aadhaar', 'aadhar', 'uidai', 'national id', 'nid'];
const CARD_LABELS = ['card', 'visa', 'mastercard', 'amex', 'credit', 'debit'];
const PAN_LABELS = ['pan', 'income tax'];

// Labels are matched as whole words so "Intel", "telemetry", "excellent" or
// "Japan" do not count as context for an unrelated number.
const LABEL_PATTERNS = new Map();
function labelPattern(label) {
  let pattern = LABEL_PATTERNS.get(label);
  if (!pattern) {
    const words = label
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .split(/\s+/)
      .join('[^a-z0-9]+');
    pattern = new RegExp(`(?:^|[^a-z0-9])${words}(?:$|[^a-z0-9])`);
    LABEL_PATTERNS.set(label, pattern);
  }
  return pattern;
}

function nearbyLabel(text, index, labels, window = 48) {
  const start = Math.max(0, index - window);
  const before = text.slice(start, index).toLowerCase();
  // Labels usually lead the value ("phone: ..."), but a short trailing label
  // ("... is my phone") is accepted too.
  const after = text.slice(index, Math.min(text.length, index + window)).toLowerCase();
  return labels.some((label) => {
    const pattern = labelPattern(label);
    return pattern.test(before) || pattern.test(after);
  });
}

function digitsOf(value) {
  return value.replace(/\D/g, '');
}

function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const VERHOEFF_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_PERMUTATIONS = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffValid(digits) {
  let checksum = 0;
  const reversed = digits.split('').reverse();
  for (let index = 0; index < reversed.length; index += 1) {
    checksum = VERHOEFF_TABLE[checksum][VERHOEFF_PERMUTATIONS[index % 8][Number(reversed[index])]];
  }
  return checksum === 0;
}

export function redactText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { text: value, count: 0, kinds: [] };
  }

  let text = value;
  let count = 0;
  const kinds = new Set();
  const replace = (pattern, kind, replacement) => {
    text = text.replace(pattern, (...args) => {
      const matched = args[0];
      if (matched.includes('[REDACTED:')) return matched;
      count += 1;
      kinds.add(kind);
      return typeof replacement === 'function' ? replacement(...args) : `[REDACTED: ${kind}]`;
    });
  };

  replace(PRIVATE_KEY, 'private key');
  replace(JWT, 'jwt');
  replace(GOOGLE_KEY, 'api key');
  replace(PROVIDER_KEY, 'api key');
  replace(BEARER, 'bearer token');
  replace(
    CONNECTION_STRING,
    'connection string',
    (_match, scheme) => `${scheme}://[REDACTED: connection string]@`,
  );
  replace(WEBHOOK, 'webhook');
  text = text.replace(PASSWORD_ASSIGNMENT, (match, label, separator) => {
    if (!isPasswordKey(label)) return match;
    count += 1;
    kinds.add('credential');
    return `${label}${separator}[REDACTED: credential]`;
  });
  text = text.replace(SECRET_ASSIGNMENT, (match, label, separator, value) => {
    if (!isSecretKey(label) || value.startsWith('[REDACTED:')) return match;
    count += 1;
    kinds.add('credential');
    return `${label}${separator}[REDACTED: credential]`;
  });
  replace(EMAIL, 'email');

  // PII runs as dedicated passes so a bare number can be judged by its label
  // or its checksum instead of being redacted on length alone.
  text = text.replace(CARD_GLOBAL, (match, offset, source) => {
    const digits = digitsOf(match);
    const labelled = nearbyLabel(source, offset, CARD_LABELS);
    if (!luhnValid(digits) && !labelled) return match;
    count += 1;
    kinds.add('card');
    return '[REDACTED: card]';
  });

  text = text.replace(AADHAAR_GLOBAL, (match, offset, source) => {
    const digits = digitsOf(match);
    if (digits.length !== 12) return match;
    if (!verhoeffValid(digits) && !nearbyLabel(source, offset, AADHAAR_LABELS)) return match;
    count += 1;
    kinds.add('national id');
    return '[REDACTED: national id]';
  });

  text = text.replace(PHONE_GLOBAL, (match, offset, source) => {
    const digits = digitsOf(match);
    const countryCode = /^\+?91/.test(match) || digits.startsWith('91');
    if (!countryCode && !nearbyLabel(source, offset, PHONE_LABELS)) return match;
    count += 1;
    kinds.add('phone');
    return '[REDACTED: phone]';
  });

  text = text.replace(PAN, (match, offset, source) => {
    if (!nearbyLabel(source, offset, PAN_LABELS)) return match;
    count += 1;
    kinds.add('national id');
    return '[REDACTED: national id]';
  });

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
