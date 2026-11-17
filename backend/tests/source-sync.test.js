import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { githubState, driveState } = vi.hoisted(() => ({
  githubState: { documents: [], fail: null },
  driveState: { documents: [], fail: null },
}));

function normalizedDocuments(documents) {
  return documents.map((document) => ({
    ...document,
    occurredAt: document.occurredAt ? new Date(document.occurredAt) : null,
    locator: document.locator || {},
    parseWarnings: [],
  }));
}

vi.mock('../src/services/ingest/github.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    collectGithubDocuments: vi.fn(async () => {
      if (githubState.fail) throw githubState.fail;
      return normalizedDocuments(githubState.documents);
    }),
  };
});

vi.mock('../src/services/ingest/googleDrive.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    collectDriveDocuments: vi.fn(async () => {
      if (driveState.fail) throw driveState.fail;
      return normalizedDocuments(driveState.documents);
    }),
  };
});

import { auth, idOf, app, request, seed, startDb, stopDb, tokenOf, whenIdle } from './helpers.js';
import { Source } from '../src/models/index.js';
import { documentsChecksum, syncDue } from '../src/services/ingest/sync.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

function documentSet({ taskStatus = 'open', decision = 'Use Redis for caching.' } = {}) {
  return [
    {
      kind: 'github_readme',
      title: 'README (acme/threadline-demo)',
      path: 'README',
      mime: 'text/markdown',
      size: 180,
      author: null,
      occurredAt: new Date('2026-10-01T00:00:00Z'),
      locator: { url: 'https://github.com/acme/threadline-demo#readme' },
      rawText: `# Demo repository\nDecision: ${decision} (date: 2026-10-01, status: active)\nTask: Ship cache invalidation (status: ${taskStatus})`,
      meta: {},
    },
  ];
}

function driveDocumentSet({ decision = 'Use Redis for caching.' } = {}) {
  return [
    {
      kind: 'drive_text',
      title: 'Drive: Threadline handover folder',
      path: 'handover-notes.md',
      mime: 'text/markdown',
      size: 180,
      author: null,
      occurredAt: new Date('2026-10-01T00:00:00Z'),
      locator: { url: 'https://drive.google.com/file/d/handover-notes' },
      rawText: `# Handover notes\nDecision: ${decision} (date: 2026-10-01, status: active)\nTask: Publish the migration runbook (status: open)`,
      meta: {},
    },
  ];
}

describe('connected source sync', () => {
  let seeded;
  let projectId;
  let leadToken;
  let incomingId;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    githubState.fail = null;
    githubState.documents = documentSet();
    driveState.fail = null;
    driveState.documents = driveDocumentSet();
    seeded = await seed();
    await whenIdle();
    projectId = seeded.project.id;
    leadToken = tokenOf(seeded, LEAD);
    incomingId = idOf(seeded, INCOMING);
  });

  async function createGithubSource() {
    const created = await request(app)
      .post(`/api/projects/${projectId}/sources`)
      .set(auth(leadToken))
      .send({
        kind: 'github',
        externalRef: 'acme/threadline-demo',
        visibility: { scope: 'project', roles: [], users: [] },
      });
    expect(created.status).toBe(202);
    await whenIdle();
    return created.body.source.id;
  }

  async function createDriveSource() {
    const created = await request(app)
      .post(`/api/projects/${projectId}/sources`)
      .set(auth(leadToken))
      .send({
        kind: 'drive',
        externalRef: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
        visibility: { scope: 'project', roles: [], users: [] },
      });
    expect(created.status).toBe(202);
    await whenIdle();
    return created.body.source.id;
  }

  async function createLiveHandover() {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId: incomingId });
    expect(created.status).toBe(201);
    const handoverId = created.body.handover.id;

    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(leadToken))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(leadToken))
      .send({})
      .expect(200);
    const shared = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken))
      .expect(200);

    return { handoverId, token: shared.body.sharePath.split('/').pop() };
  }

  it('checks a connected source on its interval and can be forced', async () => {
    const sourceId = await createGithubSource();
    let source = await Source.findById(sourceId).lean();
    expect(source.status).toBe('ready');
    expect(source.sync.enabled).toBe(true);
    expect(source.sync.cursor.checksum).toHaveLength(64);
    expect(source.sync.lastChangedAt).toBeTruthy();

    const lastChanged = new Date(source.sync.lastChangedAt).getTime();

    githubState.documents = documentSet({ taskStatus: 'done' });
    await request(app)
      .post(`/api/projects/${projectId}/sources/${sourceId}/sync`)
      .set(auth(leadToken))
      .expect(202);
    await whenIdle();

    source = await Source.findById(sourceId).lean();
    expect(source.status).toBe('ready');
    expect(new Date(source.sync.lastChangedAt).getTime()).toBeGreaterThan(lastChanged);

    const checkedAt = new Date(source.sync.lastCheckedAt).getTime();
    const changedAt = new Date(source.sync.lastChangedAt).getTime();
    githubState.documents = documentSet({ taskStatus: 'done' });
    await request(app)
      .post(`/api/projects/${projectId}/sources/${sourceId}/sync`)
      .set(auth(leadToken))
      .expect(202);
    await whenIdle();

    source = await Source.findById(sourceId).lean();
    expect(new Date(source.sync.lastCheckedAt).getTime()).toBeGreaterThanOrEqual(checkedAt);
    expect(new Date(source.sync.lastChangedAt).getTime()).toBe(changedAt);
  });

  it('marks approved handovers outdated with a visible diff when content changes', async () => {
    await createGithubSource();
    const { handoverId, token } = await createLiveHandover();

    const before = await request(app)
      .get(`/api/handovers/${handoverId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(before.body.handover.freshness.status).toBe('current');

    githubState.documents = documentSet({ taskStatus: 'done' });
    const githubSource = await Source.findOne({ project: projectId, kind: 'github' });
    await request(app)
      .post(`/api/projects/${projectId}/sources/${githubSource._id}/sync`)
      .set(auth(leadToken))
      .expect(202);
    await whenIdle();

    const after = await request(app)
      .get(`/api/handovers/${handoverId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(after.body.handover.freshness.status).toBe('outdated');
    expect(after.body.handover.freshness.outdatedAt).toBeTruthy();
    expect(after.body.handover.freshness.changes.length).toBeGreaterThan(0);
    expect(
      after.body.handover.freshness.changes.some(
        (change) =>
          change.change === 'updated' &&
          change.fields?.some((field) => field.field === 'status'),
      ),
    ).toBe(true);

    const recipient = await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(tokenOf(seeded, INCOMING)))
      .expect(200);
    expect(recipient.body.handover.freshness.status).toBe('outdated');
    expect(recipient.body.handover.freshness.changes.length).toBeGreaterThan(0);
  });

  it('syncs a Drive folder through the same connector pipeline', async () => {
    const sourceId = await createDriveSource();
    const source = await Source.findById(sourceId).lean();
    expect(source.kind).toBe('drive');
    expect(source.sync.enabled).toBe(true);
    expect(source.sync.cursor.checksum).toHaveLength(64);

    const { handoverId } = await createLiveHandover();

    driveState.documents = driveDocumentSet({ decision: 'Use Postgres advisory locks for invoicing.' });
    await request(app)
      .post(`/api/projects/${projectId}/sources/${sourceId}/sync`)
      .set(auth(leadToken))
      .expect(202);
    await whenIdle();

    const after = await request(app)
      .get(`/api/handovers/${handoverId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(after.body.handover.freshness.status).toBe('outdated');
    expect(after.body.handover.freshness.changes.length).toBeGreaterThan(0);
  });

  it('keeps previous knowledge when a sync check fails', async () => {
    const sourceId = await createGithubSource();
    githubState.fail = new Error('network down');

    await request(app)
      .post(`/api/projects/${projectId}/sources/${sourceId}/sync`)
      .set(auth(leadToken))
      .expect(202);
    await whenIdle();

    const source = await Source.findById(sourceId).lean();
    expect(source.status).toBe('ready');
    expect(source.sync.lastError).toContain('network down');
  });

  it('updates sync interval settings and rejects uploads', async () => {
    const sourceId = await createGithubSource();
    const updated = await request(app)
      .patch(`/api/projects/${projectId}/sources/${sourceId}/sync`)
      .set(auth(leadToken))
      .send({ enabled: false, intervalMinutes: 10 })
      .expect(200);
    expect(updated.body.source.sync.enabled).toBe(false);
    expect(updated.body.source.sync.intervalMinutes).toBe(10);

    const uploadId = seeded.sources[0].id;
    const rejected = await request(app)
      .patch(`/api/projects/${projectId}/sources/${uploadId}/sync`)
      .set(auth(leadToken))
      .send({ enabled: true });
    expect(rejected.status).toBe(400);
  });
});

describe('sync helpers', () => {
  it('fingerprints documents regardless of collection order', () => {
    const a = { kind: 'github_readme', title: 'A', rawText: 'one', occurredAt: null };
    const b = { kind: 'github_issue', title: 'B', rawText: 'two', occurredAt: null };
    expect(documentsChecksum([a, b])).toBe(documentsChecksum([b, a]));
    expect(documentsChecksum([a, b])).not.toBe(documentsChecksum([a, { ...b, rawText: 'three' }]));
  });

  it('is due on the configured interval and only for enabled connectors', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const base = {
      kind: 'github',
      status: 'ready',
      deletedAt: null,
      sync: { enabled: true, intervalMinutes: 5, lastCheckedAt: new Date('2026-11-17T11:54:00Z') },
    };
    expect(syncDue(base, now)).toBe(true);
    expect(syncDue({ ...base, sync: { ...base.sync, lastCheckedAt: new Date('2026-11-17T11:58:00Z') } }, now)).toBe(false);
    expect(syncDue({ ...base, sync: { ...base.sync, enabled: false } }, now)).toBe(false);
    expect(syncDue({ ...base, kind: 'upload' }, now)).toBe(false);
    expect(syncDue({ ...base, status: 'processing' }, now)).toBe(false);
  });
});
