import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { AuditEvent, LoginThrottle, User } from '../src/models/index.js';
import { listNotifications } from '../src/services/notifications.js';
import { app, request, startDb, stopDb } from './helpers.js';

const PASSWORD = 'Threadline#2026';

function register(body) {
  return request(app)
    .post('/api/auth/register')
    .send({ name: 'Ada Lovelace', password: PASSWORD, ...body });
}

function login(email, password = PASSWORD) {
  return request(app).post('/api/auth/login').send({ email, password });
}

describe('account security', () => {
  const original = {
    mode: env.registrationMode,
    codes: env.registrationInviteCodes,
    domains: env.registrationEmailDomains,
    attempts: env.loginMaxAttempts,
  };

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  afterEach(() => {
    env.registrationMode = original.mode;
    env.registrationInviteCodes = original.codes;
    env.registrationEmailDomains = original.domains;
    env.loginMaxAttempts = original.attempts;
  });

  it('answers a new and an already registered address identically', async () => {
    const first = await register({ email: 'uniform@example.test' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      registered: true,
      message: 'Account created. Sign in with your email and password.',
    });

    const second = await register({ email: 'uniform@example.test' });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.body.token).toBeUndefined();
    expect(second.body.user).toBeUndefined();
    expect(await User.countDocuments({ email: 'uniform@example.test' })).toBe(1);
  });

  it('answers an unknown address and a wrong password identically', async () => {
    await register({ email: 'known@example.test' });

    const unknown = await login('ghost@example.test');
    const wrong = await login('known@example.test', 'Threadline#2027');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('rejects weak, short and personal passwords with a reason', async () => {
    // Ten characters, four character kinds, but a known breached password.
    const common = await register({ email: 'weak@example.test', password: 'Trustno1!!' });
    expect(common.status).toBe(400);
    const commonIssue = common.body.error.details.find((entry) => entry.path === 'password');
    expect(commonIssue.message).toMatch(/breached/i);

    const short = await register({ email: 'short@example.test', password: 'One#1' });
    expect(short.status).toBe(400);
    expect(
      short.body.error.details.some(
        (entry) => entry.path === 'password' && /at least 10/i.test(entry.message),
      ),
    ).toBe(true);

    const personal = await register({
      email: 'ada@example.test',
      password: 'AdaLovelace#2026',
      name: 'Ada Lovelace',
    });
    expect(personal.status).toBe(400);
    expect(
      personal.body.error.details.some(
        (entry) => entry.path === 'password' && /your name/i.test(entry.message),
      ),
    ).toBe(true);
  });

  it('requires a valid invite code when the deployment is invite-only', async () => {
    env.registrationMode = 'invite';
    env.registrationInviteCodes = ['TS-INVITE-2026'];
    env.registrationEmailDomains = [];

    const missing = await register({ email: 'invitee@example.test' });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('registration_invite_only');

    const wrong = await register({ email: 'invitee@example.test', inviteCode: 'TS-INVITE-2025' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('registration_invite_only');

    const right = await register({ email: 'invitee@example.test', inviteCode: 'TS-INVITE-2026' });
    expect(right.status).toBe(201);
    expect(right.body.registered).toBe(true);
  });

  it('limits registration to approved email domains when configured', async () => {
    env.registrationMode = 'open';
    env.registrationInviteCodes = [];
    env.registrationEmailDomains = ['threadline.demo'];

    const outside = await register({ email: 'someone@example.test' });
    expect(outside.status).toBe(403);
    expect(outside.body.error.code).toBe('registration_domain_restricted');

    const inside = await register({ email: 'new@threadline.demo' });
    expect(inside.status).toBe(201);
  });

  it('pauses sign-in after repeated failures and tells the account owner', async () => {
    env.loginMaxAttempts = 3;
    const email = 'locked@example.test';
    await register({ email });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await login(email, 'Wrong-Password#9');
      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Email or password is incorrect');
    }

    const blocked = await login(email);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('too_many_attempts');

    const user = await User.findOne({ email });
    const audit = await AuditEvent.findOne({ action: 'auth.lockout', targetId: user._id });
    expect(audit).toBeTruthy();
    expect(audit.meta.attempts).toBe(3);

    const { notifications } = await listNotifications({ user });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('account.lockout');
    expect(notifications[0].projectId).toBeNull();
    expect(notifications[0].title).toMatch(/sign-in attempts/i);

    // A lockout expires; it must not become a permanent ban.
    await LoginThrottle.deleteMany({ user: user._id });
    const recovered = await login(email);
    expect(recovered.status).toBe(200);
    expect(recovered.body.token).toBeTruthy();
  });

  it('serves API responses with a strict content security policy', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);

    const policy = response.headers['content-security-policy'];
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
