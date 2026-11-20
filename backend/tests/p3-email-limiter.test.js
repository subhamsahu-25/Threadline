import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { setAuthLimitsEnabledForTests } from '../src/routes/auth.routes.js';
import { app, request, seed, startDb, stopDb } from './helpers.js';

const PASSWORD = 'Threadline#2026';
const WRONG = 'Wrong-Password#9';

function login(email, password, ip) {
  return request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password });
}

function register(email) {
  return request(app)
    .post('/api/auth/register')
    .send({ name: 'Limiter Owner', email, password: PASSWORD });
}

/**
 * The limiter is off in tests so unrelated suites can sign in freely. This
 * file turns it on to exercise the key it uses.
 */
describe('P3 per-address limiter cannot punish the owner', () => {
  beforeAll(async () => {
    await startDb();
    env.loginMaxAttempts = 5;
    setAuthLimitsEnabledForTests(true);
  });

  afterAll(async () => {
    setAuthLimitsEnabledForTests(false);
    await stopDb();
  });

  it('ten guesses from one address do not stop the owner signing in from another', async () => {
    const email = 'p3-owner@example.test';
    await register(email);

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const guess = await login(email, WRONG, '192.0.2.10');
      // The on-account lockout may answer 429 after a few tries; either way
      // the attempt is counted against this address and this client.
      expect([401, 429]).toContain(guess.status);
    }

    const owner = await login(email, PASSWORD, '192.0.2.20');
    expect(owner.status).toBe(200);
    expect(owner.body.token).toBeTruthy();
  });

  it('does not rate-limit a demo persona address', async () => {
    const seeded = await seed();
    const demo = seeded.users.find((user) => user.email === 'vikram@threadline.demo');

    for (let attempt = 0; attempt < 11; attempt += 1) {
      await login(demo.email, WRONG, '198.51.100.40');
    }

    const elsewhere = await login(demo.email, WRONG, '198.51.100.41');
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.status).not.toBe(429);
  });
});
