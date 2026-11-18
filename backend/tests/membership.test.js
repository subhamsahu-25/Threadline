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

  it('adds an existing account and refuses an unknown or duplicate invitation', async () => {
    const duplicate = await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email: OBSERVER, role: 'contributor' });
    expect(duplicate.status).toBe(409);

    const unknown = await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email: 'nobody@example.com', role: 'observer' });
    expect(unknown.status).toBe(404);

    const registered = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New Joiner', email: 'joiner@example.com', password: 'Threadline#2026' })
      .expect(201);

    const added = await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email: 'joiner@example.com', role: 'observer' })
      .expect(201);
    expect(
      added.body.project.members.some(
        (entry) => entry.userId === registered.body.user.id && entry.role === 'observer',
      ),
    ).toBe(true);

    await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(registered.body.token))
      .expect(200);

    const contributorAttempt = await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(outgoingToken))
      .send({ email: 'joiner@example.com', role: 'observer' });
    expect(contributorAttempt.status).toBe(403);

    const event = (await auditEvents()).find(
      (entry) => entry.action === 'member.added' && entry.targetId === registered.body.user.id,
    );
    expect(event).toBeTruthy();
    expect(event.meta.role).toBe('observer');
  });

  it('removes a member and ends their access, but never the owner', async () => {
    const observerId = idOf(seeded, OBSERVER);
    const observerToken = tokenOf(seeded, OBSERVER);
    await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(observerToken))
      .expect(200);

    const contributorAttempt = await request(app)
      .delete(`/api/projects/${projectId}/members/${observerId}`)
      .set(auth(outgoingToken));
    expect(contributorAttempt.status).toBe(403);

    const ownerAttempt = await request(app)
      .delete(`/api/projects/${projectId}/members/${idOf(seeded, LEAD)}`)
      .set(auth(leadToken));
    expect(ownerAttempt.status).toBe(400);

    const removed = await request(app)
      .delete(`/api/projects/${projectId}/members/${observerId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(removed.body.removed).toBe(true);
    const projectAfter = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(
      projectAfter.body.project.members.some((entry) => entry.userId === observerId),
    ).toBe(false);

    await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(observerToken))
      .expect(403);

    const event = (await auditEvents()).find(
      (entry) => entry.action === 'member.removed' && entry.targetId === observerId,
    );
    expect(event).toBeTruthy();
  });
});
