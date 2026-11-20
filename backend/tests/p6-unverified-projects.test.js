import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Project, User } from '../src/models/index.js';
import { signEmailVerificationToken } from '../src/services/verification.js';
import { app, request, startDb, stopDb } from './helpers.js';

const PASSWORD = 'Threadline#2026';

async function newAccount(email) {
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Pia Unverified', email, password: PASSWORD });
  expect(registered.status).toBe(201);
  const signedIn = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  return { token: signedIn.body.token, user: await User.findOne({ email }) };
}

function createProject(token, key) {
  return request(app)
    .post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ key, name: 'Unverified project' });
}

describe('project creation requires a confirmed address', () => {
  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  it('refuses an unverified creator and changes nothing', async () => {
    const { token, user } = await newAccount('pia@example.test');
    expect(user.emailVerifiedAt).toBeUndefined();

    const refused = await createProject(token, 'P6UNVERIFIED');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('email_unverified');
    expect(await Project.countDocuments({ key: 'P6UNVERIFIED' })).toBe(0);
  });

  it('lets the same person create a project after confirming the address', async () => {
    const { token, user } = await newAccount('confirmed@example.test');
    await request(app)
      .post('/api/auth/verify-email')
      .send({ token: signEmailVerificationToken(user) })
      .expect(200);

    // The token still identifies the account; the check reads the fresh row.
    const created = await createProject(token, 'P6CONFIRMED');
    expect(created.status).toBe(201);
    expect(created.body.project.members[0].role).toBe('lead');
    expect(await Project.countDocuments({ key: 'P6CONFIRMED' })).toBe(1);
  });
});
