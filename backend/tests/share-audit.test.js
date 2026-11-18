import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { AuditEvent, Claim, Handover } from '../src/models/index.js';
import { startDb, stopDb, seed, tokenOf, auth, request, app } from './helpers.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

describe('public share-link audit trail', () => {
  let projectId;
  let recipientId;
  let leadToken;

  beforeEach(async () => {
    await startDb();
    const seeded = await seed();
    projectId = seeded.project.id;
    recipientId = seeded.users.find((user) => user.email === INCOMING).id;
    leadToken = tokenOf(seeded, LEAD);
  });

  afterAll(async () => {
    await stopDb();
  });

  async function createSharedHandover() {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId, roleTemplate: 'onboarding' });
    expect(created.status).toBe(201);
    const handover = created.body.handover;

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

    return {
      handover,
      token: shared.body.sharePath.split('/').pop(),
    };
  }

  it('opens a demo share link for an anonymous visitor and records an anonymous view once per hour', async () => {
    const { handover, token } = await createSharedHandover();

    const first = await request(app).get(`/api/handovers/shared/${token}`).expect(200);
    expect(first.body.publicPreview).toBe(true);
    expect(first.body.viewer).toBe('recipient');

    const second = await request(app).get(`/api/handovers/shared/${token}`).expect(200);
    expect(second.body.publicPreview).toBe(true);

    const stored = await Handover.findById(handover.id).lean();
    expect(stored.shareOpenCount).toBe(2);

    const views = await AuditEvent.find({
      action: 'handover.recipient_viewed',
      targetId: stored._id,
    }).lean();
    expect(views).toHaveLength(1);
    expect(views[0].actor).toBeFalsy();
    expect(views[0].actorName).toBe('Anonymous share-link visitor');
    expect(views[0].meta.anonymous).toBe(true);
  });

  it('attributes an anonymous acknowledgement to an anonymous actor', async () => {
    const { handover, token } = await createSharedHandover();

    const ack = await request(app).post(`/api/handovers/shared/${token}/acknowledge`).expect(200);
    expect(ack.body.publicPreview).toBe(true);
    expect(ack.body.handover.status).toBe('acknowledged');

    const audits = await AuditEvent.find({
      action: 'handover.acknowledged',
      targetId: handover.id,
    }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0].actor).toBeFalsy();
    expect(audits[0].actorName).toBe('Anonymous share-link visitor');
    expect(audits[0].meta.anonymous).toBe(true);
    expect(audits[0].meta.channel).toBe('public_share_link');
  });

  it('folds repeated permission rechecks into one hourly audit row', async () => {
    const { handover, token } = await createSharedHandover();
    const item = handover.items.find((entry) => entry.decision === 'accepted' && entry.claimId);
    expect(item).toBeTruthy();
    await Claim.updateOne({ _id: item.claimId }, { $set: { status: 'superseded' } });

    await request(app).get(`/api/handovers/shared/${token}`).expect(200);
    await request(app).get(`/api/handovers/shared/${token}`).expect(200);

    const checks = await AuditEvent.find({
      action: 'handover.permissions_rechecked',
      targetId: handover.id,
    }).lean();
    expect(checks).toHaveLength(1);
    expect(checks[0].meta.rechecks).toBe(2);
    expect(checks[0].meta.supersededItems).toBeGreaterThan(0);
  });
});
