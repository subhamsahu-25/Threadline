import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkTextWithMeta } from '../src/services/ingest/chunker.js';

// The first extraction call is parked so a deadline or a retry can happen
// while a real ingest run is between its claim and its commit.
const control = vi.hoisted(() => ({
  calls: 0,
  gate: null,
  release: null,
  firstRun: null,
  actual: null,
}));

vi.mock('../src/services/ai/extract.js', async (importOriginal) => {
  const actual = await importOriginal();
  control.actual = actual;
  return {
    ...actual,
    // The pipeline imports this exact binding, so the gate sits inside the
    // real run rather than replacing it.
    extractClaimsForDocuments: (args) => {
      control.calls += 1;
      const run = (async () => {
        if (control.calls === 1 && control.gate) await control.gate;
        return actual.extractClaimsForDocuments(args);
      })();
      if (control.calls === 1) control.firstRun = run;
      return run;
    },
  };
});

import { AuditEvent, Claim, Document, Project, Source, User } from '../src/models/index.js';
import { processSourceJob } from '../src/services/ingest/index.js';
import {
  configureQueue,
  enqueue,
  resetQueueForTests,
  setJobHandler,
  whenIdle,
} from '../src/services/queue.js';
import { startDb, stopDb } from './helpers.js';

let seq = 0;

function parked() {
  control.gate = new Promise((resolve) => {
    control.release = resolve;
  });
  control.calls = 0;
  control.firstRun = null;
}

async function fixture() {
  seq += 1;
  const owner = await User.create({
    email: `owner${seq}@p5.test`,
    name: 'P5 Owner',
    passwordHash: 'not-a-real-hash',
    emailVerifiedAt: new Date(),
  });
  const project = await Project.create({
    key: `P5-${seq}`,
    name: 'P5 project',
    owner: owner._id,
    members: [{ user: owner._id, role: 'lead' }],
  });
  const source = await Source.create({
    project: project._id,
    kind: 'upload',
    name: `Notes ${seq}`,
    status: 'queued',
    createdBy: owner._id,
    visibility: { scope: 'project', roles: [], users: [] },
    sensitivity: 'internal',
  });

  const sections = [];
  for (let index = 0; index < 60; index += 1) {
    sections.push(
      `## Section ${seq}-${index}\n\nDecision: Adopt archive option ${seq}-${index} for the migration.\n\nRisk: Option ${seq}-${index} could delay the handover.`,
    );
  }
  const rawText = sections.join('\n\n');
  const documents = [
    {
      kind: 'upload',
      title: 'notes.md',
      path: 'notes.md',
      mime: 'text/markdown',
      size: rawText.length,
      rawText,
      locator: { path: 'notes.md' },
    },
  ];
  return { owner, project, source, rawText, documents };
}

describe('timed-out ingest runs are cancelled and fenced', () => {
  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    resetQueueForTests();
    setJobHandler(null);
    await stopDb();
  });

  beforeEach(() => {
    parked();
    resetQueueForTests();
    configureQueue({ concurrency: 1, maxAttempts: 1, jobTimeoutMs: 120 });
    setJobHandler((job) => processSourceJob(job));
  });

  afterEach(() => {
    control.gate = null;
    control.release = null;
  });

  it('stops extracting between chunks once the run is aborted', async () => {
    const { project, source, rawText } = await fixture();
    const plan = chunkTextWithMeta(rawText);
    const doc = await Document.create({
      project: project._id,
      source: source._id,
      kind: 'upload',
      title: 'notes.md',
      path: 'notes.md',
      mime: 'text/markdown',
      rawText,
      chunks: plan.chunks,
      checksum: `checksum-${seq}`,
    });
    expect(doc.chunks.length).toBeGreaterThan(2);

    const controller = new AbortController();
    const progress = [];
    await expect(
      control.actual.extractClaimsForDocuments({
        project,
        source,
        documents: [doc],
        signal: controller.signal,
        concurrency: 1,
        timeBudgetMs: 600_000,
        onProgress: (state) => {
          progress.push(state.chunksProcessed);
          if (progress.length === 1) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'ingest_cancelled' });

    expect(progress.at(-1)).toBeLessThan(doc.chunks.length);
  });

  it('refuses a late commit after the deadline and a retry has taken over', async () => {
    const { source, documents } = await fixture();

    enqueue('ingest_source', { sourceId: String(source._id), documents });
    await vi.waitFor(
      async () => {
        expect((await Source.findById(source._id)).ingestRunId).toBeTruthy();
      },
      { timeout: 5_000 },
    );

    // The deadline fires while the run is parked, so the queue frees the slot
    // and marks the source failed.
    await whenIdle({ timeoutMs: 5_000 });
    const failed = await Source.findById(source._id);
    expect(failed.status).toBe('failed');
    expect(failed.ingestRunId).toBeFalsy();

    // A retry claims the source and finishes normally. The deadline is only
    // short for the parked run; the retry gets the normal budget.
    configureQueue({ concurrency: 1, maxAttempts: 1, jobTimeoutMs: 30_000 });
    await Source.updateOne({ _id: source._id }, { $set: { status: 'queued' } });
    enqueue('ingest_source', { sourceId: String(source._id), documents });
    await whenIdle({ timeoutMs: 10_000 });

    const ready = await Source.findById(source._id);
    expect(ready.status).toBe('ready');
    expect(control.calls).toBe(2);
    const claimsAfterRetry = await Claim.countDocuments({
      source: source._id,
      retiredAt: null,
    });
    expect(claimsAfterRetry).toBeGreaterThan(0);

    // Now let the abandoned run continue. Its signal was aborted and its token
    // is gone, so it must not write its commit over the finished retry.
    control.release();
    await control.firstRun.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));

    const after = await Source.findById(source._id);
    expect(after.status).toBe('ready');
    expect(await Claim.countDocuments({ source: source._id, retiredAt: null })).toBe(
      claimsAfterRetry,
    );
    expect(
      await AuditEvent.countDocuments({ action: 'source.failed', targetId: source._id }),
    ).toBe(0);
    expect(
      await AuditEvent.countDocuments({ action: 'source.ingested', targetId: source._id }),
    ).toBe(1);
  });

  it('only the run that holds the source token may commit', async () => {
    const { source, documents } = await fixture();

    const run = processSourceJob({
      name: 'ingest_source',
      payload: { sourceId: String(source._id), documents },
      attempts: 1,
    });
    await vi.waitFor(
      async () => {
        expect((await Source.findById(source._id)).ingestRunId).toBeTruthy();
      },
      { timeout: 5_000 },
    );

    // Emulate the retry's claim: it replaces the token while the first run is
    // still working on its extraction.
    await Source.updateOne(
      { _id: source._id },
      { $set: { status: 'processing', ingestRunId: 'retry-run-token' } },
    );
    control.release();

    await expect(run).rejects.toMatchObject({ code: 'ingest_cancelled' });
    const stored = await Source.findById(source._id);
    expect(stored.status).toBe('processing');
    expect(stored.ingestRunId).toBe('retry-run-token');
    expect(
      await AuditEvent.countDocuments({ action: 'source.ingested', targetId: source._id }),
    ).toBe(0);

    // The retry that owns the token can finish the source.
    await Source.updateOne(
      { _id: source._id },
      { $set: { status: 'queued' }, $unset: { ingestRunId: 1 } },
    );
    await processSourceJob({
      name: 'ingest_source',
      payload: { sourceId: String(source._id), documents },
      attempts: 1,
    });

    const done = await Source.findById(source._id);
    expect(done.status).toBe('ready');
    expect(done.ingestRunId).toBeFalsy();
    expect(await Claim.countDocuments({ source: source._id, retiredAt: null })).toBeGreaterThan(0);
  });
});
