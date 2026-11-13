import { Router } from 'express';
import { AppError, asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { getProjectForUser } from '../middleware/project.js';
import { validate } from '../middleware/validate.js';
import { Handover, Project, User } from '../models/index.js';
import { canManageProject, roleOf } from '../services/access/policy.js';
import { composeHandover } from '../services/handover/compose.js';
import {
  acknowledgeHandover,
  approveHandover,
  buildRecipientView,
  buildReviewerView,
  handoverAccess,
  listVersions,
  rejectHandover,
  reopenHandover,
  reviewItem,
  shareHandover,
  submitForReview,
  summarizeHandover,
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
    res.json({ handovers: handovers.map(summarizeHandover) });
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
      handover: buildReviewerView({ handover, project, user: req.user }),
      viewer: 'author',
    });
  }),
);

router.get(
  '/shared/:token',
  asyncHandler(async (req, res) => {
    const handover = await Handover.findOne({ shareToken: req.params.token });
    if (!handover) throw notFound('This share link is not valid');

    if (handover.shareExpiresAt && handover.shareExpiresAt.getTime() < Date.now()) {
      throw new AppError(410, 'share_expired', 'This share link has expired');
    }
    if (String(handover.recipient) !== String(req.user._id)) {
      throw forbidden('This share link belongs to a different recipient');
    }
    if (!['shared', 'acknowledged'].includes(handover.status)) {
      throw forbidden('This handover is not currently shared');
    }

    const project = await Project.findById(handover.project);
    if (!project) throw notFound('Project not found');
    if (!roleOf(project, req.user._id)) {
      throw forbidden('You are no longer a member of this project');
    }

    const view = await buildRecipientView({ handover, project, user: req.user, req });
    res.json({ handover: view, viewer: 'recipient' });
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
      handover: buildReviewerView({ handover, project, user: req.user }),
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
      req,
    });

    res.json({ handover: buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
    assertAuthorOrLead(handover, project, req.user, 'submit');

    await submitForReview({ handover, project, actor: req.user, req });
    res.json({ handover: buildReviewerView({ handover, project, user: req.user }) });
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
    res.json({ handover: buildReviewerView({ handover, project, user: req.user }) });
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
    res.json({ handover: buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.post(
  '/:id/reopen',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
    await reopenHandover({ handover, project, actor: req.user, req });
    res.json({ handover: buildReviewerView({ handover, project, user: req.user }) });
  }),
);

router.post(
  '/:id/share',
  asyncHandler(async (req, res) => {
    const { handover, project } = await loadContext(req.params.id);
    const token = await shareHandover({ handover, project, actor: req.user, req });

    res.json({
      shared: true,
      sharePath: `/api/handovers/shared/${token}`,
      shareExpiresAt: handover.shareExpiresAt,
      status: handover.status,
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

export default router;
