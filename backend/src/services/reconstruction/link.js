import { Claim } from '../../models/index.js';

function timeOf(claim) {
  // Never fall back to ingestion time: an undated claim is older than anything
  // with a real source date, so it cannot masquerade as the newest statement.
  if (claim.hasSourceDate === false || !claim.occurredAt) return 0;
  return new Date(claim.occurredAt).getTime();
}

function topicTokens(topicKey) {
  return new Set(String(topicKey || '').split(' ').filter(Boolean));
}

function tokensMatch(left, right) {
  if (left === right) return true;
  // Treat stems as the same word ("auth" / "authentication", "provider" /
  // "providers") so topics separated only by word form still group.
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

function topicSimilarity(a, b) {
  const left = [...topicTokens(a)];
  const right = [...topicTokens(b)];
  if (left.length === 0 || right.length === 0) return 0;
  const matchedRight = new Set();
  let shared = 0;
  for (const token of left) {
    const index = right.findIndex(
      (candidate, position) => !matchedRight.has(position) && tokensMatch(token, candidate),
    );
    if (index !== -1) {
      matchedRight.add(index);
      shared += 1;
    }
  }
  return shared / (left.length + right.length - shared);
}

const FUZZY_TOPIC_THRESHOLD = 0.6;

function sameTopicGroup(left, right) {
  if (left.topicKey === right.topicKey) return true;
  return topicSimilarity(left.topicKey, right.topicKey) >= FUZZY_TOPIC_THRESHOLD;
}

/**
 * Marks older decisions on the same topic as superseded when a later,
 * explicitly superseding decision exists. This keeps the project state from
 * presenting a stale proposal as the current truth.
 */
export async function linkSupersessions(projectId) {
  const decisions = await Claim.find({
    project: projectId,
    type: 'decision',
    retiredAt: null,
  }).lean();

  const groups = new Map();
  for (const claim of decisions) {
    if (!claim.topicKey) continue;
    if (!groups.has(claim.topicKey)) groups.set(claim.topicKey, []);
    groups.get(claim.topicKey).push(claim);
  }

  const updates = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => timeOf(a) - timeOf(b));
    for (const claim of sorted) {
      if (!(claim.flags || []).includes('explicit_supersession')) continue;
      const claimTime = timeOf(claim);
      if (claimTime === 0) continue;
      for (const other of sorted) {
        if (String(other._id) === String(claim._id)) continue;
        if (other.status === 'superseded') continue;
        if (other.hasSourceDate === false || !other.occurredAt) continue;
        if (timeOf(other) >= claimTime) continue;
        updates.push(
          Claim.updateOne(
            { _id: other._id },
            {
              $set: { status: 'superseded', supersededBy: claim._id },
              $addToSet: { flags: 'superseded_by_newer' },
            },
          ),
        );
      }
    }
  }

  if (updates.length > 0) await Promise.all(updates);
  return updates.length;
}

/**
 * Groups active decisions into topics. Exact topic keys are merged first, then
 * near-identical topics ("auth provider" / "authentication provider") are
 * joined so reviewers see a possible conflict instead of silent disagreement.
 */
export function findSupersededPairs(claims) {
  const decisions = claims.filter(
    (claim) => claim.type === 'decision' && claim.topicKey && claim.status !== 'superseded',
  );

  const exactGroups = new Map();
  for (const claim of decisions) {
    const key = claim.topicKey;
    if (!exactGroups.has(key)) exactGroups.set(key, { topicKey: key, topic: claim.topic, claims: [] });
    exactGroups.get(key).claims.push(claim);
  }

  const groups = [...exactGroups.values()];
  const merged = [];
  for (const group of groups) {
    const target = merged.find((entry) => sameTopicGroup(entry, group));
    if (!target) {
      merged.push({ ...group, topicKeys: new Set([group.topicKey]) });
    } else {
      target.claims.push(...group.claims);
      target.topicKeys.add(group.topicKey);
    }
  }

  const pairs = [];
  for (const group of merged) {
    const distinctStatements = new Set(group.claims.map((claim) => claim.statementKey));
    if (distinctStatements.size < 2) continue;
    pairs.push({
      topicKey: group.topicKey,
      topic: group.topic,
      claims: group.claims,
      possible: group.topicKeys.size > 1,
    });
  }
  return pairs;
}
