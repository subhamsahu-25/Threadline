import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, app, idOf, request, seed, startDb, stopDb, tokenOf, whenIdle } from './helpers.js';
import { AuditEvent, Claim, Clarification, Evidence, Source } from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const RECIPIENT = 'ananya@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';

describe('clarifications for departing members', () => {
  let seeded;
  let projectId;
  let leadToken;
  let outgoingToken;
  let recipientToken;
  let outgoingId;
  let recipientId;

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
    recipientToken = tokenOf(seeded, RECIPIENT);
    outgoingId = idOf(seeded, OUTGOING);
    recipientId = idOf(seeded, RECIPIENT);
  });

  async function candidates() {
    const response = await request(app)
      .get(`/api/projects/${projectId}/clarifications/candidates`)
      .set(auth(leadToken))
      .expect(200);
    return response.body;
  }

  function firstAskable(list, kind) {
    const candidate = list.find((entry) => entry.kind === kind && entry.askable && !entry.clarificationId);
    expect(candidate, `no askable ${kind} candidate`).toBeTruthy();
    return candidate;
  }

  async function ask(claimIds) {
    const response = await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ claimIds })
      .expect(201);
    return response.body.clarifications[0];
  }

  async function answer(clarificationId, text, token = outgoingToken) {
    return request(app)
      .post(`/api/clarifications/${clarificationId}/answer`)
      .set(auth(token))
      .send({ answer: text });
  }

  async function createLiveHandover() {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId });
    expect(created.status).toBe(201);
    return created.body.handover;
  }

  async function shareHandover(handoverId, claimId) {
    await request(app)
      .patch(`/api/handovers/${handoverId}/items/${claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'accepted', shareWithProject: true })
      .expect(200);
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
    return shared.body.sharePath;
  }

  it('lists askable gaps and their answer options for the departing member', async () => {
    const result = await candidates();
    expect(result.outgoing.name).toBe('Rohan Mehta');
    expect(result.members.some((member) => member.name === 'Ananya Rao')).toBe(true);

    const ownerGap = result.candidates.find(
      (entry) => entry.kind === 'missing_owner' && entry.askable,
    );
    expect(ownerGap.answerOptions.length).toBeGreaterThan(0);
    expect(ownerGap.answerOptions).not.toContain('Rohan Mehta');
    expect(ownerGap.prompt).toContain('after Rohan Mehta leaves');

    expect(result.candidates.some((entry) => entry.kind === 'open_question')).toBe(true);
    expect(result.candidates.some((entry) => entry.kind === 'conflict')).toBe(true);
  });

  it('asks for all gaps once and skips the ones already open', async () => {
    const first = await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ askForAll: true })
      .expect(201);
    expect(first.body.clarifications.length).toBeGreaterThan(1);

    const kinds = new Set(first.body.clarifications.map((entry) => entry.kind));
    expect(kinds.has('missing_owner')).toBe(true);
    expect(kinds.has('open_question')).toBe(true);

    const second = await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ askForAll: true })
      .expect(201);
    expect(second.body.clarifications).toHaveLength(0);
    expect(second.body.skipped.every((entry) => entry.reason === 'already_open')).toBe(true);
  });

  it('T-C1 only the addressee can answer or decline', async () => {
    const ownerGap = firstAskable((await candidates()).candidates, 'missing_owner');
    const clarification = await ask([ownerGap.claimId]);

    const leadAttempt = await answer(clarification.id, 'Ananya', leadToken);
    expect(leadAttempt.status).toBe(403);

    const observerAttempt = await answer(clarification.id, 'Ananya', tokenOf(seeded, OBSERVER));
    expect(observerAttempt.status).toBe(403);

    const decline = await request(app)
      .post(`/api/clarifications/${clarification.id}/decline`)
      .set(auth(leadToken))
      .send({});
    expect(decline.status).toBe(403);

    const inbox = await request(app)
      .get('/api/clarifications?status=open')
      .set(auth(outgoingToken))
      .expect(200);
    expect(inbox.body.clarifications.some((entry) => entry.id === clarification.id)).toBe(true);
  });

  it('T-C2 refuses to ask about an item the departing member cannot read', async () => {
    const ownerGap = firstAskable((await candidates()).candidates, 'missing_owner');
    const claim = await Claim.findById(ownerGap.claimId).lean();
    await Source.updateOne(
      { _id: claim.source },
      { $set: { visibility: { scope: 'roles', roles: ['lead'], users: [] } } },
    );

    const after = await candidates();
    const restricted = after.candidates.find(
      (entry) => entry.kind === 'missing_owner' && entry.claimId === ownerGap.claimId,
    );
    expect(restricted.askable).toBe(false);
    expect(restricted.unaskableReason).toBe('outgoing_member_lacks_access');

    const refused = await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ claimIds: [ownerGap.claimId] });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.reason).toBe('outgoing_member_lacks_access');
  });

  it('T-C3/T-C4 an owner answer creates a person-confirmed claim and clears the gap', async () => {
    const ownerGap = firstAskable((await candidates()).candidates, 'missing_owner');
    const clarification = await ask([ownerGap.claimId]);

    const answered = await answer(clarification.id, 'Ananya');
    expect(answered.status).toBe(200);
    const resultClaimId = answered.body.resultClaimId;

    const original = await Claim.findById(ownerGap.claimId).lean();
    expect(original.ownerName).toBe('Ananya Rao');
    expect(String(original.ownerUser)).toBe(recipientId);

    const personClaim = await Claim.findById(resultClaimId).lean();
    expect(personClaim.origin).toBe('person_confirmed');
    expect(personClaim.verifiedEvidenceCount).toBe(0);
    expect(personClaim.confirmedByName).toBe('Rohan Mehta');
    expect(personClaim.confirmedAt).toBeTruthy();

    const evidence = await Evidence.find({ claim: personClaim._id }).lean();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].validation).toBe('person_confirmed');
    expect(evidence[0].quote).toBe('Ananya');

    const state = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(leadToken))
      .expect(200);
    expect(
      state.body.ownershipGaps.some((entry) => entry.id === ownerGap.claimId),
    ).toBe(false);
    expect(
      state.body.unverified.some((entry) => entry.id === resultClaimId),
    ).toBe(false);

    const actions = await AuditEvent.find({ project: projectId }).lean();
    expect(actions.some((event) => event.action === 'clarification.answered')).toBe(true);
    expect(actions.some((event) => event.action === 'claim.owner_assigned')).toBe(true);
  });

  it('T-C5 the recipient sees the confirmed label, name and date after the lead shares it', async () => {
    const ownerGap = firstAskable((await candidates()).candidates, 'missing_owner');
    const clarification = await ask([ownerGap.claimId]);
    const answered = await answer(clarification.id, 'Ananya');
    expect(answered.status).toBe(200);
    const resultClaimId = answered.body.resultClaimId;

    const handover = await createLiveHandover();
    const item = handover.items.find((entry) => entry.claimId === resultClaimId);
    expect(item).toBeTruthy();
    expect(item.origin).toBe('person_confirmed');
    expect(item.restrictedToRecipient).toBe(true);

    const sharePath = await shareHandover(handover.id, resultClaimId);
    const token = sharePath.split('/').pop();

    const shared = await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(recipientToken))
      .expect(200);
    const delivered = shared.body.handover.items.find((entry) => entry.claimId === resultClaimId);
    expect(delivered).toBeTruthy();
    expect(delivered.origin).toBe('person_confirmed');
    expect(delivered.confirmedByName).toBe('Rohan Mehta');
    expect(delivered.confirmedAt).toBeTruthy();

    const citation = delivered.citations[0];
    const drawer = await request(app)
      .get(`/api/projects/${projectId}/evidence/${citation.evidenceId}`)
      .query({ handover: handover.id })
      .set(auth(recipientToken))
      .expect(200);
    expect(drawer.body.confirmation.answer).toBe('Ananya');
    expect(drawer.body.confirmation.by).toBe('Rohan Mehta');
    expect(drawer.body.context).toBeNull();
  });

  it('T-C6 redaction applies to a person-confirmed answer before sharing', async () => {
    const question = firstAskable((await candidates()).candidates, 'open_question');
    const clarification = await ask([question.claimId]);

    const answered = await answer(
      clarification.id,
      'Yes, but coordinate with ops@example.com before migrating.',
    );
    expect(answered.status).toBe(200);
    const resultClaimId = answered.body.resultClaimId;

    const handover = await createLiveHandover();
    const sharePath = await shareHandover(handover.id, resultClaimId);
    const token = sharePath.split('/').pop();

    const shared = await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(recipientToken))
      .expect(200);
    const delivered = shared.body.handover.items.find((entry) => entry.claimId === resultClaimId);
    expect(delivered).toBeTruthy();
    expect(delivered.statement).toContain('[REDACTED: email]');
    expect(delivered.statement).not.toContain('ops@example.com');
    expect(delivered.citations[0].quote).toContain('[REDACTED: email]');

    const stored = await Clarification.findById(clarification.id).lean();
    expect(stored.status).toBe('answered');
    expect(stored.answer).toContain('[REDACTED: email]');
  });
});
