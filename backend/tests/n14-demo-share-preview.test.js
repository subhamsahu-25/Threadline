import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '../src/models/index.js';
import { app, auth, idOf, request, seed, startDb, stopDb, tokenOf } from './helpers.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

describe('demo share links for signed-in visitors', () => {
  let seeded;
  let projectId;
  let leadToken;

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
  });

  async function createShared() {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId: idOf(seeded, INCOMING), roleTemplate: 'onboarding' });
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
    return { handover, shareToken: shared.body.sharePath.split('/').pop() };
  }

  it('serves the public preview when a different demo profile opens the link', async () => {
    const { shareToken } = await createShared();

    const view = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(leadToken))
      .expect(200);
    expect(view.body.publicPreview).toBe(true);
    expect(view.body.viewer).toBe('recipient');
    expect(view.body.recipientName).toBe('Ananya Rao');
  });

  it('still allows the anonymous preview on a demo project', async () => {
    const { shareToken } = await createShared();

    const view = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .expect(200);
    expect(view.body.publicPreview).toBe(true);
  });

  it('keeps the 403 for a different signed-in viewer on a normal project', async () => {
    const { shareToken } = await createShared();
    await Project.updateOne({ _id: projectId }, { $set: { isDemo: false } });

    const signedIn = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(leadToken));
    expect(signedIn.status).toBe(403);
    expect(signedIn.body.error.code).toBe('forbidden');

    await request(app).get(`/api/handovers/shared/${shareToken}`).expect(403);
  });
});
