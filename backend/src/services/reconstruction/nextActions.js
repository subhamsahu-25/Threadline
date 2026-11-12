import { truncate } from '../../lib/text.js';

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function action({ kind, priority, title, reason, claimIds = [] }) {
  return {
    key: `${kind}:${claimIds.map(String).sort().join(',') || title.slice(0, 40)}`,
    kind,
    priority,
    title,
    reason,
    claimIds,
    inferred: true,
  };
}

/**
 * Recommendations are deliberately kept separate from extracted facts and are
 * always labelled as inferred. They never introduce a claim that is not
 * already present in the (permission-filtered) project state.
 */
export function deriveNextActions({ state, now = new Date(), limit = 10 }) {
  const actions = [];

  for (const conflict of state.conflicts) {
    actions.push(
      action({
        kind: 'resolve_conflict',
        priority: 'critical',
        title: `Resolve conflicting decisions on "${truncate(conflict.topic || 'this topic', 60)}"`,
        reason: 'Multiple active decisions disagree. Confirm which one is current before work continues.',
        claimIds: conflict.claimIds,
      }),
    );
  }

  for (const gap of state.ownershipGaps) {
    actions.push(
      action({
        kind: 'assign_owner',
        priority: 'high',
        title: `Assign an owner for "${truncate(gap.statement, 90)}"`,
        reason: 'This task is still open and has no recorded owner.',
        claimIds: [gap._id],
      }),
    );
  }

  for (const question of state.openQuestions) {
    actions.push(
      action({
        kind: 'resolve_question',
        priority: 'high',
        title: `Answer open question: ${truncate(question.statement, 100)}`,
        reason: 'The project state records this question as unresolved.',
        claimIds: [question._id],
      }),
    );
  }

  for (const risk of state.openRisks) {
    actions.push(
      action({
        kind: 'mitigate_risk',
        priority: 'high',
        title: `Agree a mitigation for risk: ${truncate(risk.statement, 100)}`,
        reason: 'The risk is recorded as open with no confirmed mitigation.',
        claimIds: [risk._id],
      }),
    );
  }

  for (const claim of state.openTasks || []) {
    if (claim.dueAt && new Date(claim.dueAt) < now) {
      actions.push(
        action({
          kind: 'overdue_task',
          priority: 'high',
          title: `Follow up overdue task: ${truncate(claim.statement, 90)}`,
          reason: `Due date passed on ${new Date(claim.dueAt).toISOString().slice(0, 10)}${
            claim.ownerName ? `; owner recorded as ${claim.ownerName}` : ''
          }.`,
          claimIds: [claim._id],
        }),
      );
    }
  }

  for (const claim of state.stale || []) {
    actions.push(
      action({
        kind: 'stale_item',
        priority: 'medium',
        title: `Re-check stale item: ${truncate(claim.statement, 90)}`,
        reason: `No update recorded for more than the staleness threshold (status: ${claim.status}).`,
        claimIds: [claim._id],
      }),
    );
  }

  for (const claim of state.openTasks || []) {
    if (claim.dueAt && new Date(claim.dueAt) < now) continue;
    actions.push(
      action({
        kind: 'continue_task',
        priority: 'medium',
        title: `Continue task: ${truncate(claim.statement, 90)}`,
        reason: claim.ownerName
          ? `Recorded owner: ${claim.ownerName}.`
          : 'Open task with no owner recorded.',
        claimIds: [claim._id],
      }),
    );
  }

  const seen = new Set();
  return actions
    .filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    })
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    .slice(0, limit);
}
