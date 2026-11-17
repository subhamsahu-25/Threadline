import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, auth, idOf, request, seed, startDb, stopDb, tokenOf } from './helpers.js';

const LEAD = 'subham@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

describe('decision conflict resolution', () => {
  let seeded;
  let projectId;
  let leadToken;
  let outgoingToken;
  let observerToken;
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
    outgoingToken = tokenOf(seeded, OUTGOING);
    observerToken = tokenOf(seeded, OBSERVER);
    incomingId = idOf(seeded, INCOMING);
  });

  function getState(token = leadToken) {
    return request(app).get(`/api/projects/${projectId}/state`).set(auth(token));
  }

  function resolve(conflict, keepClaimId, token = leadToken) {
    return request(app)
      .post(`/api/projects/${projectId}/conflicts/resolve`)
      .set(auth(token))
      .send({ topicKey: conflict.topicKey, keepClaimId });
  }

  it('marks the other statements superseded and clears the conflict', async () => {
    const before = await getState().expect(200);
    expect(before.body.conflicts.length).toBeGreaterThan(0);

    const conflict = before.body.conflicts[0];
    const keepId = String(conflict.statements[0].claimId);
    const expectedRemaining = before.body.conflicts.length - 1;

    const resolved = await resolve(conflict, keepId).expect(200);
    expect(resolved.body.resolved).toBe(true);
    expect(resolved.body.keptClaimId).toBe(keepId);
    expect(resolved.body.supersededClaimIds.length).toBe(conflict.statements.length - 1);

    const after = await getState().expect(200);
    expect(after.body.conflicts.length).toBe(expectedRemaining);

    const statusById = new Map(after.body.timeline.map((claim) => [claim.id, claim.status]));
    expect(statusById.get(keepId)).toBe('active');
    for (const id of resolved.body.supersededClaimIds) {
      expect(statusById.get(String(id))).toBe('superseded');
    }
  });

  it('excludes the superseded decision from a fresh handover draft', async () => {
    const before = await getState().expect(200);
    const conflict = before.body.conflicts[0];
    const keep = conflict.statements[0];
    const stale = conflict.statements[1];

    await resolve(conflict, keep.claimId).expect(200);

    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId: incomingId, roleTemplate: 'onboarding' })
      .expect(201);

    const claimIds = new Set(
      created.body.handover.items.map((item) => String(item.claimId)),
    );
    expect(claimIds.has(String(keep.claimId))).toBe(true);
    expect(claimIds.has(String(stale.claimId))).toBe(false);
  });

  it('records the resolution in the audit trail', async () => {
    const before = await getState().expect(200);
    const conflict = before.body.conflicts[0];
    await resolve(conflict, conflict.statements[0].claimId).expect(200);

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);

    const event = audit.body.events.find((entry) => entry.action === 'claim.conflict_resolved');
    expect(event).toBeTruthy();
    expect(event.meta.topicKey).toBe(conflict.topicKey);
    expect(event.meta.keptClaimId).toBe(String(conflict.statements[0].claimId));
  });

  it('rejects contributors and observers', async () => {
    const before = await getState().expect(200);
    const conflict = before.body.conflicts[0];

    await resolve(conflict, conflict.statements[0].claimId, outgoingToken).expect(403);
    await resolve(conflict, conflict.statements[0].claimId, observerToken).expect(403);
  });

  it('rejects a statement that is not part of the conflict', async () => {
    const before = await getState().expect(200);
    const conflict = before.body.conflicts[0];
    const inConflict = new Set(conflict.statements.map((entry) => String(entry.claimId)));
    const otherDecision = before.body.timeline.find(
      (claim) => claim.type === 'decision' && !inConflict.has(String(claim.id)),
    );
    expect(otherDecision).toBeTruthy();

    const resolved = await resolve(conflict, otherDecision.id).expect(404);
    expect(resolved.body.error.message).toMatch(/not part of this conflict/i);
  });

  it('rejects resolving the same conflict twice', async () => {
    const before = await getState().expect(200);
    const conflict = before.body.conflicts[0];
    await resolve(conflict, conflict.statements[0].claimId).expect(200);
    await resolve(conflict, conflict.statements[0].claimId).expect(400);
  });
});
