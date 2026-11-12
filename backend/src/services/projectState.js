import { env } from '../config/env.js';
import { Claim, Document, Evidence, Source } from '../models/index.js';
import { claimVisibleTo, roleOf } from './access/policy.js';
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
    owner: String(data.owner?._id ?? data.owner),
    role: roleOf(project, user?._id),
    members: (data.members || []).map((member) => ({
      userId: String(member.user?._id ?? member.user),
      role: member.role,
      name: member.user?.name,
      email: member.user?.email,
      joinedAt: member.joinedAt,
    })),
    transition: data.transition,
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
    stats: data.stats,
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

export function decorateClaim(claim, citationsByClaim) {
  return {
    id: String(claim._id),
    type: claim.type,
    statement: claim.statement,
    topic: claim.topic,
    status: claim.status,
    state: claim.state,
    confidence: claim.confidence,
    sensitivity: claim.sensitivity,
    ownerName: claim.ownerName,
    dueAt: claim.dueAt,
    occurredAt: claim.occurredAt || claim.createdAt,
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
  const state = reconstructState({ project, claims, staleDays });
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
      stale: decorated(state.stale),
    },
    nextActions,
  };
}
