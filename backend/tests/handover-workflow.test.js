import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  idOf,
  request,
  app,
  seed,
  startDb,
  stopDb,
  tokenOf,
} from './helpers.js';

const LEAD = 'aarav@threadline.demo';
const INCOMING = 'rohan@threadline.demo';
const OUTGOING = 'meera@threadline.demo';

describe('review and handover workflow', () => {
  let seeded;
  let projectId;
  let leadToken;
  let incomingToken;
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
    incomingToken = tokenOf(seeded, INCOMING);
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

  it('runs review, approval, sharing, acknowledgement and history', async () => {
    const handover = await createDraft();
    const handoverId = handover.id;
    const item = handover.items.find((entry) => entry.decision === 'accepted');

    const edited = await request(app)
      .patch(`/api/handovers/${handoverId}/items/${item.claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'edited', editedStatement: 'Backfill invoices written after 2024.' })
      .expect(200);
    expect(edited.body.handover.version).toBe(2);
    expect(edited.body.handover.counts.edited).toBe(1);

    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(leadToken))
      .expect(200);

    const recipientApprove = await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(incomingToken))
      .send({});
    expect(recipientApprove.status).toBe(403);

    const approved = await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(leadToken))
      .send({ note: 'Evidence checked against the source documents.' })
      .expect(200);
    expect(approved.body.handover.status).toBe('approved');
    expect(approved.body.handover.approvedBySnapshot.name).toBe('Aarav Mehta');

    const shared = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken))
      .expect(200);
    const shareToken = shared.body.sharePath.split('/').pop();

    const recipientView = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(incomingToken))
      .expect(200);
    const editedItem = recipientView.body.handover.items.find(
      (entry) => entry.claimId === item.claimId,
    );
    expect(editedItem.statement).toBe('Backfill invoices written after 2024.');
    expect(editedItem.originalStatement).toBe(item.statement);

    const acknowledged = await request(app)
      .post(`/api/handovers/${handoverId}/acknowledge`)
      .set(auth(incomingToken))
      .expect(200);
    expect(acknowledged.body.handover.status).toBe('acknowledged');

    const repeat = await request(app)
      .post(`/api/handovers/${handoverId}/acknowledge`)
      .set(auth(incomingToken));
    expect(repeat.status).toBe(400);

    const versions = await request(app)
      .get(`/api/handovers/${handoverId}/versions`)
      .set(auth(leadToken))
      .expect(200);
    const reasons = versions.body.versions.map((entry) => entry.reason);
    expect(reasons).toContain('created');
    expect(reasons).toContain('approved');
    expect(reasons).toContain('shared');
    expect(reasons).toContain('acknowledged by recipient');
    expect(versions.body.versions[0].version).toBe(6);

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    const actions = audit.body.events.map((event) => event.action);
    expect(actions).toContain('handover.created');
    expect(actions).toContain('handover.approved');
    expect(actions).toContain('handover.shared');
    expect(actions).toContain('handover.acknowledged');

    const denied = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(incomingToken));
    expect(denied.status).toBe(403);
  });

  it('blocks approval while items are pending and enforces transitions', async () => {
    const handover = await createDraft();
    const handoverId = handover.id;
    const item = handover.items[0];

    await request(app)
      .patch(`/api/handovers/${handoverId}/items/${item.claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'pending', note: 'Needs confirmation from the outgoing owner.' })
      .expect(200);

    const shareDraft = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken));
    expect(shareDraft.status).toBe(400);

    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(leadToken))
      .expect(200);

    const pendingApprove = await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(leadToken))
      .send({});
    expect(pendingApprove.status).toBe(422);
    expect(pendingApprove.body.error.code).toBe('unprocessable');
    expect(pendingApprove.body.error.details.pendingClaimIds).toContain(item.claimId);

    const contributorApprove = await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(tokenOf(seeded, OUTGOING)))
      .send({});
    expect(contributorApprove.status).toBe(403);

    const noNote = await request(app)
      .post(`/api/handovers/${handoverId}/reject`)
      .set(auth(leadToken))
      .send({});
    expect(noNote.status).toBe(400);

    const rejected = await request(app)
      .post(`/api/handovers/${handoverId}/reject`)
      .set(auth(leadToken))
      .send({ note: 'The pending item must be resolved first.' })
      .expect(200);
    expect(rejected.body.handover.status).toBe('rejected');

    const shareRejected = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken));
    expect(shareRejected.status).toBe(400);
  });

  it('never shares restricted evidence with the recipient', async () => {
    const handover = await createDraft();
    const handoverId = handover.id;

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

    const shareToken = shared.body.sharePath.split('/').pop();
    const recipientView = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(incomingToken))
      .expect(200);

    const payload = JSON.stringify(recipientView.body);
    expect(payload).not.toContain('vendor-contract-summary.md');
    expect(payload).not.toContain('22 percent');
    expect(
      recipientView.body.handover.alerts.every((alert) => alert.audience === 'recipient'),
    ).toBe(true);
    expect(recipientView.body.handover).not.toHaveProperty('withheld');
  });
});
