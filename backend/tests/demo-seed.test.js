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

  it('keeps a visitor upload that shares a seeded filename', async () => {
    const project = await Project.findOne({ key: DEMO_PROJECT_KEY });
    const lead = await User.findOne({ email: LEAD });
    const visitor = await Source.create({
      project: project._id,
      kind: 'upload',
      name: 'kickoff-notes.md',
      createdBy: lead._id,
      status: 'ready',
      files: [],
    });

    await rebuild(tokenOf(seeded, LEAD)).expect(201);

    expect(await Source.exists({ _id: visitor._id })).toBeTruthy();
    expect(await Source.countDocuments({ seeded: true })).toBe(6);
  });

  it('adopts a workspace seeded before the flag existed', async () => {
    await Source.updateMany({}, { $unset: { seeded: 1 } });

    await rebuild(tokenOf(seeded, LEAD)).expect(201);

    expect(await Source.countDocuments()).toBe(6);
    expect(await Source.countDocuments({ seeded: true })).toBe(6);
  });

  it('seeds without wiping when reset is not requested', async () => {
    const response = await ensureSeeded().expect(200);
    expect(response.body.alreadySeeded).toBe(true);
    expect(await Project.countDocuments({ key: DEMO_PROJECT_KEY })).toBe(1);
  });

  it('never rewrites an existing workspace when reset is not requested', async () => {
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
    const passwordBefore = await User.findOne({ email: LEAD }).select('+passwordHash').lean();

    const response = await ensureSeeded().expect(200);
    expect(response.body.alreadySeeded).toBe(true);
    expect(response.body.reconciled).toBeUndefined();

    const project = await Project.findOne({ key: DEMO_PROJECT_KEY }).populate(
      'members.user',
      'email',
    );
    expect(String(project.owner)).toBe(String(stale._id));
    expect(project.members.map((entry) => entry.user.email)).toEqual([
      'soumyajit@threadline.demo',
    ]);
    expect(String(project.transition.outgoingUserId)).toBe(String(stale._id));
    expect(await Source.countDocuments()).toBe(before);

    const passwordAfter = await User.findOne({ email: LEAD }).select('+passwordHash').lean();
    expect(passwordAfter.passwordHash).toBe(passwordBefore.passwordHash);
  });

  it('does not return signed tokens from the public seed endpoint', async () => {
    await mongoose.connection.dropDatabase();
    const response = await request(app).post('/api/demo/seed').expect(201);
    expect(response.body.users).toHaveLength(4);
    for (const user of response.body.users) {
      expect(user.token).toBeUndefined();
    }
  });

  it('reserves the ATLAS key for the demo workspace', async () => {
    const response = await request(app)
      .post('/api/projects')
      .set(auth(tokenOf(seeded, LEAD)))
      .send({ key: 'ATLAS', name: 'Real Atlas project' });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/reserved/i);
  });

  it('leaves a real project keyed ATLAS alone', async () => {
    await mongoose.connection.dropDatabase();
    const user = await User.create({
      email: 'real@example.com',
      name: 'Real Owner',
      passwordHash: 'not-a-real-hash',
    });
    await Project.create({
      key: DEMO_PROJECT_KEY,
      name: 'A real Atlas project',
      owner: user._id,
      members: [{ user: user._id, role: 'lead' }],
    });

    const seededResponse = await ensureSeeded();
    expect(seededResponse.status).toBe(404);

    const resetResponse = await rebuild();
    expect(resetResponse.status).toBe(404);
    const project = await Project.findOne({ key: DEMO_PROJECT_KEY });
    expect(project.name).toBe('A real Atlas project');
    expect(project.isDemo).toBe(false);
    expect(String(project.owner)).toBe(String(user._id));
  });

  it('leaves a missing workspace alone when reconciling at startup', async () => {
    await mongoose.connection.dropDatabase();
    expect(await reconcileDemoWorkspace()).toBeNull();
    expect(await Project.countDocuments({ key: DEMO_PROJECT_KEY })).toBe(0);
  });

  it('adopts a legacy demo workspace without rewriting its members', async () => {
    await Project.updateOne({ key: DEMO_PROJECT_KEY }, { $unset: { isDemo: 1 } });
    const before = await Project.findOne({ key: DEMO_PROJECT_KEY }).lean();

    const result = await reconcileDemoWorkspace();
    expect(result?.adopted).toBe(true);

    const after = await Project.findOne({ key: DEMO_PROJECT_KEY }).lean();
    expect(after.isDemo).toBe(true);
    expect(String(after.owner)).toBe(String(before.owner));
    expect(after.members.map((entry) => String(entry.user))).toEqual(
      before.members.map((entry) => String(entry.user)),
    );
    expect(await Source.countDocuments()).toBeGreaterThan(0);
  });

  it('creates a missing workspace anonymously', async () => {
    await mongoose.connection.dropDatabase();
    const response = await request(app).post('/api/demo/seed').expect(201);
    expect(response.body.project.key).toBe(DEMO_PROJECT_KEY);
  });
});
