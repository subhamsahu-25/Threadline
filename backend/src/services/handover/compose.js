import { env, llmEnabled } from '../../config/env.js';
import { badRequest } from '../../lib/errors.js';
import { createRedactionTally, redactText } from '../../lib/redaction.js';
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

export const TEMPLATES = {
  onboarding: {
    includeTypes: null,
    excludeTypes: [],
    excludeSensitivity: [],
    focus: ['Every current decision, task, risk, dependency and open question'],
  },
  executive: {
    includeTypes: ['decision', 'milestone', 'risk'],
    excludeTypes: ['task', 'responsibility', 'question', 'dependency', 'next_action'],
    excludeSensitivity: ['confidential'],
    focus: ['Decisions', 'Risks', 'Milestones', 'Ownership gaps and readiness in the snapshot'],
  },
  audit: {
    includeTypes: ['decision', 'risk'],
    excludeTypes: ['milestone', 'task', 'responsibility', 'question', 'dependency', 'next_action'],
    excludeSensitivity: [],
    focus: ['Decision and risk evidence quality', 'Redaction summary', 'Withheld content counts'],
  },
};

export function templateIncludes(template, claim) {
  if (template.includeTypes) return template.includeTypes.includes(claim.type);
  return !template.excludeTypes.includes(claim.type);
}

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

function buildItem({
  claim,
  evidence,
  docById,
  sourceById,
  redactions,
  permittedForRecipient,
}) {
  const statement = redactText(claim.statement);
  redactions.add(statement);
  let redactionCount = statement.count;

  const citations = evidence
    .map((entry) => buildCitation(entry, docById, sourceById))
    .filter(Boolean)
    .map((citation) => {
      const quote = redactText(citation.quote || '');
      redactions.add(quote);
      redactionCount += quote.count;
      return { ...citation, quote: quote.text };
    })
    .sort((a, b) => new Date(a.occurredAt || 0) - new Date(b.occurredAt || 0));

  const hasVerifiedCitation = citations.some((citation) => citation.validation !== 'failed');
  const resolutionNote = redactText(claim.resolution?.note || '');
  redactions.add(resolutionNote);

  return {
    claimId: claim._id,
    type: claim.type,
    statement: statement.text,
    topic: claim.topic,
    status: claim.status,
    state: hasVerifiedCitation ? claim.state : 'needs_review',
    confidence: claim.confidence,
    sensitivity: claim.sensitivity,
    ownerName: claim.ownerName,
    dueAt: claim.dueAt,
    occurredAt: claim.occurredAt || claim.createdAt,
    origin: claim.origin || 'document',
    confirmedByName: claim.confirmedByName,
    confirmedAt: claim.confirmedAt,
    restrictedToRecipient: !permittedForRecipient,
    hasSourceDate: claim.hasSourceDate !== false,
    flags: claim.flags || [],
    conflicting: false,
    redactionCount,
    resolutionNote: resolutionNote.text || null,
    resolutionByName: claim.resolution?.byName || null,
    citations,
    decision: hasVerifiedCitation ? 'accepted' : 'pending',
    acceptedWithoutEvidence: false,
  };
}

function redactFields(entry, fields, redactions) {
  for (const field of fields) {
    if (typeof entry[field] !== 'string') continue;
    const result = redactText(entry[field]);
    if (result.count > 0) {
      entry[field] = result.text;
      redactions.add(result);
    }
  }
}

/**
 * Builds a recipient-specific handover payload from the current project state.
 * Claims are included only when every citation behind them resolves to a source
 * the recipient may read; the alternative would leak restricted context through
 * partial evidence. Shared by the initial composition and by regeneration.
 */
export async function buildComposition({ project, recipient, actor, roleTemplate = 'onboarding' }) {
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
    byReason: { permissions: 0, author_permissions: 0, template: 0, unverified: 0 },
    entries: [],
  };

  const redactions = createRedactionTally();
  const visibleClaims = [];
  const items = [];

  const withhold = (claim, reason) => {
    withheld.total += 1;
    withheld.byType[claim.type] = (withheld.byType[claim.type] || 0) + 1;
    withheld.byReason[reason] += 1;
    withheld.entries.push({ claimId: claim._id, claimType: claim.type, reason });
  };

  for (const claim of claims) {
    const claimEvidence = evidenceByClaim.get(String(claim._id)) || [];
    const permittedForRecipient = claimVisibleTo({
      evidence: claimEvidence,
      sourceById,
      project,
      userId: recipient._id,
    });

    if (!permittedForRecipient && claim.origin !== 'person_confirmed') {
      withhold(claim, 'permissions');
      continue;
    }

    // The author must be able to read everything they hand over. Otherwise the
    // review screen would become a side channel into sources they cannot see.
    const permittedForAuthor = claimVisibleTo({
      evidence: claimEvidence,
      sourceById,
      project,
      userId: actor._id,
    });
    if (!permittedForAuthor) {
      withhold(claim, 'author_permissions');
      continue;
    }

    // A reviewer has confirmed a different statement is current, so the
    // superseded version must not appear in any new handover draft.
    if (claim.status === 'superseded') continue;

    visibleClaims.push(claim);

    if (
      !templateIncludes(template, claim) ||
      template.excludeSensitivity.includes(claim.sensitivity)
    ) {
      withhold(claim, 'template');
      continue;
    }

    items.push(
      buildItem({
        claim,
        evidence: claimEvidence,
        docById,
        sourceById,
        redactions,
        permittedForRecipient,
      }),
    );
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

  const conflictingClaimIds = new Set(
    state.conflicts.flatMap((conflict) => conflict.claimIds.map((id) => String(id))),
  );
  for (const item of items) {
    if (conflictingClaimIds.has(String(item.claimId))) item.conflicting = true;
  }

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
  const hiddenByPermissions =
    withheld.byReason.permissions + withheld.byReason.author_permissions;
  if (hiddenByPermissions > 0) {
    alerts.push({
      code: 'restricted_items_excluded',
      severity: 'info',
      message: `${hiddenByPermissions} item(s) were excluded because the author or the recipient is not authorized to read their source. Details are intentionally not shown.`,
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

  for (const alert of visibleAlerts) redactFields(alert, ['message'], redactions);
  for (const recommendation of visibleRecommendations) {
    redactFields(recommendation, ['title', 'reason'], redactions);
  }

  const description = redactText(project.description || '');
  redactions.add(description);
  const transitionContext = redactText(project.transition?.context || '');
  redactions.add(transitionContext);

  const snapshot = {
    projectName: project.name,
    projectKey: project.key,
    description: description.text,
    phase: state.phase,
    readinessScore: state.readinessScore,
    lastActivityAt: state.lastActivityAt,
    activityWindow: state.activityWindow,
    counts: state.counts,
    outgoingName: project.transition?.outgoingName,
    plannedDepartureAt: project.transition?.plannedDepartureAt,
    transitionContext: transitionContext.text,
    templateFocus: template.focus,
    generatedSummary: `Handover for ${recipient.name}: ${summarizeCounts(state)}.`,
  };

  const handover = {
    recipientRole,
    roleTemplate,
    items,
    alerts: visibleAlerts,
    recommendations: visibleRecommendations,
    withheld,
    redactions: redactions.toJSON(),
    snapshot,
    generation: {
      method: llmEnabled ? 'llm+deterministic' : 'deterministic',
      model: llmEnabled ? env.geminiModel : 'deterministic-heuristic',
      generatedAt: new Date(),
      durationMs: Date.now() - startedAt,
    },
  };

  return handover;
}

export async function composeHandover({ project, recipient, actor, roleTemplate = 'onboarding', req }) {
  const composition = await buildComposition({ project, recipient, actor, roleTemplate });

  const handover = await Handover.create({
    project: project._id,
    recipient: recipient._id,
    recipientSnapshot: {
      name: recipient.name,
      email: recipient.email,
      role: composition.recipientRole,
    },
    roleTemplate,
    status: 'draft',
    createdBy: actor._id,
    createdBySnapshot: { name: actor.name, email: actor.email },
    items: composition.items,
    alerts: composition.alerts,
    recommendations: composition.recommendations,
    withheld: composition.withheld,
    redactions: composition.redactions,
    snapshot: composition.snapshot,
    version: 1,
    generation: composition.generation,
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
      items: composition.items.length,
      withheld: composition.withheld.total,
      permissionsWithheld: composition.withheld.byReason.permissions,
      redactions: composition.redactions.count,
    },
    req,
  });

  return handover;
}
