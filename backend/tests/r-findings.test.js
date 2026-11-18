import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { HandoverVersion, Source } from '../src/models/index.js';
import { errorHandler } from '../src/middleware/error.js';
import { runDueSyncs, syncDue } from '../src/services/ingest/sync.js';
import {
  app,
  auth,
  idOf,
  request,
  seed,
  startDb,
  stopDb,
  tokenOf,
  whenIdle,
} from './helpers.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';

describe('reliability findings R1-R8', () => {
  let seeded;
  let projectId;
  let leadToken;
  let outcomeId;
  let incomingId;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    seeded = await seed();
    projectId = seeded.project.id;
    leadToken = tokenOf(seeded, LEAD);
    outcomeId = idOf(seeded, OUTGOING);
    incomingId = idOf(seeded, INCOMING);
  });

  async function createDraft() {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId: incomingId, roleTemplate: 'onboarding' });
    expect(created.status).toBe(201);
    return created.body.handover;
  }

  it('R1 applies many review decisions in one request and one history row', async () => {
    const handover = await createDraft();
    // Compose writes the baseline version; the bulk call adds exactly one more.
    const previousVersions = await HandoverVersion.countDocuments({ handover: handover.id });
    const decisions = handover.items
      .slice(0, 3)
      .map((item) => ({ claimId: item.claimId, decision: 'accepted' }));
    expect(decisions.length).toBeGreaterThan(1);

    const response = await request(app)
      .post(`/api/handovers/${handover.id}/items/bulk`)
      .set(auth(leadToken))
      .send({ decisions })
      .expect(200);

    expect(response.body.items).toHaveLength(decisions.length);
    expect(response.body.handover).toBeUndefined();
    expect(response.body.counts.accepted).toBeGreaterThanOrEqual(decisions.length - 1);
    expect(response.body.version).toBe(handover.version + 1);

    const versions = await HandoverVersion.find({ handover: handover.id })
      .sort({ version: -1 })
      .lean();
    expect(versions).toHaveLength(previousVersions + 1);
    // Per-item history stores only the changed rows, not a full snapshot.
    expect(versions[0].snapshot.diff).toBe(true);
    expect(versions[0].snapshot.items).toHaveLength(decisions.length);
  });

  it('R1 returns only the changed item from a single review call', async () => {
    const handover = await createDraft();
    const item = handover.items[0];

    const response = await request(app)
      .patch(`/api/handovers/${handover.id}/items/${item.claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'edited', editedStatement: 'Carry the reconciliation runbook forward.' })
      .expect(200);

    expect(response.body.item.statement).toBe('Carry the reconciliation runbook forward.');
    expect(response.body.item.claimId).toBe(item.claimId);
    expect(response.body.handover).toBeUndefined();
    expect(response.body.version).toBe(handover.version + 1);
  });

  it('R2 maps a stale save to a 409 instead of a 500', () => {
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const error = Object.assign(new Error('No matching document found for id "1" version 2'), {
      name: 'VersionError',
    });

    errorHandler(error, { method: 'PATCH', originalUrl: '/api/handovers/1' }, res, () => {});

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error.code).toBe('version_conflict');
  });

  it('R3 leaves connector sync opt-in and backs off until the reservation passes', async () => {
    const optedOut = await Source.create({
      project: projectId,
      kind: 'drive',
      name: 'Unwatched folder',
      externalRef: 'folder-opted-out',
      createdBy: outcomeId,
      status: 'ready',
      sync: { enabled: false, intervalMinutes: 15 },
    });
    expect(syncDue(optedOut)).toBe(false);

    const source = await Source.create({
      project: projectId,
      kind: 'drive',
      name: 'Quarterly folder',
      externalRef: 'folder-123',
      createdBy: outcomeId,
      status: 'ready',
      sync: {
        enabled: true,
        intervalMinutes: 15,
        lastCheckedAt: new Date('2020-01-01T00:00:00Z'),
      },
    });
    expect(syncDue(source)).toBe(true);

    const backedOff = {
      ...source.toObject(),
      sync: { ...source.toObject().sync, nextAttemptAt: new Date(Date.now() + 3_600_000) },
    };
    expect(syncDue(backedOff)).toBe(false);

    const enqueued = await runDueSyncs();
    expect(enqueued).toContain(String(source._id));

    const reserved = await Source.findById(source._id).lean();
    expect(new Date(reserved.sync.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());

    // The reservation is the lock: a second tick must not queue it again.
    expect(await runDueSyncs()).not.toContain(String(source._id));
    await whenIdle();
  });

  it('R8 pages claims with a stable cursor and a visibility-aware total', async () => {
    const full = await request(app)
      .get(`/api/projects/${projectId}/claims?limit=500`)
      .set(auth(leadToken))
      .expect(200);
    expect(full.body.claims.length).toBeGreaterThan(1);

    const first = await request(app)
      .get(`/api/projects/${projectId}/claims?limit=1`)
      .set(auth(leadToken))
      .expect(200);
    expect(first.body.claims).toHaveLength(1);
    expect(first.body.total).toBe(full.body.claims.length);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app)
      .get(`/api/projects/${projectId}/claims?limit=1&cursor=${first.body.nextCursor}`)
      .set(auth(leadToken))
      .expect(200);
    expect(second.body.claims).toHaveLength(1);
    expect(second.body.claims[0].id).not.toBe(first.body.claims[0].id);

    const ids = new Set([first.body.claims[0].id, second.body.claims[0].id]);
    expect(ids.size).toBe(2);
  });

  it('R8 pages the handover list and the version history', async () => {
    const firstDraft = await createDraft();
    const secondDraft = await createDraft();

    const first = await request(app)
      .get(`/api/handovers?projectId=${projectId}&limit=1`)
      .set(auth(leadToken))
      .expect(200);
    expect(first.body.handovers).toHaveLength(1);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app)
      .get(`/api/handovers?projectId=${projectId}&limit=1&cursor=${first.body.nextCursor}`)
      .set(auth(leadToken))
      .expect(200);
    expect(second.body.handovers).toHaveLength(1);
    const ids = [first.body.handovers[0].id, second.body.handovers[0].id];
    expect(new Set(ids).size).toBe(2);

    await request(app)
      .patch(`/api/handovers/${firstDraft.id}/items/${firstDraft.items[0].claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'accepted' })
      .expect(200);
    await request(app)
      .patch(`/api/handovers/${firstDraft.id}/items/${firstDraft.items[1].claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'rejected' })
      .expect(200);

    const versions = await request(app)
      .get(`/api/handovers/${firstDraft.id}/versions?limit=1`)
      .set(auth(leadToken))
      .expect(200);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.hasMore).toBe(true);
    expect(versions.body.nextCursor).toBe(versions.body.versions[0].version);

    const older = await request(app)
      .get(
        `/api/handovers/${firstDraft.id}/versions?limit=1&cursor=${versions.body.nextCursor}`,
      )
      .set(auth(leadToken))
      .expect(200);
    expect(older.body.versions).toHaveLength(1);
    expect(older.body.versions[0].version).toBeLessThan(versions.body.versions[0].version);
    expect(secondDraft.id).toBeTruthy();
  });

  it('R8 caps stored text and warns which part was analysed', async () => {
    const original = env.maxDocumentChars;
    env.maxDocumentChars = 5_000;
    try {
      const body = Array.from(
        { length: 40 },
        (_, index) => `Note ${index}: ${'context words keep the section readable '.repeat(8)}`,
      ).join('\n\n');

      const created = await request(app)
        .post(`/api/projects/${projectId}/sources/upload`)
        .set(auth(leadToken))
        .field('name', 'Capped notes')
        .attach('files', Buffer.from(`# Capped notes\n\n${body}\n`, 'utf8'), 'capped.md');
      expect(created.status).toBe(202);
      await whenIdle({ timeoutMs: 120_000 });

      const source = await request(app)
        .get(`/api/projects/${projectId}/sources/${created.body.source.id}`)
        .set(auth(leadToken))
        .expect(200);
      expect(source.body.source.status).toBe('ready');
      expect(source.body.source.parseWarnings.join(' ')).toMatch(/Stored the first 5,000 of/);

      const document = await request(app)
        .get(`/api/projects/${projectId}/documents?sourceId=${created.body.source.id}`)
        .set(auth(leadToken));
      expect(document.status).toBe(200);
      const detail = await request(app)
        .get(`/api/projects/${projectId}/documents/${document.body.documents[0].id}`)
        .set(auth(leadToken))
        .expect(200);
      expect(detail.body.rawText).toHaveLength(5_000);
    } finally {
      env.maxDocumentChars = original;
    }
  });
});
