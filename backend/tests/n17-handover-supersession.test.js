import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditEvent, Handover } from '../src/models/index.js';
import { auth, idOf, app, request, seed, startDb, stopDb, tokenOf } from './helpers.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

describe('regenerated handovers supersede the released copy', () => {
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

  async function createSharedHandover({ acknowledge = false } = {}) {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId: incomingId, roleTemplate: 'onboarding' })
      .expect(201);
    const id = created.body.handover.id;

    await request(app).post(`/api/handovers/${id}/submit`).set(auth(leadToken)).expect(200);
    await request(app)
      .post(`/api/handovers/${id}/approve`)
      .set(auth(leadToken))
      .send({})
      .expect(200);
    const shared = await request(app)
      .post(`/api/handovers/${id}/share`)
      .set(auth(leadToken))
      .expect(200);
    const token = shared.body.sharePath.split('/').pop();

    if (acknowledge) {
      await request(app)
        .post(`/api/handovers/${id}/acknowledge`)
        .set(auth(incomingToken))
        .expect(200);
    }
    return { id, token };
  }

  async function regenerate(handoverId) {
    const response = await request(app)
      .post(`/api/handovers/${handoverId}/regenerate`)
      .set(auth(leadToken))
      .expect(200);
    expect(response.body.createdNew).toBe(true);
    return response.body.handover;
  }

  async function approveAndShare(handoverId) {
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
    return shared.body.sharePath.split('/').pop();
  }

  it('references the previous acknowledgement instead of copying it', async () => {
    const old = await createSharedHandover({ acknowledge: true });
    const replacement = await regenerate(old.id);

    expect(replacement.status).toBe('draft');
    expect(replacement.acknowledgedAt).toBeFalsy();

    const stored = await Handover.findById(replacement.id).lean();
    expect(String(stored.acknowledgedFrom)).toBe(String(old.id));
    expect(stored.acknowledgedAt).toBeUndefined();
    expect(stored.acknowledgement?.at).toBeFalsy();
    expect(stored.acknowledgement?.shownItemIds || []).toHaveLength(0);
    expect(stored.acknowledgement?.statementHashes || {}).toEqual({});

    // The old copy keeps its own acknowledgement until the replacement is
    // actually shared.
    const original = await Handover.findById(old.id).lean();
    expect(original.status).toBe('acknowledged');
    expect(original.acknowledgement?.at).toBeTruthy();
  });

  it('supersedes the old release and revokes its link when the replacement is shared', async () => {
    const old = await createSharedHandover({ acknowledge: true });
    const replacement = await regenerate(old.id);
    const newToken = await approveAndShare(replacement.id);

    const original = await Handover.findById(old.id).lean();
    expect(original.status).toBe('superseded');
    expect(String(original.supersededBy)).toBe(String(replacement.id));
    expect(original.supersededAt).toBeTruthy();
    expect(original.shareTokenHash).toBeUndefined();
    expect(original.shareExpiresAt).toBeUndefined();
    expect(original.revokedReason).toBe('Superseded by a newer handover');
    // History is preserved: the acknowledgement the recipient gave is intact.
    expect(original.acknowledgement?.at).toBeTruthy();

    const audit = await AuditEvent.findOne({
      project: projectId,
      action: 'handover.superseded',
      targetId: original._id,
    }).lean();
    expect(audit).toBeTruthy();
    expect(String(audit.meta.supersededBy)).toBe(String(replacement.id));

    // The old link no longer resolves.
    const oldLink = await request(app).get(`/api/handovers/shared/${old.token}`);
    expect(oldLink.status).toBe(404);
    const newLink = await request(app)
      .get(`/api/handovers/shared/${newToken}`)
      .set(auth(incomingToken));
    expect(newLink.status).toBe(200);
    expect(newLink.body.handover.id).toBe(replacement.id);

    // The recipient's list has one current handover, not two.
    const list = await request(app)
      .get(`/api/handovers?projectId=${projectId}&scope=all`)
      .set(auth(incomingToken))
      .expect(200);
    const ids = list.body.handovers.map((entry) => String(entry.id));
    expect(ids).not.toContain(String(old.id));
    expect(ids).toContain(String(replacement.id));

    // The old record stays readable as history with a pointer to the new one.
    const history = await request(app)
      .get(`/api/handovers/${old.id}`)
      .set(auth(incomingToken))
      .expect(200);
    expect(history.body.handover.status).toBe('superseded');
    expect(history.body.handover.supersededById).toBe(replacement.id);
    expect(history.body.handover.supersededByVersion).toBeGreaterThan(0);

    const current = await request(app)
      .get(`/api/handovers/${replacement.id}`)
      .set(auth(incomingToken))
      .expect(200);
    expect(current.body.handover.history.map((entry) => String(entry.id))).toContain(
      String(old.id),
    );

    // A superseded handover accepts no writes.
    await request(app)
      .post(`/api/handovers/${old.id}/acknowledge`)
      .set(auth(incomingToken))
      .expect(403);
    await request(app)
      .post(`/api/handovers/${old.id}/feedback`)
      .set(auth(incomingToken))
      .send({ message: 'Still working from the old one' })
      .expect(403);
  });

  it('closes every earlier release in a regeneration chain', async () => {
    const first = await createSharedHandover({ acknowledge: true });
    const second = await regenerate(first.id);
    await approveAndShare(second.id);

    const third = await regenerate(second.id);
    await approveAndShare(third.id);

    const rows = await Handover.find({
      _id: { $in: [first.id, second.id, third.id] },
    }).lean();
    const byId = new Map(rows.map((row) => [String(row._id), row]));

    expect(byId.get(String(first.id)).status).toBe('superseded');
    expect(String(byId.get(String(first.id)).supersededBy)).toBe(String(second.id));
    expect(byId.get(String(second.id)).status).toBe('superseded');
    expect(String(byId.get(String(second.id)).supersededBy)).toBe(String(third.id));
    expect(byId.get(String(third.id)).status).toBe('shared');

    const list = await request(app)
      .get(`/api/handovers?projectId=${projectId}&scope=all`)
      .set(auth(incomingToken))
      .expect(200);
    expect(list.body.handovers.map((entry) => String(entry.id))).toEqual([third.id]);

    const current = await request(app)
      .get(`/api/handovers/${third.id}`)
      .set(auth(incomingToken))
      .expect(200);
    const chain = current.body.handover.history.map((entry) => String(entry.id));
    expect(chain).toEqual([second.id, first.id]);
  });
});
