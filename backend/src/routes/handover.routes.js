import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { AppError, asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { redactText } from '../lib/redaction.js';
import { calendarDate } from '../lib/text.js';
import { authenticateIfPresent } from '../middleware/auth.js';
import { getProjectForUser } from '../middleware/project.js';
import { validate } from '../middleware/validate.js';
import { Delivery, Handover, HandoverFeedback, Project, User } from '../models/index.js';
import { canContribute, canManageProject, roleOf, sourceVisibleTo } from '../services/access/policy.js';
import { recordAudit } from '../services/audit.js';
import { composeHandover } from '../services/handover/compose.js';
import { renderHandoverPdf } from '../services/handover/export.js';
import { leadIds, notify } from '../services/notifications.js';
import {
  acknowledgeHandover,
  approveHandover,
  buildRecipientView,
  buildReviewerView,
  compareHandover,
  handoverAccess,
  hashShareToken,
  listVersions,
  loadSourceMap,
  regenerateHandover,
  rejectHandover,
  reopenHandover,
  renderItem,
  revokeShare,
  reviewItem,
  reviewItems,
  shareHandover,
  submitForReview,
  summarizeHandover,
  summarizeReview,
  versionDiff,
} from '../services/handover/workflow.js';
import {
  bulkReviewSchema,
  createHandoverSchema,
  handoverFeedbackSchema,
  listHandoversQuerySchema,
  listVersionsQuerySchema,
  noteSchema,
  optionalNoteSchema,
  resolveFeedbackSchema,
  reviewItemSchema,
} from '../validation/schemas.js';

const router = Router();

async function loadContext(id, user) {
  // A non-member gets exactly the same response as a random id: existence is
  // never revealed, and no further state (status, names, counts) leaks.
  if (!mongoose.isValidObjectId(id)) throw notFound('Handover not found');
  const handover = await Handover.findById(id);
  if (!handover) throw notFound('Handover not found');
  const project = await Project.findById(handover.project);
  if (!project || !roleOf(project, user._id)) throw notFound('Handover not found');
  return { handover, project };
}

function assertAuthorOrLead(handover, project, user, action = 'change') {
  const access = handoverAccess({ handover, project, user });
  const allowed = canContribute(project, user) && (access.isCreator || access.isLead);
  if (!allowed) {
    throw forbidden(`Only the author or a project lead can ${action} this handover`);
  }
  return access;
}

function serializeFeedback(row) {
  const plain = typeof row.toObject === 'function' ? row.toObject() : row;
  return {
    id: plain._id,
    claimId: plain.claimId || null,
    authorName: plain.authorSnapshot?.name || 'Recipient',
    authorRole: plain.authorSnapshot?.role || null,
    message: plain.message,
    status: plain.status,
    createdAt: plain.createdAt,
    resolvedAt: plain.resolvedAt || null,
    resolutionNote: plain.resolutionNote || null,
  };
}

async function createFeedbackRecord({ handover, project, recipient, body, req, viewer }) {
  if (
    !['shared', 'acknowledged'].includes(handover.status) ||
    !handover.shareTokenHash
  ) {
    throw forbidden('Feedback opens only while the handover is shared');
  }

  let claimId = null;
  if (body.claimId) {
    const item = (handover.items || []).find(
      (entry) => String(entry.claimId) === String(body.claimId),
    );
    if (!item) throw badRequest('That item is not part of this handover');
    const sourceById = await loadSourceMap(project._id);
    const readable = (item.citations || []).every((citation) =>
      sourceVisibleTo(sourceById.get(String(citation.sourceId)), project, recipient._id),
    );
    if (!readable) throw forbidden('You cannot comment on an item you cannot read');
    claimId = item.claimId;
  }

  // A share link can be opened without signing in. The link still names a
  // recipient for access checks, but an anonymous visitor must never be
  // recorded as that person.
  const anonymous = !viewer;
  const record = await HandoverFeedback.create({
    project: project._id,
    handover: handover._id,
    claimId,
    author: recipient._id,
    authorSnapshot: anonymous
      ? { name: 'Anonymous demo visitor', role: 'visitor' }
      : {
          name: recipient.name,
          role: roleOf(project, recipient._id) || 'member',
        },
    message: redactText(body.message).text,
  });

  await recordAudit({
    projectId: project._id,
    actor: viewer || null,
    action: 'handover.feedback_received',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { claimId: claimId ? String(claimId) : null, anonymous },
    req,
  });

  // notify() keeps one row per handover and recipient, so repeated notes do
  // not stack up in the bell.
  await notify({
    project,
    recipients: [handover.createdBy, ...leadIds(project)],
    type: 'handover.feedback',
    entityType: 'handover',
    entityId: handover._id,
    actor: viewer || null,
  });

  return record;
}

function exportFilename(handover) {
  const who = String(handover.recipientSnapshot?.name || 'recipient')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const day = calendarDate(new Date());
  return `handover-${who || 'recipient'}-${day}.pdf`;
}

async function sendPdf(res, { view, project, viewer, filename }) {
  const pdf = await renderHandoverPdf({
    handover: view,
    projectName: project.name,
    viewer,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(pdf);
}

// One list request may look through at most this many database batches. A
// recipient whose rows keep failing the read-time check gets a cursor back
// instead of an unbounded scan.
export const HANDOVER_LIST_SCAN_BATCHES = 5;

// The recipient's list rule, expressed as a query so unshared drafts and dead
// links never enter the page loop at all.
export function recipientVisibleFilter(userId, now = Date.now()) {
  return {
    recipient: userId,
    status: { $in: ['shared', 'acknowledged'] },
    $or: [
      { status: 'acknowledged', revokedAt: null },
      {
        status: 'shared',
        revokedAt: null,
        shareTokenHash: { $exists: true, $ne: null },
        shareExpiresAt: { $gt: new Date(now) },
      },
    ],
  };
}

router.get(
  '/',
  validate({ query: listHandoversQuerySchema }),
  asyncHandler(async (req, res) => {
    const { projectId, scope, limit, cursor } = req.query;
    const userId = req.user._id;

    let query;
    if (projectId) {
      const project = await getProjectForUser(projectId, req.user);
      const isLead = canManageProject(project, req.user);
      query = { project: project._id };
      // Scope always filters. A lead may pass scope=all to list the project's
      // handovers; every other value means exactly what it says for everyone.
      if (scope === 'created') query.createdBy = userId;
      else if (scope === 'received') Object.assign(query, recipientVisibleFilter(userId));
      else if (!isLead) {
        query.$or = [{ createdBy: userId }, recipientVisibleFilter(userId)];
      }
    } else {
      const projects = await Project.find({ 'members.user': userId })
        .select('owner members')
        .lean();
      const leadProjectIds = projects
        .filter((project) => canManageProject(project, req.user))
        .map((project) => project._id);

      if (scope === 'created') {
        query = { createdBy: userId };
      } else if (scope === 'received') {
        query = recipientVisibleFilter(userId);
      } else {
        const or = [{ createdBy: userId }, recipientVisibleFilter(userId)];
        if (leadProjectIds.length > 0) or.push({ project: { $in: leadProjectIds } });
        query = { $or: or };
      }
    }

    // Visibility is filtered in the query above. This read-time check is the
    // second line of defence: rows that still fail it (membership removed,
    // permission changed) are dropped without letting the page loop walk the
    // whole collection.
    const visibleRows = async (rows) => {
      if (rows.length === 0) return [];
      const projectIds = [...new Set(rows.map((handover) => String(handover.project)))];
      const projects = await Project.find({ _id: { $in: projectIds } }).lean();
      const projectById = new Map(projects.map((project) => [String(project._id), project]));
      return rows
        .map((handover) => {
          const project = projectById.get(String(handover.project));
          const isCreator = String(handover.createdBy) === String(userId);
          const isLead = canManageProject(project || {}, req.user);
          const canView = Boolean(
            project && handoverAccess({ handover, project, user: req.user }).canView,
          );
          // The recipient sees one current handover per share. Earlier
          // releases stay reachable from the current handover's history list;
          // the team still sees them here with a "superseded" label.
          const hiddenHistory = handover.status === 'superseded' && !isCreator && !isLead;
          return {
            handover,
            project,
            isCreator,
            isLead,
            canView: canView && !hiddenHistory,
          };
        })
        .filter(({ canView }) => canView);
    };

    let after = cursor ? new mongoose.Types.ObjectId(cursor) : null;
    let hasMore = false;
    let nextCursor = null;
    let batches = 0;
    const visible = [];

    for (;;) {
      const filter = after ? { $and: [query, { _id: { $lt: after } }] } : query;
      const batch = await Handover.find(filter).sort({ _id: -1 }).limit(limit).lean();
      batches += 1;
      if (batch.length === 0) break;

      visible.push(...(await visibleRows(batch)));

      if (visible.length >= limit) {
        // Page from the last returned row, not the last examined one, so rows
        // that were examined but did not fit are re-read on the next page.
        nextCursor = String(visible[limit - 1].handover._id);
        hasMore =
          visible.length > limit ||
          Boolean(await Handover.exists({ $and: [query, { _id: { $lt: visible[limit - 1].handover._id } }] }));
        visible.length = limit;
        break;
      }

      after = batch[batch.length - 1]._id;
      if (batch.length < limit) break;

      if (batches >= HANDOVER_LIST_SCAN_BATCHES) {
        // Resume from the last row examined: everything already scanned is
        // older-_id territory, so the next page neither repeats nor skips it.
        nextCursor = String(after);
        hasMore = Boolean(await Handover.exists({ $and: [query, { _id: { $lt: after } }] }));
        break;
      }
    }

    res.json({
      handovers: visible.map(({ handover, isCreator, isLead }) =>
        summarizeHandover(handover, {
          viewer: isCreator || isLead ? 'reviewer' : 'recipient',
        }),
      ),
      nextCursor,
      hasMore,
    });
  }),
);

router.post(
  '/',
  validate({ body: createHandoverSchema }),
  asyncHandler(async (req, res) => {
    const { projectId, recipientId, roleTemplate } = req.body;
    const project = await getProjectForUser(projectId, req.user);

    if (!canContribute(project, req.user)) {
      throw forbidden('Only the outgoing team can prepare handovers; recipients receive them');
    }

    const recipient = await User.findById(recipientId);
    if (!recipient) throw notFound('Recipient user not found');
    if (!roleOf(project, recipientId)) {
      throw badRequest('The recipient must be a member of this project');
    }

    const handover = await composeHandover({
      project,
      recipient,
      actor: req.user,
      roleTemplate,
      req,
    });

    res.status(201).json({
      handover: await buildReviewerView({ handover, project, user: req.user }),
      viewer: 'author',
    });
  }),
);

/**
 * Share links are public for the demo workspace so judges can evaluate the
 * recipient journey without a password. Every other project keeps the original
 * rule: the link opens only for the named recipient's signed-in account.
 */
export const sharedHandoverRouter = Router();

/**
 * Anonymous visitors can post feedback on a shared link, so the write is
 * capped per link (one visitor cannot flood it) and per address (one client
 * cannot flood many links). Signed-in recipients are not anonymous abuse and
 * are exempt.
 */
function sharedFeedbackLimitHandler(_req, res) {
  res.status(429).json({
    error: {
      code: 'too_many_posts',
      message: 'Too many anonymous feedback posts on this link. Try again later.',
    },
  });
}

const sharedFeedbackLinkLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => Boolean(req.user),
  keyGenerator: (req) => `link:${req.params.token || req.ip}`,
  handler: sharedFeedbackLimitHandler,
});

const sharedFeedbackIpLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => Boolean(req.user),
  keyGenerator: (req) => `ip:${req.ip}`,
  handler: sharedFeedbackLimitHandler,
});

async function loadSharedHandover(token, viewer) {
  const handover = await Handover.findOne({ shareTokenHash: hashShareToken(token) });
  if (!handover) throw notFound('This share link is not valid');

  if (handover.shareExpiresAt && handover.shareExpiresAt.getTime() < Date.now()) {
    throw new AppError(410, 'share_expired', 'This share link has expired');
  }
  if (!['shared', 'acknowledged'].includes(handover.status)) {
    throw forbidden('This handover is not currently shared');
  }

  const project = await Project.findById(handover.project);
  if (!project) throw notFound('Project not found');
  const recipient = await User.findById(handover.recipient);
  if (!recipient || !roleOf(project, recipient._id)) {
    throw forbidden('The recipient is no longer a member of this project');
  }

  // Demo links are advertised as public previews. A visitor who happens to be
  // signed in as somebody else still sees the preview instead of an error.
  let publicPreview = false;
  if (viewer) {
    if (String(handover.recipient) !== String(viewer._id)) {
      if (!project.isDemo) {
        throw forbidden('This share link belongs to a different recipient');
      }
      publicPreview = true;
    }
  } else if (project.isDemo) {
    publicPreview = true;
  } else {
    throw forbidden('This share link opens only for the named recipient. Sign in to continue.');
  }

  return { handover, project, recipient, publicPreview };
}

sharedHandoverRouter.get(
  '/:token',
  authenticateIfPresent,
  asyncHandler(async (req, res) => {
    const { handover, project, recipient, publicPreview } = await loadSharedHandover(
      req.params.token,
      req.user,
    );

    // The sender can see that the link was opened even before it is
    // acknowledged. Each open is counted, but only the first and last times
    // are shown. The counter uses $inc (and the first-open timestamp $ifNull)
    // so simultaneous opens cannot overwrite each other's counts.
    const openedAt = new Date();
    handover.shareOpenedAt = handover.shareOpenedAt || openedAt;
    handover.shareLastOpenedAt = openedAt;
    handover.shareOpenCount = (handover.shareOpenCount || 0) + 1;
    handover.lastAccessedAt = openedAt;
    await Handover.updateOne(
      { _id: handover._id },
      [
        {
          $set: {
            shareOpenedAt: { $ifNull: ['$shareOpenedAt', openedAt] },
            shareLastOpenedAt: openedAt,
            shareOpenCount: { $add: [{ $ifNull: ['$shareOpenCount', 0] }, 1] },
            lastAccessedAt: openedAt,
          },
        },
      ],
    );

    const view = await buildRecipientView({
      handover,
      project,
      user: recipient,
      req,
      auditActor: req.user || null,
    });
    res.json({
      handover: view,
      viewer: 'recipient',
      recipientName: recipient.name,
      publicPreview,
    });
  }),
);

sharedHandoverRouter.get(
  '/:token/export',
  authenticateIfPresent,
  asyncHandler(async (req, res) => {
    const { handover, project, recipient } = await loadSharedHandover(
      req.params.token,
      req.user,
    );
    const view = await buildRecipientView({
      handover,
      project,
      user: recipient,
      req,
      auditActor: req.user || null,
    });
    await sendPdf(res, {
      view,
      project,
      viewer: 'recipient',
      filename: exportFilename(handover),
    });
  }),
);

sharedHandoverRouter.post(
  '/:token/feedback',
  authenticateIfPresent,
  sharedFeedbackLinkLimiter,
  sharedFeedbackIpLimiter,
  validate({ body: handoverFeedbackSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project, recipient, publicPreview } = await loadSharedHandover(
      req.params.token,
      req.user,
    );
    const record = await createFeedbackRecord({
      handover,
      project,
      recipient,
      body: req.body,
      req,
      // A signed-in visitor on somebody else's demo link is still a public
      // preview viewer; do not sign the note with the recipient's name.
      viewer: publicPreview ? null : req.user || null,
    });
    res.status(201).json({ feedback: serializeFeedback(record) });
  }),
);

sharedHandoverRouter.post(
  '/:token/acknowledge',
  authenticateIfPresent,
  asyncHandler(async (req, res) => {
    const { handover, project, recipient, publicPreview } = await loadSharedHandover(
      req.params.token,
      req.user,
    );
    await acknowledgeHandover({
      handover,
      project,
      actor: recipient,
      req,
      channel: req.user ? 'share_link' : 'public_share_link',
      auditActor: req.user || null,
    });
    const view = await buildRecipientView({
      handover,
      project,
      user: recipient,
      req,
      auditActor: req.user || null,
    });
    res.json({
      handover: view,
      viewer: 'recipient',
      recipientName: recipient.name,
      publicPreview,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    const access = handoverAccess({ handover, project, user: req.user });

    if (!access.canView) {
      throw forbidden(
        access.isRecipient
          ? 'This handover has not been shared with you yet'
          : 'You do not have access to this handover',
      );
    }

    if (access.isRecipient && !access.isCreator && !access.isLead) {
      const view = await buildRecipientView({ handover, project, user: req.user, req });
      return res.json({ handover: view, viewer: 'recipient' });
    }

    return res.json({
      handover: await buildReviewerView({ handover, project, user: req.user }),
      viewer: access.isCreator ? 'author' : 'reviewer',
    });
  }),
);

router.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    const access = handoverAccess({ handover, project, user: req.user });
    if (!access.canView) throw forbidden('You do not have access to this handover');

    const recipientOnly = access.isRecipient && !access.isCreator && !access.isLead;
    const view = recipientOnly
      ? await buildRecipientView({ handover, project, user: req.user, req })
      : await buildReviewerView({ handover, project, user: req.user });

    await sendPdf(res, {
      view,
      project,
      viewer: recipientOnly ? 'recipient' : 'reviewer',
      filename: exportFilename(handover),
    });
  }),
);

router.get(
  '/:id/feedback',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'read feedback on');
    const rows = await HandoverFeedback.find({ handover: handover._id })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ feedback: rows.map(serializeFeedback) });
  }),
);

router.post(
  '/:id/feedback',
  validate({ body: handoverFeedbackSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    const access = handoverAccess({ handover, project, user: req.user });
    if (!access.isRecipient) {
      throw forbidden('Only the named recipient can send feedback on this handover');
    }
    const record = await createFeedbackRecord({
      handover,
      project,
      recipient: req.user,
      body: req.body,
      req,
      viewer: req.user,
    });
    res.status(201).json({ feedback: serializeFeedback(record) });
  }),
);

router.patch(
  '/:id/feedback/:feedbackId',
  validate({ body: resolveFeedbackSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'resolve feedback on');
    const record = await HandoverFeedback.findOne({
      _id: req.params.feedbackId,
      handover: handover._id,
    });
    if (!record) throw notFound('Feedback not found');

    record.status = 'resolved';
    record.resolvedBy = req.user._id;
    record.resolvedAt = new Date();
    record.resolutionNote = req.body.note ? redactText(req.body.note).text : undefined;
    await record.save();

    await recordAudit({
      projectId: project._id,
      actor: req.user,
      action: 'handover.feedback_resolved',
      targetType: 'handover',
      targetId: handover._id,
      targetLabel: `Handover v${handover.version}`,
      meta: { feedbackId: String(record._id), note: record.resolutionNote || null },
      req,
    });

    res.json({ feedback: serializeFeedback(record) });
  }),
);

router.get(
  '/:id/deliveries',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'read deliveries for');
    const rows = await Delivery.find({ handover: handover._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({
      deliveries: rows.map((row) => ({
        id: row._id,
        kind: row.kind,
        channel: row.channel,
        status: row.status,
        detail: row.detail,
        createdAt: row.createdAt,
      })),
    });
  }),
);

router.patch(
  '/:id/items/:claimId',
  validate({ body: reviewItemSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'review');

    const item = await reviewItem({
      handover,
      project,
      actor: req.user,
      claimId: req.params.claimId,
      decision: req.body.decision,
      editedStatement: req.body.editedStatement,
      note: req.body.note,
      shareWithProject: req.body.shareWithProject === true,
      req,
    });

    // Return only what changed. Sending the whole reviewer view for every
    // keystroke-scale decision made the review loop heavy on large handovers.
    res.json({
      item: renderItem(item, { recipient: false }),
      version: handover.version,
      counts: summarizeReview(handover),
    });
  }),
);

router.post(
  '/:id/items/bulk',
  validate({ body: bulkReviewSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'review');

    const applied = await reviewItems({
      handover,
      project,
      actor: req.user,
      decisions: req.body.decisions,
      req,
    });

    res.json({
      items: applied.map((item) => renderItem(item, { recipient: false })),
      version: handover.version,
      counts: summarizeReview(handover),
    });
  }),
);

router.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'submit');

    await submitForReview({ handover, project, actor: req.user, req });
    res.json({ handover: await buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.post(
  '/:id/approve',
  validate({ body: optionalNoteSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    await approveHandover({
      handover,
      project,
      actor: req.user,
      note: req.body.note,
      req,
    });
    res.json({ handover: await buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.post(
  '/:id/reject',
  validate({ body: noteSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    await rejectHandover({
      handover,
      project,
      actor: req.user,
      note: req.body.note,
      req,
    });
    res.json({ handover: await buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.post(
  '/:id/reopen',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    await reopenHandover({ handover, project, actor: req.user, req });
    res.json({ handover: await buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.get(
  '/:id/freshness',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'compare');
    const comparison = await compareHandover({ handover, project, actor: req.user });
    res.json({ comparison });
  }),
);

router.post(
  '/:id/regenerate',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'regenerate');
    const result = await regenerateHandover({
      handover,
      project,
      actor: req.user,
      req,
    });
    res.json({
      regenerated: true,
      ...result,
      handover: await buildReviewerView({
        handover: result.handover,
        project,
        user: req.user,
      }),
    });
  }),
);

router.post(
  '/:id/share',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    const token = await shareHandover({
      handover,
      project,
      actor: req.user,
      confirmRotation: req.body?.confirmRotation === true,
      req,
    });

    res.json({
      shared: true,
      sharePath: `/api/handovers/shared/${token}`,
      shareExpiresAt: handover.shareExpiresAt,
      status: handover.status,
      rotated: Boolean(req.body?.confirmRotation),
    });
  }),
);

router.post(
  '/:id/share/revoke',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    const result = await revokeShare({
      handover,
      project,
      actor: req.user,
      reason: req.body?.reason,
      req,
    });
    res.json({
      revoked: true,
      idempotent: result.idempotent,
      handover: await buildReviewerView({ handover, project, user: req.user }),
    });
  }),
);

router.post(
  '/:id/acknowledge',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    await acknowledgeHandover({ handover, project, actor: req.user, req });
    const view = await buildRecipientView({ handover, project, user: req.user, req });
    res.json({ handover: view, viewer: 'recipient' });
  }),
);

router.get(
  '/:id/versions',
  validate({ query: listVersionsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'view the history of');
    const { limit, cursor } = req.query;
    const page = await listVersions(handover._id, { limit, cursor });
    res.json(page);
  }),
);

router.get(
  '/:id/versions/:version',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id, req.user);
    assertAuthorOrLead(handover, project, req.user, 'view the history of');
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw badRequest('Invalid version number');
    const diff = await versionDiff(handover._id, version, {
      viewer: req.user,
      project,
    });
    res.json({ diff });
  }),
);

export default router;
