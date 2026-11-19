import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { Handover, Project, User } from '../../models/index.js';
import { roleOf } from '../access/policy.js';
import { deliverOutbound } from '../delivery.js';
import { leadIds, notify } from '../notifications.js';

/**
 * Sends one reminder for a handover that is still unacknowledged after the
 * configured delay. The reminder is recorded on the handover, so a restart or
 * a second scan cannot send the same nudge twice. A removed recipient is
 * skipped silently; the notice system already refuses to address a non-member.
 */
export async function sendDueReminders({ now = new Date(), limit = 50 } = {}) {
  if (!env.handoverReminderEnabled) return { sent: 0, scanned: 0 };

  const cutoff = new Date(now.getTime() - env.handoverReminderDays * 86_400_000);
  const rows = await Handover.find({
    status: 'shared',
    acknowledgedAt: null,
    reminderSentAt: null,
    sharedAt: { $lte: cutoff },
    shareExpiresAt: { $gt: now },
    shareTokenHash: { $exists: true, $ne: null },
  })
    .sort({ sharedAt: 1 })
    .limit(limit);

  let sent = 0;
  for (const handover of rows) {
    const project = await Project.findById(handover.project);
    const recipient = await User.findById(handover.recipient);
    const stillMember = project && recipient && roleOf(project, recipient._id);

    if (!stillMember) {
      // Do not retry a recipient who can no longer read the handover.
      handover.reminderSentAt = now;
      await handover.save();
      continue;
    }

    await notify({
      project,
      recipients: [recipient._id],
      type: 'handover.reminder',
      entityType: 'handover',
      entityId: handover._id,
    });

    await deliverOutbound({
      projectId: project._id,
      handoverId: handover._id,
      kind: 'handover.reminder',
      text: `Reminder: the handover for ${recipient.name} in ${project.name} is still waiting to be acknowledged.`,
    });

    handover.reminderSentAt = now;
    await handover.save();
    sent += 1;
  }

  return { sent, scanned: rows.length };
}

/**
 * Warns the lead and the recipient one day before a share link expires. The
 * recipient's signed-in copy survives expiry, so this is about renewing the
 * link for anonymous access rather than about losing the handover.
 */
export async function sendExpiryReminders({ now = new Date(), limit = 50 } = {}) {
  if (!env.handoverReminderEnabled) return { sent: 0, scanned: 0 };

  const soon = new Date(now.getTime() + 86_400_000);
  const rows = await Handover.find({
    status: { $in: ['shared', 'acknowledged'] },
    shareTokenHash: { $exists: true, $ne: null },
    shareExpiresAt: { $gt: now, $lte: soon },
    expiryNoticeSentAt: null,
    revokedAt: null,
  })
    .sort({ shareExpiresAt: 1 })
    .limit(limit);

  let sent = 0;
  for (const handover of rows) {
    const project = await Project.findById(handover.project);
    if (!project) {
      handover.expiryNoticeSentAt = now;
      await handover.save();
      continue;
    }
    const recipients = [
      ...leadIds(project),
      ...(roleOf(project, handover.recipient) ? [String(handover.recipient)] : []),
    ];
    await notify({
      project,
      recipients,
      type: 'handover.expiry',
      entityType: 'handover',
      entityId: handover._id,
    });
    await deliverOutbound({
      projectId: project._id,
      handoverId: handover._id,
      kind: 'handover.expiry',
      text: `The share link for a handover in ${project.name} expires within a day. Issue a new link if it is still needed.`,
    });
    handover.expiryNoticeSentAt = now;
    await handover.save();
    sent += 1;
  }

  return { sent, scanned: rows.length };
}

export function startReminderScheduler({ intervalMs = 60_000 } = {}) {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    Promise.all([sendDueReminders(), sendExpiryReminders()])
      .catch((error) => logger.warn({ error: error.message }, 'Handover reminder scan failed'))
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
