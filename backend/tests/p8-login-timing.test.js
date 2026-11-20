import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { app, request, startDb, stopDb } from './helpers.js';

// Counts every password comparison the sign-in route performs. A locked client
// used to answer before reaching bcrypt, which both revealed that the account
// existed and made the locked path measurably faster than any other answer.
const control = vi.hoisted(() => ({ compares: 0 }));

vi.mock('../src/services/auth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    verifyPassword: async (password, hash) => {
      control.compares += 1;
      return actual.verifyPassword(password, hash);
    },
  };
});

const PASSWORD = 'Threadline#2026';
const WRONG = 'Wrong-Password#9';

function register(email) {
  return request(app)
    .post('/api/auth/register')
    .send({ name: 'Timing Owner', email, password: PASSWORD });
}

async function attempt(email, password, ip) {
  const started = performance.now();
  const response = await request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password });
  return { response, ms: performance.now() - started };
}

describe('P8 sign-in timing and resource use', () => {
  const original = { attempts: env.loginMaxAttempts };

  beforeAll(async () => {
    await startDb();
    env.loginMaxAttempts = 3;
  });

  afterAll(async () => {
    env.loginMaxAttempts = original.attempts;
    await stopDb();
  });

  it('runs one password comparison before answering a locked client', async () => {
    const email = 'p8-locked@example.test';
    await register(email);

    for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
      await attempt(email, WRONG, '192.0.2.130');
    }

    control.compares = 0;
    const locked = await attempt(email, PASSWORD, '192.0.2.130');
    const lockedCompares = control.compares;

    control.compares = 0;
    const unknown = await attempt('p8-nobody@example.test', WRONG, '192.0.2.131');
    const unknownCompares = control.compares;

    control.compares = 0;
    const wrong = await attempt(email, WRONG, '192.0.2.132');
    const wrongCompares = control.compares;

    expect(locked.response.status).toBe(429);
    expect(unknown.response.status).toBe(401);
    expect(wrong.response.status).toBe(401);

    // Every answer costs exactly one bcrypt comparison, including the lockout.
    expect(lockedCompares).toBe(1);
    expect(unknownCompares).toBe(1);
    expect(wrongCompares).toBe(1);

    // bcrypt at cost 12 is the dominant cost; none of the three may skip it.
    for (const sample of [locked.ms, unknown.ms, wrong.ms]) {
      expect(sample).toBeGreaterThan(100);
    }
  });

  it('does not hold connections open with an in-request failure delay', async () => {
    env.loginMaxAttempts = 50;
    const email = 'p8-burst@example.test';
    await register(email);

    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => attempt(email, WRONG, '192.0.2.140')),
    );
    const elapsed = performance.now() - started;

    expect(responses.every(({ response }) => response.status === 401)).toBe(true);

    // Eight guesses cost eight bcrypt hashes, not eight sleeps of up to 1.5 s.
    // The cap is deliberately generous so a loaded CI runner still passes.
    expect(elapsed).toBeLessThan(12_000);
    expect(Math.max(...responses.map(({ ms }) => ms))).toBeLessThan(10_000);
  });
});
