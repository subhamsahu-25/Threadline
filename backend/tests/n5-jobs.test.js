import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Job, Project, Source, User } from '../src/models/index.js';
import {
  configureQueue,
  enqueue,
  recoverDurableJobs,
  resetQueueForTests,
  setJobHandler,
  whenIdle,
} from '../src/services/queue.js';
import { startDb, stopDb } from './helpers.js';

describe('durable job recovery', () => {
  let runs = 0;
  let project;
  let owner;

  beforeAll(async () => {
    await startDb();
    owner = await User.create({
      email: 'jobs@example.test',
      name: 'Job Owner',
      passwordHash: 'x',
    });
    project = await Project.create({ key: 'JOBS', name: 'Jobs', owner: owner._id });
    configureQueue({ concurrency: 1, maxAttempts: 2 });
    setJobHandler(async () => {
      runs += 1;
    });
  });

  afterAll(async () => {
    await stopDb();
  });

  afterEach(async () => {
    resetQueueForTests();
    runs = 0;
    await Job.deleteMany({});
    await Source.deleteMany({});
    setJobHandler(async () => {
      runs += 1;
    });
  });

  async function makeSource(name = 'recovered.md') {
    return Source.create({
      project: project._id,
      kind: 'upload',
      name,
      sensitivity: 'internal',
      createdBy: owner._id,
    });
  }

  it('runs an abandoned job once and forgets it after completion', async () => {
    const source = await makeSource();
    await Job.create({
      _id: 'job-abandoned',
      name: 'ingest_source',
      key: `ingest_source:${source._id}`,
      payload: { sourceId: String(source._id) },
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() - 60_000),
    });

    expect(await recoverDurableJobs()).toBe(1);
    await whenIdle();
    expect(runs).toBe(1);
    expect(await Job.countDocuments({})).toBe(0);

    // Second boot with the same durable state must not repeat finished work.
    resetQueueForTests();
    expect(await recoverDurableJobs()).toBe(0);
    await whenIdle();
    expect(runs).toBe(1);
  });

  it('leaves jobs with a live lease and future retries alone', async () => {
    const source = await makeSource('live.md');
    await Job.create({
      _id: 'job-live',
      name: 'ingest_source',
      key: `ingest_source:${source._id}`,
      payload: { sourceId: String(source._id) },
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await Job.create({
      _id: 'job-backoff',
      name: 'ingest_source',
      key: 'ingest_source:backoff',
      payload: { sourceId: String(source._id) },
      status: 'queued',
      attempts: 1,
      availableAt: new Date(Date.now() + 60_000),
    });

    expect(await recoverDurableJobs()).toBe(0);
    await whenIdle();
    expect(runs).toBe(0);
    expect(await Job.countDocuments({})).toBe(2);
  });

  it('drops rows for sources that no longer exist', async () => {
    await Job.create({
      _id: 'job-orphan',
      name: 'ingest_source',
      key: 'ingest_source:gone',
      payload: { sourceId: '507f1f77bcf86cd799439011' },
      status: 'queued',
      attempts: 0,
      availableAt: new Date(Date.now() - 60_000),
    });

    expect(await recoverDurableJobs()).toBe(0);
    await whenIdle();
    expect(runs).toBe(0);
    expect(await Job.countDocuments({})).toBe(0);
  });

  it('keeps the same durable id while a recovered job runs', async () => {
    const source = await makeSource('same-id.md');
    await Job.create({
      _id: 'job-same-id',
      name: 'ingest_source',
      key: `ingest_source:${source._id}`,
      payload: { sourceId: String(source._id) },
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() - 60_000),
    });

    let seen = null;
    setJobHandler(async (job) => {
      seen = job.id;
      runs += 1;
    });
    await recoverDurableJobs();
    await whenIdle();
    expect(seen).toBe('job-same-id');
  });

  it('enqueues ordinary jobs with a fresh id', async () => {
    const id = enqueue('ingest_source', { sourceId: '507f1f77bcf86cd799439012' });
    await whenIdle();
    expect(id).toBeTruthy();
    expect(runs).toBe(1);
  });
});
