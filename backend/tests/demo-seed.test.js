import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { app, auth, request, seed, startDb, stopDb, tokenOf } from './helpers.js';
import { DEMO_PROJECT_KEY } from '../src/demo/seed.js';
import { Project } from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const CONTRIBUTOR = 'partho@threadline.demo';
const OBSERVER = 'sabyasachi@threadline.demo';

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

  it('creates a missing workspace anonymously', async () => {
    await mongoose.connection.dropDatabase();
    const response = await request(app).post('/api/demo/seed').expect(201);
    expect(response.body.project.key).toBe(DEMO_PROJECT_KEY);
  });
});
