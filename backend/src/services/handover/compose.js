import { env, llmEnabled } from '../../config/env.js';
import { badRequest } from '../../lib/errors.js';
import { Claim, Document, Evidence, Handover, HandoverVersion, Source } from '../../models/index.js';
import { claimVisibleTo, roleOf } from '../access/policy.js';
import { recordAudit } from '../audit.js';
import { deriveNextActions } from '../reconstruction/nextActions.js';
import { reconstructState, summarizeCounts } from '../reconstruction/state.js';

export const TYPE_ORDER = [
  'decision',
  'milestone',
  'task',
  'responsibility',
  'risk',
  'dependency',
  'question',
  'next_action',
];

const TEMPLATES = {
  onboarding: { excludeTypes: [], excludeSensitivity: [] },
  audit: { excludeTypes: [], excludeSensitivity: [] },
  executive: {
    excludeTypes: ['task', 'responsibility', 'question'],
    excludeSensitivity: ['confidential'],
  },
};

function timeOf(claimOrItem) {
  return new Date(claimOrItem.occurredAt || claimOrItem.createdAt || 0).getTime();
}

function buildCitation(evidence, docById, sourceById) {
  const document = docById.get(String(evidence.document));
  const source = sourceById.get(String(evidence.source));
  if (!document || !source) return null;
  return {
    evidenceId: evidence._id,
    documentId: document._id,
    sourceId: source._id,
    sourceName: source.name,
    sourceKind: source.kind,
    docTitle: document.title,
    quote: evidence.quote,
    charStart: evidence.charStart,
    charEnd: evidence.charEnd,
    locator: { path: document.path, url: document.locator?.url },
    validation: evidence.validation,
    occurredAt: document.occurredAt || evidence.createdAt,
  };
}

function buildItem({ claim, evidence, docById, sourceById }) {
  const citations = evidence
    .map((entry) => buildCitation(entry, docById, sourceById))
    .filter(Boolean)
    .sort((a, b) => new Date(a.occurredAt || 0) - new Date(b.occurredAt || 0));

  const hasVerifiedCitation = citations.some((citation) => citation.validation !== 'failed');

  return {
    claimId: claim._id,
    type: claim.type,
    statement: claim.statement,
    topic: claim.topic,
    status: claim.status,
    state: hasVerifiedCitation ? claim.state : 'needs_review',
    confidence: claim.confidence,
    sensitivity: claim.sensitivity,
    ownerName: claim.ownerName,
    dueAt: claim.dueAt,
    occurredAt: claim.occurredAt || claim.createdAt,
    flags: claim.flags || [],
    resolutionNote: claim.resolution?.note || null,
    resolutionByName: claim.resolution?.byName || null,
    citations,
    decision: hasVerifiedCitation ? 'accepted' : 'pending',
    acceptedWithoutEvidence: false,
  };
}

/**
 * Builds a recipient-specific draft. Claims are included only when every
 * citation behind them resolves to a source the recipient may read; the
 * alternative would leak restricted context through partial evidence.
 */
export async function composeHandover({
  project,
  recipient,
  actor,
  roleTemplate = 'onboarding',
  req,
}) {
  if (!TEMPLATES[roleTemplate]) {
    throw badRequest(`Unknown role template "${roleTemplate}"`);
  }
  if (String(recipient._id) === String(actor._id)) {
    throw badRequest('A handover recipient must be a different person from the author');
  }

  const recipientRole = roleOf(project, recipient._id);
  if (!recipientRole) {
    throw badRequest('The recipient must be a member of this project before a handover can be created');
  }

  const startedAt = Date.now();
  const template = TEMPLATES[roleTemplate];

  const [claims, sources] = await Promise.all([
    Claim.find({ project: project._id, retiredAt: null }).lean(),
    Source.find({ project: project._id }).lean(),
  ]);

  const sourceById = new Map(sources.map((source) => [String(source._id), source]));
  const claimIds = claims.map((claim) => claim._id);
  const evidence = await Evidence.find({ claim: { $in: claimIds } }).lean();

  const evidenceByClaim = new Map();
  for (const entry of evidence) {
    const key = String(entry.claim);
    if (!evidenceByClaim.has(key)) evidenceByClaim.set(key, []);
    evidenceByClaim.get(key).push(entry);
  }

  const documentIds = [...new Set(evidence.map((entry) => String(entry.document)))];
  const documents = await Document.find({ _id: { $in: documentIds } }).lean();
  const docById = new Map(documents.map((document) => [String(document._id), document]));

  const withheld = {
    total: 0,
    byType: {},
    byReason: { permissions: 0, template: 0, unverified: 0 },
  };

  const visibleClaims = [];
  const items = [];

  for (const claim of claims) {
    const claimEvidence = evidenceByClaim.get(String(claim._id)) || [];
    const permitted = claimVisibleTo({
      evidence: claimEvidence,
      sourceById,
      project,
      userId: recipient._id,
    });

    if (!permitted) {
      withheld.total += 1;
      withheld.byType[claim.type] = (withheld.byType[claim.type] || 0) + 1;
      withheld.byReason.permissions += 1;
      continue;
    }

    // A reviewer has confirmed a different statement is current, so the
    // superseded version must not appear in any new handover draft.
    if (claim.status === 'superseded') continue;

    visibleClaims.push(claim);

    if (
      template.excludeTypes.includes(claim.type) ||
      template.excludeSensitivity.includes(claim.sensitivity)
    ) {
      withheld.total += 1;
      withheld.byType[claim.type] = (withheld.byType[claim.type] || 0) + 1;
      withheld.byReason.template += 1;
      continue;
    }

    items.push(buildItem({ claim, evidence: claimEvidence, docById, sourceById }));
  }

  items.sort((a, b) => {
    const typeDelta = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    if (typeDelta !== 0) return typeDelta;
    return timeOf(b) - timeOf(a);
  });

  const state = reconstructState({
    project,
    claims: visibleClaims,
    staleDays: env.staleDays,
  });

  const alerts = [];
  for (const conflict of state.conflicts) {
    alerts.push({
      code: 'conflicting_decisions',
      severity: 'critical',
      message: `Sources disagree about "${conflict.topic}". The reviewer must confirm which decision is current.`,
      topic: conflict.topic,
      audience: 'recipient',
      claimIds: conflict.claimIds,
    });
  }
  for (const gap of state.ownershipGaps) {
    alerts.push({
      code: 'missing_owner',
      severity: 'warning',
      message: `An open task has no recorded owner: "${gap.statement.slice(0, 140)}"`,
      topic: gap.topic,
      audience: 'recipient',
      claimIds: [gap._id],
    });
  }
  if (state.unverified.length > 0) {
    alerts.push({
      code: 'unverified_claims',
      severity: 'warning',
      message: `${state.unverified.length} extracted item(s) could not be matched to a verbatim source quote and need reviewer confirmation.`,
      audience: 'reviewer',
      claimIds: state.unverified.map((claim) => claim._id),
    });
  }
  if (withheld.byReason.permissions > 0) {
    alerts.push({
      code: 'restricted_items_excluded',
      severity: 'info',
      message: `${withheld.byReason.permissions} item(s) were excluded because the recipient is not authorized to read their source. Details are intentionally not shown.`,
      audience: 'reviewer',
    });
  }

  const recommendations = deriveNextActions({ state, limit: 8 });

  // Recommendations and alerts quote claim statements, so they must never
  // reference a claim the selected template removed from the handover.
  const includedClaimIds = new Set(items.map((item) => String(item.claimId)));
  const referencesIncludedClaims = (entry) =>
    (entry.claimIds || []).every((id) => includedClaimIds.has(String(id)));

  const visibleAlerts = alerts.filter(referencesIncludedClaims);
  const visibleRecommendations = recommendations.filter(referencesIncludedClaims);

  const snapshot = {
    projectName: project.name,
    projectKey: project.key,
    description: project.description,
    phase: state.phase,
    readinessScore: state.readinessScore,
    lastActivityAt: state.lastActivityAt,
    activityWindow: state.activityWindow,
    counts: state.counts,
    outgoingName: project.transition?.outgoingName,
    plannedDepartureAt: project.transition?.plannedDepartureAt,
    transitionContext: project.transition?.context,
    generatedSummary: `Handover for ${recipient.name}: ${summarizeCounts(state)}.`,
  };

  const handover = await Handover.create({
    project: project._id,
    recipient: recipient._id,
    recipientSnapshot: {
      name: recipient.name,
      email: recipient.email,
      role: recipientRole,
    },
    roleTemplate,
    status: 'draft',
    createdBy: actor._id,
    items,
    alerts: visibleAlerts,
    recommendations: visibleRecommendations,
    withheld,
    snapshot,
    version: 1,
    generation: {
      method: llmEnabled ? 'llm+deterministic' : 'deterministic',
      model: llmEnabled ? env.geminiModel : 'deterministic-heuristic',
      generatedAt: new Date(),
      durationMs: Date.now() - startedAt,
    },
  });

  await HandoverVersion.create({
    handover: handover._id,
    project: project._id,
    version: 1,
    reason: 'created',
    actor: actor._id,
    actorName: actor.name,
    snapshot: handover.toObject(),
  });

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'handover.created',
    targetType: 'handover',
    targetId: handover._id,
    targetLabel: `Handover for ${recipient.name}`,
    meta: {
      roleTemplate,
      recipient: String(recipient._id),
      items: items.length,
      withheld: withheld.total,
      permissionsWithheld: withheld.byReason.permissions,
    },
    req,
  });

  return handover;
}
