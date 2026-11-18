import { truncate } from '../../lib/text.js';
import { findSupersededPairs } from './link.js';

const TYPE_LABELS = {
  decision: 'decision',
  task: 'task',
  risk: 'risk',
  dependency: 'dependency',
  question: 'open question',
  milestone: 'milestone',
  responsibility: 'responsibility',
  next_action: 'next action',
};

function timeOf(claim) {
  if (claim.hasSourceDate === false || !claim.occurredAt) return 0;
  return new Date(claim.occurredAt).getTime();
}

function isOpen(claim) {
  return ['open', 'active', 'planned', 'unknown', 'blocked'].includes(claim.status);
}

function ageInDays(date, now) {
  if (!date) return 0;
  return Math.max(0, (now.getTime() - new Date(date).getTime()) / 86_400_000);
}

export const DEFAULT_READINESS_WEIGHTS = {
  unverified: 3,
  ownershipGap: 8,
  conflict: 10,
  oldQuestion: 4,
};

// Caps keep one category from consuming the whole score. They are part of the
// documented scale, not per-project settings; the per-item costs above are the
// tunable knobs.
const READINESS_CAPS = {
  unverified: 30,
  ownershipGap: 24,
  conflict: 30,
  oldQuestion: 16,
};

function buildReadiness({ unverified, ownershipGaps, conflicts, oldQuestions, weights }) {
  const cost = { ...DEFAULT_READINESS_WEIGHTS, ...(weights || {}) };
  let score = 100;
  score -= Math.min(READINESS_CAPS.unverified, unverified.length * cost.unverified);
  score -= Math.min(READINESS_CAPS.ownershipGap, ownershipGaps.length * cost.ownershipGap);
  score -= Math.min(READINESS_CAPS.conflict, conflicts.length * cost.conflict);
  score -= Math.min(READINESS_CAPS.oldQuestion, oldQuestions.length * cost.oldQuestion);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function derivePhase({
  claims,
  decisions,
  openTasks,
  openQuestions,
  openRisks,
  ownershipGaps,
  conflicts,
}) {
  if (claims.length === 0) return 'No project knowledge ingested';
  if (decisions.length === 0 && openQuestions.length > 0) return 'Discovery';
  const clear =
    openTasks.length === 0 &&
    openQuestions.length === 0 &&
    openRisks.length === 0 &&
    ownershipGaps.length === 0 &&
    conflicts.length === 0;
  if (clear && decisions.length > 0) return 'Ready for handover';
  return 'Execution';
}

/**
 * Pure reconstruction over an already access-filtered claim set. The caller is
 * responsible for removing claims the requesting user may not see; this layer
 * only reasons about what is current, missing or contradictory.
 */
export function reconstructState({
  project,
  claims,
  staleDays = 30,
  oldQuestionDays = 14,
  readinessWeights = DEFAULT_READINESS_WEIGHTS,
  now = new Date(),
}) {
  const byType = {};
  const byState = {};
  for (const claim of claims) {
    byType[claim.type] = (byType[claim.type] || 0) + 1;
    byState[claim.state] = (byState[claim.state] || 0) + 1;
  }

  const sorted = [...claims].sort((a, b) => timeOf(b) - timeOf(a));
  const timeline = sorted.map((claim) => ({
    id: claim._id,
    type: claim.type,
    topic: claim.topic,
    statement: claim.statement,
    status: claim.status,
    state: claim.state,
    confidence: claim.confidence,
    sensitivity: claim.sensitivity,
    flags: claim.flags || [],
    ownerName: claim.ownerName,
    dueAt: claim.dueAt,
    occurredAt: claim.hasSourceDate === false ? null : claim.occurredAt || null,
    hasSourceDate: claim.hasSourceDate !== false && Boolean(claim.occurredAt),
    sourceId: claim.source,
    verifiedEvidenceCount: claim.verifiedEvidenceCount ?? 0,
    evidenceCount: claim.evidenceCount ?? 0,
  }));

  const conflicts = [];
  for (const pair of findSupersededPairs(claims)) {
    conflicts.push({
      code: 'conflicting_decisions',
      topic: pair.topic,
      topicKey: pair.topicKey,
      possible: Boolean(pair.possible),
      claimIds: pair.claims.map((claim) => claim._id),
      statements: pair.claims.map((claim) => ({
        claimId: claim._id,
        statement: claim.statement,
        occurredAt:
          claim.hasSourceDate === false ? null : claim.occurredAt || null,
        sourceId: claim.source,
      })),
    });
  }

  const tasks = claims.filter((claim) => claim.type === 'task' && isOpen(claim));
  const openTasks = tasks;
  const blockers = claims.filter((claim) => claim.status === 'blocked');
  const ownershipGaps = tasks.filter((claim) => !claim.ownerName);
  const unverified = claims.filter(
    (claim) =>
      claim.origin !== 'person_confirmed' &&
      ((claim.verifiedEvidenceCount ?? 0) === 0 ||
        (claim.flags || []).includes('unverified_citation')),
  );
  const openQuestions = claims.filter(
    (claim) => claim.type === 'question' && isOpen(claim),
  );
  const openRisks = claims.filter((claim) => claim.type === 'risk' && isOpen(claim));
  const openDependencies = claims.filter(
    (claim) => claim.type === 'dependency' && isOpen(claim),
  );
  const decisions = claims.filter((claim) => claim.type === 'decision');
  const activeDecisions = decisions.filter((claim) => claim.status !== 'superseded');
  const milestones = claims.filter((claim) => claim.type === 'milestone');

  // Undated items cannot age: without a source date we do not know how old they
  // are, so they are never reported as stale.
  const stale = claims.filter(
    (claim) =>
      ['task', 'risk', 'question', 'dependency'].includes(claim.type) &&
      isOpen(claim) &&
      claim.hasSourceDate !== false &&
      claim.occurredAt &&
      ageInDays(claim.occurredAt, now) > staleDays,
  );

  const oldQuestions = openQuestions.filter(
    (claim) =>
      claim.hasSourceDate !== false &&
      claim.occurredAt &&
      ageInDays(claim.occurredAt, now) > oldQuestionDays,
  );

  const datedClaims = claims.filter(
    (claim) => claim.hasSourceDate !== false && claim.occurredAt,
  );
  const dates = datedClaims.map((claim) => new Date(claim.occurredAt));
  const startDate = dates.length > 0 ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
  const endDate = dates.length > 0 ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null;

  const readinessScore =
    claims.length === 0
      ? null
      : buildReadiness({
          unverified,
          ownershipGaps,
          conflicts,
          oldQuestions,
          weights: readinessWeights,
        });

  return {
    counts: {
      total: claims.length,
      byType,
      byState,
      openTasks: openTasks.length,
      doneTasks: claims.filter((claim) => claim.type === 'task' && claim.status === 'done').length,
      blocked: blockers.length,
      activeDecisions: activeDecisions.length,
      milestones: milestones.length,
      openRisks: openRisks.length,
      openQuestions: openQuestions.length,
    },
    phase: derivePhase({
      claims,
      decisions,
      openTasks,
      openQuestions,
      openRisks,
      ownershipGaps,
      conflicts,
    }),
    readinessScore,
    lastActivityAt: endDate || null,
    activityWindow: { start: startDate, end: endDate },
    timeline,
    conflicts,
    blockers,
    ownershipGaps,
    unverified,
    openQuestions,
    openRisks,
    openDependencies,
    openTasks,
    stale,
    decisions: activeDecisions,
  };
}

export function summarizeCounts(state) {
  const parts = [];
  const c = state.counts;
  if (c.activeDecisions) parts.push(`${c.activeDecisions} active decision(s)`);
  if (c.openTasks) parts.push(`${c.openTasks} open task(s)`);
  if (state.ownershipGaps.length) parts.push(`${state.ownershipGaps.length} without an owner`);
  if (c.openRisks) parts.push(`${c.openRisks} open risk(s)`);
  if (c.openQuestions) parts.push(`${c.openQuestions} open question(s)`);
  if (state.conflicts.length) parts.push(`${state.conflicts.length} conflicting decision set(s)`);
  if (state.unverified.length) parts.push(`${state.unverified.length} item(s) lacking verified evidence`);
  return parts.length ? parts.join(', ') : 'No project claims extracted yet';
}

export function describeClaim(claim) {
  return `${TYPE_LABELS[claim.type] || claim.type}: ${truncate(claim.statement, 120)}`;
}
