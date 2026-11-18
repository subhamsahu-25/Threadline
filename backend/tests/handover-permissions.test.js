import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  idOf,
  registerAndLogin,
  request,
  app,
  seed,
  sourceIdOf,
  startDb,
  stopDb,
  tokenOf,
  whenIdle,
} from './helpers.js';
import { Handover } from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';

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
    expect(shared.body.handover.permissionRecheck.contentChanged).toBe(false);
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
    expect(after.body.handover.permissionRecheck.contentChanged).toBe(true);
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

  it('does not let the incoming recipient prepare a handover', async () => {
    const byIncoming = await request(app)
      .post('/api/handovers')
      .set(auth(rohanToken))
      .send({ projectId, recipientId: idOf(seeded, OUTGOING) });

    expect(byIncoming.status).toBe(403);
    expect(byIncoming.body.error.message).toMatch(/outgoing team|recipient/i);
  });

  it('limits the incoming recipient to the shared handover and readable sources', async () => {
    const shell = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(rohanToken))
      .expect(200);
    expect(shell.body.project.incoming).toBe(true);
    expect(shell.body.project.canContribute).toBe(false);

    const draft = await createHandover();
    expect(draft.status).toBe(201);

    const drafts = await request(app)
      .get(`/api/handovers?projectId=${projectId}&scope=all`)
      .set(auth(rohanToken))
      .expect(200);
    expect(drafts.body.handovers).toHaveLength(0);

    await request(app).get(`/api/projects/${projectId}/state`).set(auth(rohanToken)).expect(403);
    await request(app).get(`/api/projects/${projectId}/claims`).set(auth(rohanToken)).expect(403);

    const sources = await request(app)
      .get(`/api/projects/${projectId}/sources`)
      .set(auth(rohanToken))
      .expect(200);
    expect(sources.body.sources.length).toBeGreaterThan(0);

    const { handoverId } = await publishHandover();
    const shared = await request(app)
      .get(`/api/handovers?projectId=${projectId}&scope=all`)
      .set(auth(rohanToken))
      .expect(200);
    expect(shared.body.handovers.map((entry) => entry.id)).toEqual([handoverId]);
    // Recipient list entries deliberately omit review and withholding counts.
    expect(shared.body.handovers[0]).not.toHaveProperty('itemCount');
  });

  it('hides a handover the incoming recipient authored before the seat was locked down', async () => {
    const created = await createHandover({ recipientId: idOf(seeded, OBSERVER) });
    expect(created.status).toBe(201);
    const handoverId = created.body.handover.id;
    await Handover.updateOne({ _id: handoverId }, { $set: { createdBy: rohanId } });

    const list = await request(app)
      .get(`/api/handovers?projectId=${projectId}&scope=all`)
      .set(auth(rohanToken))
      .expect(200);
    expect(list.body.handovers).toHaveLength(0);

    await request(app).get(`/api/handovers/${handoverId}`).set(auth(rohanToken)).expect(403);
    await request(app)
      .get(`/api/handovers/${handoverId}/export`)
      .set(auth(rohanToken))
      .expect(403);
    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(rohanToken))
      .expect(403);

    await Handover.updateOne({ _id: handoverId }, { $set: { status: 'approved' } });
    await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(rohanToken))
      .send({})
      .expect(403);
  });

  it('does not leak a lead-only source into a contributor-authored handover', async () => {
    const outgoingToken = tokenOf(seeded, OUTGOING);
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(outgoingToken))
      .send({ projectId, recipientId: idOf(seeded, LEAD), roleTemplate: 'onboarding' });
    expect(created.status).toBe(201);

    const viewed = await request(app)
      .get(`/api/handovers/${created.body.handover.id}`)
      .set(auth(outgoingToken))
      .expect(200);

    const payload = JSON.stringify(viewed.body);
    expect(payload).not.toContain('vendor-contract-summary.md');
    expect(payload).not.toContain('22 percent');
    expect(payload).not.toContain('negotiation brief for the CFO');
    // Counts only cover withheld items the author can read themselves.
    expect(viewed.body.handover.withheld.byReason.author_permissions).toBe(0);
  });

  it('hides review items whose source became recipient-only after composition', async () => {
    const sentinel = 'CANARY-RECIPIENT-ONLY-4417';
    const upload = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(aaravToken))
      .field('name', 'Recipient-only sync')
      .attach(
        'files',
        Buffer.from(
          `# Recipient-only sync\n\nDecision: Use ${sentinel} for the rollout. (date: 2026-10-05, status: active)\n`,
          'utf8',
        ),
        'recipient-only.md',
      );
    expect(upload.status).toBe(202);
    await whenIdle({ timeoutMs: 60_000 });

    const created = await createHandover();
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).toContain(sentinel);

    await request(app)
      .patch(`/api/projects/${projectId}/sources/${upload.body.source.id}`)
      .set(auth(aaravToken))
      .send({ visibility: { scope: 'users', users: [rohanId] } })
      .expect(200);

    const viewed = await request(app)
      .get(`/api/handovers/${created.body.handover.id}`)
      .set(auth(aaravToken))
      .expect(200);

    const payload = JSON.stringify(viewed.body);
    expect(payload).not.toContain(sentinel);
    expect(payload).not.toContain('Recipient-only sync');
    expect(viewed.body.handover.viewerLimits.someItemsHiddenByPermissions).toBe(true);
  });

  it('redacts reviewer edits before they are stored or shown', async () => {
    const created = await createHandover();
    const handoverId = created.body.handover.id;
    const item = created.body.handover.items.find((entry) => entry.citations.length > 0);

    const edited = await request(app)
      .patch(`/api/handovers/${handoverId}/items/${item.claimId}`)
      .set(auth(aaravToken))
      .send({
        decision: 'edited',
        editedStatement: 'Contact priya@example.com for the ledger runbook.',
      })
      .expect(200);

    expect(edited.body.item.statement).toContain('[REDACTED: email]');
    expect(edited.body.item.statement).not.toContain('priya@example.com');
  });

  it('redacts handover evidence for the recipient and keeps the highlight aligned', async () => {
    const secret = 'sk-live-abc123def456ghi789jkl012';
    const upload = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(aaravToken))
      .field('name', 'Credential rotation')
      .attach(
        'files',
        Buffer.from(
          `# Credential rotation\n\nDecision: Rotate API_KEY=${secret} before handover. (date: 2026-10-06, status: active)\n`,
          'utf8',
        ),
        'credentials.md',
      );
    expect(upload.status).toBe(202);
    await whenIdle({ timeoutMs: 60_000 });

    const { handoverId, shareToken } = await publishHandover();
    const view = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(rohanToken))
      .expect(200);

    const item = view.body.handover.items.find((entry) =>
      (entry.citations || []).some((citation) => citation.quote.includes('[REDACTED:')),
    );
    expect(item).toBeTruthy();

    const citation = item.citations.find((entry) => entry.quote.includes('[REDACTED:'));

    const evidence = await request(app)
      .get(
        `/api/projects/${projectId}/evidence/${citation.evidenceId}?handover=${handoverId}`,
      )
      .set(auth(rohanToken))
      .expect(200);

    const payload = JSON.stringify(evidence.body);
    expect(payload).not.toContain(secret);
    expect(evidence.body.evidence.quote).toContain('[REDACTED:');
    expect(evidence.body.redactions.count).toBeGreaterThan(0);
    expect(
      evidence.body.context.slice(
        evidence.body.highlight.start,
        evidence.body.highlight.end,
      ),
    ).toBe(evidence.body.evidence.quote);
  });

  it('rejects handovers created for a non-member', async () => {
    const outsider = await registerAndLogin(
      'outsider@example.test',
      'Outside Person',
      'Outside#2026',
    );

    const created = await request(app)
      .post('/api/handovers')
      .set(auth(aaravToken))
      .send({
        projectId,
        recipientId: outsider.user.id,
        roleTemplate: 'onboarding',
      });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toMatch(/member/i);

    const projectAccess = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(outsider.token));
    expect(projectAccess.status).toBe(403);
  });

  it('hides every handover route from a non-member behind the same 404', async () => {
    const outsider = await registerAndLogin(
      'outsider@example.test',
      'Outside Person',
      'Outside#2026',
    );
    const outsiderToken = outsider.token;

    const draft = await createHandover();
    expect(draft.status).toBe(201);
    const draftId = draft.body.handover.id;

    const published = await publishHandover();
    const randomId = '64b000000000000000000000';

    const routes = [
      ['get', '', undefined],
      ['get', '/export', undefined],
      ['get', '/feedback', undefined],
      ['post', '/feedback', { message: 'Please check this item' }],
      ['patch', '/items/000000000000000000000000', { decision: 'accepted', note: 'ok' }],
      ['post', '/submit', undefined],
      ['post', '/approve', {}],
      ['post', '/reject', { note: 'no' }],
      ['post', '/reopen', undefined],
      ['get', '/freshness', undefined],
      ['post', '/regenerate', undefined],
      ['post', '/share', {}],
      ['post', '/share/revoke', {}],
      ['post', '/acknowledge', undefined],
      ['get', '/versions', undefined],
      ['get', '/versions/1', undefined],
      ['get', '/deliveries', undefined],
    ];

    for (const handoverId of [draftId, published.handoverId]) {
      for (const [method, suffix, body] of routes) {
        const real = await request(app)
          [method](`/api/handovers/${handoverId}${suffix}`)
          .set(auth(outsiderToken))
          .send(body);
        const missing = await request(app)
          [method](`/api/handovers/${randomId}${suffix}`)
          .set(auth(outsiderToken))
          .send(body);

        expect(real.status, `${method.toUpperCase()} ${suffix}`).toBe(404);
        expect(real.body, `${method.toUpperCase()} ${suffix}`).toEqual(missing.body);
      }
    }
  });
});
