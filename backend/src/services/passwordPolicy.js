import { createHash } from 'node:crypto';
import { env } from '../config/env.js';

const BREACHED = new Set([
  '1234567890',
  '123456789',
  '12345678',
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'password12345',
  'passw0rd',
  'p@ssw0rd',
  'qwerty123',
  'qwertyuiop',
  'qwerty12345',
  'letmein123',
  'welcome123',
  'welcometo',
  'admin12345',
  'administrator',
  'iloveyou123',
  'monkey12345',
  'dragon12345',
  'football123',
  'baseball123',
  'superman123',
  'sunshine123',
  'princess123',
  'trustno1',
  'abc123456',
  'abcd1234',
  'a1b2c3d4e5',
  'changeme123',
  'secret12345',
  'mypassword',
  'mypassword1',
  'whatever123',
  'starwars123',
  'master12345',
  'shadow12345',
  'computer123',
  'michelle123',
  'jennifer123',
  'michael123',
  'jordan12345',
  'hunter2hunter2',
  'correcthorsebatterystaple',
]);

function compact(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function hasRun(value) {
  return /(.)\1{5,}/.test(value);
}

// bcrypt silently ignores everything after the 72nd byte, so two passwords
// that share a 72-byte prefix would be interchangeable at sign-in. Measured in
// UTF-8 bytes, not characters, because a non-Latin character costs more.
export const BCRYPT_MAX_BYTES = 72;

function sha1(value) {
  return createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();
}

/**
 * Asks the Have I Been Pwned range API whether a password has appeared in a
 * breach. Only the first five SHA-1 characters are sent (k-anonymity); the
 * full hash and the password never leave this server. Fails open so an
 * unreachable API cannot block sign-up.
 */
export async function isBreachedOnline(password, { fetchImpl = globalThis.fetch } = {}) {
  const value = String(password ?? '');
  if (!env.breachCheckEnabled || !value || typeof fetchImpl !== 'function') return false;
  const digest = sha1(value);
  try {
    const response = await fetchImpl(
      `https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`,
      {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'Threadline password policy' },
        signal: AbortSignal.timeout(env.breachCheckTimeoutMs),
      },
    );
    if (!response?.ok) return false;
    const body = await response.text();
    return body
      .split('\n')
      .some((line) => line.split(':')[0]?.trim().toUpperCase() === digest.slice(5));
  } catch {
    return false;
  }
}

/**
 * Returns a human-readable reason a new password is not acceptable, or null.
 * Existing passwords are never re-checked, so a policy change cannot lock a
 * current account out of its own sign-in.
 */
export function passwordProblem(password, { email, name } = {}) {
  const value = String(password ?? '');
  if (value.length < 10) return 'Use at least 10 characters';
  if (Buffer.byteLength(value, 'utf8') > BCRYPT_MAX_BYTES) {
    return 'Use at most 72 bytes of text; accented and non-Latin characters count for more than one';
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(value),
  ).length;
  if (classes < 3) {
    return 'Mix upper case, lower case, numbers and symbols (at least three kinds)';
  }

  const key = compact(value);
  if (BREACHED.has(key)) {
    return 'This password appears in breached-password lists. Choose a different one.';
  }
  if (hasRun(value)) return 'Avoid long runs of the same character';

  const localPart = compact(String(email || '').split('@')[0]);
  if (localPart.length >= 4 && key.includes(localPart)) {
    return 'Do not include your email address in the password';
  }
  const namePart = compact(name);
  if (namePart.length >= 4 && key.includes(namePart)) {
    return 'Do not include your name in the password';
  }

  return null;
}
