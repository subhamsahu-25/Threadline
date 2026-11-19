import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { Delivery, User } from '../src/models/index.js';
import { signEmailVerificationToken } from '../src/services/verification.js';
import { app, auth, request, seed, startDb, stopDb } from './helpers.js';

const LEAD = 'subham@threadline.demo';

function expiredToken(user) {
  return jwt.sign(
    { sub: String(user._id), email: user.email, purpose: 'email_verify' },
    env.jwtSecret,
    { expiresIn: '-1s', algorithm: 'HS256' },
  );
}

describe('email verification before project membership', () => {
  let seeded;
  let projectId;
  let leadToken;
  let originalMode;
  let originalCodes;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    originalMode = env.registrationMode;
    originalCodes = env.registrationInviteCodes;
    env.registrationMode = 'open';
    env.registrationInviteCodes = [];
    seeded = await seed();
    projectId = seeded.project.id;
    leadToken = seeded.users.find((user) => user.email === LEAD).token;
  });

  afterEach(() => {
    env.registrationMode = originalMode;
    env.registrationInviteCodes = originalCodes;
  });

  async function registerRaw(email, name = 'Unconfirmed Person') {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email, name, password: 'Threadline#2026' });
    expect(response.status).toBe(201);
    return { response, user: await User.findOne({ email }) };
  }

  it('keeps an unverified account out of a project until the mailbox confirms', async () => {
    const { user } = await registerRaw('unconfirmed@example.com');
    expect(user.emailVerifiedAt).toBeFalsy();

    const lookupBefore = await request(app)
      .get(`/api/projects/${projectId}/member-lookup`)
      .query({ email: 'unconfirmed@example.com' })
      .set(auth(leadToken))
      .expect(200);
    expect(lookupBefore.body.lookup).toMatchObject({
      found: true,
      emailVerified: false,
      isMember: false,
    });

    const refused = await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email: 'unconfirmed@example.com', role: 'observer' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('email_unverified');
    expect(refused.body.error.details.emailVerified).toBe(false);

    const verified = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: signEmailVerificationToken(user) })
      .expect(200);
    expect(verified.body.verified).toBe(true);
    expect(verified.body.alreadyVerified).toBe(false);

    const repeated = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: signEmailVerificationToken(user) })
      .expect(200);
    expect(repeated.body.alreadyVerified).toBe(true);

    const lookupAfter = await request(app)
      .get(`/api/projects/${projectId}/member-lookup`)
      .query({ email: 'unconfirmed@example.com' })
      .set(auth(leadToken))
      .expect(200);
    expect(lookupAfter.body.lookup.emailVerified).toBe(true);

    const added = await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email: 'unconfirmed@example.com', role: 'observer' })
      .expect(201);
    const member = added.body.project.members.find(
      (entry) => entry.email === 'unconfirmed@example.com',
    );
    expect(member.emailVerified).toBe(true);
  });

  it('rejects an expired link and a link that names a different address', async () => {
    const { user } = await registerRaw('expired@example.com');

    const expired = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: expiredToken(user) });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('verification_invalid');

    const stolen = jwt.sign(
      { sub: String(user._id), email: 'somebody-else@example.com', purpose: 'email_verify' },
      env.jwtSecret,
      { expiresIn: '1h', algorithm: 'HS256' },
    );
    const mismatched = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: stolen });
    expect(mismatched.status).toBe(400);

    const unchanged = await User.findById(user._id);
    expect(unchanged.emailVerifiedAt).toBeFalsy();
  });

  it('refuses to create a project with an unconfirmed member', async () => {
    await registerRaw('project-invite@example.com');

    const refused = await request(app)
      .post('/api/projects')
      .set(auth(leadToken))
      .send({
        key: 'UNVERIFIED',
        name: 'Unverified invite project',
        members: [{ email: 'project-invite@example.com', role: 'contributor' }],
      });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('email_unverified');
    expect(refused.body.error.details.unverifiedEmails).toContain('project-invite@example.com');
  });

  it('binds a bound invite code to the address it names', async () => {
    env.registrationMode = 'invite';
    env.registrationInviteCodes = ['TEAM-BOUND:bound@example.com', 'OPEN-CODE'];

    const wrongAddress = await request(app).post('/api/auth/register').send({
      email: 'forwarded@example.com',
      name: 'Forwarded Code',
      password: 'Threadline#2026',
      inviteCode: 'TEAM-BOUND',
    });
    expect(wrongAddress.status).toBe(403);
    expect(wrongAddress.body.error.code).toBe('registration_invite_only');

    const bound = await request(app).post('/api/auth/register').send({
      email: 'bound@example.com',
      name: 'Bound Invitee',
      password: 'Threadline#2026',
      inviteCode: 'TEAM-BOUND',
    });
    expect(bound.status).toBe(201);

    const open = await request(app).post('/api/auth/register').send({
      email: 'open@example.com',
      name: 'Open Code',
      password: 'Threadline#2026',
      inviteCode: 'OPEN-CODE',
    });
    expect(open.status).toBe(201);
  });

  it('never returns the link or token and answers resends uniformly', async () => {
    const { response, user } = await registerRaw('quiet@example.com');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('verify-email?token');
    expect(serialized).not.toContain('token');

    const row = await Delivery.findOne({ user: user._id, kind: 'auth.verify_email' }).lean();
    expect(row).toBeTruthy();
    // No mail provider is configured in tests, so the record honestly says
    // nothing left the server.
    expect(row.status).toBe('skipped');

    const known = await request(app)
      .post('/api/auth/verification/resend')
      .send({ email: 'quiet@example.com' });
    const unknown = await request(app)
      .post('/api/auth/verification/resend')
      .send({ email: 'nobody-here@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
  });

  it('seeds demo personas as verified', async () => {
    const demo = await User.findOne({ email: LEAD });
    expect(demo.emailVerifiedAt).toBeTruthy();
    expect(demo.isDemo).toBe(true);
  });
});
