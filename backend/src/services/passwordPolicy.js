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

/**
 * Returns a human-readable reason a new password is not acceptable, or null.
 * Existing passwords are never re-checked, so a policy change cannot lock a
 * current account out of its own sign-in.
 */
export function passwordProblem(password, { email, name } = {}) {
  const value = String(password ?? '');
  if (value.length < 10) return 'Use at least 10 characters';
  if (value.length > 128) return 'Use at most 128 characters';

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
