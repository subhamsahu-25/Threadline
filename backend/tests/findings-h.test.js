import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  idOf,
  app,
  request,
  seed,
  sourceIdOf,
  startDb,
  stopDb,
  tokenOf,
  whenIdle,
} from './helpers.js';
import {
  Claim,
  Clarification,
  Document,
  Evidence,
  Handover,
  HandoverVersion,
  Source,
} from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';

describe('permission findings H1-H12', () => {
  let seeded;
  let projectId;
  let leadToken;
  let incomingToken;
  let outgoingToken;
  let leadId;
  let incomingId;
  let outgoingId;

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
    incomingToken = tokenOf(seeded, INCOMING);
    outgoingToken = tokenOf(seeded, OUTGOING);
    leadId = idOf(seeded, LEAD);
    incomingId = idOf(seeded, INCOMING);
    outgoingId = idOf(seeded, OUTGOING);
  });

  async function createDraft({ roleTemplate = 'onboarding', recipientId = incomingId } = {}) {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId, roleTemplate });
    expect(created.status).toBe(201);
    return created.body.handover;
  }

  async function createRestrictedSource({
    kind = 'upload',
    name = 'Restricted source',
    externalRef = '',
  } = {}) {
    return Source.create({
      project: projectId,
      kind,
      name,
      externalRef,
      visibility: { scope: 'users', users: [outgoingId] },
      sensitivity: 'internal',
      status: 'ready',
      createdBy: leadId,
    });
  }

  async function createRestrictedClaim(canary) {
    const source = await createRestrictedSource({ name: canary });
    const document = await Document.create({
      project: projectId,
      source: source._id,
      kind: 'text',
      title: 'Restricted note',
      path: 'restricted.md',
      rawText: canary,
      chunks: [{ index: 0, text: canary, start: 0, end: canary.length }],
    });
    const claim = await Claim.create({
      project: projectId,
      source: source._id,
      document: document._id,
      type: 'decision',
      statement: canary,
      statementKey: canary.toLowerCase(),
      topic: canary,
      topicKey: canary.toLowerCase(),
      status: 'active',
      state: 'confirmed',
      confidence: 0.9,
      sensitivity: 'internal',
      origin: 'document',
      evidenceCount: 1,
      verifiedEvidenceCount: 1,
    });
    await Evidence.create({
      project: projectId,
      claim: claim._id,
      source: source._id,
      document: document._id,
      chunkId: document.chunks[0]._id,
      quote: canary,
      charStart: 0,
      charEnd: canary.length,
      validation: 'exact',
    });
    return { source, document, claim };
  }

  async function firstAskable(kind) {
    const response = await request(app)
      .get(`/api/projects/${projectId}/clarifications/candidates`)
      .set(auth(leadToken))
      .expect(200);
    const candidate = response.body.candidates.find(
      (entry) => entry.kind === kind && entry.askable && !entry.clarificationId,
    );
    expect(candidate, `no askable ${kind} candidate`).toBeTruthy();
    return candidate;
  }

  async function ask(claimIds) {
    const response = await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ claimIds })
      .expect(201);
    return response.body.clarifications[0];
  }

  it('H1 version reasons and diffs never quote item text or hidden sources', async () => {
    const draft = await createDraft();
    const item = draft.items.find(
      (entry) => entry.decision === 'accepted' && (entry.citations || []).length > 0,
    );
    expect(item).toBeTruthy();

    await request(app)
      .patch(`/api/handovers/${draft.id}/items/${item.claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'accepted', note: 'Checked against the source' })
      .expect(200);

    const listed = await request(app)
      .get(`/api/handovers/${draft.id}/versions`)
      .set(auth(leadToken))
      .expect(200);
    const accepted = listed.body.versions.find((entry) =>
      entry.reason.startsWith('accepted item'),
    );
    expect(accepted.reason).toBe(`accepted item ${item.claimId}`);
    const statementHead = item.statement.slice(0, 30);
    for (const version of listed.body.versions) {
      expect(version.reason).not.toContain(statementHead);
    }

    // An older release stored the first characters of the statement inside the
    // reason. Reading that row today still yields the cleaned form, and the
    // diff replaces the hidden item with a placeholder.
    await HandoverVersion.deleteMany({ handover: draft.id });
    const restricted = await createRestrictedClaim('CANARY-H1-DIFF');
    await HandoverVersion.create({
      handover: draft.id,
      project: projectId,
      version: 1,
      reason: 'created',
      snapshot: { items: [] },
    });
    await HandoverVersion.create({
      handover: draft.id,
      project: projectId,
      version: 2,
      reason: `accepted item ${restricted.claim._id} "CANARY-H1-DIFF" — copied text`,
      snapshot: {
        items: [
          {
            claimId: restricted.claim._id,
            type: 'decision',
            statement: 'CANARY-H1-DIFF',
            decision: 'accepted',
            citations: [{ sourceId: restricted.source._id, validation: 'exact' }],
          },
        ],
      },
    });

    const viewed = await request(app)
      .get(`/api/handovers/${draft.id}/versions/2`)
      .set(auth(leadToken))
      .expect(200);
    expect(JSON.stringify(viewed.body)).not.toContain('CANARY-H1-DIFF');
    expect(viewed.body.diff.counts.restricted).toBe(1);
    expect(viewed.body.diff.changes[0].change).toBe('restricted');
    expect(viewed.body.diff.changes[0].statement).toBe('A restricted item changed');
    expect(viewed.body.diff.reason).toBe(`accepted item ${restricted.claim._id}`);

    const legacy = await request(app)
      .get(`/api/handovers/${draft.id}/versions`)
      .set(auth(leadToken))
      .expect(200);
    const versionTwo = legacy.body.versions.find((entry) => entry.version === 2);
    expect(versionTwo.reason).toBe(`accepted item ${restricted.claim._id}`);
  });

  it('H2 reviewer counts, summary and freshness use only readable claims', async () => {
    const draft = await createDraft();
    const restricted = await createRestrictedClaim('CANARY-H2');

    await Handover.updateOne(
      { _id: draft.id },
      {
        $set: {
          'snapshot.counts': { total: 999, openTasks: 999 },
          'snapshot.generatedSummary': 'CANARY-H2-SUMMARY',
          freshness: {
            status: 'outdated',
            checkedAt: new Date(),
            changes: [
              {
                claimId: restricted.claim._id,
                type: 'decision',
                statement: 'CANARY-H2-FRESH',
                change: 'updated',
                reason: 'status changed',
                fields: [{ field: 'status', from: 'open', to: 'done' }],
              },
            ],
          },
          'withheld.total': 42,
          'withheld.byType': { decision: 42 },
          'withheld.byReason': {
            permissions: 42,
            author_permissions: 0,
            template: 0,
            unverified: 0,
          },
          'withheld.entries': [
            { claimId: restricted.claim._id, claimType: 'decision', reason: 'permissions' },
          ],
        },
      },
    );

    const state = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(leadToken))
      .expect(200);
    const viewed = await request(app)
      .get(`/api/handovers/${draft.id}`)
      .set(auth(leadToken))
      .expect(200);
    const handover = viewed.body.handover;

    expect(handover.snapshot.counts.total).toBe(state.body.summary.counts.total);
    expect(handover.snapshot.counts.total).not.toBe(999);
    expect(JSON.stringify(viewed.body)).not.toContain('CANARY-H2');
    expect(handover.freshness.changes).toEqual([]);
    expect(handover.withheld.total).toBe(0);
  });

  it('H3 clarifications about unreadable claims are replaced with stubs', async () => {
    const restricted = await createRestrictedClaim('CANARY-H3');
    const clarification = await Clarification.create({
      project: projectId,
      claim: restricted.claim._id,
      kind: 'open_question',
      prompt: 'CANARY-H3 PROMPT',
      status: 'answered',
      askedBy: leadId,
      askedByName: 'Subham Sahu',
      askedOf: incomingId,
      askedOfName: 'Ananya Rao',
      answerOptions: ['CANARY-H3 OPTION'],
      answer: 'CANARY-H3 ANSWER',
      answeredAt: new Date(),
    });

    const projectList = await request(app)
      .get(`/api/clarifications?projectId=${projectId}`)
      .set(auth(leadToken))
      .expect(200);
    const leadRow = projectList.body.clarifications.find(
      (entry) => entry.id === String(clarification._id),
    );
    expect(leadRow.restricted).toBe(true);
    expect(leadRow.prompt).toBe('Restricted item');
    expect(leadRow.claimId).toBeNull();
    expect(leadRow.answerOptions).toEqual([]);
    expect(leadRow.answer).toBeNull();
    expect(JSON.stringify(projectList.body)).not.toContain('CANARY-H3');

    const mine = await request(app)
      .get('/api/clarifications')
      .set(auth(incomingToken))
      .expect(200);
    const myRow = mine.body.clarifications.find(
      (entry) => entry.id === String(clarification._id),
    );
    expect(myRow.restricted).toBe(true);
    expect(myRow.prompt).toBe('Restricted item');
    expect(myRow.claim).toBeNull();
    expect(JSON.stringify(mine.body)).not.toContain('CANARY-H3');
  });

  it('H4 a lead cannot re-classify a source they cannot read, but can hide it', async () => {
    const restricted = await createRestrictedSource();
    const base = `/api/projects/${projectId}/sources/${restricted._id}`;

    await request(app)
      .patch(base)
      .set(auth(leadToken))
      .send({ name: 'Renamed by a lead' })
      .expect(403);
    await request(app)
      .patch(base)
      .set(auth(leadToken))
      .send({ sensitivity: 'confidential' })
      .expect(403);
    await request(app)
      .patch(base)
      .set(auth(leadToken))
      .send({ visibility: { scope: 'project', roles: [], users: [] } })
      .expect(403);

    const hidden = await request(app)
      .patch(base)
      .set(auth(leadToken))
      .send({ hidden: true })
      .expect(200);
    expect(hidden.body.source.hidden).toBe(true);

    const stored = await Source.findById(restricted._id).lean();
    expect(stored.name).toBe('Restricted source');
    expect(stored.sensitivity).toBe('internal');
    expect(stored.visibility.scope).toBe('users');
  });

  it('H5 reingest and sync hide unreadable sources and return only job state', async () => {
    const restricted = await createRestrictedSource({
      kind: 'github',
      name: 'Private repository',
      externalRef: 'acme/private-repository',
    });
    const base = `/api/projects/${projectId}/sources/${restricted._id}`;

    await request(app).post(`${base}/reingest`).set(auth(leadToken)).expect(404);
    await request(app).post(`${base}/sync`).set(auth(leadToken)).expect(404);

    const visible = await Source.create({
      project: projectId,
      kind: 'upload',
      name: 'Visible ready source',
      visibility: { scope: 'project', roles: [], users: [] },
      sensitivity: 'internal',
      status: 'ready',
      createdBy: leadId,
    });
    const reingest = await request(app)
      .post(`/api/projects/${projectId}/sources/${visible._id}/reingest`)
      .set(auth(leadToken))
      .expect(202);
    expect(Object.keys(reingest.body)).toEqual(['source']);
    expect(Object.keys(reingest.body.source).sort()).toEqual(['id', 'status']);
    expect(reingest.body.source.status).toBe('queued');
    await whenIdle();
  });

  it('H7 purging a source erases its text from claims, handovers and questions', async () => {
    const draft = await createDraft();
    const item = draft.items.find((entry) => (entry.citations || []).length > 0);
    expect(item).toBeTruthy();
    const statement = item.statement;
    const claimId = item.claimId;
    const sourceId = item.citations[0].sourceId;

    const clarification = await Clarification.create({
      project: projectId,
      claim: claimId,
      kind: 'missing_owner',
      prompt: `Who owns "${statement}"?`,
      status: 'open',
      askedBy: leadId,
      askedByName: 'Subham Sahu',
      askedOf: outgoingId,
      askedOfName: 'Rohan Mehta',
      answerOptions: ['Ananya Rao'],
    });

    await request(app)
      .delete(`/api/projects/${projectId}/sources/${sourceId}`)
      .set(auth(leadToken))
      .expect(200);

    const claim = await Claim.findById(claimId).lean();
    expect(claim.statement).toBe('');
    expect(claim.statementKey).toBe('');
    expect(claim.topic).toBe('');
    expect(claim.retiredAt).toBeTruthy();

    const cleared = await Clarification.findById(clarification._id).lean();
    expect(cleared.status).toBe('closed');
    expect(cleared.prompt).toBe('Question removed with its source');
    expect(cleared.answerOptions).toEqual([]);

    const handovers = await Handover.find({ project: projectId }).lean();
    const versions = await HandoverVersion.find({ project: projectId }).lean();
    for (const document of [...handovers, ...versions]) {
      expect(JSON.stringify(document)).not.toContain(statement);
    }
    expect(await Claim.countDocuments({ project: projectId, statement })).toBe(0);
  });

  it('H8 re-classifying a source cascades its sensitivity to every claim', async () => {
    const sourceId = sourceIdOf(seeded, 'handover-notes.txt');
    const before = await Claim.find({ source: sourceId }).select('_id sensitivity').lean();
    expect(before.length).toBeGreaterThan(0);

    await request(app)
      .patch(`/api/projects/${projectId}/sources/${sourceId}`)
      .set(auth(leadToken))
      .send({ sensitivity: 'confidential' })
      .expect(200);

    const after = await Claim.find({ source: sourceId }).select('_id sensitivity').lean();
    expect(after.every((entry) => entry.sensitivity === 'confidential')).toBe(true);

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    expect(audit.body.events.map((event) => event.action)).toContain('source.access_changed');
  });

  it('H10 removing the addressee closes their questions and blocks answers', async () => {
    const gap = await firstAskable('missing_owner');
    const clarification = await ask([gap.claimId]);

    await request(app)
      .delete(`/api/projects/${projectId}/members/${outgoingId}`)
      .set(auth(leadToken))
      .expect(200);

    const stored = await Clarification.findById(clarification.id).lean();
    expect(stored.status).toBe('closed');

    const answered = await request(app)
      .post(`/api/clarifications/${clarification.id}/answer`)
      .set(auth(outgoingToken))
      .send({ answer: 'Ananya Rao' });
    expect(answered.status).toBe(403);

    const declined = await request(app)
      .post(`/api/clarifications/${clarification.id}/decline`)
      .set(auth(outgoingToken))
      .send({});
    expect(declined.status).toBe(403);
  });

  it('H12 two simultaneous answers create exactly one confirmation', async () => {
    const gap = await firstAskable('missing_owner');
    const clarification = await ask([gap.claimId]);

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/clarifications/${clarification.id}/answer`)
        .set(auth(outgoingToken))
        .send({ answer: 'Ananya Rao' }),
      request(app)
        .post(`/api/clarifications/${clarification.id}/answer`)
        .set(auth(outgoingToken))
        .send({ answer: 'Ananya Rao' }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const stored = await Clarification.findById(clarification.id).lean();
    expect(stored.status).toBe('answered');
    expect(await Evidence.countDocuments({ answerRef: stored._id })).toBe(1);
    expect(
      await Claim.countDocuments({ project: projectId, origin: 'person_confirmed' }),
    ).toBe(1);
  });
});
