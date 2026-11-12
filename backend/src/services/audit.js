import { AuditEvent } from '../models/index.js';
import { logger } from '../lib/logger.js';

export async function recordAudit({
  projectId,
  actor,
  action,
  targetType,
  targetId,
  targetLabel,
  meta = {},
  req,
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
    logger.error({ action, error: error.message }, 'Failed to write audit event');
  }
}
