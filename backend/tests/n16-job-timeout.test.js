import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Job, Project, Source, User } from '../src/models/index.js';
import {
  configureQueue,
  enqueue,
  resetQueueForTests,
  setJobHandler,
  whenIdle,
} from '../src/services/queue.js';
import { startDb, stopDb } from './helpers.js';

let seq = 0;

describe('background job deadline', () => {
  let sourceId;
  let ownerId;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    resetQueueForTests();
    setJobHandler(null);
    await stopDb();
  });

  beforeEach(async () => {
    seq += 1;
    // Direct fixtures: seed() enqueues its own ingestion work, which would
    // race this test's deliberately hung handler.
    const owner = await User.create({
      email: `owner${seq}@n16.test`,
      name: 'Owner N16',
      passwordHash: 'not-a-real-hash',
      emailVerifiedAt: new Date(),
    });
    const project = await Project.create({
      key: `N16-${seq}`,
      name: 'N16 project',
      owner: owner._id,
      members: [{ user: owner._id, role: 'lead' }],
    });
    const source = await Source.create({
      project: project._id,
      kind: 'upload',
      name: 'Notes',
      status: 'queued',
      createdBy: owner._id,
      visibility: { scope: 'project', roles: [], users: [] },
      sensitivity: 'internal',
    });
    sourceId = String(source._id);
    ownerId = String(owner._id);

    resetQueueForTests();
    configureQueue({ concurrency: 1, maxAttempts: 2, jobTimeoutMs: 80 });
  });

  it('fails a hung job, frees the slot and marks the source failed', async () => {
    await Source.updateOne({ _id: sourceId }, { $set: { status: 'processing' } });

    setJobHandler(() => new Promise(() => {}));
    enqueue('ingest_source', { sourceId });
    await whenIdle({ timeoutMs: 5_000 });

    const source = await Source.findById(sourceId);
    expect(source.status).toBe('failed');
    expect(source.statusMessage).toContain('timed out');

    const job = await Job.findOne({ key: `ingest_source:${sourceId}` });
    expect(job).toBeTruthy();
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(job.lastError).toContain('deadline');

    // The key and the worker slot are free again: the same source can be
    // queued and a different handler actually runs.
    let ran = 0;
    setJobHandler(async () => {
      ran += 1;
      await Source.updateOne(
        { _id: sourceId },
        { $set: { status: 'ready', statusMessage: 'Retried successfully' } },
      );
    });
    expect(enqueue('ingest_source', { sourceId })).toBeTruthy();
    await whenIdle({ timeoutMs: 5_000 });
    expect(ran).toBe(1);
    expect((await Source.findById(sourceId)).status).toBe('ready');
  });

  it('does not time out a job that finishes inside the deadline', async () => {
    let ran = 0;
    setJobHandler(async () => {
      ran += 1;
    });
    enqueue('ingest_source', { sourceId });
    await whenIdle({ timeoutMs: 5_000 });
    expect(ran).toBe(1);
    const job = await Job.findOne({ key: `ingest_source:${sourceId}` });
    expect(job).toBeNull();
  });
});
