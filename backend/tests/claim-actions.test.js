import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, auth, idOf, request, seed, startDb, stopDb, tokenOf } from './helpers.js';

const LEAD = 'subham@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

describe('claim actions from the overview deck', () => {
  let seeded;
  let projectId;
  let leadToken;
  let outgoingToken;
  let observerToken;
  let incomingToken;

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
    observerToken = tokenOf(seeded, OBSERVER);
    incomingToken = tokenOf(seeded, INCOMING);
  });

  function getState(token = leadToken) {
    return request(app).get(`/api/projects/${projectId}/state`).set(auth(token));
  }

  function act(claimId, body, token = leadToken) {
    return request(app)
      .post(`/api/projects/${projectId}/claims/${claimId}/resolve`)
      .set(auth(token))
      .send(body);
  }

  async function auditEvents() {
    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    return audit.body.events;
  }

  it('assigns an owner and clears the ownership gap', async () => {
    const before = await getState().expect(200);
    const gap = before.body.ownershipGaps[0];
    expect(gap).toBeTruthy();

    const ownerName = 'Ananya Rao';
    const result = await act(gap.id, { ownerName }).expect(200);
    expect(result.body.resolved).toBe(true);
    expect(result.body.claim.ownerName).toBe(ownerName);

    const after = await getState().expect(200);
    expect(after.body.ownershipGaps.some((entry) => entry.id === gap.id)).toBe(false);
    expect(after.body.ownershipGaps.length).toBe(before.body.ownershipGaps.length - 1);
    const timeline = after.body.timeline.find((entry) => entry.id === gap.id);
    expect(timeline.ownerName).toBe(ownerName);

    const event = (await auditEvents()).find(
      (entry) => entry.action === 'claim.owner_assigned' && entry.targetId === gap.id,
    );
    expect(event).toBeTruthy();
    expect(event.meta.ownerName).toBe(ownerName);
  });

  it('marks an open task done and drops it from the open work', async () => {
    const before = await getState().expect(200);
    const task = before.body.timeline.find(
      (claim) => claim.type === 'task' && claim.status === 'open',
    );
    expect(task).toBeTruthy();

    await act(task.id, { status: 'done', note: 'Closed out during handover prep' }).expect(200);

    const after = await getState().expect(200);
    const updated = after.body.timeline.find((entry) => entry.id === task.id);
    expect(updated.status).toBe('done');
    const remaining = (after.body.nextActions || []).flatMap((action) => action.claimIds || []);
    expect(remaining).not.toContain(task.id);

    const event = (await auditEvents()).find(
      (entry) => entry.action === 'claim.resolved' && entry.targetId === task.id,
    );
    expect(event).toBeTruthy();
    expect(event.meta.status).toBe('done');
    expect(event.meta.note).toBe('Closed out during handover prep');
  });

  it('answers an open question and removes it from the queue', async () => {
    const before = await getState().expect(200);
    const question = before.body.openQuestions[0];
    expect(question).toBeTruthy();

    await act(question.id, { status: 'resolved', note: 'Finance confirmed the 24-month window' })
      .expect(200);

    const after = await getState().expect(200);
    expect(after.body.openQuestions.some((entry) => entry.id === question.id)).toBe(false);
    expect(after.body.openQuestions.length).toBe(before.body.openQuestions.length - 1);
  });

  it('carries the closure note into a new handover item', async () => {
    const before = await getState().expect(200);
    const question = before.body.openQuestions[0];
    const note = 'Finance confirmed the 24-month retention window';

    await act(question.id, { status: 'resolved', note }).expect(200);

    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId: idOf(seeded, INCOMING), roleTemplate: 'onboarding' })
      .expect(201);

    const item = created.body.handover.items.find(
      (entry) => String(entry.claimId) === question.id,
    );
    expect(item).toBeTruthy();
    expect(item.resolutionNote).toBe(note);
    expect(item.resolutionByName).toBe('Subham Sahu');
  });

  it('records a mitigation for an open risk', async () => {
    const before = await getState().expect(200);
    const risk = before.body.openRisks[0];
    expect(risk).toBeTruthy();

    await act(risk.id, { status: 'resolved', note: 'Vendor questionnaire returned; no gaps' })
      .expect(200);

    const after = await getState().expect(200);
    expect(after.body.openRisks.some((entry) => entry.id === risk.id)).toBe(false);
    expect(after.body.openRisks.length).toBe(before.body.openRisks.length - 1);
  });

  it('lets the outgoing member answer but rejects observers and the incoming member', async () => {
    const before = await getState().expect(200);
    const question = before.body.openQuestions[0];

    await act(question.id, { status: 'resolved', note: 'Answered by the lead' }, observerToken).expect(403);
    await act(question.id, { status: 'resolved' }, incomingToken).expect(403);
    await act(
      question.id,
      { status: 'resolved', note: 'Payments owns it after I leave' },
      outgoingToken,
    ).expect(200);
  });

  it('requires an answer note when resolving a question', async () => {
    const before = await getState().expect(200);
    const question = before.body.openQuestions[0];

    await act(question.id, { status: 'resolved' }).expect(400);
    await act(question.id, { status: 'resolved', note: '   ' }).expect(400);
  });

  it('still lets the incoming member close a task', async () => {
    const before = await getState().expect(200);
    const task = before.body.timeline.find(
      (claim) => claim.type === 'task' && claim.status === 'open',
    );
    expect(task).toBeTruthy();

    await act(task.id, { status: 'done', note: 'Handed over' }, incomingToken).expect(200);
  });

  it('rejects an action with no owner or status', async () => {
    const before = await getState().expect(200);
    const question = before.body.openQuestions[0];

    await act(question.id, {}).expect(400);
    await act(question.id, { note: 'hmm' }).expect(400);
  });

  it('returns 404 for a claim that does not exist', async () => {
    await act('64b7f0c2a1b2c3d4e5f60718', { status: 'done' }).expect(404);
  });
});
