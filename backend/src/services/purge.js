import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { useSession, withOptionalTransaction } from '../lib/transactions.js';
import {
  AuditEvent,
  Claim,
  Clarification,
  Document,
  Evidence,
  Handover,
  HandoverFeedback,
  HandoverVersion,
  Job,
  Source,
} from '../models/index.js';
import { refreshOutdatedHandovers, sanitizeVersionReason } from './handover/workflow.js';
import { linkSupersessions } from './reconstruction/link.js';

function itemReferencesSource(item, sourceId, claimIds) {
  if (item.claimId && claimIds.has(String(item.claimId))) return true;
  return (item.citations || []).some((citation) => String(citation.sourceId) === String(sourceId));
}

// A tombstone keeps only identifiers and the source link, so the reader can
// learn that an item was removed and why, while no text or quote survives.
function tombstoneItem(item) {
  return {
    claimId: item.claimId,
    type: item.type,
    // The statement is required by the schema, so it holds a fixed note
    // instead of an empty string: no original text survives, and the handover
    // can still be saved when the recipient later opens it.
    statement: 'Item removed with its source',
    topic: '',
    status: item.status,
    decision: item.decision,
    citations: (item.citations || []).map((citation) => ({
      evidenceId: citation.evidenceId,
      documentId: citation.documentId,
      sourceId: citation.sourceId,
      validation: 'failed',
      quote: '',
      sourceName: '',
      docTitle: '',
    })),
  };
}

function filterSnapshot(snapshot, sourceId, claimIds) {
  if (!snapshot) return { snapshot, itemCount: 0, changed: false };
  let itemCount = 0;

  const items = (snapshot.items || []).map((item) => {
    if (itemReferencesSource(item, sourceId, claimIds)) {
      itemCount += 1;
      return tombstoneItem(item);
    }
    return item;
  });

  const keepEntry = (entry) =>
    !(entry.claimIds || []).some((id) => claimIds.has(String(id)));

  const alerts = (snapshot.alerts || []).filter(keepEntry);
  const recommendations = (snapshot.recommendations || []).filter(keepEntry);
  const withheldEntries = (snapshot.withheld?.entries || []).filter(
    (entry) => !claimIds.has(String(entry.claimId)),
  );
  const freshnessChanges = (snapshot.freshness?.changes || []).filter(
    (change) => !claimIds.has(String(change.claimId)),
  );
  const revokedItems = (snapshot.acknowledgement?.revokedItems || []).filter(
    (entry) => !claimIds.has(String(entry.claimId)),
  );
  const statementHashes = Object.fromEntries(
    Object.entries(snapshot.acknowledgement?.statementHashes || {}).filter(
      ([id]) => !claimIds.has(String(id)),
    ),
  );
  const changed =
    itemCount > 0 ||
    alerts.length !== (snapshot.alerts || []).length ||
    recommendations.length !== (snapshot.recommendations || []).length ||
    withheldEntries.length !== (snapshot.withheld?.entries || []).length ||
    freshnessChanges.length !== (snapshot.freshness?.changes || []).length ||
    revokedItems.length !== (snapshot.acknowledgement?.revokedItems || []).length ||
    Object.keys(statementHashes).length !==
      Object.keys(snapshot.acknowledgement?.statementHashes || {}).length;

  return {
    snapshot: {
      ...snapshot,
      items,
      alerts,
      recommendations,
      withheld: {
        ...(snapshot.withheld || {}),
        entries: withheldEntries,
      },
      freshness: snapshot.freshness
        ? { ...snapshot.freshness, changes: freshnessChanges }
        : snapshot.freshness,
      acknowledgement: snapshot.acknowledgement
        ? { ...snapshot.acknowledgement, revokedItems, statementHashes }
        : snapshot.acknowledgement,
    },
    itemCount,
    changed,
  };
}

const MIN_NEEDLE = 8;
const SUMMARY_SCRUBBED = 'Summary updated after a source was removed.';

/**
 * Copies of source text live in more places than documents and claims: the
 * words are pasted into conflict options, feedback comments and audit labels.
 * These needles let those copies be found by content, not only by an id the
 * record may not carry.
 */
function collectNeedles(claims, clarifications) {
  const needles = new Set();
  for (const claim of claims) {
    for (const value of [claim.statement, claim.topic]) {
      const text = String(value || '').trim();
      if (text.length >= MIN_NEEDLE) needles.add(text);
    }
  }
  for (const clarification of clarifications) {
    for (const value of [clarification.prompt, ...(clarification.answerOptions || [])]) {
      const text = String(value || '').trim();
      if (text.length >= MIN_NEEDLE) needles.add(text);
    }
  }
  return [...needles].slice(0, 200);
}

function auditLabelFor(targetType) {
  if (targetType === 'source') return 'Purged source';
  if (targetType === 'clarification') return 'Purged question';
  if (targetType === 'document') return 'Purged document';
  return 'Purged claim';
}

async function runPurge({ project, source, session }) {
  const use = (query) => useSession(query, session);
  const documents = await use(Document.find({ source: source._id }).select('_id')).lean();
  const documentIds = documents.map((document) => document._id);
  const claims = await use(
    Claim.find({ source: source._id }).select('_id statement topic'),
  ).lean();
  const claimIds = new Set(claims.map((claim) => String(claim._id)));
  const claimObjectIds = claims.map((claim) => claim._id);

  // Every clarification whose question, first claim or any offered option
  // belongs to this source. Conflict options quote several claims, so the
  // first-claim test alone used to leave their text behind.
  const clarifications = await use(
    Clarification.find({
      project: project._id,
      $or: [
        { claim: { $in: claimObjectIds } },
        { answerOptionClaimIds: { $in: claimObjectIds } },
      ],
    }).select('_id prompt answerOptions'),
  ).lean();
  const clarificationIds = clarifications.map((entry) => entry._id);

  // Needles are collected before the rows are blanked below.
  const needles = collectNeedles(claims, clarifications);

  const evidence = await use(
    Evidence.deleteMany({
      $or: [
        { source: source._id },
        ...(documentIds.length > 0 ? [{ document: { $in: documentIds } }] : []),
        ...(claimObjectIds.length > 0 ? [{ claim: { $in: claimObjectIds } }] : []),
      ],
    }),
  );

  // A queued or abandoned ingest for this source would work against rows that
  // no longer exist; recovery would otherwise resurrect it after a restart.
  await use(Job.deleteMany({ 'payload.sourceId': String(source._id) }));

  if (documentIds.length > 0) {
    await use(Document.deleteMany({ _id: { $in: documentIds } }));
  }

  if (claimObjectIds.length > 0) {
    // Blank the derived keys too: they are normalised copies of the text and
    // would otherwise answer a database search for the purged phrase.
    await use(
      Claim.updateMany(
        { _id: { $in: claimObjectIds } },
        {
          $set: {
            retiredAt: new Date(),
            statement: '',
            statementKey: '',
            topic: '',
            topicKey: '',
            'resolution.note': '',
          },
          $unset: { document: 1, ownerName: 1, ownerUser: 1 },
        },
      ),
    );
  }

  if (clarificationIds.length > 0) {
    await use(
      Clarification.updateMany(
        { _id: { $in: clarificationIds } },
        {
          $set: {
            status: 'closed',
            prompt: 'Question removed with its source',
            answerOptions: [],
            answerOptionClaimIds: [],
            answer: null,
          },
          $unset: { declineNote: 1, resultClaim: 1 },
        },
      ),
    );
  }

  // Feedback is a recipient's own words about an item, but it often repeats
  // the item it is about. The row stays (so the thread and audit stay
  // coherent) and its message is replaced with a fixed note.
  const feedback = claimObjectIds.length
    ? await use(
        HandoverFeedback.updateMany(
          { project: project._id, claimId: { $in: claimObjectIds } },
          {
            $set: {
              message: 'Feedback removed with its source',
              resolutionNote: '',
            },
          },
        ),
      )
    : { modifiedCount: 0 };

  let handoverItemsRemoved = 0;
  const handoverSummariesScrubbed = new Set();
  const handovers = await use(Handover.find({ project: project._id })).lean();
  for (const handover of handovers) {
    const { snapshot, itemCount, changed } = filterSnapshot(handover, source._id, claimIds);
    const summary = String(handover.snapshot?.generatedSummary || '');
    // A composed summary describes the items that were just removed, even
    // when it paraphrases rather than quotes them, so it is replaced whenever
    // the handover changed or still names a purged phrase.
    const summaryTouched = changed || needles.some((needle) => summary.includes(needle));
    if (!changed && !summaryTouched) continue;
    handoverItemsRemoved += itemCount;
    if (summaryTouched) handoverSummariesScrubbed.add(String(handover._id));
    await use(
      Handover.updateOne(
        { _id: handover._id },
        {
          $set: {
            items: snapshot.items,
            alerts: snapshot.alerts,
            recommendations: snapshot.recommendations,
            'withheld.entries': snapshot.withheld.entries,
            'freshness.changes': snapshot.freshness?.changes || [],
            'acknowledgement.revokedItems': snapshot.acknowledgement?.revokedItems || [],
            'acknowledgement.statementHashes': snapshot.acknowledgement?.statementHashes || {},
            ...(summaryTouched ? { 'snapshot.generatedSummary': SUMMARY_SCRUBBED } : {}),
          },
        },
      ),
    );
  }

  let versionsScrubbed = 0;
  const versionFilter = [
    { 'snapshot.items.citations.sourceId': source._id },
    ...(claimObjectIds.length > 0
      ? [
          { 'snapshot.items.claimId': { $in: claimObjectIds } },
          { 'snapshot.alerts.claimIds': { $in: claimObjectIds } },
          { 'snapshot.recommendations.claimIds': { $in: claimObjectIds } },
          { 'snapshot.withheld.entries.claimId': { $in: claimObjectIds } },
          { 'snapshot.freshness.changes.claimId': { $in: claimObjectIds } },
        ]
      : []),
  ];
  const versions = await use(
    HandoverVersion.find({ project: project._id, $or: versionFilter }),
  ).lean();
  for (const version of versions) {
    const { snapshot, changed } = filterSnapshot(version.snapshot, source._id, claimIds);
    const summary = String(version.snapshot?.generatedSummary || '');
    const summaryTouched = changed || needles.some((needle) => summary.includes(needle));
    if (!changed && !summaryTouched) continue;
    versionsScrubbed += 1;
    await use(
      HandoverVersion.updateOne(
        { _id: version._id },
        {
          $set: {
            snapshot: summaryTouched
              ? { ...snapshot, generatedSummary: SUMMARY_SCRUBBED }
              : snapshot,
            reason: sanitizeVersionReason(version.reason),
          },
        },
      ),
    );
  }

  // Audit labels and metadata quote claim statements, topics and names. Scan
  // the project's trail for the purged ids and the purged words; a record that
  // matched either keeps its action and target but loses the free text.
  const referenceIds = [
    String(source._id),
    ...claimObjectIds.map(String),
    ...clarificationIds.map(String),
    ...documentIds.map(String),
  ];
  const auditEvents = await use(
    AuditEvent.find({ project: project._id }).select('_id targetType targetId targetLabel meta'),
  ).lean();
  const labelsByGroup = new Map();
  for (const event of auditEvents) {
    const haystack = `${event.targetId || ''}\n${event.targetLabel || ''}\n${JSON.stringify(
      event.meta || {},
    )}`;
    const referenced =
      referenceIds.some((id) => haystack.includes(id)) ||
      needles.some((needle) => haystack.includes(needle));
    if (!referenced) continue;
    const label = auditLabelFor(event.targetType);
    if (!labelsByGroup.has(label)) labelsByGroup.set(label, []);
    labelsByGroup.get(label).push(event._id);
  }
  for (const [label, ids] of labelsByGroup) {
    await use(
      AuditEvent.updateMany(
        { _id: { $in: ids } },
        { $set: { targetLabel: label, meta: {} } },
      ),
    );
  }

  // Removing a source can retire the claim that hid an older decision. The
  // supersession pass is re-run so the topic keeps an active statement.
  await linkSupersessions(project._id, { session });

  await use(
    Source.updateOne(
      { _id: source._id },
      {
        $set: {
          deletedAt: new Date(),
          statusMessage:
            'Source purged: stored text, evidence, files, handover items and clarification text deleted; its claims are retired with their text removed',
          files: [],
          ...(source.sync ? { 'sync.enabled': false } : {}),
        },
      },
    ),
  );

  return {
    documents: documentIds.length,
    evidence: evidence.deletedCount || 0,
    claimsRetired: claimObjectIds.length,
    handoverItemsRemoved,
    versionsScrubbed,
    clarificationsCleared: clarificationIds.length,
    feedbackScrubbed: feedback.modifiedCount || 0,
    auditEventsScrubbed: [...labelsByGroup.values()].reduce((sum, ids) => sum + ids.length, 0),
    handoverSummariesScrubbed: handoverSummariesScrubbed.size,
  };
}

/**
 * Erases every copy of a source's text: documents, evidence, claim text,
 * handover items and their historical version snapshots, clarification
 * prompts/options/answers, recipient feedback, audit labels and derived
 * summaries. The database work is one transaction where the server supports
 * it; the source row is kept, marked deleted, so the audit trail still
 * explains why items vanished.
 */
export async function purgeSourceContent({ project, source }) {
  const files = (source.files || []).map((file) => file.storedName).filter(Boolean);

  let stats;
  const transactional = await withOptionalTransaction(async (session) => {
    stats = await runPurge({ project, source, session });
  });

  for (const storedName of files) {
    await fs.unlink(path.join(env.uploadDir, path.basename(storedName))).catch(() => {});
  }

  // Removing content changes what a released handover should say, so any
  // remaining live handover is re-judged immediately.
  try {
    await refreshOutdatedHandovers({ projectId: project._id });
  } catch {
    // Freshness refresh must never roll back a completed purge.
  }

  return { ...stats, files: files.length, transactional };
}
