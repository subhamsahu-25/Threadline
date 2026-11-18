import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '../src/models/index.js';
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

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';

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
    expect(edited.body.version).toBe(2);
    expect(edited.body.counts.edited).toBe(1);
    expect(edited.body.item.statement).toBe('Backfill invoices written after 2024.');

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
    expect(approved.body.handover.approvedBySnapshot.name).toBe('Subham Sahu');

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
    expect(repeat.status).toBe(200);
    expect(repeat.body.handover.acknowledgement.version).toBe(5);

    const versions = await request(app)
      .get(`/api/handovers/${handoverId}/versions`)
      .set(auth(leadToken))
      .expect(200);
    const reasons = versions.body.versions.map((entry) => entry.reason);
    expect(reasons).toContain('created');
    expect(reasons.some((reason) => reason.startsWith('approved by'))).toBe(true);
    expect(reasons).toContain('shared with recipient');
    expect(reasons.some((reason) => reason.startsWith('acknowledged by'))).toBe(true);
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

  it('reopens a rejected handover instead of leaving it stranded', async () => {
    const handover = await createDraft();
    const handoverId = handover.id;

    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(leadToken))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handoverId}/reject`)
      .set(auth(leadToken))
      .send({ note: 'The vendor clause quote needs a second source.' })
      .expect(200);

    const contributorReopen = await request(app)
      .post(`/api/handovers/${handoverId}/reopen`)
      .set(auth(tokenOf(seeded, OUTGOING)));
    expect(contributorReopen.status).toBe(403);

    const reopened = await request(app)
      .post(`/api/handovers/${handoverId}/reopen`)
      .set(auth(leadToken))
      .expect(200);
    expect(reopened.body.handover.status).toBe('draft');
    expect(reopened.body.handover.reopenedAt).toBeTruthy();
    expect(reopened.body.handover.rejectionNote).toBe(
      'The vendor clause quote needs a second source.',
    );

    const duplicate = await request(app)
      .post(`/api/handovers/${handoverId}/reopen`)
      .set(auth(leadToken));
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.handover.status).toBe('draft');

    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(leadToken))
      .expect(200);

    const versions = await request(app)
      .get(`/api/handovers/${handoverId}/versions`)
      .set(auth(leadToken))
      .expect(200);
    expect(versions.body.versions.map((entry) => entry.reason)).toContain(
      'reopened for further review',
    );

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    const reopenedEvent = audit.body.events.find(
      (event) => event.action === 'handover.reopened',
    );
    expect(reopenedEvent).toBeTruthy();
    expect(reopenedEvent.meta.rejectionNote).toBe(
      'The vendor clause quote needs a second source.',
    );
  });

  it('renews a share link and invalidates the previous one', async () => {
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

    const first = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken))
      .expect(200);
    const firstToken = first.body.sharePath.split('/').pop();

    const unconfirmed = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken));
    expect(unconfirmed.status).toBe(409);

    const renewed = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken))
      .send({ confirmRotation: true })
      .expect(200);
    const secondToken = renewed.body.sharePath.split('/').pop();
    expect(renewed.body.status).toBe('shared');
    expect(secondToken).not.toBe(firstToken);

    const staleLink = await request(app)
      .get(`/api/handovers/shared/${firstToken}`)
      .set(auth(incomingToken));
    expect(staleLink.status).toBe(404);

    await request(app)
      .get(`/api/handovers/shared/${secondToken}`)
      .set(auth(incomingToken))
      .expect(200);

    const detail = await request(app)
      .get(`/api/handovers/${handoverId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(detail.body.handover.sharePath).toBeNull();
    expect(detail.body.handover.shareActive).toBe(true);

    const versions = await request(app)
      .get(`/api/handovers/${handoverId}/versions`)
      .set(auth(leadToken))
      .expect(200);
    expect(versions.body.versions.map((entry) => entry.reason)).toContain(
      'share link rotated; the previous link was invalidated',
    );

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    const actions = audit.body.events.map((event) => event.action);
    expect(actions.filter((action) => action === 'handover.shared')).toHaveLength(1);
    expect(actions.filter((action) => action === 'handover.share_rotated')).toHaveLength(1);
  });

  async function createShared() {
    const handover = await createDraft();
    await request(app)
      .post(`/api/handovers/${handover.id}/submit`)
      .set(auth(leadToken))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handover.id}/approve`)
      .set(auth(leadToken))
      .send({})
      .expect(200);
    const shared = await request(app)
      .post(`/api/handovers/${handover.id}/share`)
      .set(auth(leadToken))
      .expect(200);
    return { handover, shareToken: shared.body.sharePath.split('/').pop() };
  }

  it('opens a demo share link without sign-in and records the channel', async () => {
    const { shareToken } = await createShared();

    const anonymous = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .expect(200);
    expect(anonymous.body.publicPreview).toBe(true);
    expect(anonymous.body.recipientName).toBe('Ananya Rao');
    expect(anonymous.body.handover.items.length).toBeGreaterThan(0);

    const acknowledged = await request(app)
      .post(`/api/handovers/shared/${shareToken}/acknowledge`)
      .expect(200);
    expect(acknowledged.body.publicPreview).toBe(true);
    expect(acknowledged.body.handover.status).toBe('acknowledged');

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    const event = audit.body.events.find(
      (entry) => entry.action === 'handover.acknowledged',
    );
    expect(event.meta.channel).toBe('public_share_link');
    expect(event.meta.shownItems).toBeGreaterThan(0);
  });

  it('keeps share links private outside the demo workspace', async () => {
    const { shareToken } = await createShared();
    await Project.updateOne(
      { _id: projectId },
      { $set: { key: 'PRIVATE', isDemo: false } },
    );

    const anonymous = await request(app)
      .get(`/api/handovers/shared/${shareToken}`);
    expect(anonymous.status).toBe(403);
    expect(anonymous.body.error.message).toContain('named recipient');

    const anonymousAck = await request(app)
      .post(`/api/handovers/shared/${shareToken}/acknowledge`);
    expect(anonymousAck.status).toBe(403);

    await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(incomingToken))
      .expect(200);

    const otherMember = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(tokenOf(seeded, OUTGOING)));
    expect(otherMember.status).toBe(403);
  });
});
