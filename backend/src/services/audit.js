import { AppError } from '../lib/errors.js';
import { AuditEvent, Claim, Document, Evidence, Source } from '../models/index.js';
import { logger } from '../lib/logger.js';
import { claimVisibleTo, sourceVisibleTo } from './access/policy.js';

/**
 * Writes one audit row. Routine reads and notices may lose their row to a
 * transient database hiccup, but access changes, approvals, shares and purges
 * must not: for those the caller passes `critical: true` and an unwritable log
 * turns into a 503 instead of a silent success.
 */
export async function recordAudit({
  projectId,
  actor,
  action,
  targetType,
  targetId,
  targetLabel,
  meta = {},
  req,
  critical = false,
}) {
  const actorId =
    actor?._id ??
    (typeof actor?.id === 'string' ? actor.id : undefined) ??
    (typeof actor === 'string' ? actor : undefined);

  try {
    await AuditEvent.create({
      project: projectId || undefined,
      actor: actorId,
      actorName: actor?.name,
      action,
      targetType,
      targetId: targetId || undefined,
      targetLabel,
      meta,
      ip: req?.ip,
      userAgent: req?.get?.('user-agent'),
    });
  } catch (error) {
    logger.error({ action, error: error.message, critical }, 'Failed to write audit event');
    if (critical) {
      throw new AppError(
        503,
        'audit_unavailable',
        'The action was not confirmed because its audit record could not be written',
      );
    }
  }
}

/**
 * Document views are evidence opens, not security events. Repeated opens of
 * the same document by the same person within the window fold into the first
 * row, so the log stays readable instead of growing with every scroll.
 */
export async function recordViewAudit({
  projectId,
  actor,
  action,
  targetType,
  targetId,
  targetLabel,
  meta = {},
  req,
  windowMs = 3_600_000,
}) {
  const actorId =
    actor?._id ??
    (typeof actor?.id === 'string' ? actor.id : undefined) ??
    (typeof actor === 'string' ? actor : undefined);
  const since = new Date(Date.now() - windowMs);
  const existing = await AuditEvent.findOne({
    project: projectId,
    action,
    targetType,
    targetId,
    actor: actorId || null,
    createdAt: { $gte: since },
  })
    .select('_id')
    .lean();
  if (existing) return false;

  await recordAudit({
    projectId,
    actor,
    action,
    targetType,
    targetId,
    targetLabel,
    meta,
    req,
  });
  return true;
}

/**
 * Audit trails name their target so an operator can follow what happened. That
 * label is content: a lead who is not allowed to read a restricted source must
 * still see that an action occurred, but not which source or item it touched.
 * Action, actor, time and IP are preserved; the target and metadata become
 * opaque when the viewer could not open the item themselves.
 */
export async function redactAuditEventsForViewer({ events, project, userId }) {
  const idsByType = { source: new Set(), document: new Set(), claim: new Set() };
  for (const event of events) {
    if (!event.targetId) continue;
    const bucket = idsByType[event.targetType];
    if (bucket) bucket.add(String(event.targetId));
  }

  const [sources, documents, claims] = await Promise.all([
    Source.find({ project: project._id }).lean(),
    idsByType.document.size > 0
      ? Document.find({ _id: { $in: [...idsByType.document] } }).lean()
      : [],
    idsByType.claim.size > 0
      ? Claim.find({ _id: { $in: [...idsByType.claim] } }).lean()
      : [],
  ]);

  const sourceById = new Map(sources.map((source) => [String(source._id), source]));
  const documentById = new Map(documents.map((document) => [String(document._id), document]));
  const claimById = new Map(claims.map((claim) => [String(claim._id), claim]));

  const evidenceByClaim = new Map();
  if (idsByType.claim.size > 0) {
    const evidence = await Evidence.find({
      claim: { $in: [...idsByType.claim] },
    }).lean();
    for (const entry of evidence) {
      const key = String(entry.claim);
      if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
      evidenceByClaim.get(key).push(entry);
    }
  }

  const mayRead = (event) => {
    if (!event.targetId) return true;
    const id = String(event.targetId);
    if (event.targetType === 'source') {
      return sourceVisibleTo(sourceById.get(id), project, userId);
    }
    if (event.targetType === 'document') {
      const document = documentById.get(id);
      if (!document) return false;
      return sourceVisibleTo(sourceById.get(String(document.source)), project, userId);
    }
    if (event.targetType === 'claim') {
      if (!claimById.get(id)) return false;
      return claimVisibleTo({
        evidence: evidenceByClaim.get(id) || [],
        sourceById,
        project,
        userId,
      });
    }
    return true;
  };

  return events.map((event) => {
    if (mayRead(event)) return event;
    return {
      id: event.id,
      action: event.action,
      actorName: event.actorName,
      targetType: event.targetType,
      targetLabel: 'Restricted item',
      meta: { restricted: true },
      createdAt: event.createdAt,
      ip: event.ip,
      redacted: true,
    };
  });
}
