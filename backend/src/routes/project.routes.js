import { Router } from 'express';
import { AppError, asyncHandler, badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { env } from '../config/env.js';
import { DEMO_PROJECT_KEY } from '../demo/seed.js';
import { discardUploads, uploadFiles } from '../middleware/upload.js';
import { loadProject, requireProjectContributor, requireProjectLead } from '../middleware/project.js';
import { validate } from '../middleware/validate.js';
import {
  AuditEvent,
  Claim,
  Clarification,
  Document,
  Evidence,
  Handover,
  Notification,
  Project,
  Source,
  User,
} from '../models/index.js';
import {
  assertSourceVisible,
  canContribute,
  canManageProject,
  claimVisibleTo,
  isIncoming,
  roleOf,
  sourceVisibleTo,
} from '../services/access/policy.js';
import { recordAudit, recordViewAudit, redactAuditEventsForViewer } from '../services/audit.js';
import { notify } from '../services/notifications.js';
import {
  askClarifications,
  buildClarificationCandidates,
  closeOpenClarificationsForMember,
} from '../services/clarifications.js';
import { redactText } from '../lib/redaction.js';
import { locateQuote } from '../lib/text.js';
import { mailConfigured } from '../services/mailer.js';
import { enqueue } from '../services/queue.js';
import {
  buildStateForUser,
  decorateClaim,
  loadVisibleClaimPage,
  loadVisibleClaims,
  serializeDocument,
  serializeProject,
  serializeSource,
} from '../services/projectState.js';
import { parseDriveRef } from '../services/ingest/googleDrive.js';
import { parseRepoRef } from '../services/ingest/github.js';
import { allowsExternalAI } from '../services/ai/policy.js';
import { isSyncable } from '../services/ingest/sync.js';
import {
  detachMemberFromHandovers,
  handoverAccess,
  refreshOutdatedHandovers,
} from '../services/handover/workflow.js';
import { loadOwnerDirectory, resolveOwnerName } from '../services/owners.js';
import { findSupersededPairs } from '../services/reconstruction/link.js';
import { purgeSourceContent } from '../services/purge.js';
import {
  addMemberSchema,
  askClarificationsSchema,
  auditQuerySchema,
  createProjectSchema,
  createSourceSchema,
  emailField,
  listClaimsQuerySchema,
  resolveClaimSchema,
  resolveConflictSchema,
  syncSourceSchema,
  updateMemberRoleSchema,
  updateProjectSchema,
  updateSourceSchema,
  uploadSourceSchema,
} from '../validation/schemas.js';

const router = Router();

function zodError(error) {
  return new AppError(
    400,
    'validation_error',
    'The request contains invalid fields',
    error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}

/**
 * Connectors and confidential uploads fail closed: unless the creator names a
 * wider audience, only project leads can read the source.
 */
function defaultSourceVisibility({ kind, sensitivity, visibility }) {
  if (visibility) return visibility;
  const restricted = kind === 'github' || kind === 'drive' || sensitivity === 'confidential';
  if (!restricted) return { scope: 'project', roles: [], users: [] };
  return { scope: 'roles', roles: ['lead'], users: [] };
}

/**
 * Access follows the mailbox, not the typed address. An account that never
 * confirmed its address cannot receive a project membership, so a person who
 * registered somebody else's email gains nothing.
 */
function assertEmailVerified(user) {
  if (user.emailVerifiedAt) return;
  throw new AppError(
    409,
    'email_unverified',
    `${user.name} has not confirmed ${user.email} yet. They must open the verification link before they can join a project.`,
    { email: user.email, emailVerified: false },
  );
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const projects = await Project.find({ 'members.user': req.user._id })
      .populate('members.user', 'name email emailVerifiedAt')
      .sort({ createdAt: -1 });
    res.json({ projects: projects.map((project) => serializeProject(project, req.user)) });
  }),
);

router.post(
  '/',
  validate({ body: createProjectSchema }),
  asyncHandler(async (req, res) => {
    const { key, name, description, members, transition, startedAt, targetDate } = req.body;
    const normalizedKey = key.toUpperCase();

    // The mailbox rule applies to the creator as well: an unconfirmed account
    // cannot become the lead of a new project.
    if (!req.user.emailVerifiedAt) {
      throw new AppError(
        409,
        'email_unverified',
        'Confirm your email address before you create a project. Open the link in the confirmation email, then try again.',
        { email: req.user.email, emailVerified: false },
      );
    }

    if (normalizedKey === DEMO_PROJECT_KEY) {
      throw badRequest('The ATLAS key is reserved for the demo workspace');
    }

    const existing = await Project.findOne({ key: normalizedKey });
    if (existing) throw conflict(`Project key ${normalizedKey} is already in use`);

    const memberMap = new Map();
    memberMap.set(String(req.user._id), { user: req.user._id, role: 'lead' });

    const missing = [];
    const unverified = [];
    for (const entry of members) {
      const user = await User.findOne({ email: entry.email });
      if (!user) {
        missing.push(entry.email);
        continue;
      }
      if (!user.emailVerifiedAt) {
        unverified.push(entry.email);
        continue;
      }
      if (!memberMap.has(String(user._id))) {
        memberMap.set(String(user._id), { user: user._id, role: entry.role });
      }
    }
    if (missing.length > 0) {
      throw badRequest('Some invited members do not have accounts yet', {
        missingEmails: missing,
        hint: 'Ask them to register first, then add them to the project',
      });
    }
    if (unverified.length > 0) {
      throw new AppError(
        409,
        'email_unverified',
        'Some invited accounts have not confirmed their email address yet.',
        { unverifiedEmails: unverified, hint: 'Ask them to open the link in their confirmation email' },
      );
    }

    if (transition?.outgoingUserId && !memberMap.has(String(transition.outgoingUserId))) {
      throw badRequest('The outgoing person must be a project member');
    }

    const project = await Project.create({
      key: normalizedKey,
      name,
      description,
      owner: req.user._id,
      members: [...memberMap.values()],
      transition,
      startedAt,
      targetDate,
    });

    await project.populate('members.user', 'name email emailVerifiedAt');
    await recordAudit({
      projectId: project._id,
      actor: req.user,
      action: 'project.created',
      targetType: 'project',
      targetId: project._id,
      targetLabel: project.name,
      meta: { members: project.members.length },
      req,
    });

    res.status(201).json({ project: serializeProject(project, req.user) });
  }),
);

router.get(
  '/:projectId',
  loadProject,
  asyncHandler(async (req, res) => {
    await req.project.populate('members.user', 'name email emailVerifiedAt');
    const sources = await Source.find({ project: req.project._id, deletedAt: null }).lean();
    const visibleSources = sources.filter((source) =>
      sourceVisibleTo(source, req.project, req.user._id),
    );
    const handoverRows = await Handover.find({ project: req.project._id })
      .select('createdBy recipient status shareTokenHash shareExpiresAt')
      .lean();
    const visibleHandovers = handoverRows.filter(
      (handover) => handoverAccess({ handover, project: req.project, user: req.user }).canView,
    );
    const sharedHandovers = visibleHandovers.filter((handover) =>
      ['shared', 'acknowledged'].includes(handover.status),
    ).length;
    // Handover activity is only described to people who can reach a handover:
    // the delivery team, or the recipient/author of one. An observer who is
    // not part of any handover sees source counts and nothing else.
    const handoverActivityVisible =
      canContribute(req.project, req.user) ||
      visibleHandovers.some(
        (handover) =>
          String(handover.recipient) === String(req.user._id) ||
          String(handover.createdBy) === String(req.user._id),
      );

    // Counts describe what the viewer may read. Leads manage every source but
    // do not implicitly read content restricted to other people, so the total
    // comes from the same fail-closed visibility rule.
    res.json({
      project: serializeProject(req.project, req.user),
      stats: {
        sources: visibleSources.length,
        ...(handoverActivityVisible
          ? { handovers: visibleHandovers.length, sharedHandovers }
          : {}),
      },
    });
  }),
);

router.patch(
  '/:projectId',
  loadProject,
  requireProjectLead,
  validate({ body: updateProjectSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body;
    const changed = [];
    for (const field of ['name', 'description', 'status', 'startedAt', 'targetDate']) {
      if (body[field] !== undefined) {
        req.project[field] = body[field];
        changed.push(field);
      }
    }
    if (body.transition) {
      if (
        body.transition.outgoingUserId &&
        !req.project.members.some(
          (member) => String(member.user?._id ?? member.user) === String(body.transition.outgoingUserId),
        )
      ) {
        throw badRequest('The outgoing person must be a project member');
      }
      const current = req.project.transition?.toObject
        ? req.project.transition.toObject()
        : req.project.transition || {};
      req.project.transition = { ...current, ...body.transition };
      changed.push('transition');
    }
    if (body.settings) {
      req.project.settings = {
        ...(req.project.settings?.toObject
          ? req.project.settings.toObject()
          : req.project.settings || {}),
        ...body.settings,
      };
      changed.push('settings');
    }

    await req.project.save();
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'project.updated',
      targetType: 'project',
      targetId: req.project._id,
      targetLabel: req.project.name,
      meta: { changed },
      req,
      // Project settings include access and four-eyes approval rules.
      critical: true,
    });

    await req.project.populate('members.user', 'name email emailVerifiedAt');
    res.json({ project: serializeProject(req.project, req.user) });
  }),
);

router.get(
  '/:projectId/member-lookup',
  loadProject,
  requireProjectLead,
  asyncHandler(async (req, res) => {
    const parsed = emailField.safeParse(req.query.email);
    if (!parsed.success) throw badRequest('Enter a valid email address');
    const user = await User.findOne({ email: parsed.data }).select(
      'name email emailVerifiedAt',
    );
    res.json({
      lookup: {
        email: parsed.data,
        found: Boolean(user),
        name: user?.name || null,
        emailVerified: Boolean(user?.emailVerifiedAt),
        isMember: user ? Boolean(roleOf(req.project, user._id)) : false,
        mailConfigured: mailConfigured(),
      },
    });
  }),
);

router.post(
  '/:projectId/members',
  loadProject,
  requireProjectLead,
  validate({ body: addMemberSchema }),
  asyncHandler(async (req, res) => {
    const { email, userId, role } = req.body;
    const user = userId
      ? await User.findById(userId)
      : await User.findOne({ email });
    if (!user) {
      throw notFound('No account matches that person. Ask them to register first.');
    }
    if (roleOf(req.project, user._id)) {
      throw conflict(`${user.name} is already a member of this project`);
    }
    assertEmailVerified(user);

    req.project.members.push({ user: user._id, role });
    await req.project.save();
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'member.added',
      targetType: 'user',
      targetId: user._id,
      targetLabel: user.name,
      meta: { role },
      req,
      critical: true,
    });

    await notify({
      project: req.project,
      recipients: [user._id],
      type: 'member.added',
      entityType: 'user',
      entityId: user._id,
      actor: req.user,
    });

    await req.project.populate('members.user', 'name email emailVerifiedAt');
    res.status(201).json({ project: serializeProject(req.project, req.user) });
  }),
);

router.patch(
  '/:projectId/members/:userId',
  loadProject,
  requireProjectLead,
  validate({ body: updateMemberRoleSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    if (String(req.project.owner) === String(userId)) {
      throw badRequest('The project owner always holds the lead role');
    }
    const member = req.project.members.find(
      (entry) => String(entry.user?._id ?? entry.user) === String(userId),
    );
    if (!member) throw notFound('That person is not a member');
    const role = req.body.role;
    if (member.role === role) {
      // Serialization reads member.user for names and emails, so the no-op
      // path must populate exactly like the changed path.
      await req.project.populate('members.user', 'name email emailVerifiedAt');
      res.json({ project: serializeProject(req.project, req.user) });
      return;
    }

    const previousRole = member.role;
    member.role = role;
    await req.project.save();
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'member.role_changed',
      targetType: 'user',
      targetId: userId,
      meta: { from: previousRole, to: role },
      req,
      critical: true,
    });

    await notify({
      project: req.project,
      recipients: [userId],
      type: 'member.role_changed',
      entityType: 'user',
      entityId: userId,
      actor: req.user,
    });

    await req.project.populate('members.user', 'name email emailVerifiedAt');
    res.json({ project: serializeProject(req.project, req.user) });
  }),
);

router.delete(
  '/:projectId/members/:userId',
  loadProject,
  requireProjectLead,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    if (String(req.project.owner) === String(userId)) {
      throw badRequest('The project owner cannot be removed');
    }
    const before = req.project.members.length;
    req.project.members = req.project.members.filter(
      (member) => String(member.user?._id ?? member.user) !== String(userId),
    );
    if (req.project.members.length === before) throw notFound('That person is not a member');

    const removedUser = await User.findById(userId).select('name email').lean();

    // The departing person is a membership fact, not a name. Clear the link
    // now that the account no longer belongs to the project.
    if (
      req.project.transition?.outgoingUserId &&
      String(req.project.transition.outgoingUserId) === String(userId)
    ) {
      req.project.transition.outgoingUserId = undefined;
    }

    await req.project.save();
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'member.removed',
      targetType: 'user',
      targetId: userId,
      targetLabel: removedUser?.name,
      meta: {},
      req,
      critical: true,
    });

    // Questions addressed to the departed member can never be answered now.
    await closeOpenClarificationsForMember({
      project: req.project,
      userId,
      actor: req.user,
      req,
    });

    // Remove every live reference to the account: source audience lists,
    // share links addressed to them, and any queued notice. Handovers that
    // still need a person are flagged to the leads instead of going silent.
    await Source.updateMany(
      { project: req.project._id, 'visibility.users': userId },
      { $pull: { 'visibility.users': userId } },
    );
    await Notification.deleteMany({ project: req.project._id, recipient: userId });
    await detachMemberFromHandovers({
      project: req.project,
      userId,
      actor: req.user,
      req,
    });

    res.json({ removed: true });
  }),
);

router.get(
  '/:projectId/state',
  loadProject,
  asyncHandler(async (req, res) => {
    if (isIncoming(req.project, req.user._id)) {
      throw forbidden('Incoming recipients read the shared handover, not the outgoing team record');
    }
    const result = await buildStateForUser({
      project: req.project,
      userId: req.user._id,
    });
    res.json({
      project: serializeProject(req.project, req.user),
      generatedAt: new Date(),
      summary: {
        phase: result.state.phase,
        readinessScore: result.state.readinessScore,
        counts: result.state.counts,
        lastActivityAt: result.state.lastActivityAt,
        activityWindow: result.state.activityWindow,
      },
      timeline: result.state.timeline,
      conflicts: result.state.conflicts,
      ownershipGaps: result.state.ownershipGaps,
      unverified: result.state.unverified,
      openQuestions: result.state.openQuestions,
      openRisks: result.state.openRisks,
      openDependencies: result.state.openDependencies,
      stale: result.state.stale,
      nextActions: result.nextActions,
      visibleClaimCount: result.claims.length,
    });
  }),
);

router.get(
  '/:projectId/clarifications/candidates',
  loadProject,
  requireProjectContributor,
  asyncHandler(async (req, res) => {
    const result = await buildClarificationCandidates({
      project: req.project,
      actor: req.user,
    });
    res.json(result);
  }),
);

router.post(
  '/:projectId/clarifications',
  loadProject,
  requireProjectContributor,
  validate({ body: askClarificationsSchema }),
  asyncHandler(async (req, res) => {
    const { claimIds, askForAll, prompt } = req.body;
    const result = await askClarifications({
      project: req.project,
      actor: req.user,
      claimIds,
      askForAll,
      prompt,
    });
    res.status(201).json(result);
  }),
);

router.get(
  '/:projectId/claims',
  loadProject,
  validate({ query: listClaimsQuerySchema }),
  asyncHandler(async (req, res) => {
    if (isIncoming(req.project, req.user._id)) {
      throw forbidden('Incoming recipients read the shared handover, not the outgoing team record');
    }
    const { type, limit, cursor } = req.query;
    const page = await loadVisibleClaimPage({
      project: req.project,
      userId: req.user._id,
      type,
      limit,
      cursor,
    });
    res.json({
      claims: page.claims.map((claim) => decorateClaim(claim, page.citationsByClaim)),
      total: page.total,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
  }),
);

router.post(
  '/:projectId/conflicts/resolve',
  loadProject,
  requireProjectLead,
  validate({ body: resolveConflictSchema }),
  asyncHandler(async (req, res) => {
    const { claimIds, keepClaimId } = req.body;
    const group = await Claim.find({
      _id: { $in: claimIds },
      project: req.project._id,
      type: 'decision',
      retiredAt: null,
    });

    // Act on exactly the claims the reviewer saw. A fuzzy topic group can span
    // several topic keys, so resolving by one key used to miss members.
    if (group.length !== new Set(claimIds.map(String)).size) {
      throw notFound('Some statements in this conflict no longer exist');
    }
    const active = group.filter((claim) => claim.status !== 'superseded');
    if (active.length < 2) throw badRequest('This conflict is already resolved');
    const keep = active.find((claim) => String(claim._id) === String(keepClaimId));
    if (!keep) throw notFound('The selected statement is not part of this conflict');

    // Fail closed: a lead may only confirm a decision when every statement in
    // the conflict resolves to a source they are themselves allowed to read.
    const { claims: visibleClaims } = await loadVisibleClaims({
      project: req.project,
      userId: req.user._id,
    });
    const visibleIds = new Set(visibleClaims.map((claim) => String(claim._id)));
    if (group.some((claim) => !visibleIds.has(String(claim._id)))) {
      throw forbidden(
        'You cannot resolve a conflict that includes statements you are not authorized to read',
      );
    }

    // The submitted list must be exactly one of the conflict groups the state
    // endpoint shows. Appending an unrelated decision would otherwise let one
    // request supersede claims that were never part of the reviewed conflict.
    const submitted = new Set(active.map((claim) => String(claim._id)));
    const isOneConflict = findSupersededPairs(visibleClaims).some(
      (pair) =>
        pair.claims.length === submitted.size &&
        pair.claims.every((claim) => submitted.has(String(claim._id))),
    );
    if (!isOneConflict) {
      throw notFound('The submitted statements are not part of this conflict');
    }

    const superseded = active.filter((claim) => String(claim._id) !== String(keep._id));
    await Claim.updateMany(
      { _id: { $in: superseded.map((claim) => claim._id) } },
      {
        $set: { status: 'superseded', supersededBy: keep._id },
        $addToSet: { flags: 'superseded_by_reviewer' },
      },
    );
    // The kept statement keeps the status it already had (planned, done, ...);
    // resolving only says which statement is current.
    await Claim.updateOne(
      { _id: keep._id },
      { $addToSet: { flags: 'reviewer_confirmed_current' } },
    );

    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'claim.conflict_resolved',
      targetType: 'claim',
      targetId: keep._id,
      targetLabel: `Current decision: ${keep.topic || keep.topicKey}`,
      meta: {
        topicKey: keep.topicKey,
        topic: keep.topic,
        keptClaimId: String(keep._id),
        keptStatus: keep.status,
        conflictClaimIds: claimIds.map(String),
        supersededClaimIds: superseded.map((claim) => String(claim._id)),
      },
      req,
      critical: true,
    });

    await refreshOutdatedHandovers({ projectId: req.project._id, req });

    res.json({
      resolved: true,
      keptClaimId: String(keep._id),
      keptStatus: keep.status,
      supersededClaimIds: superseded.map((claim) => String(claim._id)),
    });
  }),
);

router.get(
  '/:projectId/sources',
  loadProject,
  asyncHandler(async (req, res) => {
    const sources = await Source.find({ project: req.project._id, deletedAt: null }).sort({
      createdAt: -1,
    });
    // Hidden sources are removed from every reader's record. A lead still sees
    // the row so the hide can be reversed; its content stays unreadable.
    const visible = sources.filter((source) =>
      source.hiddenAt
        ? req.projectRole === 'lead'
        : sourceVisibleTo(source, req.project, req.user._id),
    );
    res.json({ sources: visible.map(serializeSource) });
  }),
);

router.post(
  '/:projectId/claims/:claimId/resolve',
  loadProject,
  requireProjectContributor,
  validate({ body: resolveClaimSchema }),
  asyncHandler(async (req, res) => {
    const claim = await Claim.findOne({
      _id: req.params.claimId,
      project: req.project._id,
      retiredAt: null,
    });
    if (!claim) throw notFound('Claim not found');

    // Fail closed: acting on a claim requires reading its evidence.
    const { claims: visibleClaims } = await loadVisibleClaims({
      project: req.project,
      userId: req.user._id,
    });
    if (!visibleClaims.some((entry) => String(entry._id) === String(claim._id))) {
      throw forbidden('You are not authorized to act on this claim');
    }

    const { ownerName, note, status } = req.body;

    // Supersession is a reviewer decision. Letting a status change land on a
    // superseded row would quietly make an outdated statement current again.
    if (claim.status === 'superseded' && status) {
      throw badRequest('This statement was superseded; change the statement that replaced it instead');
    }

    // Answering an open question is reserved for the people who hold the
    // knowledge: the lead and the person whose departure created the gap.
    // Contributors can still close tasks and assign owners.
    if (claim.type === 'question' && status) {
      const outgoingId = req.project.transition?.outgoingUserId;
      const isKnowledgeHolder =
        req.projectRole === 'lead' ||
        (outgoingId && String(outgoingId) === String(req.user._id));
      if (!isKnowledgeHolder) {
        throw forbidden('Only the project lead or the departing member can answer an open question');
      }
      if (!note || !note.trim()) {
        throw badRequest('An answer note is required to resolve an open question');
      }
    }

    const before = { ownerName: claim.ownerName, status: claim.status };
    let ownerResolution = null;

    if (ownerName) {
      // A typed name is matched to a project member so the recipient's "you
      // own this" board and notifications target an account, not a string.
      // Only an exact email or full name links an account; a first name stays
      // text and is flagged for a person to confirm.
      const directory = await loadOwnerDirectory(req.project);
      ownerResolution = resolveOwnerName(directory, ownerName);
      claim.ownerName = ownerName.trim().slice(0, 120);
      claim.ownerUser = ownerResolution.userId || undefined;
      if (ownerResolution.userId) {
        claim.flags = (claim.flags || []).filter(
          (flag) => flag !== 'ambiguous_owner' && flag !== 'owner_unconfirmed',
        );
      } else if (ownerResolution.unconfirmed || ownerResolution.ambiguous) {
        claim.state = 'needs_review';
        claim.flags = [
          ...new Set([
            ...(claim.flags || []),
            ownerResolution.unconfirmed ? 'owner_unconfirmed' : 'ambiguous_owner',
          ]),
        ];
      }
    }

    const safeNote = note ? redactText(note).text : '';
    if (status) {
      claim.status = status;
      claim.resolution = {
        note: safeNote,
        by: req.user._id,
        byName: req.user.name,
        at: new Date(),
      };
    } else if (safeNote) {
      // A note on its own is still a decision the team made. Store it without
      // touching the status instead of dropping the input on the floor.
      claim.resolution = {
        note: safeNote,
        by: req.user._id,
        byName: req.user.name,
        at: new Date(),
      };
    }

    await claim.save();
    // The audit rows are written only once the claim is stored. These actions
    // change ownership and status, so an unwritable log must surface as a
    // failure rather than a silent success.
    if (ownerName) {
      await recordAudit({
        projectId: req.project._id,
        actor: req.user,
        action: 'claim.owner_assigned',
        targetType: 'claim',
        targetId: claim._id,
        targetLabel: claim.statement.slice(0, 120),
        meta: {
          ownerName,
          ownerUserId: ownerResolution.userId ? String(ownerResolution.userId) : null,
          ambiguous: ownerResolution.ambiguous,
          unconfirmed: ownerResolution.unconfirmed,
          before: before.ownerName || null,
        },
        req,
        critical: true,
      });
    }
    if (status) {
      await recordAudit({
        projectId: req.project._id,
        actor: req.user,
        action: 'claim.resolved',
        targetType: 'claim',
        targetId: claim._id,
        targetLabel: claim.statement.slice(0, 120),
        meta: { status, before: before.status, note: safeNote || null },
        req,
        critical: true,
      });
    } else if (safeNote) {
      await recordAudit({
        projectId: req.project._id,
        actor: req.user,
        action: 'claim.note_added',
        targetType: 'claim',
        targetId: claim._id,
        targetLabel: claim.statement.slice(0, 120),
        meta: { note: safeNote },
        req,
        critical: true,
      });
    }
    // An owner or status change is a freshness event for any handover that
    // already carries this claim.
    await refreshOutdatedHandovers({ projectId: req.project._id, req });
    res.json({
      resolved: true,
      claim: {
        id: String(claim._id),
        status: claim.status,
        ownerName: claim.ownerName || null,
        ownerUserId: claim.ownerUser ? String(claim.ownerUser) : null,
        ownerResolution: ownerResolution
          ? { ambiguous: ownerResolution.ambiguous }
          : undefined,
        resolution: claim.resolution || null,
      },
    });
  }),
);

router.post(
  '/:projectId/sources',
  loadProject,
  // Connectors fetch with the deployment's shared provider token, so only a
  // lead may point one at a repository or folder.
  requireProjectLead,
  validate({ body: createSourceSchema }),
  asyncHandler(async (req, res) => {
    const { kind, externalRef, name, visibility, sensitivity } = req.body;

    let normalizedRef = externalRef;
    if (kind === 'github') normalizedRef = parseRepoRef(externalRef).fullName;
    if (kind === 'drive') normalizedRef = parseDriveRef(externalRef);

    const duplicate = await Source.findOne({
      project: req.project._id,
      kind,
      externalRef: normalizedRef,
      deletedAt: null,
    }).lean();
    if (duplicate) {
      throw conflict('This repository or folder is already connected to the project', {
        sourceId: String(duplicate._id),
      });
    }

    const connectorCount = await Source.countDocuments({
      project: req.project._id,
      kind: { $in: ['github', 'drive'] },
      deletedAt: null,
    });
    if (connectorCount >= env.maxConnectorSources) {
      throw unprocessable(
        `A project can have at most ${env.maxConnectorSources} connected sources. Remove one before adding another.`,
      );
    }

    const source = await Source.create({
      project: req.project._id,
      kind,
      name: name || `${kind === 'github' ? 'GitHub' : 'Google Drive'}: ${normalizedRef}`,
      externalRef: normalizedRef,
      visibility: defaultSourceVisibility({
        kind,
        sensitivity: sensitivity || 'internal',
        visibility,
      }),
      sensitivity: sensitivity || 'internal',
      aiPolicy: req.body.aiPolicy
        ? { ...req.body.aiPolicy, updatedAt: new Date(), updatedBy: req.user._id }
        : undefined,
      createdBy: req.user._id,
      status: 'queued',
      sync: {
        // Sync spends the shared provider token's quota, so it is opt-in.
        // The project lead turns it on from the source settings.
        enabled: false,
        intervalMinutes: 15,
      },
    });

    enqueue('ingest_source', { sourceId: String(source._id) });
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'source.created',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: { kind, ref: normalizedRef, visibility: source.visibility, sensitivity: source.sensitivity },
      req,
      critical: true,
    });

    res.status(202).json({ source: serializeSource(source) });
  }),
);

router.post(
  '/:projectId/sources/upload',
  loadProject,
  requireProjectContributor,
  uploadFiles,
  asyncHandler(async (req, res) => {
    try {
      const files = req.files || [];
      if (files.length === 0) throw badRequest('Attach at least one file in the "files" field');

      let visibility;
      if (req.body.visibility) {
        try {
          visibility = typeof req.body.visibility === 'string'
            ? JSON.parse(req.body.visibility)
            : req.body.visibility;
        } catch {
          throw badRequest('visibility must be valid JSON');
        }
      }

      const parsed = uploadSourceSchema.safeParse({
        name: req.body.name,
        sensitivity: req.body.sensitivity || 'internal',
        visibility,
      });
      if (!parsed.success) throw zodError(parsed.error);

      const source = await Source.create({
        project: req.project._id,
        kind: 'upload',
        name: parsed.data.name || files[0].originalname,
        externalRef: '',
        visibility: defaultSourceVisibility({
          kind: 'upload',
          sensitivity: parsed.data.sensitivity,
          visibility: parsed.data.visibility,
        }),
        sensitivity: parsed.data.sensitivity,
        createdBy: req.user._id,
        status: 'queued',
        files: files.map((file) => ({
          originalName: file.originalname,
          storedName: file.filename,
          mime: file.mimetype,
          size: file.size,
        })),
      });

      enqueue('ingest_source', { sourceId: String(source._id) });
      await recordAudit({
        projectId: req.project._id,
        actor: req.user,
        action: 'source.created',
        targetType: 'source',
        targetId: source._id,
        targetLabel: source.name,
        meta: {
          kind: 'upload',
          files: files.map((file) => file.originalname),
          visibility: source.visibility,
          sensitivity: source.sensitivity,
        },
        req,
        critical: true,
      });

      res.status(202).json({ source: serializeSource(source) });
    } catch (error) {
      await discardUploads(req.files);
      throw error;
    }
  }),
);

router.get(
  '/:projectId/sources/:sourceId',
  loadProject,
  asyncHandler(async (req, res) => {
    const source = await Source.findOne({
      _id: req.params.sourceId,
      project: req.project._id,
      deletedAt: null,
    });
    if (!source) throw notFound('Source not found');
    if (!sourceVisibleTo(source, req.project, req.user._id)) {
      throw forbidden('You are not authorized to access this source');
    }
    res.json({ source: serializeSource(source) });
  }),
);

router.patch(
  '/:projectId/sources/:sourceId',
  loadProject,
  requireProjectLead,
  validate({ body: updateSourceSchema }),
  asyncHandler(async (req, res) => {
    const source = await Source.findOne({
      _id: req.params.sourceId,
      project: req.project._id,
      deletedAt: null,
    });
    if (!source) throw notFound('Source not found');

    // Leads manage sources but do not implicitly read them. No change that
    // alters how the content is classified or shared may widen access beyond
    // what the caller can already see. Hiding, unhiding and removal stay
    // available because they never reveal content.
    const changesAccess =
      req.body.name !== undefined ||
      req.body.sensitivity !== undefined ||
      req.body.visibility !== undefined ||
      req.body.aiPolicy?.allowExternal !== undefined;
    if (changesAccess && !sourceVisibleTo(source, req.project, req.user._id)) {
      throw forbidden(
        'You can only change a source you are authorized to read. Use purge to remove it instead.',
      );
    }

    // Sending a confidential source to a third-party model is a deliberate
    // decision that has to be justified in writing. Re-saving a source that
    // already allows it does not need a fresh reason.
    const willBeConfidential = (req.body.sensitivity ?? source.sensitivity) === 'confidential';
    const alreadyAllowedConfidential =
      source.sensitivity === 'confidential' && allowsExternalAI(source);
    const enablingExternalOnConfidential =
      req.body.aiPolicy?.allowExternal === true &&
      willBeConfidential &&
      !alreadyAllowedConfidential;
    const reason = redactText(String(req.body.reason || '').trim()).text;
    if (enablingExternalOnConfidential && reason.length < 3) {
      throw badRequest(
        'A written reason is required before a confidential source can be sent to an external model',
      );
    }

    const before = {
      visibility: source.visibility?.toObject ? source.visibility.toObject() : source.visibility,
      sensitivity: source.sensitivity,
      hidden: Boolean(source.hiddenAt),
      allowExternalAI: allowsExternalAI(source),
    };

    for (const field of ['name', 'sensitivity']) {
      if (req.body[field] !== undefined) source[field] = req.body[field];
    }
    if (req.body.visibility !== undefined) source.visibility = req.body.visibility;
    if (req.body.hidden !== undefined) {
      source.hiddenAt = req.body.hidden ? new Date() : undefined;
    }
    if (req.body.aiPolicy?.allowExternal !== undefined) {
      source.aiPolicy = {
        allowExternal: req.body.aiPolicy.allowExternal,
        updatedAt: new Date(),
        updatedBy: req.user._id,
      };
    } else if (
      req.body.sensitivity !== undefined &&
      source.sensitivity === 'confidential' &&
      source.sensitivity !== before.sensitivity
    ) {
      // Making a source confidential withdraws any earlier consent to send it
      // to an external model; a lead has to allow it again on purpose.
      source.aiPolicy = {
        allowExternal: false,
        updatedAt: new Date(),
        updatedBy: req.user._id,
      };
    }

    await source.save();

    // Claims copy the sensitivity at ingest, so re-classifying a source must
    // cascade or templates keep including now-confidential claims.
    if (
      req.body.sensitivity !== undefined &&
      source.sensitivity !== before.sensitivity
    ) {
      await Claim.updateMany(
        { source: source._id },
        { $set: { sensitivity: source.sensitivity } },
      );
    }

    // Any access change (sensitivity, visibility or hidden state) alters what
    // a recipient can read, so live handovers are re-judged immediately.
    const accessChanged =
      source.sensitivity !== before.sensitivity ||
      JSON.stringify(source.visibility) !== JSON.stringify(before.visibility) ||
      Boolean(source.hiddenAt) !== before.hidden;
    if (accessChanged) {
      await refreshOutdatedHandovers({ projectId: req.project._id, req });
    }

    const aiPolicyChanged = before.allowExternalAI !== allowsExternalAI(source);
    const auditAction =
      req.body.hidden !== undefined
        ? source.hiddenAt
          ? 'source.hidden'
          : 'source.unhidden'
        : aiPolicyChanged && !accessChanged
          ? 'source.ai_policy_changed'
          : 'source.access_changed';

    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: auditAction,
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {
        before,
        after: {
          visibility: source.visibility,
          sensitivity: source.sensitivity,
          hidden: Boolean(source.hiddenAt),
          allowExternalAI: allowsExternalAI(source),
          reason: reason || null,
        },
      },
      req,
      critical: true,
    });

    // The restricted audience is told when their confidential source is
    // allowed to leave the server, so consent is not only the lead's.
    if (
      before.allowExternalAI !== allowsExternalAI(source) &&
      allowsExternalAI(source) &&
      source.sensitivity === 'confidential'
    ) {
      const audience = (req.project.members || [])
        .map((member) => member.user?._id ?? member.user)
        .filter((id) => id && sourceVisibleTo(source, req.project, id));
      await notify({
        project: req.project,
        recipients: audience,
        type: 'source.external_ai_enabled',
        entityType: 'source',
        entityId: source._id,
        actor: req.user,
      });
    }

    res.json({ source: serializeSource(source) });
  }),
);

router.delete(
  '/:projectId/sources/:sourceId',
  loadProject,
  requireProjectLead,
  asyncHandler(async (req, res) => {
    const source = await Source.findOne({
      _id: req.params.sourceId,
      project: req.project._id,
      deletedAt: null,
    });
    if (!source) throw notFound('Source not found');
    if (['queued', 'processing'].includes(source.status)) {
      throw conflict('Wait for ingestion to finish before removing this source');
    }

    // Purging removes every copy of the content a permission decision was
    // based on, including handover items, saved version snapshots and
    // clarification text. The source row itself is kept (marked deleted) so
    // the audit trail still explains why items vanished.
    const result = await purgeSourceContent({ project: req.project, source });

    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'source.purged',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: result,
      req,
      critical: true,
    });

    res.json({ deleted: true, purged: true, ...result });
  }),
);

router.post(
  '/:projectId/sources/:sourceId/reingest',
  loadProject,
  requireProjectContributor,
  asyncHandler(async (req, res) => {
    const source = await Source.findOne({
      _id: req.params.sourceId,
      project: req.project._id,
      deletedAt: null,
    });
    // A source the caller cannot read is indistinguishable from a missing one.
    if (!source || !sourceVisibleTo(source, req.project, req.user._id)) {
      throw notFound('Source not found');
    }
    if (['queued', 'processing'].includes(source.status)) {
      throw conflict(
        source.status === 'queued'
          ? 'This source is already queued for ingestion'
          : 'This source is already being ingested',
      );
    }
    if (!['ready', 'partial', 'failed'].includes(source.status)) {
      throw conflict('This source cannot be re-ingested in its current state');
    }

    source.status = 'queued';
    source.statusMessage = 'Re-ingestion requested';
    await source.save();

    enqueue('ingest_source', { sourceId: String(source._id) });

    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'source.reingest_requested',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {},
      req,
    });

    res.status(202).json({ source: { id: String(source._id), status: source.status } });
  }),
);

router.post(
  '/:projectId/sources/:sourceId/sync',
  loadProject,
  requireProjectContributor,
  asyncHandler(async (req, res) => {
    const source = await Source.findOne({
      _id: req.params.sourceId,
      project: req.project._id,
      deletedAt: null,
    });
    if (!source || !sourceVisibleTo(source, req.project, req.user._id)) {
      throw notFound('Source not found');
    }
    if (!isSyncable(source)) {
      throw badRequest('Only connected GitHub and Drive sources can be synced');
    }
    if (['queued', 'processing'].includes(source.status)) {
      throw conflict('This source is already queued or being refreshed');
    }

    enqueue('sync_source', { sourceId: String(source._id) });
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'source.sync_requested',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: { intervalMinutes: source.sync?.intervalMinutes || 5 },
      req,
    });

    res.status(202).json({
      queued: true,
      source: { id: String(source._id), status: source.status },
    });
  }),
);

router.patch(
  '/:projectId/sources/:sourceId/sync',
  loadProject,
  requireProjectLead,
  validate({ body: syncSourceSchema }),
  asyncHandler(async (req, res) => {
    const source = await Source.findOne({
      _id: req.params.sourceId,
      project: req.project._id,
      deletedAt: null,
    });
    if (!source) throw notFound('Source not found');
    if (!isSyncable(source)) {
      throw badRequest('Only connected GitHub and Drive sources can be synced');
    }

    const before = {
      enabled: Boolean(source.sync?.enabled),
      intervalMinutes: source.sync?.intervalMinutes || 5,
    };
    if (req.body.enabled !== undefined) source.sync.enabled = req.body.enabled;
    if (req.body.intervalMinutes !== undefined) {
      source.sync.intervalMinutes = req.body.intervalMinutes;
    }
    await source.save();

    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'source.sync_updated',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {
        before,
        after: {
          enabled: Boolean(source.sync?.enabled),
          intervalMinutes: source.sync?.intervalMinutes || 5,
        },
      },
      req,
    });

    res.json({ source: serializeSource(source) });
  }),
);

router.get(
  '/:projectId/documents',
  loadProject,
  asyncHandler(async (req, res) => {
    const query = { project: req.project._id, retiredAt: null };
    if (req.query.sourceId) query.source = req.query.sourceId;

    const documents = await Document.find(query).sort({ createdAt: -1 }).limit(300);
    const sources = await Source.find({ project: req.project._id }).lean();
    const sourceById = new Map(sources.map((source) => [String(source._id), source]));

    const visible = documents.filter((document) =>
      sourceVisibleTo(sourceById.get(String(document.source)), req.project, req.user._id),
    );
    res.json({ documents: visible.map(serializeDocument) });
  }),
);

router.get(
  '/:projectId/documents/:documentId',
  loadProject,
  asyncHandler(async (req, res) => {
    const document = await Document.findOne({
      _id: req.params.documentId,
      project: req.project._id,
    });
    if (!document) throw notFound('Document not found');

    const source = await Source.findById(document.source);
    assertSourceVisible(source, req.project, req.user._id);

    await recordViewAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'document.viewed',
      targetType: 'document',
      targetId: document._id,
      targetLabel: document.title,
      meta: {},
      req,
    });

    res.json({
      document: serializeDocument(document),
      rawText: document.rawText,
      chunks: document.chunks.map((chunk) => ({
        index: chunk.index,
        start: chunk.start,
        end: chunk.end,
      })),
    });
  }),
);

router.get(
  '/:projectId/evidence/:evidenceId',
  loadProject,
  asyncHandler(async (req, res) => {
    let handover = null;
    if (req.query.handover) {
      handover = await Handover.findOne({
        _id: req.query.handover,
        project: req.project._id,
      });
      if (!handover) throw notFound('Handover not found');

      const isRecipient = String(handover.recipient) === String(req.user._id);
      const isCreator = String(handover.createdBy) === String(req.user._id);
      if (!isRecipient && !isCreator && !canManageProject(req.project, req.user)) {
        throw forbidden('You do not have access to this handover');
      }
    }

    const asRecipient = Boolean(
      handover && String(handover.recipient) === String(req.user._id),
    );

    // The handover stores the quote, source and document it was approved with.
    // That snapshot keeps a citation readable after the evidence row was
    // replaced by a re-ingest, and lets the drawer say when the passage changed.
    const snapshotCitation = () => {
      if (!handover) return null;
      for (const item of handover.items || []) {
        if (asRecipient && !['accepted', 'edited'].includes(item.decision)) continue;
        const match = (item.citations || []).find(
          (citation) => String(citation.evidenceId) === String(req.params.evidenceId),
        );
        if (match) return match;
      }
      return null;
    };

    const citation = snapshotCitation();
    // A recipient may only resolve evidence that is actually cited by a
    // shareable item in this handover, never arbitrary evidence IDs.
    if (asRecipient && !citation) throw notFound('Evidence not found');

    const evidence = await Evidence.findOne({
      _id: req.params.evidenceId,
      project: req.project._id,
    });
    if (!evidence && !citation) throw notFound('Evidence not found');

    const sourceId = evidence ? evidence.source : citation.sourceId;
    const source = await Source.findById(sourceId);
    assertSourceVisible(source, req.project, req.user._id);

    const documentId = evidence ? evidence.document : citation.documentId;
    let document = documentId ? await Document.findById(documentId) : null;
    if (!document && !evidence && citation?.documentId) {
      // A re-ingest prunes the old revision, but the handover keeps a citation
      // snapshot. Check that snapshot against the current revision of the same
      // document so a reviewed quote stays verifiable instead of always
      // reading as changed.
      const sameTitle = citation.docTitle ? { title: citation.docTitle } : null;
      document =
        (sameTitle &&
          (await Document.findOne({ source: sourceId, retiredAt: null, ...sameTitle }).sort({
            revision: -1,
          }))) ||
        (await Document.findOne({ source: sourceId, retiredAt: null }).sort({ revision: -1 }));
    }

    const isPersonConfirmed = (evidence?.validation || citation.validation) === 'person_confirmed';
    const storedQuote = evidence ? evidence.quote : citation.quote || '';
    const storedValidation = evidence ? evidence.validation : citation.validation;
    let changed = false;
    let note;

    if (!evidence) {
      note =
        'The original evidence record was replaced when this source was re-ingested. This is the quote stored with the handover when it was reviewed.';
    }

    // Locate the quote in the current revision. A missing match means the
    // passage no longer exists as cited, so the response falls back to the
    // stored quote instead of highlighting the wrong characters.
    let located = { ok: false };
    if (document && !isPersonConfirmed && storedQuote) {
      if (
        Number.isInteger(evidence?.charStart) &&
        Number.isInteger(evidence?.charEnd) &&
        document.rawText.slice(evidence.charStart, evidence.charEnd) === evidence.quote
      ) {
        located = { ok: true, start: evidence.charStart, end: evidence.charEnd };
      } else {
        located = locateQuote(document.rawText, storedQuote);
      }
      if (!located.ok) {
        changed = true;
        note =
          note ||
          'This passage is no longer present in the current revision of the source document. The quote below is the one stored with the handover.';
      }
    } else if (!document && !isPersonConfirmed) {
      changed = true;
      note =
        note ||
        'The source document for this citation is no longer available. The quote below is the one stored with the handover.';
    }

    const charStart = located.ok ? located.start : evidence?.charStart ?? citation?.charStart;
    const charEnd = located.ok ? located.end : evidence?.charEnd ?? citation?.charEnd;

    let quote = storedQuote;
    let context = null;
    let highlight = null;
    let redactions = { count: 0, kinds: [] };

    if (document && located.ok && !isPersonConfirmed) {
      const contextStart = Math.max(0, located.start - 600);
      const contextEnd = Math.min(document.rawText.length, located.end + 600);
      if (asRecipient) {
        // Redact the three slices independently, then rebuild the highlight
        // from the redacted lengths so it still lands on the right words.
        const before = redactText(document.rawText.slice(contextStart, located.start));
        const middle = redactText(storedQuote);
        const after = redactText(document.rawText.slice(located.end, contextEnd));
        context = `${before.text}${middle.text}${after.text}`;
        quote = middle.text;
        highlight = {
          start: before.text.length,
          end: before.text.length + middle.text.length,
        };
        redactions = {
          count: before.count + middle.count + after.count,
          kinds: [...new Set([...before.kinds, ...middle.kinds, ...after.kinds])],
        };
      } else {
        context = document.rawText.slice(contextStart, contextEnd);
        highlight = { start: located.start - contextStart, end: located.end - contextStart };
      }
    } else if (asRecipient) {
      quote = redactText(storedQuote).text;
    }

    let confirmation = null;
    if (isPersonConfirmed) {
      if (asRecipient) quote = redactText(storedQuote).text;
      const clarification = evidence?.answerRef
        ? await Clarification.findById(evidence.answerRef).lean()
        : null;
      confirmation = {
        answer: quote,
        by: evidence?.confirmedByName || citation?.confirmedByName || null,
        at: evidence?.confirmedAt || citation?.confirmedAt || null,
        prompt: clarification?.prompt || null,
        kind: clarification?.kind || null,
      };
    }

    res.json({
      evidence: {
        id: String(evidence?._id || citation.evidenceId || req.params.evidenceId),
        quote,
        validation: storedValidation,
        charStart: charStart ?? null,
        charEnd: charEnd ?? null,
        origin: isPersonConfirmed ? 'person_confirmed' : 'document',
        confirmedByName: evidence?.confirmedByName || citation?.confirmedByName || null,
        confirmedAt: evidence?.confirmedAt || citation?.confirmedAt || null,
      },
      confirmation,
      // A confirmed answer has no document context to show; the drawer renders
      // the answer, the person and the date from `confirmation` instead.
      context: isPersonConfirmed ? null : context,
      highlight: isPersonConfirmed ? null : highlight,
      redacted: asRecipient,
      redactions: asRecipient ? redactions : undefined,
      // True when this response is served from the handover citation rather
      // than a live evidence row, or when the passage moved or disappeared.
      snapshot: !evidence,
      changed,
      note,
      source: { name: source.name, kind: source.kind },
      document: document
        ? {
            id: String(document._id),
            title: document.title,
            path: document.path,
            url: document.locator?.url,
            occurredAt: document.occurredAt,
            revision: document.revision,
          }
        : {
            id: citation?.documentId ? String(citation.documentId) : null,
            title: citation?.docTitle || 'Source document',
            path: citation?.locator?.path,
            url: citation?.locator?.url,
            occurredAt: citation?.occurredAt || null,
            revision: null,
            available: false,
          },
    });
  }),
);

router.get(
  '/:projectId/audit',
  loadProject,
  requireProjectLead,
  validate({ query: auditQuerySchema }),
  asyncHandler(async (req, res) => {
    const events = await AuditEvent.find({ project: req.project._id })
      .sort({ createdAt: -1 })
      .limit(req.query.limit)
      .lean();

    const serialized = events.map((event) => ({
      id: String(event._id),
      action: event.action,
      actorName: event.actorName,
      targetType: event.targetType,
      targetId: event.targetId ? String(event.targetId) : undefined,
      targetLabel: event.targetLabel,
      meta: event.meta,
      createdAt: event.createdAt,
      ip: event.ip,
    }));

    const visibleEvents = await redactAuditEventsForViewer({
      events: serialized,
      project: req.project,
      userId: req.user._id,
    });

    res.json({ events: visibleEvents });
  }),
);

export default router;
