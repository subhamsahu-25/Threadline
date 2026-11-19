import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditEvent,
  Claim,
  Clarification,
  Document,
  Evidence,
  Handover,
  HandoverFeedback,
  HandoverVersion,
  Source,
  User,
} from '../src/models/index.js';
import { purgeSourceContent } from '../src/services/purge.js';
import { linkSupersessions } from '../src/services/reconstruction/link.js';
import { seed, startDb, stopDb } from './helpers.js';

const PHRASE = 'zephyr-quartz-handshake-771';
const CACHED_PHRASE = 'cobalt-otter-marker-482';

async function databaseHits(phrase) {
  const hits = [];
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) {
    if (collection.collectionName.startsWith('system.')) continue;
    const rows = await collection.find({}).toArray();
    const serialized = JSON.stringify(rows);
    if (serialized.includes(phrase)) hits.push(collection.collectionName);
  }
  return hits;
}

async function makeSource(project, createdBy, name) {
  return Source.create({
    project: project._id,
    kind: 'upload',
    name,
    status: 'ready',
    createdBy,
    files: [],
  });
}

async function makeClaim({ project, source, statement, topic, occurredAt, flags = [] }) {
  return Claim.create({
    project: project._id,
    source: source._id,
    type: 'decision',
    statement,
    statementKey: statement.toLowerCase(),
    topic,
    topicKey: topic,
    status: 'active',
    occurredAt,
    hasSourceDate: true,
    flags,
    sensitivity: 'internal',
  });
}

async function makeDocument(project, source, text) {
  return Document.create({
    project: project._id,
    source: source._id,
    kind: 'upload',
    title: 'Handover notes',
    path: 'notes.md',
    mime: 'text/markdown',
    size: text.length,
    rawText: text,
  });
}

describe('purge erases every copy of source text', () => {
  let seeded;
  let project;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  it('scrubs documents, options, feedback, audit labels, summaries and versions', async () => {
    seeded = await seed();
    project = await mongoose.model('Project').findById(seeded.project.id);
    const lead = await User.findOne({ email: 'subham@threadline.demo' });
    const recipient = await User.findOne({ email: 'ananya@threadline.demo' });

    const source = await makeSource(project, lead._id, 'Purge canary source');
    const controlSource = await makeSource(project, lead._id, 'Control source');
    const document = await makeDocument(
      project,
      source,
      `# Notes\nDecision: Adopt the ${PHRASE} protocol. (status: active)\n`,
    );
    const claim = await makeClaim({
      project,
      source,
      statement: `Adopt the ${PHRASE} protocol.`,
      topic: 'protocol adoption',
      occurredAt: new Date('2026-10-01T00:00:00Z'),
    });
    const controlClaim = await makeClaim({
      project,
      source: controlSource,
      statement: `Keep ${CACHED_PHRASE} unchanged.`,
      topic: 'cached decisions',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
    });
    await Evidence.create({
      project: project._id,
      claim: claim._id,
      source: source._id,
      document: document._id,
      quote: `Adopt the ${PHRASE} protocol.`,
      charStart: 0,
      charEnd: 40,
    });

    const citation = {
      evidenceId: new mongoose.Types.ObjectId(),
      documentId: document._id,
      sourceId: source._id,
      validation: 'exact',
      quote: `Adopt the ${PHRASE} protocol.`,
      sourceName: source.name,
      docTitle: document.title,
    };
    const handover = await Handover.create({
      project: project._id,
      recipient: recipient._id,
      recipientSnapshot: { name: recipient.name, email: recipient.email, role: 'contributor' },
      createdBy: lead._id,
      createdBySnapshot: { name: lead.name, email: lead.email },
      status: 'approved',
      approvedAt: new Date(),
      items: [
        {
          claimId: claim._id,
          type: 'decision',
          statement: `Adopt the ${PHRASE} protocol.`,
          topic: 'protocol adoption',
          status: 'active',
          decision: 'accepted',
          citations: [citation],
        },
      ],
      snapshot: {
        projectName: project.name,
        generatedSummary: `Handover for ${recipient.name}: adopted the ${PHRASE} protocol.`,
      },
    });
    await HandoverVersion.create({
      handover: handover._id,
      project: project._id,
      version: 1,
      reason: 'created',
      snapshot: {
        items: [
          {
            claimId: claim._id,
            type: 'decision',
            statement: `Adopt the ${PHRASE} protocol.`,
            citations: [citation],
          },
        ],
        alerts: [],
        recommendations: [],
        generatedSummary: `Handover for ${recipient.name}: ${PHRASE}.`,
      },
    });

    // Conflict options quote other claims; the record's own `claim` is a
    // different, still-visible claim. Purge must find it through the option
    // ids, not only through the first claim.
    const clarification = await Clarification.create({
      project: project._id,
      claim: controlClaim._id,
      kind: 'conflict',
      prompt: 'Which decision is current?',
      status: 'open',
      answerOptions: [`Adopt the ${PHRASE} protocol.`, `Keep ${CACHED_PHRASE} unchanged.`],
      answerOptionClaimIds: [claim._id, controlClaim._id],
    });
    const feedback = await HandoverFeedback.create({
      project: project._id,
      handover: handover._id,
      claimId: claim._id,
      author: recipient._id,
      authorSnapshot: { name: recipient.name, role: 'contributor' },
      message: `Please confirm whether the ${PHRASE} protocol is still planned.`,
      resolutionNote: `Answer references ${PHRASE}.`,
    });

    const claimAudit = await AuditEvent.create({
      project: project._id,
      actor: lead._id,
      action: 'handover.feedback_resolved',
      targetType: 'handover',
      targetId: handover._id,
      targetLabel: `Handover v${handover.version}`,
      meta: { claimId: String(claim._id), note: PHRASE },
    });
    const sourceAudit = await AuditEvent.create({
      project: project._id,
      actor: lead._id,
      action: 'source.viewed',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {},
    });
    const controlAudit = await AuditEvent.create({
      project: project._id,
      actor: lead._id,
      action: 'project.updated',
      targetType: 'project',
      targetId: project._id,
      targetLabel: project.name,
      meta: { changed: ['name'] },
    });

    const result = await purgeSourceContent({ project, source });
    expect(result.claimsRetired).toBe(1);
    expect(result.clarificationsCleared).toBe(1);
    expect(result.feedbackScrubbed).toBe(1);
    expect(result.handoverItemsRemoved).toBe(1);
    expect(result.versionsScrubbed).toBe(1);

    const storedClaim = await Claim.findById(claim._id).lean();
    expect(storedClaim.statement).toBe('');
    expect(storedClaim.retiredAt).toBeTruthy();

    const storedClarification = await Clarification.findById(clarification._id).lean();
    expect(storedClarification.prompt).toBe('Question removed with its source');
    expect(storedClarification.answerOptions).toEqual([]);
    expect(storedClarification.answerOptionClaimIds || []).toEqual([]);

    const storedFeedback = await HandoverFeedback.findById(feedback._id).lean();
    expect(storedFeedback.message).toBe('Feedback removed with its source');
    expect(storedFeedback.resolutionNote).toBe('');

    const storedHandover = await Handover.findById(handover._id).lean();
    expect(storedHandover.items[0].statement).toBe('Item removed with its source');
    expect(storedHandover.items[0].citations[0].quote).toBe('');
    expect(storedHandover.snapshot.generatedSummary).not.toContain(PHRASE);

    const storedVersion = await HandoverVersion.findOne({ handover: handover._id }).lean();
    expect(storedVersion.snapshot.items[0].statement).toBe('Item removed with its source');
    expect(storedVersion.snapshot.generatedSummary).not.toContain(PHRASE);

    const storedClaimAudit = await AuditEvent.findById(claimAudit._id).lean();
    expect(storedClaimAudit.meta).toEqual({});
    expect(storedClaimAudit.targetLabel).toBe('Purged claim');
    const storedSourceAudit = await AuditEvent.findById(sourceAudit._id).lean();
    expect(storedSourceAudit.targetLabel).toBe('Purged source');
    expect(storedSourceAudit.meta).toEqual({});
    // An unrelated event keeps its label and metadata.
    const storedControl = await AuditEvent.findById(controlAudit._id).lean();
    expect(storedControl.targetLabel).toBe(project.name);
    expect(storedControl.meta).toEqual({ changed: ['name'] });

    expect(await databaseHits(PHRASE)).toEqual([]);
    // The control phrase was never part of the purged source.
    expect(await databaseHits(CACHED_PHRASE)).not.toEqual([]);
  });

  it('restores an older decision the purged claim had superseded', async () => {
    seeded = await seed();
    project = await mongoose.model('Project').findById(seeded.project.id);
    const lead = await User.findOne({ email: 'subham@threadline.demo' });

    const oldSource = await makeSource(project, lead._id, 'Older decision source');
    const newSource = await makeSource(project, lead._id, 'Newer decision source');
    const older = await makeClaim({
      project,
      source: oldSource,
      statement: 'Release every second Friday.',
      topic: 'release cadence',
      occurredAt: new Date('2026-01-05T00:00:00Z'),
    });
    const newer = await makeClaim({
      project,
      source: newSource,
      statement: 'Release every Thursday.',
      topic: 'release cadence',
      occurredAt: new Date('2026-02-05T00:00:00Z'),
      flags: ['explicit_supersession'],
    });
    await linkSupersessions(project._id);
    expect((await Claim.findById(older._id).lean()).status).toBe('superseded');

    await purgeSourceContent({ project, source: newSource });

    const restored = await Claim.findById(older._id).lean();
    expect(restored.status).toBe('active');
    expect(restored.supersededBy).toBeFalsy();
    const purged = await Claim.findById(newer._id).lean();
    expect(purged.retiredAt).toBeTruthy();
  });
});
