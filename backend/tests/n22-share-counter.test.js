import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Handover } from '../src/models/index.js';
import { app, auth, request, seed, startDb, stopDb, tokenOf } from './helpers.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

describe('N22 share-open counter', () => {
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

  it('does not lose concurrent opens', async () => {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId, roleTemplate: 'onboarding' });
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
    const token = shared.body.sharePath.split('/').pop();

    const opens = await Promise.all(
      Array.from({ length: 6 }, () => request(app).get(`/api/handovers/shared/${token}`)),
    );
    expect(opens.every((response) => response.status === 200)).toBe(true);

    const stored = await Handover.findById(handoverId).lean();
    expect(stored.shareOpenCount).toBe(6);
    expect(stored.shareOpenedAt).toBeTruthy();
  });
});
