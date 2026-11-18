import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { env } from '../config/env.js';
import { uploadFiles } from '../middleware/upload.js';
import { loadProject, requireProjectContributor, requireProjectLead } from '../middleware/project.js';
import { validate } from '../middleware/validate.js';
import { AuditEvent, Claim, Clarification, Document, Evidence, Handover, Project, Source, User } from '../models/index.js';
import {
  assertSourceVisible,
  canManageProject,
  claimVisibleTo,
  roleOf,
  sourceVisibleTo,
} from '../services/access/policy.js';
import { recordAudit, redactAuditEventsForViewer } from '../services/audit.js';
import { notify } from '../services/notifications.js';
import { askClarifications, buildClarificationCandidates } from '../services/clarifications.js';
import { redactText } from '../lib/redaction.js';
import { enqueue } from '../services/queue.js';
import {
  buildStateForUser,
  decorateClaim,
  loadVisibleClaims,
  serializeDocument,
  serializeProject,
  serializeSource,
} from '../services/projectState.js';
import { parseDriveRef } from '../services/ingest/googleDrive.js';
import { parseRepoRef } from '../services/ingest/github.js';
import { isSyncable } from '../services/ingest/sync.js';
import { handoverAccess } from '../services/handover/workflow.js';
import {
  addMemberSchema,
  askClarificationsSchema,
  auditQuerySchema,
  createProjectSchema,
  createSourceSchema,
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

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const projects = await Project.find({ 'members.user': req.user._id })
      .populate('members.user', 'name email')
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

    const existing = await Project.findOne({ key: normalizedKey });
    if (existing) throw conflict(`Project key ${normalizedKey} is already in use`);

    const memberMap = new Map();
    memberMap.set(String(req.user._id), { user: req.user._id, role: 'lead' });

    const missing = [];
    for (const entry of members) {
      const user = await User.findOne({ email: entry.email });
      if (!user) {
        missing.push(entry.email);
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

    await project.populate('members.user', 'name email');
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
    await req.project.populate('members.user', 'name email');
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

    // Counts are description of what the viewer may read. Leads manage every
    // source but do not implicitly read content restricted to other people, so
    // both totals come from the same fail-closed visibility rule.
    res.json({
      project: serializeProject(req.project, req.user),
      stats: {
        sources: visibleSources.length,
        totalSources: visibleSources.length,
        handovers: visibleHandovers.length,
        sharedHandovers,
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
      const current = req.project.transition?.toObject
        ? req.project.transition.toObject()
        : req.project.transition || {};
      req.project.transition = { ...current, ...body.transition };
      changed.push('transition');
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
    });

    await req.project.populate('members.user', 'name email');
    res.json({ project: serializeProject(req.project, req.user) });
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
    });

    await notify({
      project: req.project,
      recipients: [user._id],
      type: 'member.added',
      entityType: 'user',
      entityId: user._id,
      actor: req.user,
    });

    await req.project.populate('members.user', 'name email');
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
    });

    await notify({
      project: req.project,
      recipients: [userId],
      type: 'member.role_changed',
      entityType: 'user',
      entityId: userId,
      actor: req.user,
    });

    await req.project.populate('members.user', 'name email');
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

    await req.project.save();
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'member.removed',
      targetType: 'user',
      targetId: userId,
      meta: {},
      req,
    });
    res.json({ removed: true });
  }),
);

router.get(
  '/:projectId/state',
  loadProject,
  asyncHandler(async (req, res) => {
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
    const { type, limit } = req.query;
    const { claims, citationsByClaim } = await loadVisibleClaims({
      project: req.project,
      userId: req.user._id,
    });
    const filtered = type ? claims.filter((claim) => claim.type === type) : claims;
    res.json({
      claims: filtered.slice(0, limit).map((claim) => decorateClaim(claim, citationsByClaim)),
      total: filtered.length,
    });
  }),
);

router.post(
  '/:projectId/conflicts/resolve',
  loadProject,
  requireProjectLead,
  validate({ body: resolveConflictSchema }),
  asyncHandler(async (req, res) => {
    const { topicKey, keepClaimId } = req.body;
    const group = await Claim.find({
      project: req.project._id,
      type: 'decision',
      topicKey,
      retiredAt: null,
    });

    const active = group.filter((claim) => claim.status !== 'superseded');
    if (active.length < 2) throw badRequest('This conflict is already resolved');
    const keep = active.find((claim) => String(claim._id) === keepClaimId);
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

    const superseded = active.filter((claim) => String(claim._id) !== keepClaimId);
    await Claim.updateMany(
      { _id: { $in: superseded.map((claim) => claim._id) } },
      {
        $set: { status: 'superseded', supersededBy: keep._id },
        $addToSet: { flags: 'superseded_by_reviewer' },
      },
    );
    await Claim.updateOne(
      { _id: keep._id },
      { $set: { status: 'active' }, $addToSet: { flags: 'reviewer_confirmed_current' } },
    );

    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'claim.conflict_resolved',
      targetType: 'claim',
      targetId: keep._id,
      targetLabel: `Current decision: ${keep.topic || topicKey}`,
      meta: {
        topicKey,
        topic: keep.topic,
        keptClaimId: String(keep._id),
        supersededClaimIds: superseded.map((claim) => String(claim._id)),
      },
      req,
    });

    res.json({
      resolved: true,
      keptClaimId: String(keep._id),
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

    if (ownerName) {
      claim.ownerName = ownerName;
      await recordAudit({
        projectId: req.project._id,
        actor: req.user,
        action: 'claim.owner_assigned',
        targetType: 'claim',
        targetId: claim._id,
        targetLabel: claim.statement.slice(0, 120),
        meta: { ownerName, before: before.ownerName || null },
        req,
      });
    }

    if (status) {
      claim.status = status;
      const safeNote = redactText(note || '').text;
      claim.resolution = {
        note: safeNote,
        by: req.user._id,
        byName: req.user.name,
        at: new Date(),
      };
      await recordAudit({
        projectId: req.project._id,
        actor: req.user,
        action: 'claim.resolved',
        targetType: 'claim',
        targetId: claim._id,
        targetLabel: claim.statement.slice(0, 120),
        meta: { status, before: before.status, note: safeNote || null },
        req,
      });
    }

    await claim.save();
    res.json({
      resolved: true,
      claim: {
        id: String(claim._id),
        status: claim.status,
        ownerName: claim.ownerName || null,
        resolution: claim.resolution || null,
      },
    });
  }),
);

router.post(
  '/:projectId/sources',
  loadProject,
  requireProjectContributor,
  validate({ body: createSourceSchema }),
  asyncHandler(async (req, res) => {
    const { kind, externalRef, name, visibility, sensitivity } = req.body;

    let normalizedRef = externalRef;
    if (kind === 'github') normalizedRef = parseRepoRef(externalRef).fullName;
    if (kind === 'drive') normalizedRef = parseDriveRef(externalRef);

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
      createdBy: req.user._id,
      status: 'queued',
      sync: {
        enabled: kind === 'github' || kind === 'drive',
        intervalMinutes: 5,
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
    });

    res.status(202).json({ source: serializeSource(source) });
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

    const before = {
      visibility: source.visibility?.toObject ? source.visibility.toObject() : source.visibility,
      sensitivity: source.sensitivity,
      hidden: Boolean(source.hiddenAt),
    };

    for (const field of ['name', 'sensitivity']) {
      if (req.body[field] !== undefined) source[field] = req.body[field];
    }
    if (req.body.visibility !== undefined) source.visibility = req.body.visibility;
    if (req.body.hidden !== undefined) {
      source.hiddenAt = req.body.hidden ? new Date() : undefined;
    }

    await source.save();
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action:
        req.body.hidden === undefined
          ? 'source.access_changed'
          : source.hiddenAt
            ? 'source.hidden'
            : 'source.unhidden',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {
        before,
        after: {
          visibility: source.visibility,
          sensitivity: source.sensitivity,
          hidden: Boolean(source.hiddenAt),
        },
      },
      req,
    });

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

    // Purging removes the content a permission decision was based on. The
    // source row itself is kept (marked deleted) so citations and audits can
    // still explain why an item disappeared, but no text, evidence or file
    // survives, and every claim it produced is retired.
    const documents = await Document.find({ source: source._id }).select('_id').lean();
    const documentIds = documents.map((document) => document._id);
    const claims = await Claim.find({ source: source._id }).select('_id').lean();
    const claimIds = claims.map((claim) => claim._id);

    const evidence = await Evidence.deleteMany({
      $or: [
        { source: source._id },
        ...(documentIds.length > 0 ? [{ document: { $in: documentIds } }] : []),
        ...(claimIds.length > 0 ? [{ claim: { $in: claimIds } }] : []),
      ],
    });
    if (documentIds.length > 0) {
      await Document.deleteMany({ _id: { $in: documentIds } });
    }
    if (claimIds.length > 0) {
      await Claim.updateMany(
        { _id: { $in: claimIds }, retiredAt: null },
        { $set: { retiredAt: new Date() }, $unset: { document: 1 } },
      );
    }

    for (const file of source.files || []) {
      if (!file.storedName) continue;
      await fs
        .unlink(path.join(env.uploadDir, path.basename(file.storedName)))
        .catch(() => {});
    }
    const fileCount = (source.files || []).length;

    source.deletedAt = new Date();
    source.statusMessage =
      'Source purged: stored text, evidence and files deleted; its claims are retired';
    source.files = [];
    if (source.sync) source.sync.enabled = false;
    await source.save();

    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'source.purged',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {
        documents: documentIds.length,
        evidence: evidence.deletedCount || 0,
        claimsRetired: claimIds.length,
        files: fileCount,
      },
      req,
    });

    res.json({
      deleted: true,
      purged: true,
      documents: documentIds.length,
      evidence: evidence.deletedCount || 0,
      claimsRetired: claimIds.length,
    });
  }),
);

router.post(
  '/:projectId/sources/:sourceId/reingest',
  loadProject,
  requireProjectContributor,
  asyncHandler(async (req, res) => {
    const source = await Source.findOneAndUpdate(
      {
        _id: req.params.sourceId,
        project: req.project._id,
        deletedAt: null,
        status: { $in: ['ready', 'partial', 'failed'] },
      },
      { $set: { status: 'queued', statusMessage: 'Re-ingestion requested' } },
      { new: true },
    );

    if (!source) {
      const existing = await Source.findOne({
        _id: req.params.sourceId,
        project: req.project._id,
        deletedAt: null,
      }).select('status');
      if (!existing) throw notFound('Source not found');
      throw conflict(
        existing.status === 'queued'
          ? 'This source is already queued for ingestion'
          : 'This source is already being ingested',
      );
    }

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

    res.status(202).json({ source: serializeSource(source) });
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
    if (!source) throw notFound('Source not found');
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

    res.status(202).json({ queued: true, source: serializeSource(source) });
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

    await recordAudit({
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
    const evidence = await Evidence.findOne({
      _id: req.params.evidenceId,
      project: req.project._id,
    });
    if (!evidence) throw notFound('Evidence not found');

    const [source, document] = await Promise.all([
      Source.findById(evidence.source),
      Document.findById(evidence.document),
    ]);
    assertSourceVisible(source, req.project, req.user._id);
    if (!document) throw notFound('The source document for this citation is unavailable');

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

      if (isRecipient) {
        // A recipient may only resolve evidence that is actually cited by a
        // shareable item in this handover, never arbitrary evidence IDs.
        const cited = (handover.items || []).some(
          (item) =>
            ['accepted', 'edited'].includes(item.decision) &&
            (item.citations || []).some(
              (citation) => String(citation.evidenceId) === String(evidence._id),
            ),
        );
        if (!cited) throw notFound('Evidence not found');
      }
    }

    const asRecipient = Boolean(
      handover && String(handover.recipient) === String(req.user._id),
    );

    const contextStart = Math.max(0, evidence.charStart - 600);
    const contextEnd = Math.min(document.rawText.length, evidence.charEnd + 600);

    let quote = evidence.quote;
    let context = document.rawText.slice(contextStart, contextEnd);
    let highlight = {
      start: evidence.charStart - contextStart,
      end: evidence.charEnd - contextStart,
    };
    let redactions = { count: 0, kinds: [] };

    if (asRecipient) {
      // Redact the three slices independently, then rebuild the highlight from
      // the redacted lengths so it still lands on the right words.
      const before = redactText(document.rawText.slice(contextStart, evidence.charStart));
      const middle = redactText(evidence.quote);
      const after = redactText(document.rawText.slice(evidence.charEnd, contextEnd));
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
    }

    const isPersonConfirmed = evidence.validation === 'person_confirmed';
    let confirmation = null;
    if (isPersonConfirmed) {
      const clarification = evidence.answerRef
        ? await Clarification.findById(evidence.answerRef).lean()
        : null;
      confirmation = {
        answer: quote,
        by: evidence.confirmedByName || null,
        at: evidence.confirmedAt || null,
        prompt: clarification?.prompt || null,
        kind: clarification?.kind || null,
      };
    }

    res.json({
      evidence: {
        id: String(evidence._id),
        quote,
        validation: evidence.validation,
        charStart: evidence.charStart,
        charEnd: evidence.charEnd,
        origin: isPersonConfirmed ? 'person_confirmed' : 'document',
        confirmedByName: evidence.confirmedByName || null,
        confirmedAt: evidence.confirmedAt || null,
      },
      confirmation,
      // A confirmed answer has no document context to show; the drawer renders
      // the answer, the person and the date from `confirmation` instead.
      context: isPersonConfirmed ? null : context,
      highlight: isPersonConfirmed ? null : highlight,
      redacted: asRecipient,
      redactions: asRecipient ? redactions : undefined,
      source: { name: source.name, kind: source.kind },
      document: {
        id: String(document._id),
        title: document.title,
        path: document.path,
        url: document.locator?.url,
        occurredAt: document.occurredAt,
        revision: document.revision,
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
