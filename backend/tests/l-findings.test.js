import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditEvent,
  Claim,
  Clarification,
  Document,
  Handover,
  Notification,
  Source,
} from '../src/models/index.js';
import { env } from '../src/config/env.js';
import {
  DEFAULT_READINESS_WEIGHTS,
  reconstructState,
} from '../src/services/reconstruction/state.js';
import {
  app,
  auth,
  idOf,
  registerAndLogin,
  request,
  seed,
  startDb,
  stopDb,
  tokenOf,
  whenIdle,
} from './helpers.js';

const LEAD = 'subham@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const RECIPIENT = 'ananya@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';

describe('logic and API consistency findings L1-L12', () => {
  let seeded;
  let projectId;
  let leadToken;
  let outgoingToken;
  let recipientToken;
  let observerToken;
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
    observerToken = tokenOf(seeded, OBSERVER);
    outgoingId = idOf(seeded, OUTGOING);
    recipientId = idOf(seeded, RECIPIENT);
  });

  async function createHandover(recipient = recipientId, token = leadToken) {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(token))
      .send({ projectId, recipientId: recipient, roleTemplate: 'onboarding' });
    expect(created.status).toBe(201);
    return created.body.handover;
  }

  async function shareHandover(handoverId) {
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
    return shared.body.sharePath.split('/').pop();
  }

  async function addLead(email, name) {
    const registered = await registerAndLogin(email, name, 'Matrix#2026');
    await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email, role: 'lead' })
      .expect(201);
    return registered;
  }

  async function listHandovers(token, query = '') {
    const response = await request(app)
      .get(`/api/handovers?projectId=${projectId}${query}`)
      .set(auth(token))
      .expect(200);
    return response.body.handovers.map((entry) => String(entry.id));
  }

  async function auditEvents() {
    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    return audit.body.events;
  }

  it('L1 applies scope to a project handover list for every role', async () => {
    const mine = await createHandover(recipientId, leadToken);
    const theirs = await createHandover(recipientId, outgoingToken);

    // A lead asking for what they created gets exactly that, not the project.
    expect(await listHandovers(leadToken, '&scope=created')).toEqual([String(mine.id)]);
    expect(await listHandovers(leadToken, '&scope=received')).toEqual([]);
    expect(await listHandovers(leadToken)).toEqual(
      expect.arrayContaining([String(mine.id), String(theirs.id)]),
    );

    // A contributor never sees the lead's draft through an omitted scope.
    expect(await listHandovers(outgoingToken, '&scope=created')).toEqual([
      String(theirs.id),
    ]);
    expect(await listHandovers(outgoingToken, '&scope=received')).toEqual([]);
    expect(await listHandovers(outgoingToken)).toEqual([String(theirs.id)]);
    expect(await listHandovers(outgoingToken, '&scope=all')).toEqual([
      String(theirs.id),
    ]);
  });

  it('L2 rejects an outgoing person who is not a project member', async () => {
    const outsider = await registerAndLogin('l2-outsider@example.test', 'L2 Outsider');

    const rejected = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set(auth(leadToken))
      .send({ transition: { outgoingUserId: outsider.user.id } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('must be a project member');

    const accepted = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set(auth(leadToken))
      .send({ transition: { outgoingUserId: outgoingId } })
      .expect(200);
    expect(accepted.body.project.transition.outgoingUserId).toBe(outgoingId);
  });

  it('L3 removes every live reference when a member leaves', async () => {
    const secondLead = await addLead('l3-lead@example.test', 'L3 Second Lead');
    const handover = await createHandover(outgoingId, leadToken);
    await shareHandover(handover.id);

    // Make the departing person the only explicit audience of one source and
    // leave an unread notice addressed to them.
    const source = await Source.findOne({ project: projectId, deletedAt: null });
    await Source.updateOne(
      { _id: source._id },
      { $set: { visibility: { scope: 'users', roles: [], users: [outgoingId] } } },
    );
    expect(await Notification.countDocuments({ project: projectId, recipient: outgoingId }))
      .toBeGreaterThan(0);

    await request(app)
      .delete(`/api/projects/${projectId}/members/${outgoingId}`)
      .set(auth(secondLead.token))
      .expect(200);

    const afterSource = await Source.findById(source._id).lean();
    expect(afterSource.visibility.users.map(String)).not.toContain(outgoingId);
    expect(
      await Notification.countDocuments({ project: projectId, recipient: outgoingId }),
    ).toBe(0);

    const afterHandover = await Handover.findById(handover.id).lean();
    expect(afterHandover.shareTokenHash).toBeUndefined();
    expect(afterHandover.shareExpiresAt).toBeUndefined();
    expect(afterHandover.revokedAt).toBeTruthy();
    expect(afterHandover.revokedReason).toContain('removed from the project');

    const project = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(project.body.project.transition.outgoingUserId).toBeFalsy();

    // The remaining lead is told that a handover lost a participant, and the
    // notice survives the read-time rebuild instead of being deleted as stale.
    const inbox = await request(app)
      .get('/api/notifications')
      .set(auth(leadToken))
      .expect(200);
    const notice = inbox.body.notifications.find(
      (entry) => entry.type === 'handover.member_left',
    );
    expect(notice).toBeTruthy();
    expect(notice.title).toContain('lost a participant');

    const audit = await auditEvents();
    expect(
      audit.some(
        (event) =>
          event.action === 'handover.share_revoked' &&
          String(event.targetId) === String(handover.id),
      ),
    ).toBe(true);
  });

  it('L4 fails a critical action closed when its audit row cannot be written', async () => {
    const spy = vi.spyOn(AuditEvent, 'create').mockRejectedValueOnce(new Error('audit down'));

    const refused = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set(auth(leadToken))
      .send({ description: 'Should not be confirmed without an audit row.' });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('audit_unavailable');

    spy.mockRestore();

    await request(app)
      .patch(`/api/projects/${projectId}`)
      .set(auth(leadToken))
      .send({ description: 'Confirmed once the log is writable again.' })
      .expect(200);
  });

  it('L4 keeps a routine document view working when its audit row fails', async () => {
    const document = await Document.findOne({ project: projectId, retiredAt: null }).lean();
    expect(document).toBeTruthy();
    const spy = vi.spyOn(AuditEvent, 'create').mockRejectedValueOnce(new Error('audit down'));

    const viewed = await request(app)
      .get(`/api/projects/${projectId}/documents/${document._id}`)
      .set(auth(leadToken))
      .expect(200);
    expect(viewed.body.rawText.length).toBeGreaterThan(0);

    spy.mockRestore();
  });

  it('L5 records a note-only decision and refuses to revive a superseded row', async () => {
    const state = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(leadToken))
      .expect(200);
    const task = state.body.timeline.find((claim) => claim.type === 'task' && claim.status === 'open');

    const noteOnly = await request(app)
      .post(`/api/projects/${projectId}/claims/${task.id}/resolve`)
      .set(auth(leadToken))
      .send({ note: 'Reviewed with finance; no action needed this sprint.' })
      .expect(200);
    expect(noteOnly.body.claim.status).toBe('open');
    expect(noteOnly.body.claim.resolution.note).toContain('Reviewed with finance');

    const audit = await auditEvents();
    expect(
      audit.some(
        (event) =>
          event.action === 'claim.note_added' && String(event.targetId) === String(task.id),
      ),
    ).toBe(true);

    const decision = state.body.timeline.find((claim) => claim.type === 'decision');
    await Claim.updateOne({ _id: decision.id }, { $set: { status: 'superseded' } });

    const revived = await request(app)
      .post(`/api/projects/${projectId}/claims/${decision.id}/resolve`)
      .set(auth(leadToken))
      .send({ status: 'resolved' });
    expect(revived.status).toBe(400);
    expect(revived.body.error.message).toContain('superseded');

    const stored = await Claim.findById(decision.id).lean();
    expect(stored.status).toBe('superseded');
  });

  it('L6 returns populated members when a role change is a no-op', async () => {
    const before = await AuditEvent.countDocuments({
      project: projectId,
      action: 'member.role_changed',
    });

    const response = await request(app)
      .patch(`/api/projects/${projectId}/members/${outgoingId}`)
      .set(auth(leadToken))
      .send({ role: 'contributor' })
      .expect(200);

    const member = response.body.project.members.find(
      (entry) => entry.userId === outgoingId,
    );
    expect(member.role).toBe('contributor');
    expect(member.name).toBe('Rohan Mehta');
    expect(member.email).toBe(OUTGOING);
    expect(
      response.body.project.members.every((entry) => entry.name && entry.email),
    ).toBe(true);

    expect(
      await AuditEvent.countDocuments({
        project: projectId,
        action: 'member.role_changed',
      }),
    ).toBe(before);
  });

  it('L7 hides handover counts from outsiders and shows them to participants', async () => {
    const before = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(observerToken))
      .expect(200);
    expect(typeof before.body.stats.sources).toBe('number');
    expect(before.body.stats.totalSources).toBeUndefined();
    expect(before.body.stats.handovers).toBeUndefined();
    expect(before.body.project.settings).toEqual({ requireSeparateApprover: false });

    const handover = await createHandover(recipientId, leadToken);
    await shareHandover(handover.id);

    const observer = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(observerToken))
      .expect(200);
    expect(observer.body.stats.handovers).toBeUndefined();

    const recipient = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(recipientToken))
      .expect(200);
    expect(recipient.body.stats.handovers).toBeGreaterThanOrEqual(1);

    const lead = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(lead.body.stats.handovers).toBeGreaterThanOrEqual(1);
    expect(typeof lead.body.stats.sharedHandovers).toBe('number');
  });

  it('L8 requires a different lead to approve when the project asks for it', async () => {
    const enabled = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set(auth(leadToken))
      .send({ settings: { requireSeparateApprover: true } })
      .expect(200);
    expect(enabled.body.project.settings.requireSeparateApprover).toBe(true);

    const handover = await createHandover(recipientId, leadToken);
    await request(app)
      .post(`/api/handovers/${handover.id}/submit`)
      .set(auth(leadToken))
      .expect(200);

    const selfApprove = await request(app)
      .post(`/api/handovers/${handover.id}/approve`)
      .set(auth(leadToken))
      .send({});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.message).toContain('different person');

    const secondLead = await addLead('l8-lead@example.test', 'L8 Second Lead');
    const approved = await request(app)
      .post(`/api/handovers/${handover.id}/approve`)
      .set(auth(secondLead.token))
      .send({})
      .expect(200);
    expect(approved.body.handover.status).toBe('approved');
  });

  it('L9 keeps the answer intact and stores a long question as separate context', async () => {
    const candidates = await request(app)
      .get(`/api/projects/${projectId}/clarifications/candidates`)
      .set(auth(leadToken))
      .expect(200);
    const question = candidates.body.candidates.find(
      (entry) => entry.kind === 'open_question' && entry.askable && !entry.clarificationId,
    );
    expect(question).toBeTruthy();

    const longQuestion = `Question: ${'pool '.repeat(500)}`;
    await Claim.updateOne(
      { _id: question.claimId },
      { $set: { statement: longQuestion } },
    );

    const asked = await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ claimIds: [question.claimId] })
      .expect(201);
    const clarification = asked.body.clarifications[0];
    // The prompt quotes a shortened form of the long question; the full text
    // remains on the claim and becomes the answer's context.
    expect(clarification.prompt.length).toBeLessThan(longQuestion.length);

    const answer = (
      'Use "<ledger.v2>" when x < y and y > z. ' + 'detail '.repeat(200)
    )
      .slice(0, 1200)
      .trimEnd();
    const answered = await request(app)
      .post(`/api/clarifications/${clarification.id}/answer`)
      .set(auth(outgoingToken))
      .send({ answer })
      .expect(200);

    const stored = await Clarification.findById(clarification.id).lean();
    expect(stored.answer).toBe(answer);
    expect(stored.answer).toContain('"<ledger.v2>"');
    expect(stored.answer).toContain('x < y and y > z');

    const claim = await Claim.findById(answered.body.resultClaimId).lean();
    expect(claim.statement).toBe(answer);
    expect(claim.statement.length).toBe(answer.length);
    expect(claim.context).toBeTruthy();
    expect(claim.context.length).toBe(2000);
    expect(claim.context.endsWith('\u2026')).toBe(true);
    expect(claim.context).not.toContain('ledger.v2');

    const evidence = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(leadToken))
      .expect(200);
    expect(evidence.status).toBe(200);
  });

  it('L10 only links an owner answer to an eligible person by exact name', async () => {
    const candidates = await request(app)
      .get(`/api/projects/${projectId}/clarifications/candidates`)
      .set(auth(leadToken))
      .expect(200);
    const gap = candidates.body.candidates.find(
      (entry) => entry.kind === 'missing_owner' && entry.askable && !entry.clarificationId,
    );
    expect(gap).toBeTruthy();

    // The offered names match the people who can act on the work.
    expect(gap.answerOptions).toContain('Ananya Rao');
    expect(gap.answerOptions).not.toContain('Vikram Nair');

    const asked = await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ claimIds: [gap.claimId] })
      .expect(201);
    const clarification = asked.body.clarifications[0];

    const observerAnswer = await request(app)
      .post(`/api/clarifications/${clarification.id}/answer`)
      .set(auth(outgoingToken))
      .send({ answer: 'Vikram Nair' });
    expect(observerAnswer.status).toBe(400);
    expect(observerAnswer.body.error.details.options).not.toContain('Vikram Nair');

    const partial = await request(app)
      .post(`/api/clarifications/${clarification.id}/answer`)
      .set(auth(outgoingToken))
      .send({ answer: 'Ana' });
    expect(partial.status).toBe(400);

    const linked = await request(app)
      .post(`/api/clarifications/${clarification.id}/answer`)
      .set(auth(outgoingToken))
      .send({ answer: 'Ananya' })
      .expect(200);
    expect(linked.body.resultClaimId).toBeTruthy();

    const claim = await Claim.findById(gap.claimId).lean();
    // Ownership is what the gap tracks: the answer assigns an accountable
    // person without pretending the underlying task is finished.
    expect(claim.ownerName).toBe('Ananya Rao');
    expect(String(claim.ownerUser)).toBe(recipientId);
  });

  it('L11 folds repeated document opens into one audit row', async () => {
    const document = await Document.findOne({ project: projectId, retiredAt: null }).lean();

    await request(app)
      .get(`/api/projects/${projectId}/documents/${document._id}`)
      .set(auth(leadToken))
      .expect(200);
    await request(app)
      .get(`/api/projects/${projectId}/documents/${document._id}`)
      .set(auth(leadToken))
      .expect(200);

    expect(
      await AuditEvent.countDocuments({
        project: projectId,
        action: 'document.viewed',
        targetId: document._id,
        actor: idOf(seeded, LEAD),
      }),
    ).toBe(1);
  });

  it('L12 applies configured readiness weights and the old-question window', () => {
    expect(env.oldQuestionDays).toBeGreaterThanOrEqual(1);
    expect(env.readinessWeights).toMatchObject(DEFAULT_READINESS_WEIGHTS);

    const oldQuestion = {
      _id: 'question-1',
      type: 'question',
      status: 'open',
      state: 'open',
      statement: 'Who owns drift alerting?',
      topic: 'drift alerting',
      occurredAt: new Date(Date.now() - 20 * 86_400_000),
      hasSourceDate: true,
      origin: 'person_confirmed',
      evidenceCount: 1,
      verifiedEvidenceCount: 1,
      flags: [],
    };

    const defaults = reconstructState({ project: {}, claims: [oldQuestion] });
    expect(defaults.readinessScore).toBe(96);

    const relaxedWindow = reconstructState({
      project: {},
      claims: [oldQuestion],
      oldQuestionDays: 30,
    });
    expect(relaxedWindow.readinessScore).toBe(100);

    const heavier = reconstructState({
      project: {},
      claims: [oldQuestion],
      readinessWeights: { oldQuestion: 10 },
    });
    expect(heavier.readinessScore).toBe(90);
  });
});
