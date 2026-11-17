import { Router } from 'express';
import { AppError, asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { authenticateIfPresent } from '../middleware/auth.js';
import { getProjectForUser } from '../middleware/project.js';
import { DEMO_PROJECT_KEY } from '../demo/seed.js';
import { validate } from '../middleware/validate.js';
import { Handover, Project, User } from '../models/index.js';
import { canManageProject, roleOf } from '../services/access/policy.js';
import { composeHandover } from '../services/handover/compose.js';
import {
  acknowledgeHandover,
  approveHandover,
  buildRecipientView,
  buildReviewerView,
  compareHandover,
  handoverAccess,
  hashShareToken,
  listVersions,
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
  listHandoversQuerySchema,
  noteSchema,
  optionalNoteSchema,
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
    const view = await buildRecipientView({ handover, project, user: recipient, req });
    res.json({
      handover: view,
      viewer: 'recipient',
      recipientName: recipient.name,
      publicPreview: !req.user,
    });
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
