import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { compare } from 'bcryptjs';
import { env } from '../src/config/env.js';
import { reconcileDemoWorkspace } from '../src/demo/seed.js';
import { User, Project } from '../src/models/index.js';
import { hashPassword } from '../src/services/auth.js';
import { app, request, startDb, stopDb } from './helpers.js';

const PUBLISHED = 'Threadline#2026';
const PERSONAS = [
  { email: 'subham@threadline.demo', name: 'Subham Sahu', role: 'lead' },
  { email: 'rohan@threadline.demo', name: 'Rohan Mehta', role: 'contributor' },
  { email: 'ananya@threadline.demo', name: 'Ananya Rao', role: 'contributor' },
  { email: 'vikram@threadline.demo', name: 'Vikram Nair', role: 'observer' },
];

/**
 * A workspace seeded by an earlier release: the project has no isDemo flag and
 * its accounts still carry the published demo password. This is the shape the
 * deployed Atlas database has after the N23 change.
 */
async function seedLegacyWorkspace() {
  const passwordHash = await hashPassword(PUBLISHED);
  const users = {};
  for (const persona of PERSONAS) {
    users[persona.email] = await User.create({
      email: persona.email,
      name: persona.name,
      passwordHash,
      isDemo: false,
    });
  }
  const project = await Project.create({
    key: 'ATLAS',
    name: 'Project Atlas - Billing Service Migration',
    description: 'Legacy workspace',
    owner: users['subham@threadline.demo']._id,
    members: PERSONAS.map((persona) => ({
      user: users[persona.email]._id,
      role: persona.role,
    })),
  });
  return { users, project };
}

describe('P2 boot-time reconciliation migrates deployed demo accounts', () => {
  let originalDemo;
  beforeAll(async () => {
    await startDb();
  });
  afterAll(async () => {
    await stopDb();
  });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
  });
  afterEach(() => {
    env.allowDemoSeed = originalDemo;
  });

  it('repairs a legacy workspace so persona sign-in works and the old password stops', async () => {
    originalDemo = env.allowDemoSeed;
    env.allowDemoSeed = true;
    await seedLegacyWorkspace();

    const before = await request(app)
      .post('/api/demo/session')
      .send({ email: 'ananya@threadline.demo' });
    expect(before.status).toBe(404);

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ananya@threadline.demo', password: PUBLISHED });
    expect(oldLogin.status).toBe(200);

    const result = await reconcileDemoWorkspace();
    expect(result).toMatchObject({ alreadySeeded: true });
    expect(result.repairedUsers).toBe(PERSONAS.length);

    const after = await request(app)
      .post('/api/demo/session')
      .send({ email: 'ananya@threadline.demo' });
    expect(after.status).toBe(200);
    expect(after.body.user.email).toBe('ananya@threadline.demo');

    const retired = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ananya@threadline.demo', password: PUBLISHED });
    expect(retired.status).toBe(401);

    const users = await User.find({ email: { $regex: '@threadline\\.demo$' } })
      .select('+passwordHash')
      .lean();
    expect(users).toHaveLength(PERSONAS.length);
    for (const user of users) {
      expect(user.isDemo).toBe(true);
      expect(user.emailVerifiedAt).toBeTruthy();
      expect(await compare(PUBLISHED, user.passwordHash)).toBe(false);
    }
  });

  it('adopts a workspace whose project flag is missing but whose accounts are already migrated', async () => {
    originalDemo = env.allowDemoSeed;
    await seedLegacyWorkspace();
    // Accounts already carry the flags; only the project record is old.
    await User.updateMany(
      { email: { $regex: '@threadline\\.demo$' } },
      { $set: { isDemo: true, emailVerifiedAt: new Date() } },
    );

    const result = await reconcileDemoWorkspace();
    expect(result).toMatchObject({ alreadySeeded: true, adopted: true });
    expect(result.repairedUsers).toBe(0);
    const project = await Project.findOne({ key: 'ATLAS' }).lean();
    expect(project.isDemo).toBe(true);
  });

  it('is idempotent and does not rotate already-repaired accounts again', async () => {
    originalDemo = env.allowDemoSeed;
    await seedLegacyWorkspace();
    await reconcileDemoWorkspace();

    const first = await User.findOne({ email: 'rohan@threadline.demo' })
      .select('+passwordHash')
      .lean();
    const second = await reconcileDemoWorkspace();
    const again = await User.findOne({ email: 'rohan@threadline.demo' })
      .select('+passwordHash')
      .lean();

    expect(second.repairedUsers).toBe(0);
    expect(again.passwordHash).toBe(first.passwordHash);
  });

  it('leaves a real ATLAS project untouched when its owner is not a demo account', async () => {
    const owner = await User.create({
      email: 'owner@example.com',
      name: 'Real Owner',
      passwordHash: await hashPassword('RealPassword#1'),
      emailVerifiedAt: new Date(),
    });
    await Project.create({
      key: 'ATLAS',
      name: 'Real Atlas project',
      owner: owner._id,
      members: [{ user: owner._id, role: 'lead' }],
    });

    expect(await reconcileDemoWorkspace()).toBeNull();
    const project = await Project.findOne({ key: 'ATLAS' }).lean();
    expect(project.isDemo).toBeFalsy();
  });
});
