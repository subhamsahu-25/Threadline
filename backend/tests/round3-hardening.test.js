import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, idOf, app, request, seed, startDb, stopDb, tokenOf } from './helpers.js';
import {
  Claim,
  Document,
  Evidence,
  Handover,
  Project,
  Source,
} from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';
const OTHER = 'rohan@threadline.demo';

describe('round 3 hardenings', () => {
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

  async function createDraft({ template = 'onboarding', recipientId = incomingId } = {}) {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId, roleTemplate: template });
    expect(created.status).toBe(201);
    return created.body.handover;
  }

  async function approve(handoverId) {
    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(leadToken))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(leadToken))
      .send({})
      .expect(200);
  }

  async function share(handoverId) {
    const shared = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(leadToken))
      .expect(200);
    return shared.body.sharePath.split('/').pop();
  }

  async function createShared(options) {
    const handover = await createDraft(options);
    await approve(handover.id);
    const token = await share(handover.id);
    return { handover, token };
  }

  it('refreshes item status and owner from live claims for the recipient', async () => {
    const { handover, token } = await createShared();
    const item = handover.items.find((entry) => entry.decision === 'accepted');
    expect(item).toBeTruthy();

    await Claim.updateOne(
      { _id: item.claimId },
      { $set: { status: 'done', ownerName: 'Ananya Rao' } },
    );

    const viewed = await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(incomingToken))
      .expect(200);

    const live = viewed.body.handover.items.find(
      (entry) => entry.claimId === item.claimId,
    );
    expect(live.status).toBe('done');
    expect(live.ownerName).toBe('Ananya Rao');
    expect(live.changedSinceApproval).toBe(true);
    expect(live.previousStatus).toBe(item.status);
    expect(viewed.body.handover.permissionRecheck.contentChanged).toBe(true);
    // The recipient is told that something changed, never how many items that
    // count covers: a number would describe content they may not read.
    expect(viewed.body.handover.permissionRecheck).not.toHaveProperty('changedItemCount');
    expect(viewed.body.handover.permissionRecheck).not.toHaveProperty('removed');
  });

  it('purges source content on delete and reports source_removed to the recipient', async () => {
    const { handover, token } = await createShared();
    const item = handover.items.find(
      (entry) => entry.decision === 'accepted' && (entry.citations || []).length > 0,
    );
    expect(item).toBeTruthy();
    const sourceId = item.citations[0].sourceId;

    const deleted = await request(app)
      .delete(`/api/projects/${projectId}/sources/${sourceId}`)
      .set(auth(leadToken))
      .expect(200);
    expect(deleted.body.purged).toBe(true);
    expect(deleted.body.documents).toBeGreaterThan(0);
    expect(deleted.body.evidence).toBeGreaterThan(0);

    const sourceDocs = await Document.countDocuments({ source: sourceId });
    expect(sourceDocs).toBe(0);
    const sourceEvidence = await Evidence.countDocuments({ source: sourceId });
    expect(sourceEvidence).toBe(0);
    const retired = await Claim.countDocuments({ source: sourceId, retiredAt: null });
    expect(retired).toBe(0);

    const viewed = await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(incomingToken))
      .expect(200);
    expect(
      viewed.body.handover.items.some((entry) => entry.claimId === item.claimId),
    ).toBe(false);
    expect(viewed.body.handover.permissionRecheck.contentChanged).toBe(true);
    expect(viewed.body.handover.permissionRecheck).not.toHaveProperty('removed');
  });

  it('compares an approved handover with current state and regenerates it', async () => {
    const { handover, token } = await createShared();
    const item = handover.items.find((entry) => entry.decision === 'accepted');

    await Claim.updateOne({ _id: item.claimId }, { $set: { status: 'done' } });

    const compared = await request(app)
      .get(`/api/handovers/${handover.id}/freshness`)
      .set(auth(leadToken))
      .expect(200);
    expect(compared.body.comparison.changed).toBe(true);
    expect(compared.body.comparison.counts.updated).toBeGreaterThan(0);
    const entry = compared.body.comparison.changes.find(
      (change) => change.claimId === item.claimId,
    );
    expect(entry.change).toBe('updated');
    expect(entry.fields.some((field) => field.field === 'status')).toBe(true);

    const regenerated = await request(app)
      .post(`/api/handovers/${handover.id}/regenerate`)
      .set(auth(leadToken))
      .expect(200);
    // The recipient keeps the shared version until the replacement is
    // approved; regeneration must not replace or revoke it in place.
    expect(regenerated.body.createdNew).toBe(true);
    expect(regenerated.body.handover.id).not.toBe(handover.id);
    expect(regenerated.body.handover.status).toBe('draft');
    expect(regenerated.body.carried).toBeGreaterThan(0);

    const liveLink = await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(incomingToken));
    expect(liveLink.status).toBe(200);
    expect(liveLink.body.handover.id).toBe(handover.id);

    const versions = await request(app)
      .get(`/api/handovers/${regenerated.body.handover.id}/versions`)
      .set(auth(leadToken))
      .expect(200);
    expect(
      versions.body.versions.some((version) =>
        version.reason.startsWith('regenerated from'),
      ),
    ).toBe(true);
  });

  it('stores only a hash of the share token and revokes links', async () => {
    const { handover, token } = await createShared();

    const stored = await Handover.findById(handover.id).lean();
    expect(stored.shareToken).toBeUndefined();
    expect(stored.shareTokenHash).toHaveLength(64);
    expect(stored.shareTokenHash).not.toBe(token);

    const revoked = await request(app)
      .post(`/api/handovers/${handover.id}/share/revoke`)
      .set(auth(leadToken))
      .send({ reason: 'Link was forwarded to the wrong person' })
      .expect(200);
    expect(revoked.body.handover.shareActive).toBe(false);
    expect(revoked.body.handover.shareRevokedReason).toBe(
      'Link was forwarded to the wrong person',
    );

    await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(incomingToken))
      .expect(404);

    // The signed-in route must close too; otherwise revoking the link only
    // hides the token while the recipient keeps reading the same handover.
    await request(app)
      .get(`/api/handovers/${handover.id}`)
      .set(auth(incomingToken))
      .expect(403);
    await request(app)
      .post(`/api/handovers/${handover.id}/acknowledge`)
      .set(auth(incomingToken))
      .expect(403);

    const repeated = await request(app)
      .post(`/api/handovers/${handover.id}/share/revoke`)
      .set(auth(leadToken));
    expect(repeated.status).toBe(200);
    expect(repeated.body.idempotent).toBe(true);
  });

  it('closes the recipient route when the share link expires', async () => {
    const { handover, token } = await createShared();

    await Handover.updateOne(
      { _id: handover.id },
      { $set: { shareExpiresAt: new Date(Date.now() - 60_000) } },
    );

    await request(app)
      .get(`/api/handovers/${handover.id}`)
      .set(auth(incomingToken))
      .expect(403);
    await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(incomingToken))
      .expect(410);
  });

  it('requires a second person to approve when maker-checker is enabled', async () => {
    const project = await Project.findById(projectId);
    project.settings = { requireSeparateApprover: true };
    project.members = project.members.map((member) =>
      String(member.user) === idOf(seeded, OTHER)
        ? { ...member.toObject(), role: 'lead' }
        : member,
    );
    await project.save();

    const handover = await createDraft();
    await request(app)
      .post(`/api/handovers/${handover.id}/submit`)
      .set(auth(leadToken))
      .expect(200);

    const selfApproval = await request(app)
      .post(`/api/handovers/${handover.id}/approve`)
      .set(auth(leadToken))
      .send({});
    expect(selfApproval.status).toBe(403);

    await request(app)
      .post(`/api/handovers/${handover.id}/approve`)
      .set(auth(tokenOf(seeded, OTHER)))
      .send({})
      .expect(200);
  });

  it('requires a note when accepting an item with no verified evidence', async () => {
    const handover = await createDraft();
    const item = handover.items.find((entry) => entry.decision === 'accepted') ||
      handover.items[0];

    const doc = await Handover.findById(handover.id);
    const target = doc.items.find((entry) => String(entry.claimId) === String(item.claimId));
    target.citations = [];
    await doc.save();

    const rejected = await request(app)
      .patch(`/api/handovers/${handover.id}/items/${item.claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'accepted' });
    expect(rejected.status).toBe(400);

    const accepted = await request(app)
      .patch(`/api/handovers/${handover.id}/items/${item.claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'accepted', note: 'Confirmed verbally with the outgoing owner.' })
      .expect(200);
    const updated = accepted.body.item;
    expect(updated.acceptedWithoutEvidence).toBe(true);
  });

  it('records what the recipient actually acknowledged', async () => {
    const { handover, token } = await createShared();

    const acknowledged = await request(app)
      .post(`/api/handovers/${handover.id}/acknowledge`)
      .set(auth(incomingToken))
      .expect(200);
    const snapshot = acknowledged.body.handover.acknowledgement;
    expect(snapshot.shownItemIds.length).toBeGreaterThan(0);
    expect(snapshot.version).toBe(4);
    expect(Object.keys(snapshot.statementHashes)).toHaveLength(snapshot.shownItemIds.length);

    const versions = await request(app)
      .get(`/api/handovers/${handover.id}/versions`)
      .set(auth(leadToken))
      .expect(200);
    const before = versions.body.versions.length;
    await request(app)
      .post(`/api/handovers/${handover.id}/acknowledge`)
      .set(auth(incomingToken))
      .expect(200);
    const after = await request(app)
      .get(`/api/handovers/${handover.id}/versions`)
      .set(auth(leadToken))
      .expect(200);
    expect(after.body.versions.length).toBe(before);

    await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(incomingToken))
      .expect(200);
  });

  it('revokes only the signing-out session, and logout-all ends every session', async () => {
    const first = await request(app)
      .post('/api/demo/session')
      .send({ email: INCOMING })
      .expect(200);
    const second = await request(app)
      .post('/api/demo/session')
      .send({ email: INCOMING })
      .expect(200);

    await request(app).get('/api/auth/me').set(auth(first.body.token)).expect(200);
    await request(app).post('/api/auth/logout').set(auth(first.body.token)).expect(200);
    await request(app).get('/api/auth/me').set(auth(first.body.token)).expect(401);
    await request(app).get('/api/auth/me').set(auth(second.body.token)).expect(200);

    await request(app).post('/api/auth/logout-all').set(auth(second.body.token)).expect(200);
    await request(app).get('/api/auth/me').set(auth(second.body.token)).expect(401);
    await request(app).get('/api/auth/me').set(auth(incomingToken)).expect(401);
  });

  it('gives executive and audit handovers distinct scopes', async () => {
    const executive = await createDraft({ template: 'executive' });
    const executiveTypes = new Set(executive.items.map((item) => item.type));
    expect([...executiveTypes].every((type) => ['decision', 'milestone', 'risk'].includes(type))).toBe(
      true,
    );
    expect(executive.withheld.byReason.template).toBeGreaterThan(0);

    const audit = await createDraft({ template: 'audit' });
    const auditTypes = new Set(audit.items.map((item) => item.type));
    expect([...auditTypes].every((type) => ['decision', 'risk'].includes(type))).toBe(true);
    expect(audit.snapshot.templateFocus).toContain('Redaction summary');
  });

  it('adds a first-week view for the recipient', async () => {
    const { token } = await createShared();
    const viewed = await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(incomingToken))
      .expect(200);
    const firstWeek = viewed.body.handover.firstWeek;
    expect(firstWeek.windowDays).toBe(7);
    expect(Array.isArray(firstWeek.youOwn)).toBe(true);
    expect(Array.isArray(firstWeek.blocked)).toBe(true);
    expect(firstWeek.doFirst.length).toBeLessThanOrEqual(3);
    expect(firstWeek.doFirst.every((entry) => entry.inferred)).toBe(true);
  });

  it('exposes a readable diff for each version', async () => {
    const handover = await createDraft();
    const item = handover.items.find((entry) => entry.decision === 'accepted');
    await request(app)
      .patch(`/api/handovers/${handover.id}/items/${item.claimId}`)
      .set(auth(leadToken))
      .send({ decision: 'rejected', note: 'Superseded by the later decision.' })
      .expect(200);

    const diff = await request(app)
      .get(`/api/handovers/${handover.id}/versions/2`)
      .set(auth(leadToken))
      .expect(200);
    expect(diff.body.diff.previousVersion).toBe(1);
    expect(diff.body.diff.counts.updated).toBe(1);
    const change = diff.body.diff.changes.find(
      (entry) => entry.claimId === item.claimId,
    );
    expect(change.change).toBe('updated');
    expect(change.fields.some((field) => field.field === 'decision')).toBe(true);
    expect(diff.body.diff.reason).toContain('rejected');
  });
});
