import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { truncate } from '../../lib/text.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { redactText } from '../../lib/redaction.js';
import {
  AuditEvent,
  Claim,
  Delivery,
  Evidence,
  Handover,
  HandoverFeedback,
  HandoverVersion,
  Project,
  Source,
  User,
} from '../../models/index.js';
import { canContribute, canManageProject, claimVisibleTo, isIncoming, roleOf, sourceVisibleTo } from '../access/policy.js';
import { recordAudit } from '../audit.js';
import { deliverOutbound } from '../delivery.js';
import { leadIds, notify } from '../notifications.js';
import { loadVisibleClaims } from '../projectState.js';
import { reconstructState, summarizeCounts } from '../reconstruction/state.js';
import {
  TEMPLATES,
  buildComposition,
  buildItemForClaim,
  itemContentHash,
  templateIncludes,
} from './compose.js';

export async function loadSourceMap(projectId) {
  const sources = await Source.find({ project: projectId }).lean();
  return new Map(sources.map((source) => [String(source._id), source]));
}

export function shareIsActive(handover, now = Date.now()) {
  if (!handover.shareTokenHash || !handover.shareExpiresAt) return false;
  return new Date(handover.shareExpiresAt).getTime() > now;
}

export function handoverAccess({ handover, project, user }) {
  const role = roleOf(project, user._id);
  const isRecipient = String(handover.recipient) === String(user._id);
  const isCreator = String(handover.createdBy) === String(user._id);
  const isLead = canManageProject(project, user);
  // A cancelled or expired link must close the recipient's own route in as
  // well as the token route, otherwise the link can be bypassed by signing in.
  const recipientMayView =
    isRecipient &&
    ['shared', 'acknowledged'].includes(handover.status) &&
    shareIsActive(handover);
  // An incoming recipient only ever receives. Drafts or handovers they
  // authored under the old, looser seat are not theirs to read anymore.
  const canView = isIncoming(project, user._id)
    ? recipientMayView
    : isCreator || isLead || recipientMayView;
  return {
    role,
    isRecipient,
    isCreator,
    isLead,
    canView,
  };
}

export function renderItem(item, { recipient }) {
  // Redaction also runs at read time so drafts created before the hardening
  // pass, and reviewer-written text, cannot bypass it.
  const statement = redactText(
    (item.decision === 'edited' ? item.editedStatement : item.statement) || '',
  ).text;
  const originalStatement =
    item.decision === 'edited' ? redactText(item.statement || '').text : undefined;
  return {
    claimId: item.claimId,
    type: item.type,
    statement,
    originalStatement,
    topic: item.topic,
    status: item.status,
    state: item.state,
    confidence: item.confidence,
    sensitivity: item.sensitivity,
    ownerName: item.ownerName,
    ownerUserId: item.ownerUser ? String(item.ownerUser) : null,
    dueAt: item.dueAt,
    occurredAt: item.occurredAt,
    origin: item.origin || 'document',
    confirmedByName: item.confirmedByName,
    confirmedAt: item.confirmedAt,
    restrictedToRecipient: recipient ? undefined : Boolean(item.restrictedToRecipient),
    hasSourceDate: item.hasSourceDate !== false,
    flags: item.flags || [],
    conflicting: Boolean(item.conflicting),
    redactionCount: item.redactionCount || 0,
    resolutionNote: item.resolutionNote ? redactText(item.resolutionNote).text : null,
    resolutionByName: item.resolutionByName || null,
    decision: item.decision,
    changedSinceReview: Boolean(item.changedSinceReview),
    previousDecision: item.previousDecision || undefined,
    acceptedWithoutEvidence: Boolean(item.acceptedWithoutEvidence),
    reviewerNote: recipient ? undefined : item.reviewerNote,
    citations: (item.citations || []).map((citation) => ({
      evidenceId: citation.evidenceId,
      documentId: citation.documentId,
      sourceId: citation.sourceId,
      sourceName: citation.sourceName,
      sourceKind: citation.sourceKind,
      docTitle: citation.docTitle,
      quote: redactText(citation.quote || '').text,
      charStart: citation.charStart,
      charEnd: citation.charEnd,
      validation: citation.validation,
      locator: citation.locator,
      occurredAt: citation.occurredAt,
    })),
  };
}

function citationsVisibleTo(items, sourceById, project, userId) {
  const hidden = [];
  for (const item of items) {
    const visible = (item.citations || []).every((citation) =>
      sourceVisibleTo(sourceById.get(String(citation.sourceId)), project, userId),
    );
    if (!visible) hidden.push(item);
  }
  return hidden;
}

async function claimVisibilityFor({ project, sourceById, userId, claimIds }) {
  const visibility = new Map();
  if (claimIds.length === 0) return visibility;
  const claims = await Claim.find({
    _id: { $in: claimIds },
    project: project._id,
  })
    .select('_id')
    .lean();
  const evidence = await Evidence.find({ claim: { $in: claims.map((claim) => claim._id) } }).lean();
  const evidenceByClaim = new Map();
  for (const entry of evidence) {
    const key = String(entry.claim);
    if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
    evidenceByClaim.get(key).push(entry);
  }
  for (const claim of claims) {
    visibility.set(
      String(claim._id),
      claimVisibleTo({
        evidence: evidenceByClaim.get(String(claim._id)) || [],
        sourceById,
        project,
        userId,
      }),
    );
  }
  return visibility;
}

/**
 * Withheld counts are recomputed against the viewer's own visibility. A lead
 * must not learn how many items sit inside a source they cannot open; entries
 * they can read are counted, everything else is omitted entirely.
 */
async function withheldForViewer({ handover, project, sourceById, userId }) {
  const entries = handover.withheld?.entries || [];
  const result = {
    total: 0,
    byType: {},
    byReason: { permissions: 0, author_permissions: 0, template: 0, unverified: 0 },
  };
  if (entries.length === 0) return result;

  const claimIds = [...new Set(entries.map((entry) => String(entry.claimId || '')))].filter(
    (id) => id && id !== 'undefined',
  );
  const visibility = await claimVisibilityFor({ project, sourceById, userId, claimIds });

  for (const entry of entries) {
    if (!entry.claimId || visibility.get(String(entry.claimId)) !== true) continue;
    result.total += 1;
    result.byType[entry.claimType] = (result.byType[entry.claimType] || 0) + 1;
    if (entry.reason in result.byReason) result.byReason[entry.reason] += 1;
  }
  return result;
}

/**
 * Freshness changes are stored from the pipeline's view. Filter them against
 * the requesting reviewer so a stored change can never quote a claim whose
 * source that reviewer may not open.
 */
async function freshnessForViewer({ handover, project, sourceById, userId }) {
  const stored = handover.freshness || { status: 'current' };
  const changes = stored.changes || [];
  if (changes.length === 0) return { ...stored, changes: [] };

  const claimIds = [...new Set(changes.map((change) => String(change.claimId || '')))].filter(
    (id) => id && id !== 'undefined',
  );
  const visibility = await claimVisibilityFor({ project, sourceById, userId, claimIds });

  const filtered = [];
  for (const change of changes) {
    if (visibility.get(String(change.claimId)) !== true) continue;
    filtered.push({
      claimId: change.claimId,
      type: change.type,
      statement: redactText(change.statement || '').text,
      change: change.change,
      reason: change.reason,
      fields: (change.fields || []).map((field) => ({
        field: field.field,
        from:
          field.from == null ? field.from : redactText(String(field.from)).text,
        to: field.to == null ? field.to : redactText(String(field.to)).text,
      })),
    });
  }
  return { ...stored, changes: filtered };
}

/**
 * Reviewer view. The author and every lead see only the items, alerts and
 * recommendations whose evidence sources they may read themselves. Counts are
 * recomputed over that filtered set so they never describe hidden content.
 */
export async function buildReviewerView({ handover, project, user }) {
  if (!roleOf(project, user._id)) {
    throw forbidden('You do not have access to this handover');
  }
  const sourceById = await loadSourceMap(project._id);
  const allItems = handover.items || [];
  const visibleItems = allItems.filter((item) =>
    (item.citations || []).every((citation) =>
      sourceVisibleTo(sourceById.get(String(citation.sourceId)), project, user._id),
    ),
  );
  const hiddenItems = allItems.length - visibleItems.length;

  const withheld = await withheldForViewer({
    handover,
    project,
    sourceById,
    userId: user._id,
  });

  const referencedIds = new Set();
  for (const entry of [...(handover.recommendations || []), ...(handover.alerts || [])]) {
    for (const id of entry.claimIds || []) referencedIds.add(String(id));
  }
  const referenceVisibility = await claimVisibilityFor({
    project,
    sourceById,
    userId: user._id,
    claimIds: [...referencedIds],
  });

  const visibleItemIds = new Set(visibleItems.map((item) => String(item.claimId)));
  const referencesVisible = (entry) =>
    (entry.claimIds || []).length === 0
      ? true
      : entry.claimIds.every(
          (id) =>
            referenceVisibility.get(String(id)) === true && visibleItemIds.has(String(id)),
        );

  const recommendations = (handover.recommendations || []).filter(referencesVisible);
  const alerts = (handover.alerts || [])
    .filter(referencesVisible)
    .map((alert) => {
      const plain = typeof alert.toObject === 'function' ? alert.toObject() : alert;
      if (plain.code === 'restricted_items_excluded') {
        const count = withheld.byReason.permissions + withheld.byReason.author_permissions;
        if (count === 0) return null;
        return {
          ...plain,
          message: `${count} item(s) in this handover were excluded because the author or the recipient is not authorized to read their source. Details are intentionally not shown.`,
        };
      }
      if (plain.code === 'confirmed_answers_unshared') {
        // The stored count came from the author's view; keep the reminder but
        // never repeat a number this reviewer cannot verify.
        return {
          ...plain,
          message:
            'Some confirmed answers are withheld until a lead shares them with the project. Use the share action on the matching item.',
        };
      }
      return plain;
    })
    .filter(Boolean);

  const [feedbackRows, deliveryRows] = await Promise.all([
    HandoverFeedback.find({ handover: handover._id }).sort({ createdAt: -1 }).limit(50).lean(),
    Delivery.find({ handover: handover._id }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  // The stored snapshot was captured from the author's view. Recompute every
  // aggregate from claims this reviewer may read so no number or sentence
  // describes a source they cannot open.
  const { claims: reviewerClaims } = await loadVisibleClaims({
    project,
    userId: user._id,
  });
  const reviewerState = reconstructState({
    project,
    claims: reviewerClaims,
    staleDays: env.staleDays,
  });
  const reviewerSnapshot = {
    ...handover.snapshot,
    counts: reviewerState.counts,
    phase: reviewerState.phase,
    readinessScore: reviewerState.readinessScore,
    lastActivityAt: reviewerState.lastActivityAt,
    activityWindow: reviewerState.activityWindow,
    generatedSummary: `Handover for ${
      handover.recipientSnapshot?.name || 'the recipient'
    }: ${summarizeCounts(reviewerState)}`,
  };
  const freshness = await freshnessForViewer({
    handover,
    project,
    sourceById,
    userId: user._id,
  });

  return {
    id: handover._id,
    projectId: handover.project,
    recipient: handover.recipient,
    recipientSnapshot: handover.recipientSnapshot,
    roleTemplate: handover.roleTemplate,
    status: handover.status,
    version: handover.version,
    createdBy: handover.createdBy,
    createdBySnapshot: handover.createdBySnapshot,
    createdAt: handover.createdAt,
    updatedAt: handover.updatedAt,
    reviewer: handover.reviewer,
    approvedAt: handover.approvedAt,
    approvedBySnapshot: handover.approvedBySnapshot,
    rejectedAt: handover.rejectedAt,
    rejectionNote: handover.rejectionNote,
    reopenedAt: handover.reopenedAt,
    sharedAt: handover.sharedAt,
    shareOpenedAt: handover.shareOpenedAt || null,
    shareLastOpenedAt: handover.shareLastOpenedAt || null,
    shareOpenCount: handover.shareOpenCount || 0,
    reminderSentAt: handover.reminderSentAt || null,
    acknowledgedAt: handover.acknowledgedAt,
    shareExpiresAt: handover.shareExpiresAt,
    // Only a hash is stored, so the link itself is released once by the share
    // response and cannot be recovered by reading the handover later.
    sharePath: null,
    shareActive: Boolean(handover.shareTokenHash),
    shareRevokedAt: handover.revokedAt || null,
    shareRevokedReason: handover.revokedReason || null,
    feedback: feedbackRows.map((row) => ({
      id: row._id,
      claimId: row.claimId || null,
      authorName: row.authorSnapshot?.name || 'Recipient',
      authorRole: row.authorSnapshot?.role || null,
      message: row.message,
      status: row.status,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt || null,
      resolutionNote: row.resolutionNote || null,
    })),
    deliveries: deliveryRows.map((row) => ({
      id: row._id,
      kind: row.kind,
      channel: row.channel,
      status: row.status,
      detail: row.detail,
      createdAt: row.createdAt,
    })),
    items: visibleItems.map((item) => renderItem(item, { recipient: false })),
    alerts,
    recommendations,
    withheld,
    viewerLimits: {
      someItemsHiddenByPermissions: hiddenItems > 0,
      note:
        hiddenItems > 0
          ? 'Some items are hidden because you are not authorized to read their source. Counts below include only items you can read.'
          : undefined,
    },
    redactions: {
      count: handover.redactions?.count || 0,
      kinds: handover.redactions?.kinds || [],
    },
    snapshot: reviewerSnapshot,
    generation: handover.generation,
    permissionsCheckedAt: handover.permissionsCheckedAt,
    lastAccessedAt: handover.lastAccessedAt,
    freshness,
    counts: summarizeReview({ items: visibleItems }),
  };
}

export function summarizeReview(handover) {
  const items = handover.items || [];
  return {
    total: items.length,
    pending: items.filter((item) => item.decision === 'pending').length,
    accepted: items.filter((item) => item.decision === 'accepted').length,
    edited: items.filter((item) => item.decision === 'edited').length,
    rejected: items.filter((item) => item.decision === 'rejected').length,
    withoutEvidence: items.filter((item) => item.acceptedWithoutEvidence).length,
  };
}

function itemSourceRemoved(item, sourceById) {
  const citations = item.citations || [];
  if (citations.length === 0) return false;
  return citations.some((citation) => {
    const source = sourceById.get(String(citation.sourceId));
    return !source || Boolean(source.deletedAt);
  });
}

/**
 * The stored freshness diff was captured from the author's view, so it may
 * quote statements whose source the recipient can no longer open. Re-check
 * each changed claim against the recipient's live permissions and drop the
 * text of anything they are not entitled to read.
 */
async function recipientFreshness({ handover, sourceById, project, userId }) {
  const freshness = handover.freshness || { status: 'current' };
  const changes = freshness.changes || [];
  const base = {
    status: freshness.status,
    checkedAt: freshness.checkedAt,
    outdatedAt: freshness.outdatedAt,
  };
  if (changes.length === 0) return { ...base, changes: [] };

  const claimIds = [
    ...new Set(changes.map((entry) => entry.claimId).filter(Boolean).map(String)),
  ];
  const claims = await Claim.find({ _id: { $in: claimIds }, project: project._id })
    .select('_id status')
    .lean();
  const evidence = await Evidence.find({ claim: { $in: claims.map((claim) => claim._id) } }).lean();
  const evidenceByClaim = new Map();
  for (const entry of evidence) {
    const key = String(entry.claim);
    if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
    evidenceByClaim.get(key).push(entry);
  }
  const visibleById = new Map(
    claims.map((claim) => [
      String(claim._id),
      claim.status !== 'superseded' &&
        claimVisibleTo({
          evidence: evidenceByClaim.get(String(claim._id)) || [],
          sourceById,
          project,
          userId,
        }),
    ]),
  );

  return {
    ...base,
    changes: changes.map((entry) => {
      if (visibleById.get(String(entry.claimId)) === true) return { ...entry };
      return {
        claimId: entry.claimId,
        type: entry.type,
        change: entry.change,
        reason: entry.reason,
        statement: null,
        withheld: true,
      };
    }),
  };
}

/**
 * Recipient view. Permissions are re-evaluated at read time, not trusted from
 * the moment the handover was generated: a source that became restricted (or a
 * recipient removed from the project) immediately removes the linked items.
 * Item statuses and owners are also refreshed from the live claims so the
 * recipient never acts on a snapshot the project has already moved past.
 */
export async function buildRecipientView({ handover, project, user, req, auditActor }) {
  if (!roleOf(project, user._id)) {
    throw forbidden('You do not have access to this handover');
  }
  const sourceById = await loadSourceMap(project._id);
  const items = [];
  let revoked = 0;
  let supersededItems = 0;
  let changedItemCount = 0;
  const removed = {
    permissions: 0,
    source_removed: 0,
    superseded: 0,
    evidence_missing: 0,
  };

  const itemClaimIds = (handover.items || [])
    .map((item) => item.claimId)
    .filter(Boolean);
  const liveClaims = await Claim.find({ _id: { $in: itemClaimIds }, project: project._id })
    .select('_id status ownerName ownerUser retiredAt')
    .lean();
  const liveById = new Map(
    liveClaims.map((claim) => [
      String(claim._id),
      {
        status: claim.status,
        ownerName: claim.ownerName || null,
        ownerUserId: claim.ownerUser ? String(claim.ownerUser) : null,
        retired: Boolean(claim.retiredAt),
      },
    ]),
  );

  for (const item of handover.items || []) {
    if (!['accepted', 'edited'].includes(item.decision)) continue;

    // A retired claim (source removed or re-ingested away) or a conflict
    // resolution that superseded this statement must not reach the recipient.
    const live = liveById.get(String(item.claimId));
    if (!live || live.retired) {
      supersededItems += 1;
      removed[itemSourceRemoved(item, sourceById) ? 'source_removed' : 'superseded'] += 1;
      continue;
    }
    if (live.status === 'superseded') {
      supersededItems += 1;
      removed.superseded += 1;
      continue;
    }

    const allVisible = (item.citations || []).every((citation) =>
      sourceVisibleTo(sourceById.get(String(citation.sourceId)), project, user._id),
    );
    if (!allVisible) {
      revoked += 1;
      removed.permissions += 1;
      continue;
    }

    const hasVerifiedEvidence = (item.citations || []).some(
      (citation) => citation.validation !== 'failed',
    );
    if (!hasVerifiedEvidence && !item.acceptedWithoutEvidence) {
      revoked += 1;
      removed.evidence_missing += 1;
      continue;
    }

    const rendered = renderItem(item, { recipient: true });
    const statusChanged = live.status !== item.status;
    const ownerNameChanged = live.ownerName !== (item.ownerName || null);
    const ownerIdChanged =
      live.ownerUserId !== (item.ownerUser ? String(item.ownerUser) : null);
    const ownerChanged = ownerNameChanged || ownerIdChanged;
    if (statusChanged || ownerChanged) changedItemCount += 1;
    rendered.status = live.status;
    rendered.ownerName = live.ownerName;
    rendered.ownerUserId = live.ownerUserId;
    rendered.changedSinceApproval = statusChanged || ownerChanged;
    rendered.previousStatus = statusChanged ? item.status : undefined;
    rendered.previousOwnerName = ownerNameChanged ? item.ownerName || null : undefined;
    items.push(rendered);
  }

  const checkedAt = new Date();
  const hasChanges = revoked > 0 || supersededItems > 0 || changedItemCount > 0;

  // The snapshot was captured from the author's view. Rebuild its counts and
  // summary from claims this recipient may read so no aggregate describes a
  // source they cannot open.
  const { claims: recipientClaims } = await loadVisibleClaims({
    project,
    userId: user._id,
  });
  const recipientState = reconstructState({
    project,
    claims: recipientClaims,
    staleDays: env.staleDays,
  });
  const recipientSnapshot = {
    ...handover.snapshot,
    counts: recipientState.counts,
    phase: recipientState.phase,
    readinessScore: recipientState.readinessScore,
    lastActivityAt: recipientState.lastActivityAt,
    activityWindow: recipientState.activityWindow,
    generatedSummary: `Handover for ${
      handover.recipientSnapshot?.name || user.name
    }: ${summarizeCounts(recipientState)}`,
  };

  // Alerts and recommendations quote claim statements, so they are re-filtered
  // against live source permissions alongside the items themselves.
  const referencedIds = new Set();
  for (const entry of [...(handover.recommendations || []), ...(handover.alerts || [])]) {
    for (const id of entry.claimIds || []) referencedIds.add(String(id));
  }
  const referenceVisibility = new Map();
  if (referencedIds.size > 0) {
    const claims = await Claim.find({
      _id: { $in: [...referencedIds] },
      project: project._id,
    })
      .select('_id')
      .lean();
    const evidence = await Evidence.find({
      claim: { $in: claims.map((claim) => claim._id) },
    }).lean();
    const evidenceByClaim = new Map();
    for (const entry of evidence) {
      const key = String(entry.claim);
      if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
      evidenceByClaim.get(key).push(entry);
    }
    for (const claim of claims) {
      referenceVisibility.set(
        String(claim._id),
        claimVisibleTo({
          evidence: evidenceByClaim.get(String(claim._id)) || [],
          sourceById,
          project,
          userId: user._id,
        }),
      );
    }
  }
  const referencesVisible = (entry) =>
    (entry.claimIds || []).every((id) => referenceVisibility.get(String(id)) === true);

  const recommendations = (handover.recommendations || [])
    .filter(referencesVisible)
    .map((entry) => {
      const plain = typeof entry.toObject === 'function' ? entry.toObject() : entry;
      return {
        ...plain,
        title: redactText(plain.title || '').text,
        reason: plain.reason ? redactText(plain.reason).text : plain.reason,
      };
    });
  const alerts = (handover.alerts || [])
    .filter((alert) => alert.audience === 'recipient' && referencesVisible(alert))
    .map((alert) => {
      const plain = typeof alert.toObject === 'function' ? alert.toObject() : alert;
      return { ...plain, message: redactText(plain.message || '').text };
    });

  const recipientName = String(handover.recipientSnapshot?.name || user.name || '')
    .trim()
    .toLowerCase();
  const recipientId = String(user._id);
  const mini = (item) => ({
    claimId: item.claimId,
    type: item.type,
    statement: item.statement,
    status: item.status,
    ownerName: item.ownerName,
    ownerUserId: item.ownerUser ? String(item.ownerUser) : null,
    dueAt: item.dueAt,
    changedSinceApproval: Boolean(item.changedSinceApproval),
  });
  const firstWeek = {
    windowDays: 7,
    // Items imported before owner accounts were linked only carry a name, so
    // the fallback keeps their "you own this" board working until re-ingest.
    youOwn: items
      .filter((item) =>
        item.ownerUser
          ? String(item.ownerUser) === recipientId
          : Boolean(item.ownerName) && item.ownerName.trim().toLowerCase() === recipientName,
      )
      .map(mini),
    blocked: items.filter((item) => item.status === 'blocked').map(mini),
    doFirst: recommendations.slice(0, 3).map((entry) => ({
      kind: entry.kind,
      priority: entry.priority,
      title: entry.title,
      reason: entry.reason,
      claimIds: entry.claimIds,
      inferred: true,
    })),
  };

  await Handover.updateOne({ _id: handover._id }, { $set: { lastAccessedAt: checkedAt } });

  // One audit row per recipient per hour: a recipient reloading the page is
  // normal use, not a new event. Anonymous demo visitors share that window
  // and are never attributed to the recipient's account.
  const auditViewer = auditActor === undefined ? user : auditActor;
  const auditWindowStart = new Date(checkedAt.getTime() - 3_600_000);
  const recentView = await AuditEvent.findOne({
    project: project._id,
    action: 'handover.recipient_viewed',
    targetId: handover._id,
    createdAt: { $gte: auditWindowStart },
  })
    .select('_id')
    .lean();

  if (!recentView) {
    await recordAudit({
      projectId: project._id,
      actor: auditViewer || { name: 'Anonymous share-link visitor' },
      action: 'handover.recipient_viewed',
      targetType: 'handover',
      targetId: handover._id,
      targetLabel: `Handover v${handover.version}`,
      meta: {
        revokedItems: revoked,
        supersededItems,
        changedItemCount,
        anonymous: !auditViewer,
      },
      req,
    });
  }

  if (revoked > 0 || supersededItems > 0 || changedItemCount > 0) {
    const recentCheck = await AuditEvent.findOne({
      project: project._id,
      action: 'handover.permissions_rechecked',
      targetId: handover._id,
      createdAt: { $gte: auditWindowStart },
    })
      .select('_id')
      .lean();

    if (recentCheck) {
      // Fold repeated rechecks into the hour's row instead of writing one
      // event per open; the latest counts stay accurate.
      await AuditEvent.updateOne(
        { _id: recentCheck._id },
        {
          $inc: { 'meta.rechecks': 1 },
          $set: {
            'meta.revokedItems': revoked,
            'meta.supersededItems': supersededItems,
            'meta.changedItemCount': changedItemCount,
            'meta.removed': removed,
            'meta.lastCheckedAt': checkedAt,
          },
        },
      );
    } else {
      await recordAudit({
        projectId: project._id,
        actor: { name: 'threadline-permissions' },
        action: 'handover.permissions_rechecked',
        targetType: 'handover',
        targetId: handover._id,
        targetLabel: `Handover v${handover.version}`,
        meta: {
          revokedItems: revoked,
          supersededItems,
          changedItemCount,
          removed,
          rechecks: 1,
          firstCheckedAt: checkedAt,
          lastCheckedAt: checkedAt,
          reason: 'Access re-evaluated when the recipient opened the handover',
        },
        req,
      });
    }
  }

  const freshness = await recipientFreshness({
    handover,
    sourceById,
    project,
    userId: user._id,
  });

  return {
    id: handover._id,
    projectId: handover.project,
    recipientSnapshot: handover.recipientSnapshot,
    createdBySnapshot: handover.createdBySnapshot,
    roleTemplate: handover.roleTemplate,
    status: handover.status,
    version: handover.version,
    approvedAt: handover.approvedAt,
    sharedAt: handover.sharedAt,
    acknowledgedAt: handover.acknowledgedAt,
    items,
    alerts,
    recommendations,
    firstWeek,
    redactions: {
      count: handover.redactions?.count || 0,
      kinds: handover.redactions?.kinds || [],
    },
    snapshot: recipientSnapshot,
    freshness,
    // The acknowledgement record belongs to the recipient, but its revoked
    // list names items they may no longer read. Keep only what they saw and
    // the integrity hashes of those statements.
    acknowledgement: handover.acknowledgement
      ? {
          at: handover.acknowledgement.at,
          version: handover.acknowledgement.version,
          shownItemIds: handover.acknowledgement.shownItemIds || [],
          statementHashes: handover.acknowledgement.statementHashes || {},
        }
      : {},
    permissionRecheck: {
      checkedAt,
      // Deliberately no numeric counts: a number would describe items the
      // recipient may not read. Per-item "changed since approval" labels below
      // carry the detail they are entitled to.
      contentChanged: hasChanges,
      note: hasChanges
        ? 'Some items changed since this handover was approved. The current state may differ from what you acknowledged.'
        : undefined,
    },
  };
}

/**
 * Re-evaluates every live handover after connected-source content changed and
 * records an outdated status with a readable diff. Runs as the pipeline, using
 * the recipient's visibility so the stored diff matches what they would see.
 */
export async function refreshOutdatedHandovers({ projectId, req } = {}) {
  const project = await Project.findById(projectId);
  if (!project) return 0;

  const handovers = await Handover.find({
    project: project._id,
    status: { $in: ['draft', 'in_review', 'approved', 'shared', 'acknowledged'] },
  });

  let transitioned = 0;
  for (const handover of handovers) {
    const comparison = await compareHandover({ handover, project });
    const wasOutdated = handover.freshness?.status === 'outdated';

    if (!comparison.changed) {
      if (wasOutdated) {
        handover.freshness = { status: 'current', checkedAt: comparison.checkedAt, changes: [] };
        await handover.save();
      }
      continue;
    }

    handover.freshness = {
      status: 'outdated',
      checkedAt: comparison.checkedAt,
      outdatedAt: handover.freshness?.outdatedAt || new Date(),
      changes: comparison.changes.slice(0, 25),
    };
    await handover.save();

    if (!wasOutdated) {
      transitioned += 1;
      await recordAudit({
        projectId: project._id,
        actor: { name: 'threadline-sync' },
        action: 'handover.marked_outdated',
        targetType: 'handover',
        targetId: handover._id,
        targetLabel: `Handover v${handover.version}`,
        meta: comparison.counts,
        req,
      });

      // A draft nobody has seen yet does not need a notification; only a
      // handover that is in review or already released to the recipient does.
      if (handover.status !== 'draft') {
        await notify({
          project,
          recipients: [...leadIds(project), String(handover.createdBy)],
          type: 'handover.outdated',
          entityType: 'handover',
          entityId: handover._id,
        });
      }
    }
  }
  return transitioned;
}

export async function saveVersion(handover, actor, reason, { changedClaimIds } = {}) {
  handover.version = (handover.version || 0) + 1;
  await handover.save();

  // Only per-item review actions ask for a diff. A diff stores the changed
  // items instead of repeating all N items (and their quotes) in every row;
  // versionDiff rebuilds the full list by walking the chain.
  let snapshot = handover.toObject();
  if (Array.isArray(changedClaimIds)) {
    const changed = new Set(changedClaimIds.map(String));
    snapshot = {
      ...snapshot,
      items: (snapshot.items || []).filter((item) => changed.has(String(item.claimId))),
      diff: true,
    };
  }

  const row = {
    handover: handover._id,
    project: handover.project,
    version: handover.version,
    reason,
    actor: actor._id,
    actorName: actor.name,
    snapshot,
  };
  try {
    await HandoverVersion.create(row);
  } catch (error) {
    // Two saves that raced past the read produced the same version number.
    // Move this write to the next free number instead of losing its history.
    if (error?.code !== 11000) throw error;
    handover.version += 1;
    await handover.save();
    await HandoverVersion.create({ ...row, version: handover.version });
  }
}

export function findItem(handover, claimId) {
  const item = (handover.items || []).find(
    (entry) => String(entry.claimId) === String(claimId),
  );
  if (!item) throw notFound('That item is not part of this handover');
  return item;
}

/**
 * A recipient-ineligible confirmed answer is withheld from the draft, so it
 * has no item row to review. This is the explicit lead action that shares its
 * source with the project and then adds the item back for review.
 */
async function shareWithheldConfirmation({ handover, project, actor, claimId }) {
  if (!canManageProject(project, actor)) {
    throw forbidden('Only a project lead can share a confirmed answer with the whole project');
  }
  const claim = await Claim.findOne({
    _id: claimId,
    project: project._id,
    retiredAt: null,
  });
  if (!claim || claim.origin !== 'person_confirmed') {
    throw notFound('That item is not part of this handover');
  }

  const evidence = await Evidence.find({ claim: claim._id }).select('source').lean();
  const sourceIds = [...new Set(evidence.map((entry) => String(entry.source)))];
  const confirmationSources = await Source.find({
    _id: { $in: sourceIds },
    project: project._id,
    kind: 'confirmation',
    deletedAt: null,
  });
  if (confirmationSources.length === 0) {
    throw badRequest('This item is not backed by a confirmed answer');
  }

  await Source.updateMany(
    { _id: { $in: confirmationSources.map((source) => source._id) } },
    { $set: { visibility: { scope: 'project', roles: [], users: [] } } },
  );

  const item = await buildItemForClaim({ project, claimId: claim._id });
  if (!item) throw notFound('That item is not part of this handover');
  item.restrictedToRecipient = false;
  handover.items.push(item);

  const entries = (handover.withheld?.entries || []).filter(
    (entry) => String(entry.claimId) !== String(claim._id),
  );
  if (handover.withheld) {
    const byType = {};
    const byReason = { permissions: 0, author_permissions: 0, template: 0, unverified: 0 };
    for (const entry of entries) {
      byType[entry.claimType] = (byType[entry.claimType] || 0) + 1;
      if (entry.reason in byReason) byReason[entry.reason] += 1;
    }
    handover.withheld.entries = entries;
    handover.withheld.total = entries.length;
    handover.withheld.byType = byType;
    handover.withheld.byReason = byReason;
    handover.alerts = (handover.alerts || []).filter(
      (alert) => alert.code !== 'confirmed_answers_unshared',
    );
    if (byReason.permissions > 0) {
      handover.alerts.push({
        code: 'confirmed_answers_unshared',
        severity: 'info',
        message:
          'Some answers are withheld until a lead shares them with the project.',
        audience: 'reviewer',
      });
    }
  }

  return item;
}

export async function reviewItem({
  handover,
  project,
  actor,
  claimId,
  decision,
  editedStatement,
  note,
  shareWithProject = false,
  req,
  persist = true,
}) {
  if (!['draft', 'in_review'].includes(handover.status)) {
    throw badRequest(`Cannot review items while the handover is ${handover.status}`);
  }

  const options = ['accepted', 'rejected', 'edited', 'pending'];
  if (!options.includes(decision)) {
    throw badRequest(`decision must be one of: ${options.join(', ')}`);
  }

  let item = (handover.items || []).find(
    (entry) => String(entry.claimId) === String(claimId),
  );
  if (!item) {
    if (!shareWithProject) throw notFound('That item is not part of this handover');
    item = await shareWithheldConfirmation({ handover, project, actor, claimId });
  }

  const sourceById = await loadSourceMap(project._id);
  const hidden = citationsVisibleTo([item], sourceById, project, actor._id);
  if (hidden.length > 0) {
    throw forbidden('You cannot review an item whose evidence you are not authorized to read');
  }

  const hasVerifiedEvidence = (item.citations || []).some(
    (citation) => citation.validation !== 'failed',
  );

  // Accepting something no verbatim quote supports is allowed, but the
  // reviewer must say why. The recipient sees that it was accepted without
  // evidence rather than it silently looking verified.
  if (
    ['accepted', 'edited'].includes(decision) &&
    !hasVerifiedEvidence &&
    !String(note ?? '').trim()
  ) {
    throw badRequest(
      'A note is required when accepting an item that has no verified source quote',
    );
  }

  if (decision === 'edited') {
    const statement = String(editedStatement ?? '').trim().slice(0, 1200);
    if (!statement) throw badRequest('editedStatement is required when decision is "edited"');
    const redacted = redactText(statement);
    item.decision = 'edited';
    item.editedStatement = redacted.text;
    if (redacted.count > 0) item.redactionCount = (item.redactionCount || 0) + redacted.count;
    item.acceptedWithoutEvidence = !hasVerifiedEvidence;
  } else if (decision === 'accepted') {
    item.decision = 'accepted';
    item.editedStatement = undefined;
    item.acceptedWithoutEvidence = !hasVerifiedEvidence;
  } else if (decision === 'pending') {
    item.decision = 'pending';
    item.editedStatement = undefined;
    item.acceptedWithoutEvidence = false;
  } else {
    item.decision = 'rejected';
    item.editedStatement = undefined;
    item.acceptedWithoutEvidence = false;
  }

  item.reviewerNote = note ? String(note).slice(0, 600) : undefined;
  // Remembers exactly what was reviewed, so a regenerated draft can carry this
  // decision only while the statement, status, owner and evidence are unchanged.
  if (decision === 'pending') {
    item.reviewedHash = undefined;
  } else {
    item.reviewedHash = itemContentHash(item);
  }

  if (shareWithProject) {
    if (!['accepted', 'edited'].includes(item.decision)) {
      throw badRequest('Share a confirmed answer only after accepting or editing the item');
    }
    if (!canManageProject(project, actor)) {
      throw forbidden('Only a project lead can share a confirmed answer with the whole project');
    }
    const evidence = await Evidence.find({ claim: item.claimId }).select('source').lean();
    const sourceIds = [...new Set(evidence.map((entry) => String(entry.source)))];
    const confirmationSources = await Source.find({
      _id: { $in: sourceIds },
      project: project._id,
      kind: 'confirmation',
      deletedAt: null,
    });
    if (confirmationSources.length === 0) {
      throw badRequest('This item is not backed by a confirmed answer');
    }
    await Source.updateMany(
      { _id: { $in: confirmationSources.map((source) => source._id) } },
      { $set: { visibility: { scope: 'project', roles: [], users: [] } } },
    );
    item.restrictedToRecipient = false;

    await recordAudit({
      projectId: project._id,
      actor,
      action: 'claim.shared_with_project',
      targetType: 'claim',
      targetId: claimId,
      targetLabel: truncate(item.statement || '', 120),
      meta: { sourceIds },
      req,
      critical: true,
    });
  }

  // Versions are readable by anyone who can see this handover, including
  // people who cannot read this item's source. The reason names the decision
  // and claim only; the statement is rendered at read time through the
  // viewer's visibility filter. A bulk call writes one diff version for all
  // the decisions it applied instead of one per item.
  if (persist) {
    await saveVersion(handover, actor, `${decision} item ${claimId}`, {
      changedClaimIds: [claimId],
    });

    await recordAudit({
      projectId: project._id,
      actor,
      action: 'handover.item_reviewed',
      targetType: 'handover',
      targetId: handover._id,
      targetLabel: `Handover v${handover.version}`,
      meta: { claimId: String(claimId), decision },
      req,
      critical: true,
    });
  }

  return item;
}

/**
 * Applies many decisions in one request and records one history row. The
 * "accept all" action used to send one PATCH per item, which cost N round
 * trips, N full reviewer responses and N full snapshots.
 */
export async function reviewItems({ handover, project, actor, decisions, req }) {
  if (!['draft', 'in_review'].includes(handover.status)) {
    throw badRequest(`Cannot review items while the handover is ${handover.status}`);
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw badRequest('Provide at least one decision');
  }
  if (decisions.length > 200) {
    throw badRequest('A bulk review can apply at most 200 decisions');
  }

  const applied = [];
  for (const entry of decisions) {
    const item = await reviewItem({
      handover,
      project,
      actor,
      claimId: entry.claimId,
      decision: entry.decision,
      editedStatement: entry.editedStatement,
      note: entry.note,
      shareWithProject: false,
      req,
      // The whole batch is saved together below; a failed decision must not
      // leave earlier ones half-written.
      persist: false,
    });
    applied.push(item);
  }

  await saveVersion(
    handover,
    actor,
    `bulk review: ${applied.length} item(s)`,
    { changedClaimIds: applied.map((item) => item.claimId) },
  );

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.items_reviewed',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: {
      count: applied.length,
      decisions: applied.map((item) => ({
        claimId: String(item.claimId),
        decision: item.decision,
      })),
    },
    req,
    critical: true,
  });

  return applied;
}

export async function submitForReview({ handover, project, actor, req }) {
  // Authorization comes before every state or idempotency check so a caller
  // who cannot act on this handover learns nothing about its current status.
  if (
    !canContribute(project, actor) ||
    (!canManageProject(project, actor) && String(handover.createdBy) !== String(actor._id))
  ) {
    throw forbidden('Only the author or a project lead can submit this handover');
  }
  // Repeating a transition the handover already reached is a no-op, so a
  // double-click or retried request cannot create a second version.
  if (handover.status === 'in_review') return { idempotent: true };
  if (handover.status !== 'draft') {
    throw badRequest(`Only a draft can be submitted (current status: ${handover.status})`);
  }
  const decided = (handover.items || []).filter((item) =>
    ['accepted', 'edited'].includes(item.decision),
  );
  if (decided.length === 0) {
    throw unprocessable('Accept or edit at least one item before submitting for review');
  }

  handover.status = 'in_review';
  await saveVersion(
    handover,
    actor,
    `submitted for review with ${decided.length} accepted item(s)`,
  );

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.submitted',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { acceptedItems: decided.length },
    req,
    critical: true,
  });

  await notify({
    project,
    recipients: leadIds(project),
    type: 'handover.submitted',
    entityType: 'handover',
    entityId: handover._id,
    actor,
  });
}

export async function approveHandover({ handover, project, actor, note, req }) {
  // Identity and role first: the idempotent shortcut must not answer a caller
  // who is not allowed to approve anything.
  if (String(handover.recipient) === String(actor._id)) {
    throw forbidden('The recipient of a handover cannot approve it');
  }
  if (!canManageProject(project, actor)) {
    throw forbidden('Only a project lead can approve a handover');
  }
  if (handover.status === 'approved') return { idempotent: true };
  if (handover.status !== 'in_review') {
    throw badRequest(`Only a handover in review can be approved (current: ${handover.status})`);
  }
  if (
    project.settings?.requireSeparateApprover &&
    String(handover.createdBy) === String(actor._id)
  ) {
    throw forbidden(
      'This project requires a different person to approve the handover they prepared',
    );
  }

  const sourceById = await loadSourceMap(project._id);
  const allItems = handover.items || [];

  // Items the approver cannot read are outside their remit. Pending items they
  // cannot see must not deadlock approval; accepted ones still block it because
  // a lead may only vouch for evidence they can read themselves.
  const readableItems = allItems.filter(
    (item) => citationsVisibleTo([item], sourceById, project, actor._id).length === 0,
  );
  const pending = readableItems.filter((item) => item.decision === 'pending');
  if (pending.length > 0) {
    throw unprocessable(
      `${pending.length} item(s) still need a review decision before approval`,
      { pendingClaimIds: pending.map((item) => item.claimId) },
    );
  }

  const approvedItems = allItems.filter((item) =>
    ['accepted', 'edited'].includes(item.decision),
  );
  const hidden = citationsVisibleTo(approvedItems, sourceById, project, actor._id);
  if (hidden.length > 0) {
    throw forbidden(
      'You cannot approve this handover because you are not authorized to read the evidence behind some accepted items',
      { hiddenClaimIds: hidden.map((item) => item.claimId) },
    );
  }

  handover.status = 'approved';
  handover.reviewer = actor._id;
  handover.approvedAt = new Date();
  handover.approvedBySnapshot = { name: actor.name, email: actor.email };
  if (note) handover.reviewNote = String(note).slice(0, 600);
  await saveVersion(
    handover,
    actor,
    `approved by ${actor.name} with ${approvedItems.length} item(s)`,
  );

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.approved',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { acceptedItems: approvedItems.length, note: note || null },
    req,
    critical: true,
  });

  await notify({
    project,
    recipients: [handover.createdBy],
    type: 'handover.approved',
    entityType: 'handover',
    entityId: handover._id,
    actor,
  });
}

export async function rejectHandover({ handover, project, actor, note, req }) {
  if (!canManageProject(project, actor)) {
    throw forbidden('Only a project lead can reject a handover');
  }
  if (handover.status === 'rejected') return { idempotent: true };
  if (!['draft', 'in_review'].includes(handover.status)) {
    throw badRequest(`Cannot reject a handover that is ${handover.status}`);
  }
  const reason = String(note ?? '').trim();
  if (!reason) throw badRequest('A rejection note is required');

  handover.status = 'rejected';
  handover.rejectedAt = new Date();
  handover.rejectionNote = reason.slice(0, 600);
  // The note stays on the handover for the author and leads; the version
  // reason is world-readable within the handover and must not embed it.
  await saveVersion(handover, actor, 'rejected');

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.rejected',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { note: reason },
    req,
    critical: true,
  });

  await notify({
    project,
    recipients: [handover.createdBy],
    type: 'handover.rejected',
    entityType: 'handover',
    entityId: handover._id,
    actor,
  });
}

export async function reopenHandover({ handover, project, actor, req }) {
  if (!canContribute(project, actor)) {
    throw forbidden('Incoming recipients cannot reopen handovers');
  }
  if (!canManageProject(project, actor) && String(handover.createdBy) !== String(actor._id)) {
    throw forbidden('Only the author or a project lead can reopen this handover');
  }
  if (handover.status === 'draft' && handover.reopenedAt) return { idempotent: true };
  if (handover.status !== 'rejected') {
    throw badRequest(`Only a rejected handover can be reopened (current: ${handover.status})`);
  }

  handover.status = 'draft';
  handover.reopenedAt = new Date();
  await saveVersion(handover, actor, 'reopened for further review');

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.reopened',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { rejectionNote: handover.rejectionNote || null },
    req,
    critical: true,
  });
}

export function hashShareToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function shareHandover({
  handover,
  project,
  actor,
  confirmRotation = false,
  req,
}) {
  if (String(handover.recipient) === String(actor._id)) {
    throw forbidden('The recipient cannot share their own handover');
  }
  if (!canContribute(project, actor)) {
    throw forbidden('Incoming recipients cannot share handovers');
  }
  if (!canManageProject(project, actor) && String(handover.createdBy) !== String(actor._id)) {
    throw forbidden('Only the author or a project lead can share this handover');
  }
  if (!['approved', 'shared'].includes(handover.status)) {
    throw badRequest(
      `Only an approved handover can be shared (current: ${handover.status})`,
    );
  }

  const rotating = Boolean(handover.shareTokenHash);
  if (rotating && !confirmRotation) {
    throw conflict(
      'This handover already has an active share link. Confirm rotation to invalidate the current link before issuing a new one.',
      { confirmRotation: true },
    );
  }

  const token = randomBytes(24).toString('hex');
  handover.status = 'shared';
  handover.sharedAt = new Date();
  // Only the hash is persisted; the plaintext link is handed back once below.
  handover.shareToken = undefined;
  handover.shareTokenHash = hashShareToken(token);
  handover.shareExpiresAt = new Date(Date.now() + env.shareTtlDays * 86_400_000);
  handover.revokedAt = undefined;
  handover.revokedReason = undefined;
  // A new link starts a new read history. The old link's opens must not be
  // reported against the link the recipient is about to receive.
  handover.shareOpenedAt = undefined;
  handover.shareLastOpenedAt = undefined;
  handover.shareOpenCount = 0;
  handover.reminderSentAt = undefined;
  await saveVersion(
    handover,
    actor,
    rotating
      ? 'share link rotated; the previous link was invalidated'
      : 'shared with recipient',
  );

  await recordAudit({
    projectId: project._id,
    actor,
    action: rotating ? 'handover.share_rotated' : 'handover.shared',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { shareExpiresAt: handover.shareExpiresAt },
    req,
    critical: true,
  });

  await notify({
    project,
    recipients: [handover.recipient],
    type: 'handover.shared',
    entityType: 'handover',
    entityId: handover._id,
    actor,
  });

  await deliverOutbound({
    projectId: project._id,
    handoverId: handover._id,
    kind: 'handover.shared',
    text: `A handover for ${handover.recipientSnapshot?.name || 'the recipient'} is ready in ${project.name}. Open Threadline for the share link.`,
    createdBy: actor._id,
  });

  return token;
}

export async function revokeShare({ handover, project, actor, reason, req }) {
  if (!canManageProject(project, actor) && String(handover.createdBy) !== String(actor._id)) {
    throw forbidden('Only the author or a project lead can revoke this share link');
  }
  if (!handover.shareTokenHash) return { idempotent: true };

  handover.shareToken = undefined;
  handover.shareTokenHash = undefined;
  handover.shareExpiresAt = undefined;
  handover.revokedAt = new Date();
  handover.revokedReason = String(reason || 'Revoked by the author').slice(0, 600);
  await saveVersion(handover, actor, 'share link revoked');

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.share_revoked',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { reason: handover.revokedReason },
    req,
    critical: true,
  });

  await notify({
    project,
    recipients: [handover.recipient],
    type: 'handover.revoked',
    entityType: 'handover',
    entityId: handover._id,
    actor,
  });

  return { idempotent: false };
}

/**
 * Called when a member leaves. A share addressed to them can never open
 * again, and an author who left can no longer finish a draft. Both are
 * closed here and the leads are told which handovers still need a person,
 * instead of leaving a live-looking link or an orphaned draft behind.
 */
export async function detachMemberFromHandovers({ project, userId, actor, req }) {
  const affected = await Handover.find({
    project: project._id,
    $or: [{ recipient: userId }, { createdBy: userId }],
  });
  const leads = leadIds(project);
  let revoked = 0;

  for (const handover of affected) {
    const isRecipient = String(handover.recipient) === String(userId);
    if (isRecipient && handover.shareTokenHash) {
      handover.shareToken = undefined;
      handover.shareTokenHash = undefined;
      handover.shareExpiresAt = undefined;
      handover.revokedAt = new Date();
      handover.revokedReason = 'The recipient was removed from the project';
      await saveVersion(
        handover,
        actor,
        'share link revoked because the recipient left the project',
      );
      revoked += 1;

      await recordAudit({
        projectId: project._id,
        actor,
        action: 'handover.share_revoked',
        targetType: 'handover',
        targetId: handover._id,
        targetLabel: `Handover v${handover.version}`,
        meta: { reason: 'recipient_removed' },
        req,
        critical: true,
      });
    }

    if (['draft', 'in_review', 'approved', 'shared'].includes(handover.status)) {
      await notify({
        project,
        recipients: leads,
        type: 'handover.member_left',
        entityType: 'handover',
        entityId: handover._id,
        actor,
      });
    }
  }

  return { affected: affected.length, revoked };
}

export async function acknowledgeHandover({
  handover,
  project,
  actor,
  req,
  channel,
  auditActor,
}) {
  // The recipient check runs before status and idempotency checks: nobody else
  // may learn whether this handover is shared, acknowledged or expired.
  if (String(handover.recipient) !== String(actor._id)) {
    throw forbidden('Only the recipient can acknowledge this handover');
  }
  if (!shareIsActive(handover)) {
    throw forbidden('This share link is no longer active');
  }
  if (handover.status === 'acknowledged') {
    return { idempotent: true, acknowledgement: handover.acknowledgement };
  }
  if (handover.status !== 'shared') {
    throw badRequest(`Only a shared handover can be acknowledged (current: ${handover.status})`);
  }

  const sourceById = await loadSourceMap(project._id);
  const reviewedItems = (handover.items || []).filter((item) =>
    ['accepted', 'edited'].includes(item.decision),
  );
  const liveClaims = await Claim.find({
    _id: { $in: reviewedItems.map((item) => item.claimId).filter(Boolean) },
    project: project._id,
  })
    .select('_id status retiredAt')
    .lean();
  const liveById = new Map(
    liveClaims.map((claim) => [
      String(claim._id),
      { status: claim.status, retired: Boolean(claim.retiredAt) },
    ]),
  );

  const shownItemIds = [];
  const revokedItems = [];
  const statementHashes = {};
  for (const item of reviewedItems) {
    const live = liveById.get(String(item.claimId));
    if (!live || live.retired || live.status === 'superseded') {
      revokedItems.push({
        claimId: item.claimId,
        type: item.type,
        reason: itemSourceRemoved(item, sourceById) ? 'source_removed' : 'superseded',
      });
      continue;
    }
    const visible = (item.citations || []).every((citation) =>
      sourceVisibleTo(sourceById.get(String(citation.sourceId)), project, actor._id),
    );
    if (!visible) {
      revokedItems.push({ claimId: item.claimId, type: item.type, reason: 'permissions' });
      continue;
    }
    const hasVerifiedEvidence = (item.citations || []).some(
      (citation) => citation.validation !== 'failed',
    );
    if (!hasVerifiedEvidence && !item.acceptedWithoutEvidence) {
      revokedItems.push({
        claimId: item.claimId,
        type: item.type,
        reason: 'evidence_missing',
      });
      continue;
    }

    const statement = (item.decision === 'edited' ? item.editedStatement : item.statement) || '';
    shownItemIds.push(item.claimId);
    statementHashes[String(item.claimId)] = createHash('sha256').update(statement).digest('hex');
  }

  const acknowledgedVersion = handover.version;
  handover.status = 'acknowledged';
  handover.acknowledgedAt = new Date();
  handover.acknowledgement = {
    at: handover.acknowledgedAt,
    version: acknowledgedVersion,
    shownItemIds,
    revokedItems,
    statementHashes,
  };
  await saveVersion(
    handover,
    actor,
    `acknowledged by ${actor.name}: ${shownItemIds.length} item(s), ${revokedItems.length} changed since approval`,
  );

  const auditViewer = auditActor === undefined ? actor : auditActor;
  await recordAudit({
    projectId: project._id,
    actor: auditViewer || { name: 'Anonymous share-link visitor' },
    action: 'handover.acknowledged',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: {
      shownItems: shownItemIds.length,
      revokedItems: revokedItems.length,
      acknowledgedVersion,
      anonymous: !auditViewer,
      ...(channel ? { channel } : {}),
    },
    req,
    critical: true,
  });
}

/**
 * Read-only comparison between a handover and the current project state. The
 * eligibility test mirrors composition exactly: the template, sensitivity and
 * the same author/recipient visibility, with superseded claims ignored. The
 * stored diff is rendered from the recipient's visibility so it never reveals
 * a source they cannot open.
 */
export async function compareHandover({ handover, project }) {
  const sourceById = await loadSourceMap(project._id);
  const template = TEMPLATES[handover.roleTemplate] || TEMPLATES.onboarding;
  const recipientId = handover.recipient;
  const authorId = handover.createdBy;

  const claims = await Claim.find({ project: project._id, retiredAt: null }).lean();
  const evidence = await Evidence.find({
    claim: { $in: claims.map((claim) => claim._id) },
  }).lean();
  const evidenceByClaim = new Map();
  for (const entry of evidence) {
    const key = String(entry.claim);
    if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
    evidenceByClaim.get(key).push(entry);
  }

  const current = new Map();
  for (const claim of claims) {
    if (claim.status === 'superseded') continue;
    if (!templateIncludes(template, claim)) continue;
    if (template.excludeSensitivity.includes(claim.sensitivity)) continue;
    const claimEvidence = evidenceByClaim.get(String(claim._id)) || [];
    const readableByRecipient = claimVisibleTo({
      evidence: claimEvidence,
      sourceById,
      project,
      userId: recipientId,
    });
    const readableByAuthor = claimVisibleTo({
      evidence: claimEvidence,
      sourceById,
      project,
      userId: authorId,
    });
    if (!readableByRecipient || !readableByAuthor) continue;
    current.set(String(claim._id), claim);
  }

  const changes = [];
  const counts = { added: 0, updated: 0, removed: 0, total: 0 };

  for (const item of handover.items || []) {
    const live = current.get(String(item.claimId));
    if (!live) {
      counts.removed += 1;
      changes.push({
        claimId: item.claimId,
        type: item.type,
        statement: redactText(item.statement || '').text,
        change: 'removed',
        reason: itemSourceRemoved(item, sourceById) ? 'source_removed' : 'no_longer_current',
      });
      continue;
    }

    const fields = [];
    if (live.status !== item.status) {
      fields.push({ field: 'status', from: item.status || null, to: live.status });
    }
    if ((live.ownerName || null) !== (item.ownerName || null)) {
      fields.push({
        field: 'owner',
        from: item.ownerName || null,
        to: live.ownerName || null,
      });
    }
    if (fields.length > 0) {
      counts.updated += 1;
      changes.push({
        claimId: item.claimId,
        type: item.type,
        statement: redactText(item.statement || '').text,
        change: 'updated',
        fields,
      });
    }
    current.delete(String(item.claimId));
  }

  for (const claim of current.values()) {
    counts.added += 1;
    changes.push({
      claimId: claim._id,
      type: claim.type,
      statement: redactText(claim.statement || '').text,
      change: 'added',
    });
  }

  counts.total = changes.length;
  return { checkedAt: new Date(), changed: counts.total > 0, counts, changes };
}

/**
 * Rebuilds a released handover from current state without mutating what the
 * recipient currently holds. Review decisions are carried over only when the
 * hash of statement, status, owner and evidence quotes still matches what the
 * reviewer actually saw; anything else returns to pending and is marked as
 * changed since review, so a stale approval can never ship silently.
 *
 * A shared or acknowledged handover stays live until the replacement is
 * approved: regeneration creates a new draft and copies the acknowledgement
 * record. An approved handover has not been released yet, so it is rebuilt in
 * place.
 */
export async function regenerateHandover({ handover, project, actor, req }) {
  if (!['approved', 'shared', 'acknowledged'].includes(handover.status)) {
    throw badRequest(
      `Only an approved, shared or acknowledged handover can be regenerated (current: ${handover.status})`,
    );
  }
  if (!canManageProject(project, actor) && String(handover.createdBy) !== String(actor._id)) {
    throw forbidden('Only the author or a project lead can regenerate this handover');
  }

  const recipient = await User.findById(handover.recipient);
  if (!recipient) throw notFound('The recipient account no longer exists');

  // The regenerator may not be able to read everything the original author
  // could. Composing with the union keeps the draft complete instead of
  // silently dropping items the regenerator cannot open.
  const composition = await buildComposition({
    project,
    recipient,
    actor,
    roleTemplate: handover.roleTemplate,
    permissionUserIds: [String(handover.createdBy)],
  });

  const previousById = new Map(
    (handover.items || []).map((item) => [String(item.claimId), item]),
  );
  let carried = 0;
  let added = 0;
  let changed = 0;
  for (const item of composition.items) {
    const previous = previousById.get(String(item.claimId));
    previousById.delete(String(item.claimId));
    if (!previous) {
      added += 1;
      // Composition auto-accepts items with a verified citation for a fresh
      // handover, but nothing here was reviewed yet. A regenerated draft must
      // send new items through review instead of shipping them approved.
      item.decision = 'pending';
      item.reviewedHash = undefined;
      continue;
    }
    const reviewedHash = previous.reviewedHash || null;
    if (!reviewedHash || reviewedHash !== item.contentHash) {
      if (previous.decision && previous.decision !== 'pending') {
        changed += 1;
        item.changedSinceReview = true;
        item.previousDecision = previous.decision;
      }
      item.decision = 'pending';
      item.reviewedHash = undefined;
      item.editedStatement = undefined;
      item.acceptedWithoutEvidence = false;
      continue;
    }
    item.decision = previous.decision;
    item.reviewedHash = reviewedHash;
    if (previous.decision === 'edited') item.editedStatement = previous.editedStatement;
    item.reviewerNote = previous.reviewerNote;
    item.acceptedWithoutEvidence = previous.acceptedWithoutEvidence;
    carried += 1;
  }
  const dropped = previousById.size;

  const released = ['shared', 'acknowledged'].includes(handover.status);
  let target = handover;

  if (released) {
    target = await Handover.create({
      project: handover.project,
      recipient: handover.recipient,
      recipientSnapshot: handover.recipientSnapshot,
      roleTemplate: handover.roleTemplate,
      status: 'draft',
      createdBy: actor._id,
      createdBySnapshot: { name: actor.name, email: actor.email },
      items: composition.items,
      alerts: composition.alerts,
      recommendations: composition.recommendations,
      withheld: composition.withheld,
      redactions: composition.redactions,
      snapshot: composition.snapshot,
      version: 1,
      generation: composition.generation,
      regeneratedFrom: handover._id,
      // The recipient acknowledged a version of this handover; the record
      // travels with the replacement so the approval history stays complete.
      acknowledgement: handover.acknowledgement || undefined,
      acknowledgedAt: handover.acknowledgedAt || undefined,
      freshness: { status: 'current', checkedAt: new Date(), changes: [] },
    });

    await HandoverVersion.create({
      handover: target._id,
      project: project._id,
      version: 1,
      reason: `regenerated from v${handover.version} (${carried} kept, ${added} new, ${dropped} dropped)`,
      actor: actor._id,
      actorName: actor.name,
      snapshot: target.toObject(),
    });
  } else {
    handover.items = composition.items;
    handover.alerts = composition.alerts;
    handover.recommendations = composition.recommendations;
    handover.withheld = composition.withheld;
    handover.redactions = composition.redactions;
    handover.snapshot = composition.snapshot;
    handover.generation = composition.generation;
    handover.status = 'draft';
    handover.reviewer = undefined;
    handover.approvedAt = undefined;
    handover.approvedBySnapshot = undefined;
    handover.rejectedAt = undefined;
    handover.rejectionNote = undefined;
    handover.reopenedAt = undefined;
    handover.reviewNote = undefined;
    handover.sharedAt = undefined;
    handover.acknowledgedAt = undefined;
    handover.shareToken = undefined;
    handover.shareTokenHash = undefined;
    handover.shareExpiresAt = undefined;
    handover.revokedAt = undefined;
    handover.revokedReason = undefined;
    handover.acknowledgement = { shownItemIds: [], revokedItems: [], statementHashes: {} };
    handover.freshness = { status: 'current', checkedAt: new Date(), changes: [] };

    await saveVersion(
      handover,
      actor,
      `regenerated from current state (${carried} kept, ${added} new, ${dropped} dropped, ${changed} reset)`,
    );
  }

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.regenerated',
    targetType: 'handover',
    targetId: target._id,
    targetLabel: `Handover v${target.version}`,
    meta: {
      carried,
      added,
      dropped,
      changed,
      createdNew: released,
      sourceHandoverId: released ? String(handover._id) : undefined,
    },
    req,
    critical: true,
  });

  return { carried, added, dropped, changed, createdNew: released, handover: target };
}

/**
 * Older releases wrote the first 80 characters of an item statement into the
 * version reason. Strip any quoted tail and the free-text note that followed
 * an em dash, then redact, so historical rows obey today's rules too.
 */
export function sanitizeVersionReason(reason) {
  const text = String(reason ?? '')
    // Oldest rows put the statement before an em-dash note; strip the note
    // first so the quoted tail becomes the end of the string and the second
    // pass can remove it too.
    .replace(/\s+—\s+[\s\S]*$/, '')
    .replace(/\s+"[^"]*"\s*$/, '')
    .trim();
  return redactText(text).text || 'Changed';
}

function visibleSnapshotItems(items, { sourceById, project, userId }) {
  const visible = [];
  const hidden = [];
  for (const item of items || []) {
    const readable = (item.citations || []).every((citation) =>
      sourceVisibleTo(sourceById.get(String(citation.sourceId)), project, userId),
    );
    if (readable) visible.push(item);
    else hidden.push(item);
  }
  return { visible, hidden };
}

const RESTRICTED_STATEMENT = 'A restricted item changed';

export async function listVersions(handoverId, { limit = 50, cursor = null } = {}) {
  const query = { handover: handoverId };
  if (cursor) query.version = { $lt: cursor };
  const rows = await HandoverVersion.find(query)
    .select('-snapshot')
    .sort({ version: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    versions: page.map((entry) => ({
      ...entry,
      reason: sanitizeVersionReason(entry.reason),
    })),
    hasMore,
    nextCursor: hasMore ? page[page.length - 1]?.version ?? null : null,
  };
}

/**
 * Rebuilds the item list a version represented. Full snapshots return as-is;
 * a diff row is applied on top of the nearest earlier full snapshot, so a
 * request that changed one item still diffs correctly against everything
 * before it.
 */
async function resolveSnapshotItems(row) {
  if (!row?.snapshot?.diff) return row?.snapshot?.items || [];

  const base = await HandoverVersion.findOne({
    handover: row.handover,
    version: { $lt: row.version },
    'snapshot.diff': { $ne: true },
  })
    .sort({ version: -1 })
    .lean();
  let items = base?.snapshot?.items || [];

  const chain = await HandoverVersion.find({
    handover: row.handover,
    version: { $gte: base ? base.version + 1 : 1, $lte: row.version },
  })
    .sort({ version: 1 })
    .lean();

  for (const entry of chain) {
    if (!entry.snapshot?.diff) {
      items = entry.snapshot?.items || [];
      continue;
    }
    const byClaim = new Map(items.map((item) => [String(item.claimId), item]));
    for (const item of entry.snapshot.items || []) {
      byClaim.set(String(item.claimId), item);
    }
    items = [...byClaim.values()];
  }
  return items;
}

/**
 * Human-readable diff between one stored version and the one before it, so the
 * history shows what changed instead of an opaque version number. Snapshots
 * are filtered against the viewer's current source visibility: an item whose
 * citation the viewer cannot open never contributes text, only a placeholder.
 */
export async function versionDiff(handoverId, version, { viewer, project } = {}) {
  const target = await HandoverVersion.findOne({ handover: handoverId, version }).lean();
  if (!target) throw notFound('That handover version does not exist');

  const previous =
    version > 1
      ? await HandoverVersion.findOne({ handover: handoverId, version: version - 1 }).lean()
      : null;

  let targetItems = await resolveSnapshotItems(target);
  let previousItemList = previous ? await resolveSnapshotItems(previous) : [];
  let hiddenTarget = [];
  let hiddenPrevious = [];

  if (viewer && project) {
    const sourceById = await loadSourceMap(project._id);
    const targetView = visibleSnapshotItems(targetItems, {
      sourceById,
      project,
      userId: viewer._id,
    });
    targetItems = targetView.visible;
    hiddenTarget = targetView.hidden;
    const previousView = visibleSnapshotItems(previousItemList, {
      sourceById,
      project,
      userId: viewer._id,
    });
    previousItemList = previousView.visible;
    hiddenPrevious = previousView.hidden;
  }

  const previousItems = new Map(
    previousItemList.map((item) => [String(item.claimId), item]),
  );
  const changes = [];
  const text = (value) => redactText(String(value ?? '')).text;
  const short = (value) => text(value).slice(0, 140);

  for (const item of targetItems) {
    const key = String(item.claimId);
    const before = previousItems.get(key);
    previousItems.delete(key);
    if (!before) {
      changes.push({
        claimId: item.claimId,
        type: item.type,
        statement: short(item.statement),
        change: 'added',
      });
      continue;
    }

    const fields = [];
    if (before.decision !== item.decision) {
      fields.push({ field: 'decision', from: before.decision, to: item.decision });
    }
    if ((before.editedStatement || null) !== (item.editedStatement || null)) {
      fields.push({
        field: 'statement',
        from: short(before.editedStatement || before.statement || ''),
        to: short(item.editedStatement || item.statement || ''),
      });
    }
    if (before.status !== item.status) {
      fields.push({ field: 'status', from: before.status, to: item.status });
    }
    if ((before.ownerName || null) !== (item.ownerName || null)) {
      fields.push({ field: 'owner', from: before.ownerName || null, to: item.ownerName || null });
    }
    if (fields.length > 0) {
      changes.push({
        claimId: item.claimId,
        type: item.type,
        statement: short(item.statement),
        change: 'updated',
        fields,
      });
    }
  }

  for (const item of previousItems.values()) {
    changes.push({
      claimId: item.claimId,
      type: item.type,
      statement: short(item.statement),
      change: 'removed',
    });
  }

  const hiddenTargetIds = new Set(hiddenTarget.map((item) => String(item.claimId)));
  const hiddenPreviousIds = new Set(hiddenPrevious.map((item) => String(item.claimId)));
  for (const item of hiddenTarget) {
    if (hiddenPreviousIds.has(String(item.claimId))) continue;
    changes.push({
      claimId: item.claimId,
      type: item.type,
      statement: RESTRICTED_STATEMENT,
      change: 'restricted',
    });
  }
  for (const item of hiddenPrevious) {
    if (hiddenTargetIds.has(String(item.claimId))) continue;
    changes.push({
      claimId: item.claimId,
      type: item.type,
      statement: RESTRICTED_STATEMENT,
      change: 'restricted',
    });
  }

  return {
    handover: target.handover,
    version: target.version,
    reason: sanitizeVersionReason(target.reason),
    actorName: target.actorName,
    createdAt: target.createdAt,
    previousVersion: previous ? previous.version : null,
    counts: {
      added: changes.filter((entry) => entry.change === 'added').length,
      updated: changes.filter((entry) => entry.change === 'updated').length,
      removed: changes.filter((entry) => entry.change === 'removed').length,
      restricted: changes.filter((entry) => entry.change === 'restricted').length,
      total: changes.length,
    },
    changes,
  };
}

export function summarizeHandover(handover, { viewer = 'reviewer' } = {}) {
  const items = handover.items || [];
  const base = {
    id: handover._id,
    project: handover.project,
    recipient: handover.recipient,
    recipientSnapshot: handover.recipientSnapshot,
    roleTemplate: handover.roleTemplate,
    status: handover.status,
    version: handover.version,
    createdAt: handover.createdAt,
    updatedAt: handover.updatedAt,
    approvedAt: handover.approvedAt,
    sharedAt: handover.sharedAt,
    acknowledgedAt: handover.acknowledgedAt,
    // Lists show only the freshness state. The per-change diff can quote
    // statements whose sources a given viewer cannot read, so the detail view
    // rebuilds it against that viewer's permissions instead.
    freshness: handover.freshness
      ? {
          status: handover.freshness.status,
          checkedAt: handover.freshness.checkedAt,
          outdatedAt: handover.freshness.outdatedAt,
        }
      : { status: 'current' },
  };

  // A recipient's list entry carries no review or withholding counts. Before
  // sharing they would describe content that has not been released; after
  // sharing the detail view rechecks permissions and is the authoritative
  // source of item counts.
  if (viewer === 'recipient') return base;

  return {
    ...base,
    itemCount: items.length,
    pendingCount: items.filter((item) => item.decision === 'pending').length,
    // Deliberately omitted: the stored withheld tally was computed against the
    // author's view and can include sources this reviewer cannot read. The
    // handover detail recomputes it against the current viewer.
  };
}
