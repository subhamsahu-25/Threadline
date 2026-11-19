import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { compare } from 'bcryptjs';
import { env } from '../src/config/env.js';
import { seedDemo } from '../src/demo/seed.js';
import { User } from '../src/models/index.js';
import { app, auth, request, seed, startDb, stopDb } from './helpers.js';

const PUBLISHED = 'Threadline#2026';
const DEMO_EMAIL = 'ananya@threadline.demo';

describe('demo sign-in without a published password', () => {
  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    await seed();
  });

  it('issues a session for a seeded persona', async () => {
    const response = await request(app)
      .post('/api/demo/session')
      .send({ email: DEMO_EMAIL })
      .expect(200);

    expect(response.body.token).toBeTruthy();
    expect(response.body.user.email).toBe(DEMO_EMAIL);

    const me = await request(app).get('/api/auth/me').set(auth(response.body.token)).expect(200);
    expect(me.body.user.email).toBe(DEMO_EMAIL);
  });

  it('refuses addresses that are not demo personas', async () => {
    await request(app)
      .post('/api/demo/session')
      .send({ email: 'owner@example.test' })
      .expect(404);
    await request(app).post('/api/demo/session').send({}).expect(404);
  });

  it('disappears when demo mode is off', async () => {
    const original = env.allowDemoSeed;
    env.allowDemoSeed = false;
    try {
      await request(app).post('/api/demo/session').send({ email: DEMO_EMAIL }).expect(404);
      const status = await request(app).get('/api/demo/status').expect(200);
      expect(status.body.available).toBe(false);
    } finally {
      env.allowDemoSeed = original;
    }
  });

  it('never answers with an account password', async () => {
    await mongoose.connection.dropDatabase();
    const response = await request(app).post('/api/demo/seed').expect(201);
    for (const user of response.body.users) {
      expect(user).not.toHaveProperty('password');
    }
  });

  it('keeps demo passwords unknown and rotates them on a reset', async () => {
    const before = await User.findOne({ email: DEMO_EMAIL }).select('+passwordHash').lean();
    expect(await compare(PUBLISHED, before.passwordHash)).toBe(false);

    await seedDemo({ reset: true });

    const after = await User.findOne({ email: DEMO_EMAIL }).select('+passwordHash').lean();
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(await compare(PUBLISHED, after.passwordHash)).toBe(false);
  });

  it('ships no demo credential in the browser sources', async () => {
    const directory = new URL('../../frontend/src/', import.meta.url);
    const files = [
      'lib/constants.js',
      'lib/api.js',
      'context/AuthContext.jsx',
      'pages/LoginPage.jsx',
      'components/AppShell.jsx',
    ];

    for (const file of files) {
      const source = await readFile(new URL(file, directory), 'utf8');
      expect(source).not.toContain(PUBLISHED);
      expect(source).not.toContain('DEMO_PASSWORD');
    }
  });
});
