import { Claim } from '../../models/index.js';

function timeOf(claim) {
  return new Date(claim.occurredAt || claim.createdAt || 0).getTime();
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
      for (const other of sorted) {
        if (String(other._id) === String(claim._id)) continue;
        if (other.status === 'superseded') continue;
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

export function findSupersededPairs(claims) {
  const pairs = [];
  const byTopic = new Map();
  for (const claim of claims) {
    if (claim.type !== 'decision' || !claim.topicKey) continue;
    if (!byTopic.has(claim.topicKey)) byTopic.set(claim.topicKey, []);
    byTopic.get(claim.topicKey).push(claim);
  }
  for (const group of byTopic.values()) {
    const active = group.filter((claim) => claim.status !== 'superseded');
    if (active.length > 1) {
      pairs.push({ topicKey: group[0].topicKey, topic: group[0].topic, claims: active });
    }
  }
  return pairs;
}
