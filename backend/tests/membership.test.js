import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, auth, idOf, request, seed, startDb, stopDb, tokenOf } from './helpers.js';

const LEAD = 'subham@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';

describe('project membership management', () => {
  let seeded;
  let projectId;
  let leadToken;
  let outgoingToken;

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
  });

  function changeRole(userId, role, token = leadToken) {
    return request(app)
      .patch(`/api/projects/${projectId}/members/${userId}`)
      .set(auth(token))
      .send({ role });
  }

  async function auditEvents() {
    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    return audit.body.events;
  }

  it("changes a member's role and applies it on their next request", async () => {
    const outgoingId = idOf(seeded, OUTGOING);
    const before = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(outgoingToken))
      .expect(200);
    const observerBefore = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(tokenOf(seeded, OBSERVER)))
      .expect(200);
    expect(before.body.visibleClaimCount).not.toBe(observerBefore.body.visibleClaimCount);

    const changed = await changeRole(outgoingId, 'observer').expect(200);
    const member = changed.body.project.members.find(
      (entry) => entry.userId === outgoingId,
    );
    expect(member.role).toBe('observer');

    const after = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(outgoingToken))
      .expect(200);
    expect(after.body.visibleClaimCount).toBe(observerBefore.body.visibleClaimCount);

    const claimId = after.body.openQuestions[0]?.id || after.body.timeline[0].id;
    const action = await request(app)
      .post(`/api/projects/${projectId}/claims/${claimId}/resolve`)
      .set(auth(outgoingToken))
      .send({ status: 'resolved' });
    expect(action.status).toBe(403);

    const event = (await auditEvents()).find(
      (entry) => entry.action === 'member.role_changed' && entry.targetId === outgoingId,
    );
    expect(event).toBeTruthy();
    expect(event.meta).toMatchObject({ from: 'contributor', to: 'observer' });
  });

  it('guards who can change roles and which targets are valid', async () => {
    const outgoingId = idOf(seeded, OUTGOING);

    const contributorAttempt = await changeRole(outgoingId, 'observer', outgoingToken);
    expect(contributorAttempt.status).toBe(403);

    const ownerAttempt = await changeRole(idOf(seeded, LEAD), 'observer');
    expect(ownerAttempt.status).toBe(400);

    const invalidRole = await changeRole(outgoingId, 'admin');
    expect(invalidRole.status).toBe(400);

    const registered = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Outsider Account', email: 'outsider@example.com', password: 'Threadline#2026' })
      .expect(201);

    const notMember = await changeRole(registered.body.user.id, 'observer');
    expect(notMember.status).toBe(404);

    const eventsBefore = (await auditEvents()).filter(
      (entry) => entry.action === 'member.role_changed',
    );
    await changeRole(outgoingId, 'contributor').expect(200);
    const eventsAfter = (await auditEvents()).filter(
      (entry) => entry.action === 'member.role_changed',
    );
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
});
