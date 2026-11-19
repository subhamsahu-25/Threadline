import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditEvent, HandoverFeedback, Notification } from '../src/models/index.js';
import { app, auth, idOf, request, seed, startDb, stopDb, tokenOf } from './helpers.js';

const LEAD = 'subham@threadline.demo';

describe('anonymous demo feedback', () => {
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
      .send({ projectId, recipientId: idOf(seeded, 'ananya@threadline.demo'), roleTemplate: 'onboarding' });
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

  it('labels an unsigned visitor instead of attributing the note to the recipient', async () => {
    const { handover, shareToken } = await createShared();

    const first = await request(app)
      .post(`/api/handovers/shared/${shareToken}/feedback`)
      .send({ message: 'The runbook link is missing.' })
      .expect(201);
    expect(first.body.feedback.authorName).toBe('Anonymous demo visitor');
    expect(first.body.feedback.authorRole).toBe('visitor');

    const second = await request(app)
      .post(`/api/handovers/shared/${shareToken}/feedback`)
      .send({ message: 'The escalation contact has changed.' })
      .expect(201);
    expect(second.body.feedback.authorName).toBe('Anonymous demo visitor');

    // Audit keeps the anonymous channel rather than naming the recipient.
    const event = await AuditEvent.findOne({
      action: 'handover.feedback_received',
      targetId: handover.id,
    });
    expect(event).toBeTruthy();
    expect(event.actor).toBeUndefined();
    expect(event.actorName).toBeUndefined();
    expect(event.meta.anonymous).toBe(true);

    // Repeated notes from the same link coalesce into one bell row per lead.
    const notices = await Notification.countDocuments({
      recipient: idOf(seeded, LEAD),
      type: 'handover.feedback',
      entityId: handover.id,
    });
    expect(notices).toBe(1);
    const rows = await HandoverFeedback.countDocuments({ handover: handover.id });
    expect(rows).toBe(2);
  });

  it('caps anonymous feedback per link', async () => {
    const { shareToken } = await createShared();

    for (let index = 0; index < 5; index += 1) {
      await request(app)
        .post(`/api/handovers/shared/${shareToken}/feedback`)
        .send({ message: `Anonymous note number ${index + 1}.` })
        .expect(201);
    }

    const blocked = await request(app)
      .post(`/api/handovers/shared/${shareToken}/feedback`)
      .send({ message: 'One note too many.' })
      .expect(429);
    expect(blocked.body.error.code).toBe('too_many_posts');
  });

  it('keeps signed-in recipient feedback attributed to the recipient', async () => {
    const { shareToken } = await createShared();

    const created = await request(app)
      .post(`/api/handovers/shared/${shareToken}/feedback`)
      .set(auth(tokenOf(seeded, 'ananya@threadline.demo')))
      .send({ message: 'Signed-in note from the recipient.' })
      .expect(201);
    expect(created.body.feedback.authorName).toBe('Ananya Rao');
  });
});
