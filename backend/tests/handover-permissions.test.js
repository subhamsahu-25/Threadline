import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  idOf,
  request,
  app,
  seed,
  sourceIdOf,
  startDb,
  stopDb,
  tokenOf,
} from './helpers.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'partho@threadline.demo';
const OUTGOING = 'soumyajit@threadline.demo';
const OBSERVER = 'sabyasachi@threadline.demo';

describe('permission-aware handovers', () => {
  let seeded;
  let projectId;
  let aaravToken;
  let rohanToken;
  let rohanId;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    seeded = await seed();
    projectId = seeded.project.id;
    aaravToken = tokenOf(seeded, LEAD);
    rohanToken = tokenOf(seeded, INCOMING);
    rohanId = idOf(seeded, INCOMING);
  });

  function createHandover({ recipientId = rohanId, roleTemplate = 'onboarding' } = {}) {
    return request(app)
      .post('/api/handovers')
      .set(auth(aaravToken))
      .send({ projectId, recipientId, roleTemplate });
  }

  async function publishHandover(options = {}) {
    const created = await createHandover(options);
    expect(created.status).toBe(201);
    const handoverId = created.body.handover.id;

    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(aaravToken))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(aaravToken))
      .send({})
      .expect(200);
    const shared = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(aaravToken))
      .expect(200);

    return {
      handoverId,
      shareToken: shared.body.sharePath.split('/').pop(),
      draft: created.body.handover,
    };
  }

  it('withholds claims whose evidence the recipient cannot read', async () => {
    const created = await createHandover();
    expect(created.status).toBe(201);

    const handover = created.body.handover;
    expect(handover.items.length).toBeGreaterThan(0);
    expect(handover.withheld.byReason.permissions).toBeGreaterThan(0);
    expect(handover.withheld.total).toBeGreaterThanOrEqual(3);

    const serialized = JSON.stringify(handover);
    expect(serialized).not.toContain('22 percent');
    expect(serialized).not.toContain('negotiation brief for the CFO');

    expect(
      handover.items.some((item) =>
        item.statement.includes('Send the vendor security questionnaire'),
      ),
    ).toBe(true);
  });

  it('keeps a handover hidden from the recipient until it is shared', async () => {
    const created = await createHandover();
    const handoverId = created.body.handover.id;

    const hidden = await request(app)
      .get(`/api/handovers/${handoverId}`)
      .set(auth(rohanToken));
    expect(hidden.status).toBe(403);

    const { shareToken } = await publishHandover();
    const shared = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(rohanToken));
    expect(shared.status).toBe(200);
    expect(shared.body.viewer).toBe('recipient');
    expect(JSON.stringify(shared.body)).not.toContain('22 percent');
    expect(shared.body.handover.permissionRecheck.revokedItems).toBe(0);
  });

  it('re-checks permissions when the recipient opens the handover', async () => {
    const { shareToken } = await publishHandover();

    const before = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(rohanToken))
      .expect(200);
    const beforeCount = before.body.handover.items.length;
    const beforeStatements = before.body.handover.items.map((item) => item.statement);
    expect(beforeStatements.some((statement) => statement.includes('Grafana'))).toBe(true);

    const notesSourceId = sourceIdOf(seeded, 'handover-notes.txt');
    await request(app)
      .patch(`/api/projects/${projectId}/sources/${notesSourceId}`)
      .set(auth(aaravToken))
      .send({ visibility: { scope: 'roles', roles: ['lead'], users: [] } })
      .expect(200);

    const after = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(rohanToken))
      .expect(200);

    expect(after.body.handover.items.length).toBeLessThan(beforeCount);
    expect(after.body.handover.permissionRecheck.revokedItems).toBeGreaterThan(0);
    const afterJson = JSON.stringify(after.body);
    expect(afterJson).not.toContain('Grafana');
    expect(afterJson).not.toContain('vendor security questionnaire');

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(aaravToken))
      .expect(200);
    expect(audit.body.events.map((event) => event.action)).toContain(
      'handover.permissions_rechecked',
    );
  });

  it('builds a role-appropriate executive view without tasks or questions', async () => {
    const created = await createHandover({ roleTemplate: 'executive' });
    expect(created.status).toBe(201);

    const handover = created.body.handover;
    expect(handover.items.some((item) => item.type === 'decision')).toBe(true);
    expect(
      handover.items.some((item) => ['task', 'question', 'responsibility'].includes(item.type)),
    ).toBe(false);
    expect(handover.withheld.byReason.template).toBeGreaterThan(0);
  });

  it('enforces the review permission boundary', async () => {
    const created = await createHandover();
    const handoverId = created.body.handover.id;
    const firstItem = created.body.handover.items[0];

    const byRecipient = await request(app)
      .patch(`/api/handovers/${handoverId}/items/${firstItem.claimId}`)
      .set(auth(rohanToken))
      .send({ decision: 'accepted' });
    expect(byRecipient.status).toBe(403);

    const observerCreate = await request(app)
      .post('/api/handovers')
      .set(auth(tokenOf(seeded, OBSERVER)))
      .send({ projectId, recipientId: rohanId });
    expect(observerCreate.status).toBe(403);

    const outgoingCreate = await request(app)
      .post('/api/handovers')
      .set(auth(tokenOf(seeded, OUTGOING)))
      .send({ projectId, recipientId: idOf(seeded, LEAD) });
    expect(outgoingCreate.status).toBe(201);
  });

  it('rejects handovers created for a non-member', async () => {
    const registered = await request(app).post('/api/auth/register').send({
      email: 'outsider@example.test',
      name: 'Outside Person',
      password: 'Outside#2026',
    });
    expect(registered.status).toBe(201);

    const created = await request(app)
      .post('/api/handovers')
      .set(auth(aaravToken))
      .send({
        projectId,
        recipientId: registered.body.user.id,
        roleTemplate: 'onboarding',
      });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toMatch(/member/i);

    const projectAccess = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(registered.body.token));
    expect(projectAccess.status).toBe(403);
  });
});
