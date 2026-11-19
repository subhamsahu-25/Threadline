import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Claim,
  Clarification,
  Document,
  Evidence,
  Project,
  Source,
} from '../src/models/index.js';
import { app, auth, registerAndLogin, request, startDb, stopDb } from './helpers.js';

const LEAD = 'lead@n11.test';
const OUTGOING = 'outgoing@n11.test';

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

async function makeClarification(project, claim, leadUser, outgoingUser, prompt) {
  return Clarification.create({
    project: project._id,
    claim: claim._id,
    kind: 'open_question',
    prompt,
    status: 'open',
    askedBy: leadUser.user.id,
    askedByName: leadUser.user.name,
    askedOf: outgoingUser.user.id,
    askedOfName: outgoingUser.user.name,
    answerOptions: [],
    answerOptionClaimIds: [],
  });
}

async function simulateCrashHalfway(project, clarification) {
  const source = await Source.create({
    project: project._id,
    kind: 'confirmation',
    name: 'Confirmed answer',
    externalRef: String(clarification._id),
    visibility: { scope: 'users', roles: [], users: [] },
    sensitivity: 'internal',
    status: 'ready',
    createdBy: clarification.askedBy,
  });
  const document = await Document.create({
    project: project._id,
    source: source._id,
    kind: 'confirmation',
    title: 'Half-written answer',
    path: `clarification-${clarification._id}`,
    rawText: 'half-written',
    chunks: [{ index: 0, text: 'half-written', start: 0, end: 12 }],
  });
  const claim = await Claim.create({
    project: project._id,
    source: source._id,
    document: document._id,
    type: 'decision',
    statement: 'half-written answer',
    statementKey: 'half-written answer',
    topic: 'release cadence',
    topicKey: 'release cadence',
    status: 'active',
    occurredAt: new Date(),
    hasSourceDate: true,
    sensitivity: 'internal',
  });
  await Evidence.create({
    project: project._id,
    claim: claim._id,
    source: source._id,
    document: document._id,
    chunkId: document.chunks[0]._id,
    quote: 'half-written',
    charStart: 0,
    charEnd: 12,
  });

  await Clarification.updateOne(
    { _id: clarification._id },
    {
      $set: {
        status: 'answering',
        answeringAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    },
  );

  return { source, document, claim };
}

describe('stuck "answering" clarification recovery', () => {
  let lead;
  let outgoing;
  let project;
  let projectId;
  let openClaim;

  beforeAll(async () => {
    await startDb();
    lead = await registerAndLogin(LEAD, 'Lead N11');
    outgoing = await registerAndLogin(OUTGOING, 'Outgoing N11');

    const created = await request(app)
      .post('/api/projects')
      .set(auth(lead.token))
      .send({
        key: 'N11',
        name: 'Answer recovery',
        members: [{ email: OUTGOING, role: 'contributor' }],
        transition: {
          outgoingUserId: outgoing.user.id,
          outgoingName: outgoing.user.name,
        },
      });
    expect(created.status).toBe(201);
    projectId = created.body.project.id;
    project = await Project.findById(projectId);

    const source = await Source.create({
      project: project._id,
      kind: 'upload',
      name: 'Release notes',
      status: 'ready',
      createdBy: lead.user.id,
      visibility: { scope: 'project', roles: [], users: [] },
      sensitivity: 'internal',
    });
    openClaim = await makeClaim(project, source, 'Release every second Friday.');
  });

  afterAll(async () => {
    await stopDb();
  });

  it('re-opens a stale answering row on read and removes the half-created confirmation', async () => {
    const clarification = await makeClarification(
      project,
      openClaim,
      lead,
      outgoing,
      'Who signs off the release?',
    );
    const half = await simulateCrashHalfway(project, clarification);

    const listed = await request(app)
      .get(`/api/clarifications?projectId=${projectId}`)
      .set(auth(lead.token))
      .expect(200);
    const view = listed.body.clarifications.find((entry) => entry.id === String(clarification._id));
    expect(view.status).toBe('open');

    expect(await Source.countDocuments({ _id: half.source._id })).toBe(0);
    expect(await Document.countDocuments({ _id: half.document._id })).toBe(0);
    expect(await Claim.countDocuments({ _id: half.claim._id })).toBe(0);
    expect(await Evidence.countDocuments({ source: half.source._id })).toBe(0);

    const answered = await request(app)
      .post(`/api/clarifications/${clarification._id}/answer`)
      .set(auth(outgoing.token))
      .send({ answer: 'The release manager signs off.' })
      .expect(200);
    expect(answered.body.clarification.status).toBe('answered');
  });

  it('leaves a fresh in-flight answer alone', async () => {
    const clarification = await makeClarification(
      project,
      openClaim,
      lead,
      outgoing,
      'Who updates the changelog?',
    );
    await Clarification.updateOne(
      { _id: clarification._id },
      { $set: { status: 'answering', answeringAt: new Date() } },
    );

    const listed = await request(app)
      .get(`/api/clarifications?projectId=${projectId}`)
      .set(auth(lead.token))
      .expect(200);
    const view = listed.body.clarifications.find((entry) => entry.id === String(clarification._id));
    expect(view.status).toBe('answering');

    const retry = await request(app)
      .post(`/api/clarifications/${clarification._id}/answer`)
      .set(auth(outgoing.token))
      .send({ answer: 'The release manager does.' })
      .expect(409);
    expect(retry.body.error.code).toBe('conflict');
  });

  it('recovers legacy rows that have no answeringAt timestamp', async () => {
    const clarification = await makeClarification(
      project,
      openClaim,
      lead,
      outgoing,
      'Who owns the checklist?',
    );
    await Clarification.collection.updateOne(
      { _id: clarification._id },
      {
        $set: {
          status: 'answering',
          updatedAt: new Date(Date.now() - 10 * 60 * 1000),
        },
        $unset: { answeringAt: '' },
      },
    );

    const mine = await request(app)
      .get('/api/clarifications')
      .set(auth(outgoing.token))
      .expect(200);
    const view = mine.body.clarifications.find((entry) => entry.id === String(clarification._id));
    expect(view.status).toBe('open');
  });
});
