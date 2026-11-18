import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  auth,
  idOf,
  request,
  seed,
  sourceIdOf,
  startDb,
  stopDb,
  tokenOf,
  whenIdle,
} from './helpers.js';
import { env } from '../src/config/env.js';
import { keyOf, keyOfOrHash, locateQuote, missingValueTokens } from '../src/lib/text.js';
import {
  heuristicExtractWithMeta,
  isExplicitSupersession,
  validDate,
} from '../src/services/ai/heuristics.js';
import {
  findSupersededPairs,
  hasContradiction,
  linkSupersessions,
} from '../src/services/reconstruction/link.js';
import { resolveOwnerName } from '../src/services/owners.js';
import { Claim, Evidence, Handover, Source } from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';

function claimFixture(overrides) {
  return {
    type: 'decision',
    status: 'active',
    statement: '',
    statementKey: '',
    topic: 'Release',
    topicKey: 'release',
    flags: [],
    ...overrides,
  };
}

describe('D1 unicode-safe comparison keys', () => {
  it('keeps Devanagari, accented Latin and mixed scripts instead of dropping them', () => {
    const hindi = keyOf('PostgreSQL और Redis का उपयोग करें');
    expect(hindi).toContain('postgresql');
    expect(hindi).toContain('उपयोग');

    const marathi = keyOf('PostgreSQL वापरा');
    expect(marathi).toContain('वापरा');

    expect(keyOf('Café résumé')).toBe('café résumé');
  });

  it('gives different statements different keys and a stable fallback for emoji', () => {
    expect(keyOf('निर्णय एक')).not.toBe(keyOf('निर्णय दो'));

    expect(keyOf('🚀🔥')).toBe('');
    const first = keyOfOrHash('🚀🔥');
    expect(first).toMatch(/^h[0-9a-f]{16}$/);
    expect(keyOfOrHash('🚀🔥')).toBe(first);
    expect(keyOfOrHash('🎉')).not.toBe(first);
  });
});

describe('D2 quote verification', () => {
  const document = 'The team will migrate the ledger to PostgreSQL next quarter.';

  it('rejects a quote whose invented tail does not exist in the document', () => {
    const invented =
      'to PostgreSQL next quarter and drop MySQL entirely';
    expect(locateQuote(document, invented).ok).toBe(false);
  });

  it('accepts a case-folded match and prefers the occurrence inside the chunk', () => {
    const normalized = locateQuote(document, 'migrate the ledger to postgresql next quarter');
    expect(normalized.ok).toBe(true);
    expect(normalized.match).toBe('normalized');

    const text = 'Old plan: use Redis for cache.\n\nNew plan: use Redis for cache now.';
    const second = text.indexOf('use Redis for cache now');
    const located = locateQuote(text, 'use Redis for cache', {
      within: { start: second, end: text.length },
    });
    expect(located.ok).toBe(true);
    expect(located.start).toBe(second);
  });

  it('flags statement values the matched quote never contains', () => {
    expect(
      missingValueTokens(
        'Adopt MongoDB immediately',
        'migrate the ledger to PostgreSQL next quarter',
      ),
    ).toContain('mongodb');
    expect(missingValueTokens('Migrate to PostgreSQL', document)).toEqual([]);
  });
});

describe('D3 heuristic extraction correctness', () => {
  const text = [
    '# Ops runbook',
    'Task: Fix bug 2026-13-45 in parser (owner: Rohan, due: 2026-13-45)',
    'Risk-based testing approach stays in place',
    'Risks: vendor lock-in for the ledger',
    'Decisions: use PostgreSQL for the ledger',
    'Owner: Rohan Mehta',
    'Task: Review onboarding (owner: Renée Dupont, due: 2026-12-01)',
  ].join('\n');

  it('validates dates instead of crashing on an impossible one', () => {
    expect(validDate('2026-13-45')).toBe(null);
    expect(validDate('2026-02-29')).toBe(null);
    expect(validDate('2026-10-05')).toBe('2026-10-05');
  });

  it('drops the invalid date with a warning and never dates from a due date', () => {
    const { items, warnings } = heuristicExtractWithMeta({ text, docTitle: 'Ops' });

    const invalid = items.find((item) => item.statement.includes('Fix bug'));
    expect(invalid).toBeTruthy();
    expect(invalid.dueDate).toBe(null);
    expect(invalid.occurredAt).toBe(null);
    expect(warnings.some((warning) => /not real calendar dates/.test(warning))).toBe(true);

    const review = items.find((item) => item.statement.includes('Review onboarding'));
    expect(review.dueDate).toBe('2026-12-01');
    expect(review.occurredAt).toBe(null);
    expect(review.owner).toBe('Renée Dupont');
  });

  it('reads plural labels, ignores hyphenated words and attaches owner lines', () => {
    const { items } = heuristicExtractWithMeta({ text, docTitle: 'Ops' });

    expect(items.some((item) => item.type === 'decision')).toBe(true);
    expect(items.some((item) => item.type === 'risk')).toBe(true);
    expect(items.some((item) => item.statement.includes('based testing approach'))).toBe(false);

    const decision = items.find((item) => item.type === 'decision');
    expect(decision.owner).toBe('Rohan Mehta');
  });

  it('reports truncation instead of silently dropping items', () => {
    const many = Array.from({ length: 30 }, (_, index) => `Task: item number ${index + 1}`).join(
      '\n',
    );
    const { items, warnings } = heuristicExtractWithMeta({ text: many, docTitle: 'List' });
    expect(items).toHaveLength(24);
    expect(warnings.some((warning) => /first 24/.test(warning))).toBe(true);
  });

  it('only treats explicit replacement wording as supersession', () => {
    expect(isExplicitSupersession('Decision: replace the logo')).toBe(false);
    expect(
      isExplicitSupersession('The new vendor replaces the previous contract'),
    ).toBe(true);
  });
});

describe('D4/D5 contradiction-aware conflict grouping', () => {
  it('does not call complementary decisions a conflict', () => {
    const left = claimFixture({ statement: 'Use PostgreSQL', statementKey: 'use postgresql' });
    const right = claimFixture({ statement: 'Run read replicas', statementKey: 'run read replicas' });
    expect(hasContradiction(left, right)).toBe(false);
    expect(findSupersededPairs([left, right])).toHaveLength(0);
  });

  it('flags decisions that name different values for the same subject', () => {
    const left = claimFixture({
      _id: 'a',
      statement: 'Deploy PostgreSQL 15',
      statementKey: 'deploy postgresql 15',
    });
    const right = claimFixture({
      _id: 'b',
      statement: 'Deploy PostgreSQL 16',
      statementKey: 'deploy postgresql 16',
    });
    expect(hasContradiction(left, right)).toBe(true);
    expect(findSupersededPairs([left, right])).toHaveLength(1);
  });

});

describe('D4/D5 supersession restore over the database', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('restores an older decision when the newer one is deleted', async () => {
    const seeded = await seed();
    const projectId = seeded.project.id;
    const userId = idOf(seeded, LEAD);
    const source = await Source.create({
      project: projectId,
      kind: 'upload',
      name: `dfix-${randomUUID()}.md`,
      status: 'ready',
      createdBy: userId,
    });

    const older = await Claim.create({
      project: projectId,
      source: source._id,
      type: 'decision',
      statement: 'Store sessions in Redis',
      statementKey: 'store sessions in redis',
      topic: 'Session store',
      topicKey: 'session store',
      status: 'planned',
      occurredAt: new Date('2026-01-05'),
    });
    const newer = await Claim.create({
      project: projectId,
      source: source._id,
      type: 'decision',
      statement: 'Store sessions in Redis 8 instead of Redis 7',
      statementKey: 'store sessions in redis 8 instead of redis 7',
      topic: 'Session store',
      topicKey: 'session store',
      status: 'active',
      occurredAt: new Date('2026-02-05'),
      flags: ['explicit_supersession'],
    });

    await linkSupersessions(projectId);
    const superseded = await Claim.findById(older._id).lean();
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededPriorStatus).toBe('planned');
    expect(String(superseded.supersededBy)).toBe(String(newer._id));

    await Claim.deleteOne({ _id: newer._id });
    await linkSupersessions(projectId);
    const restored = await Claim.findById(older._id).lean();
    expect(restored.status).toBe('planned');
    expect(restored.supersededBy).toBeFalsy();
  });
});

describe('D9 owner resolution by identity', () => {
  it('resolves unique names and emails, and flags ambiguous first names', () => {
    const directory = {
      byEmail: new Map([['ananya@threadline.demo', 'email-id']]),
      byName: new Map([
        ['ananya rao', ['rao-id']],
        ['ananya sharma', ['sharma-id']],
      ]),
      byFirstName: new Map([
        ['ananya', ['rao-id', 'sharma-id']],
        ['rohan', ['rohan-id']],
      ]),
    };

    expect(resolveOwnerName(directory, 'Rohan')).toEqual({ userId: 'rohan-id', ambiguous: false });
    expect(resolveOwnerName(directory, 'Ananya Rao')).toEqual({
      userId: 'rao-id',
      ambiguous: false,
    });
    expect(resolveOwnerName(directory, 'ANANYA@THREADLINE.DEMO')).toEqual({
      userId: 'email-id',
      ambiguous: false,
    });
    expect(resolveOwnerName(directory, 'Ananya')).toEqual({ userId: null, ambiguous: true });
    expect(resolveOwnerName(directory, 'Unknown Person')).toEqual({
      userId: null,
      ambiguous: false,
    });
  });
});

describe('D6-D10 behaviour over the API', () => {
  let seeded;
  let projectId;
  let leadToken;
  let recipientToken;
  let recipientId;

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
    recipientToken = tokenOf(seeded, INCOMING);
    recipientId = idOf(seeded, INCOMING);
  });

  async function composeHandover(roleTemplate = 'onboarding') {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId, roleTemplate })
      .expect(201);
    return created.body.handover;
  }

  async function publishHandover(handoverId) {
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

  it('keeps approved citations readable after a source is re-ingested', async () => {
    const handover = await composeHandover();
    const item = handover.items.find(
      (entry) => entry.decision === 'accepted' && (entry.citations || []).length > 0,
    );
    expect(item).toBeTruthy();
    const citation = item.citations.find((entry) => entry.evidenceId);
    expect(citation).toBeTruthy();

    const token = await publishHandover(handover.id);

    await request(app)
      .post(`/api/projects/${projectId}/sources/${citation.sourceId}/reingest`)
      .set(auth(leadToken))
      .expect(202);
    await whenIdle({ timeoutMs: 120_000 });

    expect(await Evidence.findById(citation.evidenceId).lean()).toBeFalsy();

    const viewed = await request(app)
      .get(`/api/projects/${projectId}/evidence/${citation.evidenceId}?handover=${handover.id}`)
      .set(auth(recipientToken))
      .expect(200);
    expect(viewed.body.snapshot).toBe(true);
    expect(viewed.body.changed).toBe(false);
    expect(viewed.body.evidence.quote.length).toBeGreaterThan(0);
    expect(viewed.body.note).toMatch(/replaced|stored with the handover/i);

    const shared = await request(app)
      .get(`/api/handovers/shared/${token}`)
      .set(auth(recipientToken))
      .expect(200);
    expect(shared.body.handover.items.length).toBeGreaterThan(0);
  });

  it('saves partial extraction progress and resumes without losing it', async () => {
    const sections = Array.from({ length: 12 }, (_, index) => {
      const filler = 'Context notes keep the section long enough to become its own chunk. '.repeat(
        10,
      );
      return [
        `## Section ${index + 1}`,
        `Decision: Adopt runtime pattern ${index + 1} for the service.`,
        filler,
      ].join('\n\n');
    });
    const content = `# Long runbook\n\n${sections.join('\n\n')}`;

    const previousBudget = env.extractTimeBudgetMs;
    env.extractTimeBudgetMs = 1;
    try {
      const uploaded = await request(app)
        .post(`/api/projects/${projectId}/sources/upload`)
        .set(auth(leadToken))
        .field('name', 'Resumable runbook')
        .attach('files', Buffer.from(content, 'utf8'), 'resumable-runbook.md')
        .expect(202);
      await whenIdle({ timeoutMs: 120_000 });

      const sourceId = uploaded.body.source.id;
      const partial = await request(app)
        .get(`/api/projects/${projectId}/sources/${sourceId}`)
        .set(auth(leadToken))
        .expect(200);
      expect(partial.body.source.status).toBe('partial');
      const cursor = (await Source.findById(sourceId).lean()).extractionCursor;
      expect(cursor.chunksProcessed).toBeGreaterThan(0);
      expect(cursor.chunksProcessed).toBeLessThan(cursor.chunksTotal);

      const firstRun = await Claim.find({
        source: sourceId,
        retiredAt: null,
      })
        .select('_id')
        .lean();
      expect(firstRun.length).toBeGreaterThan(0);
      const firstRunIds = firstRun.map((claim) => String(claim._id));

      env.extractTimeBudgetMs = previousBudget;
      await request(app)
        .post(`/api/projects/${projectId}/sources/${sourceId}/reingest`)
        .set(auth(leadToken))
        .expect(202);
      await whenIdle({ timeoutMs: 120_000 });

      const finished = await request(app)
        .get(`/api/projects/${projectId}/sources/${sourceId}`)
        .set(auth(leadToken))
        .expect(200);
      expect(finished.body.source.status).toBe('ready');
      expect(finished.body.source.extractionCursor).toBeUndefined();

      const finalClaims = await Claim.find({ source: sourceId, retiredAt: null })
        .select('_id')
        .lean();
      const finalIds = new Set(finalClaims.map((claim) => String(claim._id)));
      for (const id of firstRunIds) expect(finalIds.has(id)).toBe(true);
      expect(finalClaims.length).toBeGreaterThan(firstRunIds.length);

      const audit = await request(app)
        .get(`/api/projects/${projectId}/audit?limit=200`)
        .set(auth(leadToken))
        .expect(200);
      const partialEvent = audit.body.events.find((event) => event.action === 'source.partial');
      expect(partialEvent.meta.resumable).toBe(true);
      expect(partialEvent.meta.resumed).toBe(false);
      const finishedEvent = audit.body.events.find((event) => event.action === 'source.ingested');
      expect(finishedEvent.meta.resumed).toBe(true);
    } finally {
      env.extractTimeBudgetMs = previousBudget;
    }
  });

  it('marks draft handovers outdated when a cited source becomes restricted', async () => {
    const handover = await composeHandover();
    const item = handover.items.find((entry) =>
      (entry.citations || []).some(
        (citation) => citation.sourceId === sourceIdOf(seeded, 'handover-notes.txt'),
      ),
    );
    expect(item).toBeTruthy();

    await request(app)
      .patch(`/api/projects/${projectId}/sources/${sourceIdOf(seeded, 'handover-notes.txt')}`)
      .set(auth(leadToken))
      .send({ visibility: { scope: 'roles', roles: ['lead'], users: [] } })
      .expect(200);

    const detail = await request(app)
      .get(`/api/handovers/${handover.id}`)
      .set(auth(leadToken))
      .expect(200);
    expect(detail.body.handover.status).toBe('draft');
    expect(detail.body.handover.freshness.status).toBe('outdated');

    const comparison = await request(app)
      .get(`/api/handovers/${handover.id}/freshness`)
      .set(auth(leadToken))
      .expect(200);
    expect(comparison.body.comparison.changes.length).toBeGreaterThan(0);
    expect(comparison.body.comparison.changes.some((entry) => entry.change === 'removed')).toBe(
      true,
    );
  });

  it('stores the recipient owner id on the item, not just the display name', async () => {
    const handover = await composeHandover();
    const rohanId = idOf(seeded, 'rohan@threadline.demo');
    const rohanItems = handover.items.filter((entry) => entry.ownerName === 'Rohan');
    expect(rohanItems.length).toBeGreaterThan(0);
    for (const item of rohanItems) expect(item.ownerUserId).toBe(rohanId);
  });

  it('resets only changed decisions when regenerating and preserves acknowledgement', async () => {
    const handover = await composeHandover();
    const accepted = handover.items.filter(
      (entry) => entry.decision === 'accepted' && (entry.citations || []).length > 0,
    );
    expect(accepted.length).toBeGreaterThan(1);
    const changedItem = accepted[0];
    const carriedItem = accepted[1];

    const token = await publishHandover(handover.id);
    const acknowledged = await request(app)
      .post(`/api/handovers/shared/${token}/acknowledge`)
      .set(auth(recipientToken))
      .expect(200);
    const acknowledgementAt =
      acknowledged.body.handover.acknowledgement?.at || new Date().toISOString();

    await Claim.updateOne(
      { _id: changedItem.claimId },
      { $set: { statement: `${changedItem.statement} (revised)` } },
    );

    const regenerated = await request(app)
      .post(`/api/handovers/${handover.id}/regenerate`)
      .set(auth(leadToken))
      .expect(200);
    expect(regenerated.body.createdNew).toBe(true);
    expect(regenerated.body.changed).toBeGreaterThan(0);
    expect(regenerated.body.handover.status).toBe('draft');

    const changed = regenerated.body.handover.items.find(
      (entry) => String(entry.claimId) === String(changedItem.claimId),
    );
    expect(changed.decision).toBe('pending');
    expect(changed.changedSinceReview).toBe(true);
    expect(changed.previousDecision).toBe('accepted');

    const carried = regenerated.body.handover.items.find(
      (entry) => String(entry.claimId) === String(carriedItem.claimId),
    );
    expect(carried.decision).toBe('accepted');

    const stored = await Handover.findById(regenerated.body.handover.id).lean();
    expect(stored.acknowledgedAt).toBeTruthy();
    expect(stored.acknowledgement?.at).toBeTruthy();
    expect(new Date(stored.acknowledgement.at).toISOString()).toBe(
      new Date(acknowledgementAt).toISOString(),
    );
  });
});
