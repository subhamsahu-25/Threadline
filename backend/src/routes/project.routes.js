import { Router } from 'express';
import { AppError, asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { uploadFiles } from '../middleware/upload.js';
import { loadProject, requireProjectContributor, requireProjectLead } from '../middleware/project.js';
import { validate } from '../middleware/validate.js';
import { AuditEvent, Claim, Document, Evidence, Handover, Project, Source, User } from '../models/index.js';
import { assertSourceVisible, roleOf, sourceVisibleTo } from '../services/access/policy.js';
import { recordAudit } from '../services/audit.js';
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
import {
  addMemberSchema,
  auditQuerySchema,
  createProjectSchema,
  createSourceSchema,
  listClaimsQuerySchema,
  resolveConflictSchema,
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
    const visibleSources = sources.filter(
      (source) =>
        req.projectRole === 'lead' || sourceVisibleTo(source, req.project, req.user._id),
    );
    const handovers = await Handover.countDocuments({ project: req.project._id });

    res.json({
      project: serializeProject(req.project, req.user),
      stats: {
        sources: visibleSources.length,
        totalSources: req.projectRole === 'lead' ? sources.length : visibleSources.length,
        handovers,
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

    await req.project.populate('members.user', 'name email');
    res.status(201).json({ project: serializeProject(req.project, req.user) });
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
    const visible = sources.filter(
      (source) =>
        req.projectRole === 'lead' || sourceVisibleTo(source, req.project, req.user._id),
    );
    res.json({ sources: visible.map(serializeSource) });
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
      visibility: visibility || { scope: 'project', roles: [], users: [] },
      sensitivity: sensitivity || 'internal',
      createdBy: req.user._id,
      status: 'queued',
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
      visibility: parsed.data.visibility || { scope: 'project', roles: [], users: [] },
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
    if (!sourceVisibleTo(source, req.project, req.user._id) && req.projectRole !== 'lead') {
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
    };

    for (const field of ['name', 'sensitivity']) {
      if (req.body[field] !== undefined) source[field] = req.body[field];
    }
    if (req.body.visibility !== undefined) source.visibility = req.body.visibility;

    await source.save();
    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'source.access_changed',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {
        before,
        after: {
          visibility: source.visibility,
          sensitivity: source.sensitivity,
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

    source.deletedAt = new Date();
    source.statusMessage = 'Source removed; documents retained for audit history';
    await source.save();

    await recordAudit({
      projectId: req.project._id,
      actor: req.user,
      action: 'source.deleted',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {},
      req,
    });

    res.json({ deleted: true });
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
    if (!source) throw notFound('Source not found');

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

    res.status(202).json({ source: serializeSource(source) });
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

    const contextStart = Math.max(0, evidence.charStart - 600);
    const contextEnd = Math.min(document.rawText.length, evidence.charEnd + 600);

    res.json({
      evidence: {
        id: String(evidence._id),
        quote: evidence.quote,
        validation: evidence.validation,
        charStart: evidence.charStart,
        charEnd: evidence.charEnd,
      },
      context: document.rawText.slice(contextStart, contextEnd),
      highlight: {
        start: evidence.charStart - contextStart,
        end: evidence.charEnd - contextStart,
      },
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

    res.json({
      events: events.map((event) => ({
        id: String(event._id),
        action: event.action,
        actorName: event.actorName,
        targetType: event.targetType,
        targetId: event.targetId ? String(event.targetId) : undefined,
        targetLabel: event.targetLabel,
        meta: event.meta,
        createdAt: event.createdAt,
        ip: event.ip,
      })),
    });
  }),
);

export default router;
