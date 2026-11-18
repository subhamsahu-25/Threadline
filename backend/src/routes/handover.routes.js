import { Router } from 'express';
import { AppError, asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { redactText } from '../lib/redaction.js';
import { authenticateIfPresent } from '../middleware/auth.js';
import { getProjectForUser } from '../middleware/project.js';
import { DEMO_PROJECT_KEY } from '../demo/seed.js';
import { validate } from '../middleware/validate.js';
import { Delivery, Handover, HandoverFeedback, Project, User } from '../models/index.js';
import { canManageProject, roleOf, sourceVisibleTo } from '../services/access/policy.js';
import { recordAudit } from '../services/audit.js';
import { composeHandover } from '../services/handover/compose.js';
import { renderHandoverMarkdown } from '../services/handover/export.js';
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
  revokeShare,
  reviewItem,
  shareHandover,
  submitForReview,
  summarizeHandover,
  versionDiff,
} from '../services/handover/workflow.js';
import {
  createHandoverSchema,
  handoverFeedbackSchema,
  listHandoversQuerySchema,
  noteSchema,
  optionalNoteSchema,
  resolveFeedbackSchema,
  reviewItemSchema,
} from '../validation/schemas.js';

const router = Router();

async function loadContext(id) {
  const handover = await Handover.findById(id);
  if (!handover) throw notFound('Handover not found');
  const project = await Project.findById(handover.project);
  if (!project) throw notFound('Project not found');
  return { handover, project };
}

function assertAuthorOrLead(handover, project, user, action = 'change') {
  const access = handoverAccess({ handover, project, user });
  if (!(access.isCreator || access.isLead)) {
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

async function createFeedbackRecord({ handover, project, recipient, body, req }) {
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

  const record = await HandoverFeedback.create({
    project: project._id,
    handover: handover._id,
    claimId,
    author: recipient._id,
    authorSnapshot: {
      name: recipient.name,
      role: roleOf(project, recipient._id) || 'member',
    },
    message: redactText(body.message).text,
  });

  await recordAudit({
    projectId: project._id,
    actor: recipient,
    action: 'handover.feedback_received',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover v${handover.version}`,
    meta: { claimId: claimId ? String(claimId) : null },
    req,
  });

  await notify({
    project,
    recipients: [handover.createdBy, ...leadIds(project)],
    type: 'handover.feedback',
    entityType: 'handover',
    entityId: handover._id,
    actor: recipient,
  });

  return record;
}

function exportFilename(handover) {
  const who = String(handover.recipientSnapshot?.name || 'recipient')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const day = new Date().toISOString().slice(0, 10);
  return `handover-${who || 'recipient'}-${day}.md`;
}

function sendMarkdown(res, { view, project, viewer, filename }) {
  const markdown = renderHandoverMarkdown({
    handover: view,
    projectName: project.name,
    viewer,
  });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(markdown);
}

router.get(
  '/',
  validate({ query: listHandoversQuerySchema }),
  asyncHandler(async (req, res) => {
    const { projectId, scope } = req.query;
    const userId = req.user._id;

    let query;
    if (projectId) {
      const project = await getProjectForUser(projectId, req.user);
      const isLead = canManageProject(project, req.user);
      query = { project: project._id };
      if (!isLead) {
        if (scope === 'created') query.createdBy = userId;
        else if (scope === 'received') query.recipient = userId;
        else query.$or = [{ createdBy: userId }, { recipient: userId }];
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
        query = { recipient: userId };
      } else {
        const or = [{ createdBy: userId }, { recipient: userId }];
        if (leadProjectIds.length > 0) or.push({ project: { $in: leadProjectIds } });
        query = { $or: or };
      }
    }

    const handovers = await Handover.find(query).sort({ createdAt: -1 }).limit(100);

    const projectIds = [...new Set(handovers.map((handover) => String(handover.project)))];
    const projects = await Project.find({ _id: { $in: projectIds } }).lean();
    const projectById = new Map(projects.map((project) => [String(project._id), project]));

    res.json({
      handovers: handovers.map((handover) => {
        const project = projectById.get(String(handover.project));
        const isCreator = String(handover.createdBy) === String(userId);
        const isLead = project ? canManageProject(project, req.user) : false;
        return summarizeHandover(handover, {
          viewer: isCreator || isLead ? 'reviewer' : 'recipient',
        });
      }),
    });
  }),
);

router.post(
  '/',
  validate({ body: createHandoverSchema }),
  asyncHandler(async (req, res) => {
    const { projectId, recipientId, roleTemplate } = req.body;
    const project = await getProjectForUser(projectId, req.user);

    const role = roleOf(project, req.user._id);
    if (!['lead', 'contributor'].includes(role)) {
      throw forbidden('Observers cannot prepare handovers');
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

  if (viewer) {
    if (String(handover.recipient) !== String(viewer._id)) {
      throw forbidden('This share link belongs to a different recipient');
    }
  } else if (project.key !== DEMO_PROJECT_KEY) {
    throw forbidden('This share link opens only for the named recipient. Sign in to continue.');
  }

  return { handover, project, recipient };
}

sharedHandoverRouter.get(
  '/:token',
  authenticateIfPresent,
  asyncHandler(async (req, res) => {
    const { handover, project, recipient } = await loadSharedHandover(
      req.params.token,
      req.user,
    );

    // The sender can see that the link was opened even before it is
    // acknowledged. Each open is counted, but only the first and last times
    // are shown. A save here is safe: this document was just loaded and only
    // these tracking fields change.
    const openedAt = new Date();
    if (!handover.shareOpenedAt) handover.shareOpenedAt = openedAt;
    handover.shareLastOpenedAt = openedAt;
    handover.shareOpenCount = (handover.shareOpenCount || 0) + 1;
    handover.lastAccessedAt = openedAt;
    await handover.save();

    const view = await buildRecipientView({ handover, project, user: recipient, req });
    res.json({
      handover: view,
      viewer: 'recipient',
      recipientName: recipient.name,
      publicPreview: !req.user,
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
    const view = await buildRecipientView({ handover, project, user: recipient, req });
    sendMarkdown(res, {
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
  validate({ body: handoverFeedbackSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project, recipient } = await loadSharedHandover(
      req.params.token,
      req.user,
    );
    const record = await createFeedbackRecord({
      handover,
      project,
      recipient,
      body: req.body,
      req,
    });
    res.status(201).json({ feedback: serializeFeedback(record) });
  }),
);

sharedHandoverRouter.post(
  '/:token/acknowledge',
  authenticateIfPresent,
  asyncHandler(async (req, res) => {
    const { handover, project, recipient } = await loadSharedHandover(
      req.params.token,
      req.user,
    );
    await acknowledgeHandover({
      handover,
      project,
      actor: recipient,
      req,
      channel: req.user ? 'share_link' : 'public_share_link',
    });
    const view = await buildRecipientView({ handover, project, user: recipient, req });
    res.json({
      handover: view,
      viewer: 'recipient',
      recipientName: recipient.name,
      publicPreview: !req.user,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
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
    const { handover, project } = await loadContext(req.params.id);
    const access = handoverAccess({ handover, project, user: req.user });
    if (!access.canView) throw forbidden('You do not have access to this handover');

    const recipientOnly = access.isRecipient && !access.isCreator && !access.isLead;
    const view = recipientOnly
      ? await buildRecipientView({ handover, project, user: req.user, req })
      : await buildReviewerView({ handover, project, user: req.user });

    sendMarkdown(res, {
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
    const { handover, project } = await loadContext(req.params.id);
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
    const { handover, project } = await loadContext(req.params.id);
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
    });
    res.status(201).json({ feedback: serializeFeedback(record) });
  }),
);

router.patch(
  '/:id/feedback/:feedbackId',
  validate({ body: resolveFeedbackSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
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
    const { handover, project } = await loadContext(req.params.id);
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
    const { handover, project } = await loadContext(req.params.id);
    assertAuthorOrLead(handover, project, req.user, 'review');

    await reviewItem({
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

    res.json({ handover: await buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
    assertAuthorOrLead(handover, project, req.user, 'submit');

    await submitForReview({ handover, project, actor: req.user, req });
    res.json({ handover: await buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.post(
  '/:id/approve',
  validate({ body: optionalNoteSchema }),
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
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
    const { handover, project } = await loadContext(req.params.id);
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
    const { handover, project } = await loadContext(req.params.id);
    await reopenHandover({ handover, project, actor: req.user, req });
    res.json({ handover: await buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.get(
  '/:id/freshness',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
    assertAuthorOrLead(handover, project, req.user, 'compare');
    const comparison = await compareHandover({ handover, project, actor: req.user });
    res.json({ comparison });
  }),
);

router.post(
  '/:id/regenerate',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
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
      handover: await buildReviewerView({ handover, project, user: req.user }),
    });
  }),
);

router.post(
  '/:id/share',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
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
    const { handover, project } = await loadContext(req.params.id);
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
    const { handover, project } = await loadContext(req.params.id);
    await acknowledgeHandover({ handover, project, actor: req.user, req });
    const view = await buildRecipientView({ handover, project, user: req.user, req });
    res.json({ handover: view, viewer: 'recipient' });
  }),
);

router.get(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
    assertAuthorOrLead(handover, project, req.user, 'view the history of');
    const versions = await listVersions(handover._id);
    res.json({ versions });
  }),
);

router.get(
  '/:id/versions/:version',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
    assertAuthorOrLead(handover, project, req.user, 'view the history of');
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw badRequest('Invalid version number');
    const diff = await versionDiff(handover._id, version);
    res.json({ diff });
  }),
);

export default router;
