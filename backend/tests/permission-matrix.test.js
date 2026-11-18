import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  idOf,
  request,
  app,
  seed,
  startDb,
  stopDb,
  tokenOf,
  whenIdle,
} from './helpers.js';
import { Claim, Document, Evidence, Handover, Project, Source } from '../src/models/index.js';
import { claimVisibleTo, sourceVisibleTo } from '../src/services/access/policy.js';

const LEAD = 'subham@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const RECIPIENT = 'ananya@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';

const CANARY = {
  leadOnly: 'CANARY-LEADONLY-7731',
  recipientOnly: 'CANARY-RECIPIENT-4472',
  roleExcluded: 'CANARY-ROLE-EXCLUDED-3350',
  deleted: 'CANARY-DELETED-6621',
  confidential: 'CANARY-CONFIDENTIAL-9184',
};

const CANARY_VALUES = Object.values(CANARY);

/**
 * Role-by-surface matrix. Every canary lives in a source name, a document
 * title, an extracted statement and a citation quote, so a single leaked
 * string anywhere in a serialised response is enough to fail the cell.
 */
describe('permission canary matrix', () => {
  let projectId;
  let project;
  let tokens;
  let userIds;
  let fixtures;
  let handover;

  beforeAll(async () => {
    await startDb();
    const seeded = await seed();
    projectId = seeded.project.id;

    tokens = {
      lead: tokenOf(seeded, LEAD),
      outgoing: tokenOf(seeded, OUTGOING),
      recipient: tokenOf(seeded, RECIPIENT),
      observer: tokenOf(seeded, OBSERVER),
    };
    userIds = {
      lead: idOf(seeded, LEAD),
      outgoing: idOf(seeded, OUTGOING),
      recipient: idOf(seeded, RECIPIENT),
      observer: idOf(seeded, OBSERVER),
    };

    const contributor = await register('matrix-contributor@example.test', 'Matrix Contributor');
    const secondLead = await register('matrix-lead@example.test', 'Matrix Second Lead');
    const outsider = await register('matrix-outsider@example.test', 'Matrix Outsider');
    tokens.contributor = contributor.token;
    tokens.secondLead = secondLead.token;
    tokens.outsider = outsider.token;
    userIds.contributor = contributor.user.id;
    userIds.secondLead = secondLead.user.id;
    userIds.outsider = outsider.user.id;

    await addMember(contributor.user.email, 'contributor');
    await addMember(secondLead.user.email, 'lead');

    fixtures = await createCanaries();
    handover = await publishHandover();
  });

  afterAll(async () => {
    await stopDb();
  });

  it('keeps every canary out of every surface before any access change', async () => {
    await assertMatrix();
  });

  it('re-checks every surface after role access is revoked', async () => {
    await patchVisibility(fixtures.roleExcluded.sourceId, {
      scope: 'roles',
      roles: ['lead'],
      users: [],
    });
    await assertMatrix();

    const shared = await request(app)
      .get(`/api/handovers/shared/${handover.token}`)
      .set(auth(tokens.recipient))
      .expect(200);
    expect(JSON.stringify(shared.body)).not.toContain(CANARY.roleExcluded);
    expect(shared.body.handover.permissionRecheck.contentChanged).toBe(true);

    await patchVisibility(fixtures.roleExcluded.sourceId, {
      scope: 'roles',
      roles: ['lead', 'contributor'],
      users: [],
    });
  });

  it('re-checks every surface after a conflict is resolved', async () => {
    await resolveCanaryConflict();
    await assertMatrix();

    const shared = await request(app)
      .get(`/api/handovers/shared/${handover.token}`)
      .set(auth(tokens.recipient))
      .expect(200);
    expect(JSON.stringify(shared.body)).not.toContain(CANARY.roleExcluded);
    expect(shared.body.handover.permissionRecheck.contentChanged).toBe(true);
  });

  async function register(email, name) {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, name, password: 'Matrix#2026' });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function addMember(email, role) {
    await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(tokens.lead))
      .send({ email, role })
      .expect(201);
  }

  async function uploadCanary({ canary, heading, visibility, sensitivity = 'internal' }) {
    const content = [
      `# ${canary} rollout notes`,
      '',
      `## ${heading}`,
      `Decision: Adopt ${canary} as the ledger engine. (date: 2026-10-05, status: active)`,
      `Task: Document the ${canary} cutover (owner: Rohan, due: 2026-11-20, status: open)`,
      '',
    ].join('\n');

    const res = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(tokens.lead))
      .field('name', canary)
      .field('sensitivity', sensitivity)
      .field('visibility', JSON.stringify(visibility))
      .attach('files', Buffer.from(content, 'utf8'), `${canary}.md`);

    expect(res.status).toBe(202);
    return res.body.source.id;
  }

  async function createCanaries() {
    const leadOnlyId = await uploadCanary({
      canary: CANARY.leadOnly,
      heading: 'Ledger engine',
      visibility: { scope: 'roles', roles: ['lead'], users: [] },
    });
    const recipientOnlyId = await uploadCanary({
      canary: CANARY.recipientOnly,
      heading: 'Invoice retention',
      visibility: { scope: 'users', roles: [], users: [userIds.recipient] },
    });
    const roleExcludedId = await uploadCanary({
      canary: CANARY.roleExcluded,
      heading: 'Ledger engine',
      visibility: { scope: 'roles', roles: ['lead', 'contributor'], users: [] },
    });
    const deletedId = await uploadCanary({
      canary: CANARY.deleted,
      heading: 'Retired migration',
      visibility: { scope: 'project', roles: [], users: [] },
    });
    const confidentialId = await uploadCanary({
      canary: CANARY.confidential,
      heading: 'Vendor pricing',
      visibility: { scope: 'project', roles: [], users: [] },
      sensitivity: 'confidential',
    });

    await whenIdle({ timeoutMs: 120_000 });

    await request(app)
      .delete(`/api/projects/${projectId}/sources/${deletedId}`)
      .set(auth(tokens.lead))
      .expect(200);

    const sources = await Source.find({ project: projectId }).lean();
    const sourceByName = new Map(sources.map((source) => [source.name, source]));
    const result = {};

    for (const canary of CANARY_VALUES) {
      const source = sourceByName.get(canary);
      expect(source, `fixture source ${canary} must exist`).toBeTruthy();
      const doc = await Document.findOne({ source: source._id }).lean();
      const claim = await Claim.findOne({
        source: source._id,
        type: 'decision',
        retiredAt: null,
      }).lean();
      const evidence = claim
        ? await Evidence.findOne({ claim: claim._id }).lean()
        : null;

      if (canary === CANARY.deleted) {
        expect(doc).toBeFalsy();
        expect(claim).toBeFalsy();
      } else {
        expect(doc, `${canary} document must be ingested`).toBeTruthy();
        expect(claim, `${canary} claim must be extracted`).toBeTruthy();
        expect(evidence, `${canary} evidence must be validated`).toBeTruthy();
        expect(claim.statement).toContain(canary);
        expect(evidence.quote).toContain(canary);
      }

      result[fixtureKey(canary)] = {
        sourceId: String(source._id),
        docId: doc ? String(doc._id) : null,
        claimId: claim ? String(claim._id) : null,
        evidenceId: evidence ? String(evidence._id) : null,
      };
    }

    return result;
  }

  function fixtureKey(canary) {
    return Object.keys(CANARY).find((key) => CANARY[key] === canary);
  }

  async function publishHandover() {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(tokens.lead))
      .send({ projectId, recipientId: userIds.recipient, roleTemplate: 'executive' });
    expect(created.status).toBe(201);
    const handoverId = created.body.handover.id;

    await request(app)
      .post(`/api/handovers/${handoverId}/submit`)
      .set(auth(tokens.lead))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handoverId}/approve`)
      .set(auth(tokens.lead))
      .send({})
      .expect(200);
    const shared = await request(app)
      .post(`/api/handovers/${handoverId}/share`)
      .set(auth(tokens.lead))
      .expect(200);

    return { id: handoverId, token: shared.body.sharePath.split('/').pop() };
  }

  async function patchVisibility(sourceId, visibility) {
    await request(app)
      .patch(`/api/projects/${projectId}/sources/${sourceId}`)
      .set(auth(tokens.lead))
      .send({ visibility })
      .expect(200);
  }

  async function resolveCanaryConflict() {
    const state = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(tokens.lead))
      .expect(200);

    const conflict = state.body.conflicts.find(
      (entry) =>
        (entry.statements || []).some((statement) =>
          statement.statement.includes(CANARY.leadOnly),
        ) &&
        (entry.statements || []).some((statement) =>
          statement.statement.includes(CANARY.roleExcluded),
        ),
    );
    expect(conflict, 'the two ledger-engine decisions must conflict').toBeTruthy();

    const keep = conflict.statements.find((statement) =>
      statement.statement.includes(CANARY.leadOnly),
    );
    await request(app)
      .post(`/api/projects/${projectId}/conflicts/resolve`)
      .set(auth(tokens.lead))
      .send({ topicKey: conflict.topicKey, keepClaimId: keep.claimId })
      .expect(200);
  }

  function contexts() {
    return [
      { key: 'lead', token: tokens.lead, userId: userIds.lead, member: true },
      {
        key: 'second_lead',
        token: tokens.secondLead,
        userId: userIds.secondLead,
        member: true,
      },
      {
        key: 'contributor',
        token: tokens.contributor,
        userId: userIds.contributor,
        member: true,
      },
      { key: 'observer', token: tokens.observer, userId: userIds.observer, member: true },
      {
        key: 'recipient',
        token: tokens.recipient,
        userId: userIds.recipient,
        member: true,
        incoming: true,
      },
      { key: 'outgoing', token: tokens.outgoing, userId: userIds.outgoing, member: true },
      {
        key: 'non_member',
        token: tokens.outsider,
        userId: userIds.outsider,
        member: false,
      },
    ];
  }

  async function loadFacts() {
    const [projectDoc, sources, claims, documents, evidence] = await Promise.all([
      Project.findById(projectId).lean(),
      Source.find({ project: projectId }).lean(),
      Claim.find({ project: projectId, retiredAt: null }).lean(),
      Document.find({ project: projectId, retiredAt: null }).lean(),
      Evidence.find({ project: projectId }).lean(),
    ]);

    const sourceById = new Map(sources.map((source) => [String(source._id), source]));
    const claimById = new Map(claims.map((claim) => [String(claim._id), claim]));
    const evidenceByClaim = new Map();
    for (const entry of evidence) {
      const key = String(entry.claim);
      if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
      evidenceByClaim.get(key).push(entry);
    }

    return { project: projectDoc, sources, claims, documents, sourceById, claimById, evidenceByClaim };
  }

  function readableSourceIds(facts, userId) {
    return new Set(
      facts.sources
        .filter((source) => sourceVisibleTo(source, facts.project, userId))
        .map((source) => String(source._id)),
    );
  }

  function visibleClaimIds(facts, userId) {
    return new Set(
      facts.claims
        .filter((claim) =>
          claimVisibleTo({
            evidence: facts.evidenceByClaim.get(String(claim._id)) || [],
            sourceById: facts.sourceById,
            project: facts.project,
            userId,
          }),
        )
        .map((claim) => String(claim._id)),
    );
  }

  function forbiddenCanaries(facts, userId) {
    return CANARY_VALUES.filter((canary) => {
      const source = facts.sources.find((entry) => entry.name === canary);
      return !sourceVisibleTo(source, facts.project, userId);
    });
  }

  function assertAbsent(payload, canaries) {
    const text = JSON.stringify(payload);
    for (const canary of canaries) {
      expect(text).not.toContain(canary);
    }
  }

  function assertPresent(payload, canaries) {
    const text = JSON.stringify(payload);
    for (const canary of canaries) {
      expect(text).toContain(canary);
    }
  }

  function canariesInSourceSet(facts, sourceIds) {
    return CANARY_VALUES.filter((canary) => {
      const source = facts.sources.find((entry) => entry.name === canary);
      return source && sourceIds.has(String(source._id));
    });
  }

  async function assertMatrix() {
    const facts = await loadFacts();

    for (const context of contexts()) {
      await assertContentSurfaces(context, facts);
      await assertHandoverSurfaces(context, facts);
    }

    await assertAuditSurface(facts);
    await assertRecipientCounts(facts);
  }

  async function assertContentSurfaces(context, facts) {
    const { token, userId } = context;
    const all = CANARY_VALUES;
    const forbidden = forbiddenCanaries(facts, userId);

    const projectRes = await request(app)
      .get(`/api/projects/${projectId}`)
      .set(auth(token));

    if (!context.member) {
      expect(projectRes.status).toBe(403);
      assertAbsent(projectRes.body, all);
      for (const path of [
        `/api/projects/${projectId}/state`,
        `/api/projects/${projectId}/claims`,
        `/api/projects/${projectId}/sources`,
        `/api/projects/${projectId}/documents`,
        `/api/projects/${projectId}/audit`,
        `/api/handovers?projectId=${projectId}`,
      ]) {
        const res = await request(app).get(path).set(auth(token));
        expect(res.status).toBe(403);
        assertAbsent(res.body, all);
      }
      const detail = await request(app)
        .get(`/api/handovers/${handover.id}`)
        .set(auth(token));
      expect([403, 404]).toContain(detail.status);
      assertAbsent(detail.body, all);
      return;
    }

    expect(projectRes.status).toBe(200);
    const readable = readableSourceIds(facts, userId);
    const readableSourceCount = facts.sources.filter(
      (source) => !source.deletedAt && sourceVisibleTo(source, facts.project, userId),
    ).length;
    expect(projectRes.body.stats.sources).toBe(readableSourceCount);
    expect(projectRes.body.stats.totalSources).toBe(readableSourceCount);
    assertAbsent(projectRes.body, all);

    const visibleClaims = visibleClaimIds(facts, userId);

    if (context.incoming) {
      // An incoming recipient receives the shared handover, not the outgoing
      // team's working record: state and claims close, sources stay readable.
      for (const path of [
        `/api/projects/${projectId}/state`,
        `/api/projects/${projectId}/claims`,
      ]) {
        const res = await request(app).get(path).set(auth(token));
        expect(res.status).toBe(403);
        assertAbsent(res.body, all);
      }
    } else {
      const stateRes = await request(app)
        .get(`/api/projects/${projectId}/state`)
        .set(auth(token))
        .expect(200);
      expect(stateRes.body.visibleClaimCount).toBe(visibleClaims.size);
      expect(stateRes.body.summary.counts.total).toBe(visibleClaims.size);
      assertAbsent(stateRes.body, forbidden);
      assertAbsent(stateRes.body.nextActions, forbidden);
      assertPresent(stateRes.body, canariesInSourceSet(facts, readable));

      const claimsRes = await request(app)
        .get(`/api/projects/${projectId}/claims`)
        .set(auth(token))
        .expect(200);
      expect(claimsRes.body.total).toBe(visibleClaims.size);
      assertAbsent(claimsRes.body, forbidden);
      assertPresent(claimsRes.body, canariesInSourceSet(facts, readable));
    }

    const sourcesRes = await request(app)
      .get(`/api/projects/${projectId}/sources`)
      .set(auth(token))
      .expect(200);
    expect(sourcesRes.body.sources).toHaveLength(readableSourceCount);
    assertAbsent(sourcesRes.body, forbidden);
    assertPresent(sourcesRes.body, canariesInSourceSet(facts, readable));

    const documentsRes = await request(app)
      .get(`/api/projects/${projectId}/documents`)
      .set(auth(token))
      .expect(200);
    const readableDocuments = facts.documents.filter((document) =>
      readable.has(String(document.source)),
    );
    expect(documentsRes.body.documents).toHaveLength(readableDocuments.length);
    assertAbsent(documentsRes.body, forbidden);
    assertPresent(documentsRes.body, canariesInSourceSet(facts, readable));

    for (const canary of all) {
      const fixture = fixtures[fixtureKey(canary)];
      const mayRead = readable.has(fixture.sourceId);

      const sourceRes = await request(app)
        .get(`/api/projects/${projectId}/sources/${fixture.sourceId}`)
        .set(auth(token));
      if (mayRead) {
        expect(sourceRes.status).toBe(200);
        expect(JSON.stringify(sourceRes.body)).toContain(canary);
      } else {
        expect([403, 404]).toContain(sourceRes.status);
        assertAbsent(sourceRes.body, [canary]);
      }

      if (fixture.docId) {
        const documentRes = await request(app)
          .get(`/api/projects/${projectId}/documents/${fixture.docId}`)
          .set(auth(token));
        if (mayRead) {
          expect(documentRes.status).toBe(200);
          expect(JSON.stringify(documentRes.body)).toContain(canary);
        } else {
          expect([403, 404]).toContain(documentRes.status);
          assertAbsent(documentRes.body, [canary]);
        }
      }

      if (fixture.evidenceId) {
        const evidenceRes = await request(app)
          .get(`/api/projects/${projectId}/evidence/${fixture.evidenceId}`)
          .set(auth(token));
        if (mayRead) {
          expect(evidenceRes.status).toBe(200);
          expect(JSON.stringify(evidenceRes.body)).toContain(canary);
        } else {
          expect([403, 404]).toContain(evidenceRes.status);
          assertAbsent(evidenceRes.body, [canary]);
        }
      }
    }
  }

  function expectedHandoverItems(handoverDoc, facts, userId, viewer) {
    const live = new Map(
      facts.claims.map((claim) => [
        String(claim._id),
        { status: claim.status },
      ]),
    );

    return (handoverDoc.items || []).filter((item) => {
      if (viewer === 'recipient' && !['accepted', 'edited'].includes(item.decision)) {
        return false;
      }
      if (viewer === 'recipient') {
        const claim = live.get(String(item.claimId));
        if (!claim || claim.status === 'superseded') return false;
        if (
          !(item.citations || []).some((citation) => citation.validation !== 'failed')
        ) {
          return false;
        }
      }
      return (item.citations || []).every((citation) =>
        sourceVisibleTo(
          facts.sourceById.get(String(citation.sourceId)),
          facts.project,
          userId,
        ),
      );
    });
  }

  async function assertHandoverSurfaces(context, facts) {
    const { token, userId } = context;
    const all = CANARY_VALUES;
    const forbidden = forbiddenCanaries(facts, userId);

    const listRes = await request(app)
      .get(`/api/handovers?projectId=${projectId}`)
      .set(auth(token));

    if (!context.member) {
      expect(listRes.status).toBe(403);
      assertAbsent(listRes.body, all);
      const detailRes = await request(app)
        .get(`/api/handovers/${handover.id}`)
        .set(auth(token));
      expect([403, 404]).toContain(detailRes.status);
      assertAbsent(detailRes.body, all);
      const sharedRes = await request(app)
        .get(`/api/handovers/shared/${handover.token}`)
        .set(auth(token));
      expect(sharedRes.status).toBe(403);
      assertAbsent(sharedRes.body, all);
      return;
    }

    expect(listRes.status).toBe(200);
    assertAbsent(listRes.body, all);

    const isAuthor = userIds.lead === userId;
    const isSecondLead = userIds.secondLead === userId;
    const isRecipient = userIds.recipient === userId;
    const canView = isAuthor || isSecondLead || isRecipient;

    const listEntry = (listRes.body.handovers || []).find(
      (entry) => String(entry.id) === String(handover.id),
    );
    if (!canView) {
      expect(listEntry).toBeFalsy();
    } else if (isRecipient && !isAuthor && !isSecondLead) {
      expect(listEntry).toBeTruthy();
      expect(listEntry).not.toHaveProperty('itemCount');
      expect(listEntry).not.toHaveProperty('pendingCount');
      expect(listEntry).not.toHaveProperty('withheld');
    }

    const detailRes = await request(app)
      .get(`/api/handovers/${handover.id}`)
      .set(auth(token));

    if (!canView) {
      expect(detailRes.status).toBe(403);
      assertAbsent(detailRes.body, all);
      const sharedRes = await request(app)
        .get(`/api/handovers/shared/${handover.token}`)
        .set(auth(token));
      expect(sharedRes.status).toBe(403);
      assertAbsent(sharedRes.body, all);
      return;
    }

    expect(detailRes.status).toBe(200);
    const viewer = isRecipient && !isAuthor && !isSecondLead ? 'recipient' : 'reviewer';
    const detailView = detailRes.body.handover;
    const handoverDoc = await Handover.findById(handover.id).lean();
    const expectedItems = expectedHandoverItems(handoverDoc, facts, userId, viewer);
    const expectedCanaries = new Set(
      expectedItems
        .map((item) => facts.claimById.get(String(item.claimId))?.source)
        .map((sourceId) => facts.sourceById.get(String(sourceId))?.name)
        .filter((name) => all.includes(name)),
    );

    assertAbsent(
      detailRes.body,
      all.filter((canary) => !expectedCanaries.has(canary)),
    );
    for (const canary of expectedCanaries) {
      expect(JSON.stringify(detailRes.body)).toContain(canary);
    }
    assertAbsent(detailView.alerts, forbidden);
    assertAbsent(detailView.recommendations, forbidden);
    if (viewer === 'recipient') {
      assertAbsent(detailView.firstWeek, forbidden);
    }

    const sharedRes = await request(app)
      .get(`/api/handovers/shared/${handover.token}`)
      .set(auth(token));
    if (isRecipient) {
      expect(sharedRes.status).toBe(200);
      const sharedExpected = expectedHandoverItems(handoverDoc, facts, userId, 'recipient');
      const sharedCanaries = new Set(
        sharedExpected
          .map((item) => facts.claimById.get(String(item.claimId))?.source)
          .map((sourceId) => facts.sourceById.get(String(sourceId))?.name)
          .filter((name) => all.includes(name)),
      );
      const sharedText = JSON.stringify(sharedRes.body);
      for (const canary of all) {
        if (sharedCanaries.has(canary)) expect(sharedText).toContain(canary);
        else expect(sharedText).not.toContain(canary);
      }
      assertAbsent(sharedRes.body.handover.alerts, forbidden);
      assertAbsent(sharedRes.body.handover.recommendations, forbidden);
      assertAbsent(sharedRes.body.handover.firstWeek, forbidden);
      expect(sharedRes.body.handover.permissionRecheck).not.toHaveProperty(
        'changedItemCount',
      );
      expect(sharedRes.body.handover.permissionRecheck).not.toHaveProperty('removed');
    } else {
      expect(sharedRes.status).toBe(403);
      assertAbsent(sharedRes.body, all);
    }
  }

  async function assertAuditSurface(facts) {
    const auditRes = await request(app)
      .get(`/api/projects/${projectId}/audit?limit=500`)
      .set(auth(tokens.lead))
      .expect(200);
    const text = JSON.stringify(auditRes.body);

    // The lead may read the lead-only, role-excluded and confidential sources.
    expect(text).toContain(CANARY.leadOnly);
    expect(text).toContain(CANARY.roleExcluded);

    // But not sources scoped to someone else or purged from the project.
    expect(text).not.toContain(CANARY.recipientOnly);
    expect(text).not.toContain(CANARY.deleted);

    const redacted = auditRes.body.events.filter((event) => event.redacted);
    expect(redacted.length).toBeGreaterThan(0);
    for (const event of redacted) {
      expect(event.targetLabel).toBe('Restricted item');
      expect(event.targetId).toBeUndefined();
      expect(event.meta).toEqual({ restricted: true });
    }

    for (const context of contexts()) {
      if ([userIds.lead, userIds.secondLead].includes(context.userId)) continue;
      const res = await request(app)
        .get(`/api/projects/${projectId}/audit`)
        .set(auth(context.token));
      expect(res.status).toBe(403);
      assertAbsent(res.body, CANARY_VALUES);
    }
  }

  async function assertRecipientCounts(facts) {
    const sharedRes = await request(app)
      .get(`/api/handovers/shared/${handover.token}`)
      .set(auth(tokens.recipient))
      .expect(200);

    const visible = visibleClaimIds(facts, userIds.recipient);
    expect(sharedRes.body.handover.snapshot.counts.total).toBe(visible.size);
    assertAbsent(sharedRes.body, forbiddenCanaries(facts, userIds.recipient));
  }
});
