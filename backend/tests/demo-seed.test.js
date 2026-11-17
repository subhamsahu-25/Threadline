import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { app, auth, request, seed, startDb, stopDb, tokenOf } from './helpers.js';
import { DEMO_PROJECT_KEY, reconcileDemoWorkspace } from '../src/demo/seed.js';
import { Project, Source, User } from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const CONTRIBUTOR = 'ananya@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';

function rebuild(token) {
  const call = request(app).post('/api/demo/seed?reset=true');
  return token ? call.set(auth(token)) : call;
}

function ensureSeeded() {
  return request(app).post('/api/demo/seed');
}

describe('demo seed authorization', () => {
  let seeded;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    seeded = await seed();
  });

  it('rejects an anonymous rebuild', async () => {
    await rebuild().expect(401);
    expect(await Project.countDocuments({ key: DEMO_PROJECT_KEY })).toBe(1);
  });

  it('rejects a non-lead rebuild', async () => {
    await rebuild(tokenOf(seeded, CONTRIBUTOR)).expect(403);
    await rebuild(tokenOf(seeded, OBSERVER)).expect(403);
    expect(await Project.countDocuments({ key: DEMO_PROJECT_KEY })).toBe(1);
  });

  it('lets the Atlas lead rebuild the workspace', async () => {
    const response = await rebuild(tokenOf(seeded, LEAD)).expect(201);
    expect(response.body.project.key).toBe(DEMO_PROJECT_KEY);
    expect(await Project.countDocuments({ key: DEMO_PROJECT_KEY })).toBe(1);
  });

  it('seeds without wiping when reset is not requested', async () => {
    const response = await ensureSeeded().expect(200);
    expect(response.body.alreadySeeded).toBe(true);
    expect(await Project.countDocuments({ key: DEMO_PROJECT_KEY })).toBe(1);
  });

  it('repairs stale members and the outgoing person without touching content', async () => {
    const stale = await User.create({
      email: 'soumyajit@threadline.demo',
      name: 'Soumyajit Jena',
      passwordHash: 'not-a-real-hash',
    });
    const before = await Source.countDocuments();

    await Project.updateOne(
      { key: DEMO_PROJECT_KEY },
      {
        $set: {
          owner: stale._id,
          members: [{ user: stale._id, role: 'contributor' }],
          transition: {
            outgoingUserId: stale._id,
            outgoingName: 'Soumyajit Jena',
            plannedDepartureAt: new Date('2026-12-01'),
            context: 'Old seed',
          },
        },
      },
    );

    const response = await ensureSeeded().expect(200);
    expect(response.body.reconciled).toBe(true);

    const project = await Project.findOne({ key: DEMO_PROJECT_KEY }).populate(
      'members.user',
      'email',
    );
    const roles = Object.fromEntries(project.members.map((entry) => [entry.user.email, entry.role]));
    expect(roles).toEqual({
      'subham@threadline.demo': 'lead',
      'rohan@threadline.demo': 'contributor',
      'ananya@threadline.demo': 'contributor',
      'vikram@threadline.demo': 'observer',
    });
    const lead = await User.findOne({ email: LEAD });
    const rohan = await User.findOne({ email: 'rohan@threadline.demo' });
    expect(String(project.owner)).toBe(String(lead._id));
    expect(String(project.transition.outgoingUserId)).toBe(String(rohan._id));
    expect(project.transition.outgoingName).toBe('Rohan Mehta');
    expect(await Source.countDocuments()).toBe(before);
  });

  it('leaves a missing workspace alone when reconciling at startup', async () => {
    await mongoose.connection.dropDatabase();
    expect(await reconcileDemoWorkspace()).toBeNull();
    expect(await Project.countDocuments({ key: DEMO_PROJECT_KEY })).toBe(0);
  });

  it('creates a missing workspace anonymously', async () => {
    await mongoose.connection.dropDatabase();
    const response = await request(app).post('/api/demo/seed').expect(201);
    expect(response.body.project.key).toBe(DEMO_PROJECT_KEY);
  });
});
