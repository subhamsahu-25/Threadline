import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { AuditEvent, LoginThrottle, User } from '../src/models/index.js';
import { app, request, seed, startDb, stopDb } from './helpers.js';

const PASSWORD = 'Threadline#2026';

function login(email, password = PASSWORD, ip = '198.51.100.10', token) {
  const call = request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password });
  if (token) call.set('Authorization', `Bearer ${token}`);
  return call;
}

function register(email) {
  return request(app)
    .post('/api/auth/register')
    .send({ name: 'Nadia Okafor', email, password: PASSWORD });
}

describe('credential lockout scope', () => {
  const original = { attempts: env.loginMaxAttempts };

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  afterEach(() => {
    env.loginMaxAttempts = original.attempts;
  });

  it('never locks a demo persona, whatever strangers guess', async () => {
    env.loginMaxAttempts = 3;
    const seeded = await seed();
    const demo = seeded.users[0];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await login(demo.email, 'Not-The-Password#7', '203.0.113.9');
    }

    // Demo personas have no published password; their one-click entry survives
    // whatever strangers guess.
    const signedIn = await request(app).post('/api/demo/session').send({ email: demo.email });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.token).toBeTruthy();

    const stored = await User.findOne({ email: demo.email });
    expect(stored.isDemo).toBe(true);
    expect(await LoginThrottle.countDocuments({ user: stored._id })).toBe(0);
  });

  it('charges failures to the client, so another network can still sign in', async () => {
    env.loginMaxAttempts = 3;
    const email = 'owner@example.test';
    await register(email);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wrong = await login(email, 'Wrong-Password#9', '192.0.2.44');
      expect(wrong.status).toBe(401);
    }

    const sameClient = await login(email, PASSWORD, '192.0.2.44');
    expect(sameClient.status).toBe(429);

    const ownerElsewhere = await login(email, PASSWORD, '192.0.2.90');
    expect(ownerElsewhere.status).toBe(200);
    expect(ownerElsewhere.body.token).toBeTruthy();

    const stored = await User.findOne({ email });
    const throttle = await LoginThrottle.findOne({ user: stored._id, client: '192.0.2.44' });
    expect(throttle.lockUntil.getTime()).toBeGreaterThan(Date.now());
    const audit = await AuditEvent.findOne({ action: 'auth.lockout', targetId: stored._id });
    expect(audit.meta.client).toBe('192.0.2.44');
  });

  it('counts concurrent wrong guesses without losing updates', async () => {
    env.loginMaxAttempts = 10;
    const email = 'concurrent@example.test';
    await register(email);

    await Promise.all(
      Array.from({ length: 6 }, () => login(email, 'Wrong-Password#9', '192.0.2.70')),
    );

    const stored = await User.findOne({ email });
    const throttle = await LoginThrottle.findOne({ user: stored._id, client: '192.0.2.70' });
    expect(throttle.attempts).toBe(6);
  });

  it('lets the owner clear a client lock with a session they already hold', async () => {
    env.loginMaxAttempts = 3;
    const email = 'returning@example.test';
    await register(email);

    const first = await login(email, PASSWORD, '192.0.2.120');
    expect(first.status).toBe(200);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login(email, 'Wrong-Password#9', '192.0.2.120');
    }
    expect((await login(email, PASSWORD, '192.0.2.120')).status).toBe(429);

    const unlocked = await login(email, PASSWORD, '192.0.2.120', first.body.token);
    expect(unlocked.status).toBe(200);

    const stored = await User.findOne({ email });
    expect(await LoginThrottle.countDocuments({ user: stored._id })).toBe(0);
  });
});
