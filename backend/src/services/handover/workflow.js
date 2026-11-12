import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { Claim, Evidence, Handover, HandoverVersion, Source } from '../../models/index.js';
import { canManageProject, claimVisibleTo, roleOf, sourceVisibleTo } from '../access/policy.js';
import { recordAudit } from '../audit.js';

export async function loadSourceMap(projectId) {
  const sources = await Source.find({ project: projectId }).lean();
  return new Map(sources.map((source) => [String(source._id), source]));
}

export function handoverAccess({ handover, project, user }) {
  const role = roleOf(project, user._id);
  const isRecipient = String(handover.recipient) === String(user._id);
  const isCreator = String(handover.createdBy) === String(user._id);
  const isLead = canManageProject(project, user);
  const recipientMayView =
    isRecipient && ['shared', 'acknowledged'].includes(handover.status);
  return {
    role,
    isRecipient,
    isCreator,
    isLead,
    canView: isCreator || isLead || recipientMayView,
  };
}

function renderItem(item, { recipient }) {
  return {
    claimId: item.claimId,
    type: item.type,
    statement: item.decision === 'edited' ? item.editedStatement : item.statement,
    originalStatement: item.decision === 'edited' ? item.statement : undefined,
    topic: item.topic,
    status: item.status,
    state: item.state,
    confidence: item.confidence,
    sensitivity: item.sensitivity,
    ownerName: item.ownerName,
    dueAt: item.dueAt,
    occurredAt: item.occurredAt,
    flags: item.flags || [],
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
      quote: citation.quote,
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

export function buildReviewerView({ handover, project, user }) {
  return {
    id: handover._id,
    projectId: handover.project,
    recipient: handover.recipient,
    recipientSnapshot: handover.recipientSnapshot,
    roleTemplate: handover.roleTemplate,
    status: handover.status,
    version: handover.version,
    createdBy: handover.createdBy,
    createdAt: handover.createdAt,
    updatedAt: handover.updatedAt,
    reviewer: handover.reviewer,
    approvedAt: handover.approvedAt,
    approvedBySnapshot: handover.approvedBySnapshot,
    rejectedAt: handover.rejectedAt,
    rejectionNote: handover.rejectionNote,
    sharedAt: handover.sharedAt,
    acknowledgedAt: handover.acknowledgedAt,
    shareExpiresAt: handover.shareExpiresAt,
    items: (handover.items || []).map((item) => renderItem(item, { recipient: false })),
    alerts: handover.alerts || [],
    recommendations: handover.recommendations || [],
    withheld: handover.withheld,
    snapshot: handover.snapshot,
    generation: handover.generation,
    permissionsCheckedAt: handover.permissionsCheckedAt,
    lastAccessedAt: handover.lastAccessedAt,
    counts: summarizeReview(handover),
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

/**
 * Recipient view. Permissions are re-evaluated at read time, not trusted from
 * the moment the handover was generated: a source that became restricted (or a
 * recipient removed from the project) immediately removes the linked items.
 */
export async function buildRecipientView({ handover, project, user, req }) {
  const sourceById = await loadSourceMap(project._id);
  const items = [];
  let revoked = 0;

  for (const item of handover.items || []) {
    if (!['accepted', 'edited'].includes(item.decision)) continue;

    const allVisible = (item.citations || []).every((citation) =>
      sourceVisibleTo(sourceById.get(String(citation.sourceId)), project, user._id),
    );
    if (!allVisible) {
      revoked += 1;
      continue;
    }

    const hasVerifiedEvidence = (item.citations || []).some(
      (citation) => citation.validation !== 'failed',
    );
    if (!hasVerifiedEvidence && !item.acceptedWithoutEvidence) {
      revoked += 1;
      continue;
    }

    items.push(renderItem(item, { recipient: true }));
  }

  const checkedAt = new Date();

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

  const recommendations = (handover.recommendations || []).filter(referencesVisible);
  const alerts = (handover.alerts || []).filter(
    (alert) => alert.audience === 'recipient' && referencesVisible(alert),
  );

  await Handover.updateOne({ _id: handover._id }, { $set: { lastAccessedAt: checkedAt } });

  await recordAudit({
    projectId: project._id,
    actor: user,
    action: 'handover.recipient_viewed',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { revokedItems: revoked },
    req,
  });

  if (revoked > 0) {
    await recordAudit({
      projectId: project._id,
      actor: { name: 'threadline-permissions' },
      action: 'handover.permissions_rechecked',
      targetType: 'handover',
      targetId: handover._id,
      targetLabel: `Handover v${handover.version}`,
      meta: { revokedItems: revoked, reason: 'Access re-evaluated when the recipient opened the handover' },
      req,
    });
  }

  return {
    id: handover._id,
    projectId: handover.project,
    recipientSnapshot: handover.recipientSnapshot,
    roleTemplate: handover.roleTemplate,
    status: handover.status,
    version: handover.version,
    approvedAt: handover.approvedAt,
    sharedAt: handover.sharedAt,
    acknowledgedAt: handover.acknowledgedAt,
    items,
    alerts,
    recommendations,
    snapshot: handover.snapshot,
    permissionRecheck: {
      checkedAt,
      revokedItems: revoked,
      note:
        revoked > 0
          ? 'Some items are no longer shown because your access to their source changed.'
          : undefined,
    },
  };
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

  if (['accepted', 'edited'].includes(decision) && (item.citations || []).length > 0) {
    const sourceById = await loadSourceMap(project._id);
    const hidden = citationsVisibleTo([item], sourceById, project, actor._id);
    if (hidden.length > 0) {
      throw forbidden(
        'You cannot accept an item whose evidence you are not authorized to read',
      );
    }
  }

  if (decision === 'edited') {
    const statement = String(editedStatement ?? '').trim();
    if (!statement) throw badRequest('editedStatement is required when decision is "edited"');
    item.decision = 'edited';
    item.editedStatement = statement.slice(0, 1200);
    item.acceptedWithoutEvidence = !(item.citations || []).some(
      (citation) => citation.validation !== 'failed',
    );
  } else if (decision === 'accepted') {
    item.decision = 'accepted';
    item.editedStatement = undefined;
    item.acceptedWithoutEvidence = !(item.citations || []).some(
      (citation) => citation.validation !== 'failed',
    );
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

  await saveVersion(handover, actor, `item ${decision}: ${claimId}`);

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
  await saveVersion(handover, actor, 'submitted for review');

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
}

export async function approveHandover({ handover, project, actor, note, req }) {
  if (handover.status !== 'in_review') {
    throw badRequest(`Only a handover in review can be approved (current: ${handover.status})`);
  }
  if (String(handover.recipient) === String(actor._id)) {
    throw forbidden('The recipient of a handover cannot approve it');
  }
  if (!canManageProject(project, actor)) {
    throw forbidden('Only a project lead can approve a handover');
  }

  const pending = (handover.items || []).filter((item) => item.decision === 'pending');
  if (pending.length > 0) {
    throw unprocessable(
      `${pending.length} item(s) still need a review decision before approval`,
      { pendingClaimIds: pending.map((item) => item.claimId) },
    );
  }

  const approvedItems = (handover.items || []).filter((item) =>
    ['accepted', 'edited'].includes(item.decision),
  );
  const sourceById = await loadSourceMap(project._id);
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
  await saveVersion(handover, actor, 'approved');

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
}

export async function rejectHandover({ handover, project, actor, note, req }) {
  if (!['draft', 'in_review'].includes(handover.status)) {
    throw badRequest(`Cannot reject a handover that is ${handover.status}`);
  }
  if (!canManageProject(project, actor)) {
    throw forbidden('Only a project lead can reject a handover');
  }
  const reason = String(note ?? '').trim();
  if (!reason) throw badRequest('A rejection note is required');

  handover.status = 'rejected';
  handover.rejectedAt = new Date();
  handover.rejectionNote = reason.slice(0, 600);
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
  });
}

export async function shareHandover({ handover, project, actor, req }) {
  if (handover.status !== 'approved') {
    throw badRequest(`Only an approved handover can be shared (current: ${handover.status})`);
  }
  if (String(handover.recipient) === String(actor._id)) {
    throw forbidden('The recipient cannot share their own handover');
  }
  if (!canManageProject(project, actor) && String(handover.createdBy) !== String(actor._id)) {
    throw forbidden('Only the author or a project lead can share this handover');
  }

  const token = randomBytes(24).toString('hex');
  handover.status = 'shared';
  handover.sharedAt = new Date();
  handover.shareToken = token;
  handover.shareExpiresAt = new Date(Date.now() + env.shareTtlDays * 86_400_000);
  await saveVersion(handover, actor, 'shared');

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.shared',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { shareExpiresAt: handover.shareExpiresAt },
    req,
  });

  return token;
}

export async function acknowledgeHandover({ handover, project, actor, req }) {
  if (handover.status !== 'shared') {
    throw badRequest(`Only a shared handover can be acknowledged (current: ${handover.status})`);
  }
  if (String(handover.recipient) !== String(actor._id)) {
    throw forbidden('Only the recipient can acknowledge this handover');
  }

  handover.status = 'acknowledged';
  handover.acknowledgedAt = new Date();
  await saveVersion(handover, actor, 'acknowledged by recipient');

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.acknowledged',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: {},
    req,
  });
}

export async function listVersions(handoverId) {
  return HandoverVersion.find({ handover: handoverId })
    .select('-snapshot')
    .sort({ version: -1 })
    .lean();
}

export function summarizeHandover(handover) {
  const items = handover.items || [];
  return {
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
    itemCount: items.length,
    pendingCount: items.filter((item) => item.decision === 'pending').length,
    withheld: handover.withheld?.total || 0,
  };
}
