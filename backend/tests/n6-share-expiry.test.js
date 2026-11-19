import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Handover, Notification } from '../src/models/index.js';
import { sendExpiryReminders } from '../src/services/handover/reminders.js';
import {
  app,
  auth,
  idOf,
  request,
  seed,
  startDb,
  stopDb,
  tokenOf,
} from './helpers.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

describe('share expiry versus recipient access', () => {
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

  async function sharedAndAcknowledged() {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId: incomingId, roleTemplate: 'onboarding' })
      .expect(201);
    const handoverId = created.body.handover.id;

    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(leadToken))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(leadToken))
      .send({ note: 'checked' })
      .expect(200);
    const shared = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handoverId}/acknowledge`)
      .set(auth(incomingToken))
      .expect(200);

    return { handoverId, shareToken: shared.body.sharePath.split('/').pop() };
  }

  it('keeps the acknowledged recipient reading after the link has expired', async () => {
    const { handoverId, shareToken } = await sharedAndAcknowledged();

    // Eight days later: the public link has expired, the recipient has not.
    await Handover.updateOne(
      { _id: handoverId },
      { $set: { shareExpiresAt: new Date(Date.now() - 8 * 86_400_000) } },
    );

    const signedIn = await request(app)
      .get(`/api/handovers/${handoverId}`)
      .set(auth(incomingToken));
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.viewer).toBe('recipient');

    const exportPdf = await request(app)
      .get(`/api/handovers/${handoverId}/export`)
      .set(auth(incomingToken));
    expect(exportPdf.status).toBe(200);

    const expiredLink = await request(app).get(`/api/handovers/shared/${shareToken}`);
    expect(expiredLink.status).toBe(410);

    const reshared = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken))
      .send({ confirmRotation: true });
    expect(reshared.status).toBe(200);
    expect(reshared.body.status).toBe('acknowledged');
    expect(new Date(reshared.body.shareExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const freshToken = reshared.body.sharePath.split('/').pop();
    const reopened = await request(app)
      .get(`/api/handovers/shared/${freshToken}`)
      .set(auth(incomingToken));
    expect(reopened.status).toBe(200);
  });

  it('still closes the recipient route when the lead revokes the copy', async () => {
    const { handoverId } = await sharedAndAcknowledged();

    await request(app)
      .post(`/api/handovers/${handoverId}/share/revoke`)
      .set(auth(leadToken))
      .send({ reason: 'Access should end now' })
      .expect(200);

    const blocked = await request(app)
      .get(`/api/handovers/${handoverId}`)
      .set(auth(incomingToken));
    expect(blocked.status).toBe(403);
  });

  it('warns the lead and recipient a day before expiry, once', async () => {
    const { handoverId } = await sharedAndAcknowledged();
    await Handover.updateOne(
      { _id: handoverId },
      {
        $set: {
          shareExpiresAt: new Date(Date.now() + 12 * 3_600_000),
          expiryNoticeSentAt: null,
        },
      },
    );

    const first = await sendExpiryReminders({ now: new Date() });
    expect(first.sent).toBe(1);

    const rows = await Notification.find({ type: 'handover.expiry' }).lean();
    const recipients = rows.map((row) => String(row.recipient));
    expect(recipients).toContain(incomingId);
    expect(recipients).toContain(idOf(seeded, LEAD));
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const second = await sendExpiryReminders({ now: new Date() });
    expect(second.sent).toBe(0);
  });
});
