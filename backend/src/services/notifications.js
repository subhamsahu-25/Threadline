import { randomUUID } from 'node:crypto';
import { Clarification, Handover, Notification, Project, Source } from '../models/index.js';
import { canManageProject, roleOf, sourceVisibleTo } from './access/policy.js';
import { logger } from '../lib/logger.js';

const ROLE_WORDS = { lead: 'lead', contributor: 'contributor', observer: 'observer' };

const KIND_WORDS = {
  missing_owner: 'Ownership gap',
  open_question: 'Open question',
  conflict: 'Conflicting statements',
};

export function leadIds(project) {
  const ids = new Set();
  if (project?.owner) ids.add(String(project.owner?._id ?? project.owner));
  for (const entry of project?.members || []) {
    if (entry.role === 'lead') ids.add(String(entry.user?._id ?? entry.user));
  }
  return [...ids];
}

/**
 * Writes one pointer per recipient. Repeating an action that reaches the same
 * state does not stack a second row: the unique key is type plus record, and
 * the existing row simply becomes unread again.
 */
export async function notify({ project, recipients, type, entityType, entityId, actor }) {
  if (!project?._id || !entityId) return 0;
  const actorId = String(actor?._id ?? actor?.id ?? '');
  const targets = [...new Set((recipients || []).filter(Boolean).map(String))].filter(
    (id) => id !== actorId,
  );
  if (targets.length === 0) return 0;

  const dedupeKey = `${type}:${String(entityId)}`;
  const results = await Promise.allSettled(
    targets.map((recipient) =>
      Notification.updateOne(
        { recipient, dedupeKey },
        {
          $set: { readAt: null },
          $setOnInsert: {
            project: project._id,
            recipient,
            type,
            entityType,
            entityId,
            dedupeKey,
          },
        },
        { upsert: true },
      ),
    ),
  );

  const failures = results.filter((result) => result.status === 'rejected');
  for (const failure of failures) {
    // A duplicate-key race is the upsert working as intended, not an error.
    if (failure.reason?.code !== 11000) {
      logger.warn({ type, error: failure.reason?.message }, 'Failed to write a notification');
    }
  }
  return results.length - failures.length;
}

/**
 * Account-level notice that does not belong to a project. Each lockout is its
 * own row so the person can see that it happened; the body is rebuilt at read
 * time and never includes an IP address or the attempted password.
 */
export async function notifyAccountLockout({ user }) {
  if (!user?._id) return 0;
  try {
    await Notification.create({
      recipient: user._id,
      type: 'account.lockout',
      entityType: 'user',
      entityId: user._id,
      dedupeKey: `account.lockout:${randomUUID()}`,
    });
    return 1;
  } catch (error) {
    logger.warn({ error: error.message }, 'Could not write an account security notice');
    return 0;
  }
}

function handoverNotice({ type, handover, project, viewer, isLead, isAuthor }) {
  if (!handover) return null;
  const isRecipient = String(handover.recipient) === String(viewer._id);
  const linkLive = Boolean(handover.shareTokenHash);
  const recipientName = handover.recipientSnapshot?.name || 'the recipient';
  const href = `/projects/${project._id}/handovers`;

  switch (type) {
    case 'handover.submitted':
      if (!isLead && !isAuthor) return null;
      return {
        title: isAuthor && !isLead ? 'Your handover is with the leads' : 'A handover needs your approval',
        detail: `${recipientName} · ${project.name}`,
        href,
      };
    case 'handover.approved':
      if (!isAuthor && !isLead) return null;
      return {
        title: isAuthor ? 'Your handover was approved' : 'A handover was approved',
        detail: `${recipientName} · ${project.name}`,
        href,
      };
    case 'handover.rejected':
      if (!isAuthor && !isLead) return null;
      return {
        title: isAuthor ? 'Your handover was sent back' : 'A handover was sent back',
        detail: 'Open it to read the reviewer’s note.',
        href,
      };
    case 'handover.shared':
      if (!isRecipient || !linkLive) return null;
      return {
        title: 'Your handover is ready to read',
        detail: `${project.name} · open the share link you were given`,
        href,
      };
    case 'handover.revoked':
      if (!isRecipient) return null;
      return {
        title: 'Your share link was withdrawn',
        detail: `${project.name} · ask the project lead if you still need it`,
        href,
      };
    case 'handover.reminder':
      if (!isRecipient || !linkLive) return null;
      return {
        title: 'Reminder: your handover is waiting',
        detail: `${project.name} · open the link and acknowledge it when you have read it`,
        href,
      };
    case 'handover.expiry':
      if (!isLead && !isRecipient) return null;
      return {
        title: isRecipient ? 'Your handover link expires tomorrow' : 'A handover link expires tomorrow',
        detail: `${project.name} · reissue it in one click if the recipient still needs a link`,
        href,
      };
    case 'handover.feedback':
      if (!isLead && !isAuthor) return null;
      return {
        title: 'The recipient sent feedback on a handover',
        detail: `${recipientName} · ${project.name}`,
        href,
      };
    case 'handover.outdated':
      if (!isLead && !isAuthor) return null;
      return {
        title: 'A handover is now out of date',
        detail: `A connected source changed · ${recipientName} · ${project.name}`,
        href,
      };
    case 'handover.member_left':
      // Only leads act on this; they need to pick a new author or recipient.
      if (!isLead) return null;
      return {
        title: 'A handover lost a participant',
        detail: `Someone connected to this handover left ${project.name}. Check the link and owner.`,
        href,
      };
    default:
      return null;
  }
}

function clarificationNotice({ type, clarification, project, viewer, isLead }) {
  if (!clarification) return null;
  const isAssignee = String(clarification.askedOf) === String(viewer._id);
  const isAsker = String(clarification.askedBy) === String(viewer._id);
  const href = `/projects/${project._id}/questions`;
  const kind = KIND_WORDS[clarification.kind] || 'Question';

  switch (type) {
    case 'clarification.asked':
      if (!isAssignee) return null;
      return {
        title: 'A question needs your answer',
        detail: `${kind} · ${project.name}`,
        href,
      };
    case 'clarification.answered':
      if (!isAsker && !isLead) return null;
      return {
        title: isAsker ? 'Your question was answered' : 'A question was answered',
        detail: `${kind} · ${project.name}`,
        href,
      };
    case 'clarification.declined':
      if (!isAsker && !isLead) return null;
      return {
        title: isAsker ? 'Your question was declined' : 'A question was declined',
        detail: `${kind} · ${project.name}`,
        href,
      };
    case 'clarification.closed':
      if (!isAsker && !isLead) return null;
      return {
        title: isAsker
          ? 'Your question was closed because the person left the project'
          : 'A question was closed after a member left',
        detail: `${kind} · ${project.name}`,
        href,
      };
    default:
      return null;
  }
}

function memberNotice({ type, entityId, project, viewer, role }) {
  if (String(entityId) !== String(viewer._id) || !role) return null;
  if (type === 'member.added') {
    return {
      title: `You were added to ${project.name}`,
      detail: `You now have the ${ROLE_WORDS[role] || 'member'} role on this project.`,
      href: `/projects/${project._id}/people`,
    };
  }
  if (type === 'member.role_changed') {
    return {
      title: 'Your access changed',
      detail: `You now have the ${ROLE_WORDS[role] || 'member'} role on ${project.name}.`,
      href: `/projects/${project._id}/people`,
    };
  }
  return null;
}

/**
 * Rebuilds every notice for this viewer at read time. A notice whose record is
 * gone, or whose record the viewer may no longer open, is deleted rather than
 * returned with a placeholder.
 */
export async function listNotifications({ user, limit = 50 }) {
  const rows = await Notification.find({ recipient: user._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const projectIds = [...new Set(rows.map((row) => row.project).filter(Boolean).map(String))];
  const projects = await Project.find({ _id: { $in: projectIds } }).lean();
  const projectById = new Map(projects.map((project) => [String(project._id), project]));

  const handoverIds = rows
    .filter((row) => row.entityType === 'handover')
    .map((row) => row.entityId)
    .filter(Boolean);
  const clarificationIds = rows
    .filter((row) => row.entityType === 'clarification')
    .map((row) => row.entityId)
    .filter(Boolean);
  const sourceIds = rows
    .filter((row) => row.entityType === 'source')
    .map((row) => row.entityId)
    .filter(Boolean);

  const [handovers, clarifications, sources] = await Promise.all([
    handoverIds.length
      ? Handover.find({ _id: { $in: handoverIds } })
          .select('recipient recipientSnapshot createdBy status shareTokenHash project')
          .lean()
      : [],
    clarificationIds.length
      ? Clarification.find({ _id: { $in: clarificationIds } })
          .select('askedBy askedOf kind status project')
          .lean()
      : [],
    sourceIds.length
      ? Source.find({ _id: { $in: sourceIds } })
          .select('name project visibility sensitivity deletedAt hiddenAt')
          .lean()
      : [],
  ]);

  const handoverById = new Map(handovers.map((entry) => [String(entry._id), entry]));
  const clarificationById = new Map(clarifications.map((entry) => [String(entry._id), entry]));
  const sourceById = new Map(sources.map((entry) => [String(entry._id), entry]));

  const stale = [];
  const notifications = [];

  for (const row of rows) {
    if (!row.project) {
      if (row.type === 'account.lockout' && String(row.entityId) === String(user._id)) {
        notifications.push({
          id: String(row._id),
          type: row.type,
          projectId: null,
          projectName: '',
          projectKey: '',
          createdAt: row.createdAt,
          readAt: row.readAt || null,
          title: 'Repeated sign-in attempts on your account',
          detail: 'Sign-in was paused for a short time. If this was not you, change your password.',
          href: '/',
        });
        continue;
      }
      stale.push(row._id);
      continue;
    }

    const project = projectById.get(String(row.project));
    const role = project ? roleOf(project, user._id) : null;
    if (!project || !role) {
      stale.push(row._id);
      continue;
    }

    const isLead = canManageProject(project, user);
    let notice = null;

    if (row.entityType === 'handover') {
      const handover = handoverById.get(String(row.entityId));
      if (!handover || String(handover.project) !== String(project._id)) {
        stale.push(row._id);
        continue;
      }
      notice = handoverNotice({
        type: row.type,
        handover,
        project,
        viewer: user,
        isLead,
        isAuthor: String(handover.createdBy) === String(user._id),
      });
    } else if (row.entityType === 'clarification') {
      const clarification = clarificationById.get(String(row.entityId));
      if (!clarification || String(clarification.project) !== String(project._id)) {
        stale.push(row._id);
        continue;
      }
      notice = clarificationNotice({
        type: row.type,
        clarification,
        project,
        viewer: user,
        isLead,
      });
    } else if (row.entityType === 'source') {
      const source = sourceById.get(String(row.entityId));
      if (
        !source ||
        String(source.project) !== String(project._id) ||
        source.deletedAt ||
        // The notice names the source, so only its readers may receive it.
        !sourceVisibleTo(source, project, user._id)
      ) {
        stale.push(row._id);
        continue;
      }
      if (row.type === 'source.external_ai_enabled') {
        notice = {
          title: 'A confidential source may leave the server',
          detail: `${source.name} now allows external AI · ${project.name}`,
          href: `/projects/${project._id}/sources`,
        };
      }
    } else {
      notice = memberNotice({
        type: row.type,
        entityId: row.entityId,
        project,
        viewer: user,
        role,
      });
    }

    if (!notice) {
      stale.push(row._id);
      continue;
    }

    notifications.push({
      id: String(row._id),
      type: row.type,
      projectId: String(project._id),
      projectName: project.name,
      projectKey: project.key,
      createdAt: row.createdAt,
      readAt: row.readAt || null,
      ...notice,
    });
  }

  if (stale.length > 0) {
    await Notification.deleteMany({ _id: { $in: stale } });
  }

  const unread = await Notification.countDocuments({ recipient: user._id, readAt: null });
  return { notifications, unread };
}

export async function markNotificationRead({ id, user }) {
  const result = await Notification.updateOne(
    { _id: id, recipient: user._id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { changed: result.modifiedCount > 0 };
}

export async function markAllNotificationsRead({ user }) {
  const result = await Notification.updateMany(
    { recipient: user._id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { changed: result.modifiedCount };
}
