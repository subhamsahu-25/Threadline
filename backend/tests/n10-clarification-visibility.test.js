import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Claim, Clarification, Document, Evidence, Source } from '../src/models/index.js';
import { app, auth, registerAndLogin, request, startDb, stopDb } from './helpers.js';

const LEAD = 'lead@n10.test';
const OUTGOING = 'outgoing@n10.test';

async function makeClaim(project, source, statement) {
  const claim = await Claim.create({
    project: project._id,
    source: source._id,
    type: 'decision',
    statement,
    statementKey: statement.toLowerCase(),
    topic: 'release cadence',
    topicKey: 'release cadence',
    status: 'active',
    occurredAt: new Date('2026-10-01T00:00:00Z'),
    hasSourceDate: true,
    sensitivity: 'internal',
  });
  // A claim is visible only through evidence that resolves to a readable
  // source, so the fixture has to look like an ingested claim.
  const document = await Document.create({
    project: project._id,
    source: source._id,
    kind: 'upload',
    title: source.name,
    path: `${source.name}.txt`,
    rawText: statement,
    chunks: [{ index: 0, text: statement, start: 0, end: statement.length }],
  });
  await Evidence.create({
    project: project._id,
    claim: claim._id,
    source: source._id,
    document: document._id,
    chunkId: document.chunks[0]._id,
    quote: statement,
    charStart: 0,
    charEnd: statement.length,
  });
  return claim;
}

describe('multi-claim clarification visibility', () => {
  let lead;
  let outgoing;
  let projectId;
  let clarificationId;
  let controlId;

  beforeAll(async () => {
    await startDb();
    lead = await registerAndLogin(LEAD, 'Lead N10');
    outgoing = await registerAndLogin(OUTGOING, 'Outgoing N10');

    const created = await request(app)
      .post('/api/projects')
      .set(auth(lead.token))
      .send({
        key: 'N10',
        name: 'Clarification visibility',
        members: [{ email: OUTGOING, role: 'contributor' }],
        transition: {
          outgoingUserId: outgoing.user.id,
          outgoingName: outgoing.user.name,
        },
      });
    expect(created.status).toBe(201);
    projectId = created.body.project.id;
    const project = await (await import('../src/models/index.js')).Project.findById(projectId);

    const openSource = await Source.create({
      project: project._id,
      kind: 'upload',
      name: 'Open notes',
      status: 'ready',
      createdBy: lead.user.id,
      visibility: { scope: 'project', roles: [], users: [] },
      sensitivity: 'internal',
    });
    const restrictedSource = await Source.create({
      project: project._id,
      kind: 'upload',
      name: 'Leadership notes',
      status: 'ready',
      createdBy: lead.user.id,
      visibility: { scope: 'roles', roles: ['lead'], users: [] },
      sensitivity: 'confidential',
    });

    const openClaim = await makeClaim(project, openSource, 'Release every second Friday.');
    const hiddenClaim = await makeClaim(project, restrictedSource, 'Release every Thursday.');

    const clarification = await Clarification.create({
      project: project._id,
      claim: openClaim._id,
      kind: 'conflict',
      prompt: 'Which release cadence is current?',
      status: 'open',
      askedBy: lead.user.id,
      askedByName: lead.user.name,
      askedOf: outgoing.user.id,
      askedOfName: outgoing.user.name,
      answerOptions: [openClaim.statement, hiddenClaim.statement],
      answerOptionClaimIds: [openClaim._id, hiddenClaim._id],
    });
    clarificationId = String(clarification._id);

    const control = await Clarification.create({
      project: project._id,
      claim: openClaim._id,
      kind: 'open_question',
      prompt: 'Who owns the release checklist?',
      status: 'open',
      askedBy: lead.user.id,
      askedByName: lead.user.name,
      askedOf: outgoing.user.id,
      askedOfName: outgoing.user.name,
      answerOptions: [openClaim.statement],
      answerOptionClaimIds: [openClaim._id],
    });
    controlId = String(control._id);
  });

  afterAll(async () => {
    await stopDb();
  });

  it('hides a question whose options quote a decision the viewer cannot read', async () => {
    const asLead = await request(app)
      .get(`/api/clarifications?projectId=${projectId}`)
      .set(auth(lead.token))
      .expect(200);
    const leadView = asLead.body.clarifications.find((entry) => entry.id === clarificationId);
    expect(leadView.restricted).toBe(false);
    expect(leadView.answerOptions).toHaveLength(2);

    const asOutgoing = await request(app)
      .get(`/api/clarifications?projectId=${projectId}`)
      .set(auth(outgoing.token))
      .expect(200);
    const hidden = asOutgoing.body.clarifications.find((entry) => entry.id === clarificationId);
    expect(hidden.restricted).toBe(true);
    expect(hidden.answerOptions).toEqual([]);
    expect(hidden.prompt).not.toContain('Thursday');
    expect(hidden.answer).toBeNull();

    const control = asOutgoing.body.clarifications.find((entry) => entry.id === controlId);
    expect(control.restricted).toBe(false);
    expect(control.answerOptions).toEqual(['Release every second Friday.']);
  });

  it('applies the same filter to the personal question list', async () => {
    const mine = await request(app)
      .get('/api/clarifications')
      .set(auth(outgoing.token))
      .expect(200);
    const hidden = mine.body.clarifications.find((entry) => entry.id === clarificationId);
    expect(hidden.restricted).toBe(true);
    expect(hidden.answerOptions).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain('Thursday');
  });
});
