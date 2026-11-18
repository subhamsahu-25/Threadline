import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { truncate } from '../../lib/text.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { redactText } from '../../lib/redaction.js';
import {
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
import { TEMPLATES, buildComposition, templateIncludes } from './compose.js';

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

function renderItem(item, { recipient }) {
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
 * Reviewer view. The author and every lead see only the items, alerts and
 * recommendations whose evidence sources they may read themselves. Counts are
 * recomputed over that filtered set so they never describe hidden content.
 */
export async function buildReviewerView({ handover, project, user }) {
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
      if (plain.code !== 'restricted_items_excluded') return plain;
      const count = withheld.byReason.permissions + withheld.byReason.author_permissions;
      if (count === 0) return null;
      return {
        ...plain,
        message: `${count} item(s) in this handover were excluded because the author or the recipient is not authorized to read their source. Details are intentionally not shown.`,
      };
    })
    .filter(Boolean);

  const [feedbackRows, deliveryRows] = await Promise.all([
    HandoverFeedback.find({ handover: handover._id }).sort({ createdAt: -1 }).limit(50).lean(),
    Delivery.find({ handover: handover._id }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);

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
    snapshot: handover.snapshot,
    generation: handover.generation,
    permissionsCheckedAt: handover.permissionsCheckedAt,
    lastAccessedAt: handover.lastAccessedAt,
    freshness: handover.freshness || { status: 'current' },
    counts: summarizeReview({ items: visibleItems }),
  };
}

function summarizeReview(handover) {
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
 * Recipient view. Permissions are re-evaluated at read time, not trusted from
 * the moment the handover was generated: a source that became restricted (or a
 * recipient removed from the project) immediately removes the linked items.
 * Item statuses and owners are also refreshed from the live claims so the
 * recipient never acts on a snapshot the project has already moved past.
 */
export async function buildRecipientView({ handover, project, user, req }) {
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
    .select('_id status ownerName retiredAt')
    .lean();
  const liveById = new Map(
    liveClaims.map((claim) => [
      String(claim._id),
      {
        status: claim.status,
        ownerName: claim.ownerName || null,
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
    const ownerChanged = live.ownerName !== (item.ownerName || null);
    if (statusChanged || ownerChanged) changedItemCount += 1;
    rendered.status = live.status;
    rendered.ownerName = live.ownerName;
    rendered.changedSinceApproval = statusChanged || ownerChanged;
    rendered.previousStatus = statusChanged ? item.status : undefined;
    rendered.previousOwnerName = ownerChanged ? item.ownerName || null : undefined;
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
  const mini = (item) => ({
    claimId: item.claimId,
    type: item.type,
    statement: item.statement,
    status: item.status,
    ownerName: item.ownerName,
    dueAt: item.dueAt,
    changedSinceApproval: Boolean(item.changedSinceApproval),
  });
  const firstWeek = {
    windowDays: 7,
    youOwn: items
      .filter((item) => item.ownerName && item.ownerName.trim().toLowerCase() === recipientName)
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

  await recordAudit({
    projectId: project._id,
    actor: user,
    action: 'handover.recipient_viewed',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { revokedItems: revoked, supersededItems, changedItemCount },
    req,
  });

  if (revoked > 0 || supersededItems > 0 || changedItemCount > 0) {
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
        reason: 'Access re-evaluated when the recipient opened the handover',
      },
      req,
    });
  }

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
    freshness: handover.freshness || { status: 'current' },
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
    status: { $in: ['approved', 'shared', 'acknowledged'] },
  });

  let transitioned = 0;
  for (const handover of handovers) {
    const comparison = await compareHandover({
      handover,
      project,
      actor: { _id: handover.recipient },
    });
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

      await notify({
        project,
        recipients: [...leadIds(project), String(handover.createdBy)],
        type: 'handover.outdated',
        entityType: 'handover',
        entityId: handover._id,
      });
    }
  }
  return transitioned;
}

export async function saveVersion(handover, actor, reason) {
  handover.version = (handover.version || 0) + 1;
  await handover.save();
  await HandoverVersion.create({
    handover: handover._id,
    project: handover.project,
    version: handover.version,
    reason,
    actor: actor._id,
    actorName: actor.name,
    snapshot: handover.toObject(),
  });
}

export function findItem(handover, claimId) {
  const item = (handover.items || []).find(
    (entry) => String(entry.claimId) === String(claimId),
  );
  if (!item) throw notFound('That item is not part of this handover');
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
}) {
  if (!['draft', 'in_review'].includes(handover.status)) {
    throw badRequest(`Cannot review items while the handover is ${handover.status}`);
  }

  const item = findItem(handover, claimId);
  const options = ['accepted', 'rejected', 'edited', 'pending'];
  if (!options.includes(decision)) {
    throw badRequest(`decision must be one of: ${options.join(', ')}`);
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
    });
  }

  const label = truncate((decision === 'edited' ? item.editedStatement : item.statement) || '', 80);
  await saveVersion(handover, actor, `${decision} "${label}"`);

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.item_reviewed',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { claimId: String(claimId), decision },
    req,
  });

  return item;
}

export async function submitForReview({ handover, project, actor, req }) {
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
  if (handover.status === 'approved') return { idempotent: true };
  if (handover.status !== 'in_review') {
    throw badRequest(`Only a handover in review can be approved (current: ${handover.status})`);
  }
  if (String(handover.recipient) === String(actor._id)) {
    throw forbidden('The recipient of a handover cannot approve it');
  }
  if (!canManageProject(project, actor)) {
    throw forbidden('Only a project lead can approve a handover');
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
    `approved by ${actor.name} with ${approvedItems.length} item(s)${note ? ` — ${truncate(note, 80)}` : ''}`,
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
  await saveVersion(handover, actor, `rejected — ${truncate(reason, 100)}`);

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.rejected',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { note: reason },
    req,
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
  if (!['approved', 'shared'].includes(handover.status)) {
    throw badRequest(
      `Only an approved handover can be shared (current: ${handover.status})`,
    );
  }
  if (String(handover.recipient) === String(actor._id)) {
    throw forbidden('The recipient cannot share their own handover');
  }
  if (!canContribute(project, actor)) {
    throw forbidden('Incoming recipients cannot share handovers');
  }
  if (!canManageProject(project, actor) && String(handover.createdBy) !== String(actor._id)) {
    throw forbidden('Only the author or a project lead can share this handover');
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
  await saveVersion(
    handover,
    actor,
    `share link revoked — ${truncate(handover.revokedReason, 90)}`,
  );

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.share_revoked',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { reason: handover.revokedReason },
    req,
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

export async function acknowledgeHandover({ handover, project, actor, req, channel }) {
  if (!shareIsActive(handover)) {
    throw forbidden('This share link is no longer active');
  }
  if (handover.status === 'acknowledged') {
    return { idempotent: true, acknowledgement: handover.acknowledgement };
  }
  if (handover.status !== 'shared') {
    throw badRequest(`Only a shared handover can be acknowledged (current: ${handover.status})`);
  }
  if (String(handover.recipient) !== String(actor._id)) {
    throw forbidden('Only the recipient can acknowledge this handover');
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

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.acknowledged',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: {
      shownItems: shownItemIds.length,
      revokedItems: revokedItems.length,
      acknowledgedVersion,
      ...(channel ? { channel } : {}),
    },
    req,
  });
}

/**
 * Read-only comparison between an approved handover and the current project
 * state. Only claims both the author and the recipient may read are compared,
 * so the diff can never reveal restricted content.
 */
export async function compareHandover({ handover, project, actor }) {
  const sourceById = await loadSourceMap(project._id);
  const template = TEMPLATES[handover.roleTemplate] || TEMPLATES.onboarding;
  const recipientId = handover.recipient;

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
    const readableByRequestor = claimVisibleTo({
      evidence: claimEvidence,
      sourceById,
      project,
      userId: actor._id,
    });
    if (!readableByRecipient || !readableByRequestor) continue;
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
 * Rebuilds an approved/shared/acknowledged handover from current state. Review
 * decisions are carried over per claim where the claim still exists; anything
 * new starts pending so a person confirms it before the recipient sees it.
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

  const composition = await buildComposition({
    project,
    recipient,
    actor,
    roleTemplate: handover.roleTemplate,
  });

  const previousById = new Map(
    (handover.items || []).map((item) => [String(item.claimId), item]),
  );
  let carried = 0;
  let added = 0;
  for (const item of composition.items) {
    const previous = previousById.get(String(item.claimId));
    previousById.delete(String(item.claimId));
    if (!previous) {
      added += 1;
      continue;
    }
    if (['accepted', 'edited'].includes(previous.decision)) {
      item.decision = previous.decision;
      if (previous.decision === 'edited') item.editedStatement = previous.editedStatement;
      item.reviewerNote = previous.reviewerNote;
      item.acceptedWithoutEvidence = previous.acceptedWithoutEvidence;
      carried += 1;
    }
  }
  const dropped = previousById.size;

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
    `regenerated from current state (${carried} kept, ${added} new, ${dropped} dropped)`,
  );

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.regenerated',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { carried, added, dropped },
    req,
  });

  return { carried, added, dropped };
}

export async function listVersions(handoverId) {
  return HandoverVersion.find({ handover: handoverId })
    .select('-snapshot')
    .sort({ version: -1 })
    .lean();
}

/**
 * Human-readable diff between one stored version and the one before it, so the
 * history shows what changed instead of an opaque version number.
 */
export async function versionDiff(handoverId, version) {
  const target = await HandoverVersion.findOne({ handover: handoverId, version }).lean();
  if (!target) throw notFound('That handover version does not exist');

  const previous =
    version > 1
      ? await HandoverVersion.findOne({ handover: handoverId, version: version - 1 }).lean()
      : null;
  const previousItems = new Map(
    ((previous?.snapshot?.items) || []).map((item) => [String(item.claimId), item]),
  );
  const changes = [];

  for (const item of target.snapshot?.items || []) {
    const key = String(item.claimId);
    const before = previousItems.get(key);
    previousItems.delete(key);
    if (!before) {
      changes.push({
        claimId: item.claimId,
        type: item.type,
        statement: truncate(item.statement || '', 140),
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
        from: truncate(before.editedStatement || before.statement || '', 140),
        to: truncate(item.editedStatement || item.statement || '', 140),
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
        statement: truncate(item.statement || '', 140),
        change: 'updated',
        fields,
      });
    }
  }

  for (const item of previousItems.values()) {
    changes.push({
      claimId: item.claimId,
      type: item.type,
      statement: truncate(item.statement || '', 140),
      change: 'removed',
    });
  }

  return {
    handover: target.handover,
    version: target.version,
    reason: target.reason,
    actorName: target.actorName,
    createdAt: target.createdAt,
    previousVersion: previous ? previous.version : null,
    counts: {
      added: changes.filter((entry) => entry.change === 'added').length,
      updated: changes.filter((entry) => entry.change === 'updated').length,
      removed: changes.filter((entry) => entry.change === 'removed').length,
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
    freshness: handover.freshness || { status: 'current' },
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
