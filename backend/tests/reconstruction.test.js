import { describe, expect, it } from 'vitest';
import { heuristicExtract } from '../src/services/ai/heuristics.js';
import { deriveNextActions } from '../src/services/reconstruction/nextActions.js';
import { findSupersededPairs } from '../src/services/reconstruction/link.js';
import { reconstructState } from '../src/services/reconstruction/state.js';

const now = new Date('2026-11-17T00:00:00Z');

function claim(overrides = {}) {
  return {
    _id: overrides._id || `c${Math.random().toString(16).slice(2)}`,
    type: 'task',
    statement: 'Do the thing',
    statementKey: overrides.statementKey || overrides.statement || 'do the thing',
    topic: 'Planning',
    topicKey: overrides.topicKey || 'planning',
    status: 'open',
    state: 'confirmed',
    confidence: 0.8,
    sensitivity: 'internal',
    flags: [],
    ownerName: null,
    dueAt: null,
    occurredAt: null,
    hasSourceDate: false,
    source: 's1',
    verifiedEvidenceCount: 1,
    evidenceCount: 1,
    ...overrides,
  };
}

describe('heuristic extraction statuses', () => {
  it('keeps an explicit blocked status instead of flattening it to open', () => {
    const items = heuristicExtract({
      text: 'Task: Wire the audit export -- status: blocked',
    });
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('blocked');
  });

  it('still maps explicit open to open', () => {
    const items = heuristicExtract({ text: 'Task: Wire the audit export -- status: open' });
    expect(items[0].status).toBe('open');
  });
});

describe('state reconstruction ordering and dates', () => {
  it('never dates an undated claim with ingestion time', () => {
    const dated = claim({
      _id: 'dated',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      hasSourceDate: true,
    });
    const undated = claim({ _id: 'undated', statement: 'Undated note', occurredAt: null });

    const state = reconstructState({ project: {}, claims: [dated, undated], now });

    expect(state.timeline.map((entry) => entry.id)).toEqual(['dated', 'undated']);
    const entry = state.timeline.find((item) => item.id === 'undated');
    expect(entry.occurredAt).toBeNull();
    expect(entry.hasSourceDate).toBe(false);
    expect(state.lastActivityAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never reports an undated open item as stale', () => {
    const undated = claim({ _id: 'undated', status: 'open' });
    const old = claim({
      _id: 'old',
      occurredAt: new Date('2025-01-01T00:00:00Z'),
      hasSourceDate: true,
    });

    const state = reconstructState({ project: {}, claims: [undated, old], now });

    expect(state.stale.map((item) => item._id)).toEqual(['old']);
  });

  it('returns a null readiness score when nothing has been extracted', () => {
    const state = reconstructState({ project: {}, claims: [], now });
    expect(state.readinessScore).toBeNull();
    expect(state.phase).toBe('No project knowledge ingested');
  });

  it('keeps the project in execution while any category is still open', () => {
    const decided = claim({
      _id: 'd1',
      type: 'decision',
      status: 'active',
      statement: 'Use Postgres',
      ownerName: 'Priya',
    });
    const gap = claim({ _id: 't1', type: 'task', status: 'open', ownerName: null });

    const state = reconstructState({ project: {}, claims: [decided, gap], now });
    expect(state.phase).toBe('Execution');

    const closed = claim({ _id: 't1', type: 'task', status: 'done', ownerName: 'Arjun' });
    const ready = reconstructState({ project: {}, claims: [decided, closed], now });
    expect(ready.phase).toBe('Ready for handover');
  });

  it('counts blocked work separately and exposes it as a blocker list', () => {
    const blocked = claim({ _id: 'b1', status: 'blocked', ownerName: 'Arjun' });
    const state = reconstructState({ project: {}, claims: [blocked], now });

    expect(state.counts.blocked).toBe(1);
    expect(state.blockers.map((item) => item._id)).toEqual(['b1']);
    expect(state.phase).toBe('Execution');
  });
});

describe('decision conflict grouping', () => {
  it('joins near-identical topics and marks the conflict as possible', () => {
    const pairs = findSupersededPairs([
      claim({
        _id: 'a',
        type: 'decision',
        status: 'active',
        topic: 'Auth provider',
        topicKey: 'auth provider',
        statement: 'Use Auth0',
        statementKey: 'use auth0',
      }),
      claim({
        _id: 'b',
        type: 'decision',
        status: 'active',
        topic: 'Authentication provider',
        topicKey: 'authentication provider',
        statement: 'Use AWS Cognito',
        statementKey: 'use aws cognito',
      }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].possible).toBe(true);
    expect(pairs[0].claims).toHaveLength(2);
  });

  it('treats identical restatements as the same decision, not a conflict', () => {
    const pairs = findSupersededPairs([
      claim({ _id: 'a', type: 'decision', status: 'active', statementKey: 'use auth0' }),
      claim({ _id: 'b', type: 'decision', status: 'active', statementKey: 'use auth0' }),
    ]);
    expect(pairs).toHaveLength(0);
  });
});

describe('next actions', () => {
  it('raises a critical unblock action and skips blocked tasks elsewhere', () => {
    const blocked = claim({
      _id: 'b1',
      status: 'blocked',
      ownerName: 'Arjun',
      dueAt: new Date('2026-01-01T00:00:00Z'),
    });
    const state = reconstructState({ project: {}, claims: [blocked], now });
    const actions = deriveNextActions({ state, now });

    const unblock = actions.find((entry) => entry.kind === 'unblock_task');
    expect(unblock).toBeTruthy();
    expect(unblock.priority).toBe('critical');
    expect(unblock.inferred).toBe(true);
    expect(actions.some((entry) => entry.kind === 'continue_task')).toBe(false);
    expect(actions.some((entry) => entry.kind === 'overdue_task')).toBe(false);
  });

  it('continues an ordinary open task', () => {
    const open = claim({ _id: 't1', status: 'open', ownerName: 'Priya' });
    const state = reconstructState({ project: {}, claims: [open], now });
    const actions = deriveNextActions({ state, now });
    expect(actions.some((entry) => entry.kind === 'continue_task')).toBe(true);
  });
});
