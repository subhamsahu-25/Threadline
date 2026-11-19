import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { Claim, Document, Evidence, Source } from '../models/index.js';
import { allowsExternalAI } from './ai/policy.js';
import {
  canContribute,
  claimVisibleTo,
  isIncoming,
  roleOf,
  sourceVisibleTo,
} from './access/policy.js';
import { deriveNextActions } from './reconstruction/nextActions.js';
import { reconstructState } from './reconstruction/state.js';

export function serializeProject(project, user) {
  const data = project.toObject ? project.toObject() : { ...project };
  return {
    id: String(data._id),
    key: data.key,
    name: data.name,
    description: data.description,
    status: data.status,
    isDemo: Boolean(data.isDemo),
    owner: String(data.owner?._id ?? data.owner),
    role: roleOf(project, user?._id),
    incoming: isIncoming(project, user?._id),
    canContribute: canContribute(project, user),
    members: (data.members || []).map((member) => ({
      userId: String(member.user?._id ?? member.user),
      role: member.role,
      incoming: Boolean(member.incoming),
      name: member.user?.name,
      email: member.user?.email,
      // Leads see this before inviting or promoting somebody, and the add
      // endpoint refuses an unconfirmed address outright.
      emailVerified: Boolean(member.user?.emailVerifiedAt),
      joinedAt: member.joinedAt,
    })),
    transition: data.transition,
    settings: {
      requireSeparateApprover: Boolean(data.settings?.requireSeparateApprover),
    },
    startedAt: data.startedAt,
    targetDate: data.targetDate,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

export function serializeSource(source) {
  const data = source.toObject ? source.toObject() : { ...source };
  return {
    id: String(data._id),
    name: data.name,
    kind: data.kind,
    externalRef: data.externalRef,
    visibility: data.visibility,
    sensitivity: data.sensitivity,
    status: data.status,
    statusMessage: data.statusMessage,
    hidden: Boolean(data.hiddenAt),
    hiddenAt: data.hiddenAt,
    stats: data.stats,
    parseWarnings: data.parseWarnings || [],
    aiPolicy: {
      allowExternal: allowsExternalAI(data),
      updatedAt: data.aiPolicy?.updatedAt,
    },
    sync: data.sync,
    lastIngestedAt: data.lastIngestedAt,
    createdAt: data.createdAt,
    files: (data.files || []).map((file) => ({
      originalName: file.originalName,
      mime: file.mime,
      size: file.size,
    })),
  };
}

export function serializeDocument(document) {
  const data = document.toObject ? document.toObject() : { ...document };
  return {
    id: String(data._id),
    source: String(data.source?._id ?? data.source),
    kind: data.kind,
    title: data.title,
    path: data.path,
    mime: data.mime,
    size: data.size,
    author: data.author,
    occurredAt: data.occurredAt,
    locator: data.locator,
    revision: data.revision,
    chunkCount: (data.chunks || []).length,
    parseWarnings: data.parseWarnings || [],
    createdAt: data.createdAt,
  };
}

function citationFor(evidence, sourceById, docById) {
  const source = sourceById.get(String(evidence.source));
  const document = docById.get(String(evidence.document));
  return {
    evidenceId: String(evidence._id),
    documentId: String(evidence.document),
    sourceId: String(evidence.source),
    sourceName: source?.name,
    sourceKind: source?.kind,
    docTitle: document?.title,
    quote: evidence.quote,
    charStart: evidence.charStart,
    charEnd: evidence.charEnd,
    validation: evidence.validation,
    locator: document?.locator,
    occurredAt: document?.occurredAt,
  };
}

/**
 * Loads only the claims the requesting user is allowed to see. A claim is
 * visible only when every citation behind it resolves to a visible source.
 */
export async function loadVisibleClaims({ project, userId }) {
  const [claims, sources] = await Promise.all([
    Claim.find({ project: project._id, retiredAt: null }).sort({ occurredAt: -1 }).lean(),
    Source.find({ project: project._id }).lean(),
  ]);

  const sourceById = new Map(sources.map((source) => [String(source._id), source]));
  const evidence = await Evidence.find({ claim: { $in: claims.map((claim) => claim._id) } }).lean();

  const evidenceByClaim = new Map();
  for (const entry of evidence) {
    const key = String(entry.claim);
    if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
    evidenceByClaim.get(key).push(entry);
  }

  const documentIds = [...new Set(evidence.map((entry) => String(entry.document)))];
  const documents = await Document.find({ _id: { $in: documentIds } })
    .select('title path locator occurredAt')
    .lean();
  const docById = new Map(documents.map((document) => [String(document._id), document]));

  const visibleClaims = [];
  const citationsByClaim = new Map();

  for (const claim of claims) {
    const claimEvidence = evidenceByClaim.get(String(claim._id)) || [];
    if (!claimVisibleTo({ evidence: claimEvidence, sourceById, project, userId })) continue;
    visibleClaims.push(claim);
    citationsByClaim.set(
      String(claim._id),
      claimEvidence.map((entry) => citationFor(entry, sourceById, docById)),
    );
  }

  return { claims: visibleClaims, citationsByClaim, sources, sourceById };
}

function encodeClaimCursor(claim) {
  // The cursor is built both from a claim row and from the {occurredAt, id}
  // bookkeeping object used while paging.
  return Buffer.from(
    JSON.stringify({
      o: claim?.occurredAt ? new Date(claim.occurredAt).getTime() : null,
      id: String(claim?._id ?? claim?.id),
    }),
  ).toString('base64url');
}

function decodeClaimCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || !Types.ObjectId.isValid(parsed.id)) return null;
    if (parsed.o !== null) {
      const date = new Date(parsed.o);
      if (Number.isNaN(date.getTime())) return null;
      return { occurredAt: date, id: new Types.ObjectId(parsed.id) };
    }
    return { occurredAt: null, id: new Types.ObjectId(parsed.id) };
  } catch {
    return null;
  }
}

function remainingClaimFilter(after) {
  if (!after) return {};
  if (after.occurredAt === null) return { occurredAt: null, _id: { $lt: after.id } };
  return {
    $or: [
      { occurredAt: { $lt: after.occurredAt } },
      { occurredAt: null },
      { occurredAt: after.occurredAt, _id: { $lt: after.id } },
    ],
  };
}

async function countVisibleClaims({ project, userId, type, sources }) {
  const visibleSourceIds = sources
    .filter((source) => sourceVisibleTo(source, project, userId))
    .map((source) => source._id);
  const match = { project: project._id, retiredAt: null };
  if (type) match.type = type;

  // A claim counts only when it has evidence and every evidence source is
  // readable, mirroring claimVisibleTo without loading the project into memory.
  const [row] = await Claim.aggregate([
    { $match: match },
    {
      $lookup: {
        from: Evidence.collection.name,
        localField: '_id',
        foreignField: 'claim',
        as: 'claimEvidence',
      },
    },
    { $match: { 'claimEvidence.0': { $exists: true } } },
    { $addFields: { evidenceSources: { $setUnion: '$claimEvidence.source' } } },
    {
      $match: {
        evidenceSources: { $not: { $elemMatch: { $nin: visibleSourceIds } } },
      },
    },
    { $count: 'total' },
  ]);
  return row?.total || 0;
}

/**
 * Cursor-paged variant of loadVisibleClaims used by the claims list. Only the
 * claims on the requested page are hydrated with evidence and documents; the
 * visibility rule itself is unchanged, so a page can be shorter than the limit
 * when a hidden claim sits at the boundary.
 */
export async function loadVisibleClaimPage({
  project,
  userId,
  type,
  limit,
  cursor,
}) {
  const sources = await Source.find({ project: project._id }).lean();
  const sourceById = new Map(sources.map((source) => [String(source._id), source]));
  const baseFilter = { project: project._id, retiredAt: null };
  if (type) baseFilter.type = type;

  const [total, visible] = await Promise.all([
    countVisibleClaims({ project, userId, type, sources }),
    (async () => {
      const batchSize = limit;
      let after = decodeClaimCursor(cursor);
      let examined = after;
      const entries = [];

      while (entries.length < limit) {
        const batch = await Claim.find({ ...baseFilter, ...remainingClaimFilter(examined) })
          .sort({ occurredAt: -1, _id: -1 })
          .limit(batchSize)
          .lean();
        if (batch.length === 0) break;

        const evidence = await Evidence.find({
          claim: { $in: batch.map((claim) => claim._id) },
        }).lean();
        const evidenceByClaim = new Map();
        for (const item of evidence) {
          const key = String(item.claim);
          if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
          evidenceByClaim.get(key).push(item);
        }

        let consumed = null;
        for (const claim of batch) {
          consumed = claim;
          const claimEvidence = evidenceByClaim.get(String(claim._id)) || [];
          if (!claimVisibleTo({ evidence: claimEvidence, sourceById, project, userId })) continue;
          entries.push({ claim, evidence: claimEvidence });
          if (entries.length === limit) break;
        }

        examined = { occurredAt: consumed?.occurredAt || null, id: consumed?._id };
        if (batch.length < batchSize) break;
      }

      return { entries, examined };
    })(),
  ]);

  const documentIds = [
    ...new Set(visible.entries.flatMap(({ evidence }) => evidence.map((item) => String(item.document)))),
  ];
  const documents = await Document.find({ _id: { $in: documentIds } })
    .select('title path locator occurredAt')
    .lean();
  const docById = new Map(documents.map((document) => [String(document._id), document]));

  const citationsByClaim = new Map();
  const claims = visible.entries.map(({ claim, evidence }) => {
    citationsByClaim.set(
      String(claim._id),
      evidence.map((item) => citationFor(item, sourceById, docById)),
    );
    return claim;
  });

  const hasMore = Boolean(
    visible.examined &&
      (await Claim.exists({ ...baseFilter, ...remainingClaimFilter(visible.examined) })),
  );

  return {
    claims,
    citationsByClaim,
    sources,
    sourceById,
    total,
    hasMore,
    nextCursor: hasMore ? encodeClaimCursor(visible.examined) : null,
  };
}

export function decorateClaim(claim, citationsByClaim) {
  return {
    id: String(claim._id),
    type: claim.type,
    statement: claim.statement,
    context: claim.context || null,
    topic: claim.topic,
    status: claim.status,
    state: claim.state,
    confidence: claim.confidence,
    sensitivity: claim.sensitivity,
    ownerName: claim.ownerName,
    dueAt: claim.dueAt,
    occurredAt: claim.occurredAt || claim.createdAt,
    origin: claim.origin || 'document',
    confirmedByName: claim.confirmedByName,
    confirmedAt: claim.confirmedAt,
    flags: claim.flags || [],
    evidenceCount: claim.evidenceCount,
    verifiedEvidenceCount: claim.verifiedEvidenceCount,
    sourceId: String(claim.source),
    citations: citationsByClaim.get(String(claim._id)) || [],
  };
}

export async function buildStateForUser({ project, userId, limit = 12 }) {
  const { claims, citationsByClaim } = await loadVisibleClaims({ project, userId });
  const staleDays = env.staleDays;
  const state = reconstructState({
    project,
    claims,
    staleDays,
    oldQuestionDays: env.oldQuestionDays,
    readinessWeights: env.readinessWeights,
  });
  const nextActions = deriveNextActions({ state, limit });

  const decorated = (list) => list.map((claim) => decorateClaim(claim, citationsByClaim));
  const claimById = new Map(claims.map((claim) => [String(claim._id), claim]));

  return {
    claims: decorated(claims),
    state: {
      phase: state.phase,
      readinessScore: state.readinessScore,
      counts: state.counts,
      lastActivityAt: state.lastActivityAt,
      activityWindow: state.activityWindow,
      timeline: state.timeline
        .map((entry) => claimById.get(String(entry.id)))
        .filter(Boolean)
        .map((claim) => decorateClaim(claim, citationsByClaim)),
      conflicts: state.conflicts,
      ownershipGaps: decorated(state.ownershipGaps),
      unverified: decorated(state.unverified),
      openQuestions: decorated(state.openQuestions),
      openRisks: decorated(state.openRisks),
      openDependencies: decorated(state.openDependencies),
      blockers: decorated(state.blockers),
      stale: decorated(state.stale),
    },
    nextActions,
  };
}
