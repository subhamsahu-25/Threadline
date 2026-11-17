import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, app, idOf, request, seed, startDb, stopDb, tokenOf, whenIdle } from './helpers.js';
import { Notification } from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const INCOMING = 'ananya@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';

describe('per-user notifications', () => {
  let seeded;
  let projectId;
  let leadToken;
  let outgoingToken;
  let incomingToken;
  let observerToken;
  let outgoingId;
  let incomingId;
  let observerId;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    seeded = await seed();
    await whenIdle();
    projectId = seeded.project.id;
    leadToken = tokenOf(seeded, LEAD);
    outgoingToken = tokenOf(seeded, OUTGOING);
    incomingToken = tokenOf(seeded, INCOMING);
    observerToken = tokenOf(seeded, OBSERVER);
    outgoingId = idOf(seeded, OUTGOING);
    incomingId = idOf(seeded, INCOMING);
    observerId = idOf(seeded, OBSERVER);
  });

  async function listFor(token) {
    const response = await request(app).get('/api/notifications').set(auth(token)).expect(200);
    return response.body;
  }

  async function typesFor(token) {
    return (await listFor(token)).notifications.map((entry) => entry.type);
  }

  async function setRole(userId, role) {
    await request(app)
      .patch(`/api/projects/${projectId}/members/${userId}`)
      .set(auth(leadToken))
      .send({ role })
      .expect(200);
  }

  async function createHandover(recipientId = incomingId, token = leadToken) {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(token))
      .send({ projectId, recipientId });
    expect(created.status).toBe(201);
    return created.body.handover;
  }

  function submit(handoverId, token = leadToken) {
    return request(app).post(`/api/handovers/${handoverId}/submit`).set(auth(token));
  }

  function approve(handoverId, token = leadToken) {
    return request(app).post(`/api/handovers/${handoverId}/approve`).set(auth(token)).send({});
  }

  async function share(handoverId, token = leadToken) {
    const response = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(token))
      .expect(200);
    return response.body.sharePath.split('/').pop();
  }

  async function askOwnershipGap() {
    const candidates = await request(app)
      .get(`/api/projects/${projectId}/clarifications/candidates`)
      .set(auth(leadToken))
      .expect(200);
    const candidate = candidates.body.candidates.find(
      (entry) => entry.kind === 'missing_owner' && entry.askable && !entry.clarificationId,
    );
    expect(candidate, 'no askable ownership gap in the seed').toBeTruthy();
    const asked = await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ claimIds: [candidate.claimId] })
      .expect(201);
    return asked.body.clarifications[0];
  }

  it('tells every lead about a submitted handover and nobody else', async () => {
    await setRole(observerId, 'lead');
    const handover = await createHandover();

    await submit(handover.id).expect(200);

    expect(await typesFor(observerToken)).toContain('handover.submitted');
    // The submitter does not notify themselves.
    expect(await typesFor(leadToken)).not.toContain('handover.submitted');
    expect(await typesFor(incomingToken)).not.toContain('handover.submitted');
    expect(await typesFor(outgoingToken)).not.toContain('handover.submitted');
  });

  it('tells the author when a lead approves or sends a handover back', async () => {
    const first = await createHandover(incomingId, outgoingToken);
    await submit(first.id, outgoingToken).expect(200);
    await approve(first.id).expect(200);

    const approvedNotice = (await listFor(outgoingToken)).notifications.find(
      (entry) => entry.type === 'handover.approved',
    );
    expect(approvedNotice).toBeTruthy();
    expect(approvedNotice.title).toBe('Your handover was approved');
    expect(await typesFor(incomingToken)).not.toContain('handover.approved');

    const second = await createHandover(incomingId, outgoingToken);
    await submit(second.id, outgoingToken).expect(200);
    await request(app)
      .post(`/api/handovers/${second.id}/reject`)
      .set(auth(leadToken))
      .send({ note: 'Two items need evidence before this can go out.' })
      .expect(200);

    const rejectedNotice = (await listFor(outgoingToken)).notifications.find(
      (entry) => entry.type === 'handover.rejected',
    );
    expect(rejectedNotice).toBeTruthy();
    // The reviewer's note is not copied into the notice.
    expect(JSON.stringify(rejectedNotice)).not.toContain('Two items need evidence');
  });

  it('tells the recipient when a handover is shared, and removes the notice when the link is revoked', async () => {
    const handover = await createHandover();
    await submit(handover.id).expect(200);
    await approve(handover.id).expect(200);
    await share(handover.id);

    const shared = (await listFor(incomingToken)).notifications.find(
      (entry) => entry.type === 'handover.shared',
    );
    expect(shared).toBeTruthy();
    expect(await typesFor(observerToken)).not.toContain('handover.shared');

    await request(app)
      .post(`/api/handovers/${handover.id}/share/revoke`)
      .set(auth(leadToken))
      .send({ reason: 'Recipient changed teams.' })
      .expect(200);

    const afterRevoke = await typesFor(incomingToken);
    expect(afterRevoke).not.toContain('handover.shared');
    expect(afterRevoke).toContain('handover.revoked');
    expect(await Notification.countDocuments({ type: 'handover.shared' })).toBe(0);
  });

  it('does not stack a second notice when the same action is repeated', async () => {
    await setRole(observerId, 'lead');
    const handover = await createHandover(incomingId, outgoingToken);
    await submit(handover.id, outgoingToken).expect(200);
    await submit(handover.id, outgoingToken).expect(200);

    const submitted = (await listFor(observerToken)).notifications.filter(
      (entry) => entry.type === 'handover.submitted',
    );
    expect(submitted).toHaveLength(1);

    await approve(handover.id).expect(200);
    await approve(handover.id).expect(200);
    const approved = (await listFor(outgoingToken)).notifications.filter(
      (entry) => entry.type === 'handover.approved',
    );
    expect(approved).toHaveLength(1);
  });

  it('asks the departing member for an answer and reports it back to the asker and leads', async () => {
    const clarification = await askOwnershipGap();

    expect(await typesFor(outgoingToken)).toContain('clarification.asked');
    expect(await typesFor(observerToken)).not.toContain('clarification.asked');
    expect(await typesFor(leadToken)).not.toContain('clarification.asked');

    await request(app)
      .post(`/api/clarifications/${clarification.id}/answer`)
      .set(auth(outgoingToken))
      .send({ answer: 'Ananya Rao' })
      .expect(200);

    expect(await typesFor(leadToken)).toContain('clarification.answered');
    // The person who answered is not notified about their own answer.
    const outgoingTypes = await typesFor(outgoingToken);
    expect(outgoingTypes).toContain('clarification.asked');
    expect(outgoingTypes).not.toContain('clarification.answered');
  });

  it('tells the asker when a question is declined', async () => {
    const clarification = await askOwnershipGap();
    await request(app)
      .post(`/api/clarifications/${clarification.id}/decline`)
      .set(auth(outgoingToken))
      .send({ note: 'That work moved to another team.' })
      .expect(200);

    expect(await typesFor(leadToken)).toContain('clarification.declined');
  });

  it('notifies a person when they are added or when their role changes', async () => {
    const newMember = seeded.users.find((user) => user.email === OBSERVER);
    await request(app)
      .delete(`/api/projects/${projectId}/members/${newMember.id}`)
      .set(auth(leadToken))
      .expect(200);

    await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email: OBSERVER, role: 'contributor' })
      .expect(201);
    expect(await typesFor(observerToken)).toContain('member.added');

    await setRole(observerId, 'observer');
    const added = (await listFor(observerToken)).notifications.find(
      (entry) => entry.type === 'member.role_changed',
    );
    expect(added).toBeTruthy();
    expect(added.detail).toBe(
      `You now have the observer role on ${seeded.project.name}.`,
    );
    expect(await typesFor(incomingToken)).not.toContain('member.role_changed');
  });

  it('drops a notice when the person loses the access it depended on', async () => {
    await setRole(observerId, 'lead');
    const handover = await createHandover();
    await submit(handover.id).expect(200);
    expect(await typesFor(observerToken)).toContain('handover.submitted');

    await setRole(observerId, 'observer');

    expect(await typesFor(observerToken)).not.toContain('handover.submitted');
    expect(await Notification.countDocuments({ type: 'handover.submitted' })).toBe(0);
  });

  it('marks one notice read, or all of them, without touching other people', async () => {
    for (let index = 0; index < 2; index += 1) {
      const handover = await createHandover();
      await submit(handover.id).expect(200);
      await approve(handover.id).expect(200);
      await share(handover.id);
    }

    const inbox = await listFor(incomingToken);
    expect(inbox.unread).toBe(2);
    const first = inbox.notifications[0];

    await request(app)
      .post(`/api/notifications/${first.id}/read`)
      .set(auth(incomingToken))
      .expect(200);

    const notTheirNotice = await request(app)
      .post(`/api/notifications/${first.id}/read`)
      .set(auth(observerToken))
      .expect(200);
    expect(notTheirNotice.body.changed).toBe(false);

    const partial = await listFor(incomingToken);
    expect(partial.unread).toBe(1);

    const cleared = await request(app)
      .post('/api/notifications/read-all')
      .set(auth(incomingToken))
      .expect(200);
    expect(cleared.body.changed).toBe(1);
    expect((await listFor(incomingToken)).unread).toBe(0);
  });

  it('keeps the payload to a pointer, never a quote or a source name', async () => {
    const handover = await createHandover();
    await submit(handover.id).expect(200);
    await approve(handover.id).expect(200);
    await share(handover.id);

    const response = await request(app)
      .get('/api/notifications')
      .set(auth(incomingToken))
      .expect(200);

    const allowed = new Set([
      'id',
      'type',
      'projectId',
      'projectName',
      'projectKey',
      'createdAt',
      'readAt',
      'title',
      'detail',
      'href',
    ]);
    for (const entry of response.body.notifications) {
      expect(Object.keys(entry).every((key) => allowed.has(key))).toBe(true);
    }

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('handover-notes.txt');
    expect(body).not.toContain('quote');
    expect(body).not.toContain('statement');
  });
});
