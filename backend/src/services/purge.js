import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import {
  AuditEvent,
  Claim,
  Clarification,
  Document,
  Evidence,
  Handover,
  HandoverVersion,
  Source,
} from '../models/index.js';
import { refreshOutdatedHandovers, sanitizeVersionReason } from './handover/workflow.js';

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

/**
 * Erases every copy of a source's text: documents, evidence, claim text,
 * handover items and their historical version snapshots, clarification
 * prompts/answers and the audit labels that quoted a claim. The source row is
 * kept, marked deleted, so the audit trail still explains why items vanished.
 */
export async function purgeSourceContent({ project, source }) {
  const documents = await Document.find({ source: source._id }).select('_id').lean();
  const documentIds = documents.map((document) => document._id);
  const claims = await Claim.find({ source: source._id }).select('_id').lean();
  const claimIds = new Set(claims.map((claim) => String(claim._id)));
  const claimObjectIds = claims.map((claim) => claim._id);

  const evidence = await Evidence.deleteMany({
    $or: [
      { source: source._id },
      ...(documentIds.length > 0 ? [{ document: { $in: documentIds } }] : []),
      ...(claimObjectIds.length > 0 ? [{ claim: { $in: claimObjectIds } }] : []),
    ],
  });

  if (documentIds.length > 0) {
    await Document.deleteMany({ _id: { $in: documentIds } });
  }

  if (claimObjectIds.length > 0) {
    // Blank the derived keys too: they are normalised copies of the text and
    // would otherwise answer a database search for the purged phrase.
    await Claim.updateMany(
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
    );
  }

  const clarifications = await Clarification.find({
    project: project._id,
    claim: { $in: claimObjectIds },
  })
    .select('_id')
    .lean();
  const clarificationIds = clarifications.map((entry) => entry._id);
  if (clarificationIds.length > 0) {
    await Clarification.updateMany(
      { _id: { $in: clarificationIds } },
      {
        $set: {
          status: 'closed',
          prompt: 'Question removed with its source',
          answerOptions: [],
          answer: null,
        },
        $unset: { declineNote: 1, resultClaim: 1 },
      },
    );
  }

  let handoverItemsRemoved = 0;
  const handovers = await Handover.find({ project: project._id }).lean();
  for (const handover of handovers) {
    const { snapshot, itemCount, changed } = filterSnapshot(handover, source._id, claimIds);
    if (!changed) continue;
    handoverItemsRemoved += itemCount;
    await Handover.updateOne(
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
        },
      },
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
  const versions = await HandoverVersion.find({
    project: project._id,
    $or: versionFilter,
  }).lean();
  for (const version of versions) {
    const { snapshot, changed } = filterSnapshot(version.snapshot, source._id, claimIds);
    if (!changed) continue;
    versionsScrubbed += 1;
    await HandoverVersion.updateOne(
      { _id: version._id },
      {
        $set: {
          snapshot,
          reason: sanitizeVersionReason(version.reason),
        },
      },
    );
  }

  if (claimObjectIds.length > 0) {
    await AuditEvent.updateMany(
      {
        project: project._id,
        targetType: 'claim',
        targetId: { $in: claimObjectIds },
      },
      { $set: { targetLabel: 'Purged claim', meta: {} } },
    );
  }
  if (clarificationIds.length > 0) {
    await AuditEvent.updateMany(
      {
        project: project._id,
        targetType: 'clarification',
        targetId: { $in: clarificationIds },
      },
      { $set: { targetLabel: 'Purged question', meta: {} } },
    );
  }

  for (const file of source.files || []) {
    if (!file.storedName) continue;
    await fs.unlink(path.join(env.uploadDir, path.basename(file.storedName))).catch(() => {});
  }
  const fileCount = (source.files || []).length;

  source.deletedAt = new Date();
  source.statusMessage =
    'Source purged: stored text, evidence, files, handover items and clarification text deleted; its claims are retired with their text removed';
  source.files = [];
  if (source.sync) source.sync.enabled = false;
  await source.save();

  // Removing content changes what a released handover should say, so any
  // remaining live handover is re-judged immediately.
  try {
    await refreshOutdatedHandovers({ projectId: project._id });
  } catch {
    // Freshness refresh must never roll back a completed purge.
  }

  return {
    documents: documentIds.length,
    evidence: evidence.deletedCount || 0,
    claimsRetired: claimObjectIds.length,
    handoverItemsRemoved,
    versionsScrubbed,
    clarificationsCleared: clarificationIds.length,
    files: fileCount,
  };
}
