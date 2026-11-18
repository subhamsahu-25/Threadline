import { Claim, Source } from '../../models/index.js';
import { valueTokens } from '../../lib/text.js';

const AUTO_SUPERSEDE_FLAG = 'superseded_by_newer';
const REVIEWER_SUPERSEDE_FLAG = 'superseded_by_reviewer';

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

function topicKeyOf(claim) {
  return claim.topicKey || `untopiced:${String(claim._id)}`;
}

export function sameTopicGroup(left, right) {
  const leftKey = topicKeyOf(left);
  const rightKey = topicKeyOf(right);
  if (leftKey === rightKey) return true;
  if (leftKey.startsWith('untopiced:') || rightKey.startsWith('untopiced:')) return false;
  return topicSimilarity(leftKey, rightKey) >= FUZZY_TOPIC_THRESHOLD;
}

/**
 * Deterministic, transitive topic grouping. Claims are ordered by id before the
 * union-find runs, so the same claim set always produces the same groups no
 * matter which caller loaded it. Both conflict detection and supersession use
 * this one function.
 */
export function groupDecisionTopics(claims) {
  const ordered = claims
    .filter((claim) => claim.type === 'decision' && claim.status !== 'superseded')
    .sort((a, b) => String(a._id).localeCompare(String(b._id)));

  const parent = ordered.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (sameTopicGroup(ordered[i], ordered[j])) union(i, j);
    }
  }

  const groups = new Map();
  ordered.forEach((claim, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(claim);
  });

  return [...groups.values()].map((members) => {
    const counts = new Map();
    for (const member of members) {
      if (!member.topicKey) continue;
      counts.set(member.topicKey, (counts.get(member.topicKey) || 0) + 1);
    }
    const topicKey =
      [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])),
      )[0]?.[0] || '';
    const topic = members.find((member) => member.topicKey === topicKey)?.topic || members[0]?.topic || '';
    return { topicKey, topic, claims: members, fuzzy: counts.size > 1 };
  });
}

const NEGATION_RE = /\b(?:not|no|never|without|avoid|drop|remove|stop|disable|reject)\b/i;
const SHARED_STOPWORDS = new Set(
  'the a an and or but if then to for of in on at with by from as is are be was were will would should must can may we our they it this that these those use uses using used run runs running keep keeps add adds remove removes set sets switch switches migrate migrates move moves deploy deploys store stores support supports choose chooses adopt adopts go goes'.split(
    ' ',
  ),
);

function contentTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((token) => token.length >= 3 && !SHARED_STOPWORDS.has(token)),
  );
}

/**
 * A conflict needs a contradiction, not just a shared topic. Two decisions
 * about the same subject are complementary unless they name values the other
 * side does not: both sides must carry at least one distinct value for the
 * same subject ("PostgreSQL" vs "MongoDB", "15" vs "16"), or one negates what
 * the other asserts. A decision that only adds to another ("Use PostgreSQL"
 * and "Use PostgreSQL with read replicas") is complementary.
 */
export function hasContradiction(left, right) {
  if ((left.flags || []).includes('contradicts') || (right.flags || []).includes('contradicts')) {
    return true;
  }
  if (left.statementKey && left.statementKey === right.statementKey) return false;

  const leftValues = new Set(valueTokens(left.statement));
  const rightValues = new Set(valueTokens(right.statement));
  if (leftValues.size > 0 && rightValues.size > 0) {
    const leftOnly = [...leftValues].some((token) => !rightValues.has(token));
    const rightOnly = [...rightValues].some((token) => !leftValues.has(token));
    if (leftOnly && rightOnly) return true;
  }

  if (NEGATION_RE.test(left.statement) !== NEGATION_RE.test(right.statement)) {
    const leftContent = contentTokens(left.statement);
    const rightContent = contentTokens(right.statement);
    return [...leftContent].some((token) => rightContent.has(token));
  }
  return false;
}

/**
 * Marks older decisions on the same topic as superseded when a later,
 * explicitly superseding decision exists, within the same visibility audience.
 * Recomputes from scratch on every run: restoring first means deleting or
 * editing the newer decision brings the older one back, and a restricted
 * source can never hide a decision from people who cannot read it.
 */
export async function linkSupersessions(projectId) {
  const [claims, sources] = await Promise.all([
    Claim.find({ project: projectId, type: 'decision', retiredAt: null }),
    Source.find({ project: projectId }).select('visibility sensitivity deletedAt hiddenAt').lean(),
  ]);
  const sourceById = new Map(sources.map((source) => [String(source._id), source]));

  // 1. Undo the previous automatic pass. Reviewer resolutions are left alone.
  const restoredIds = new Set();
  for (const claim of claims) {
    const flags = claim.flags || [];
    if (!flags.includes(AUTO_SUPERSEDE_FLAG) || flags.includes(REVIEWER_SUPERSEDE_FLAG)) continue;
    claim.status = claim.supersededPriorStatus || 'active';
    claim.supersededBy = undefined;
    claim.supersededPriorStatus = undefined;
    claim.flags = flags.filter((flag) => flag !== AUTO_SUPERSEDE_FLAG);
    await claim.save();
    restoredIds.add(String(claim._id));
  }
  for (const claim of claims) {
    if (!claim.supersededBy) continue;
    if (!restoredIds.has(String(claim.supersededBy))) continue;
    if ((claim.flags || []).includes(REVIEWER_SUPERSEDE_FLAG)) continue;
    claim.supersededBy = undefined;
    await claim.save();
  }

  const audienceOf = (claim) => {
    const source = sourceById.get(String(claim.source));
    if (!source || source.deletedAt || source.hiddenAt) return null;
    const visibility = source.visibility || {};
    const roles = [...(visibility.roles || [])].sort();
    const users = [...(visibility.users || [])].sort();
    return [
      visibility.scope || 'project',
      roles.join(','),
      users.join(','),
      source.sensitivity || 'internal',
    ].join('|');
  };

  const byAudience = new Map();
  for (const claim of claims) {
    if (!claim.occurredAt || claim.hasSourceDate === false) continue;
    if (claim.status === 'superseded') continue;
    const flags = claim.flags || [];
    if (flags.includes(REVIEWER_SUPERSEDE_FLAG) || flags.includes('reviewer_confirmed_current')) {
      continue;
    }
    const audience = audienceOf(claim);
    if (!audience) continue;
    if (!byAudience.has(audience)) byAudience.set(audience, []);
    byAudience.get(audience).push(claim);
  }

  let applied = 0;
  for (const audienceClaims of byAudience.values()) {
    for (const group of groupDecisionTopics(audienceClaims)) {
      if (group.claims.length < 2) continue;
      const sorted = [...group.claims].sort(
        (a, b) => timeOf(a) - timeOf(b) || String(a._id).localeCompare(String(b._id)),
      );
      for (let index = 0; index < sorted.length; index += 1) {
        const claim = sorted[index];
        if (claim.status === 'superseded') continue;
        const newer = sorted
          .slice(index + 1)
          .find((candidate) => (candidate.flags || []).includes('explicit_supersession'));
        if (!newer || timeOf(newer) <= timeOf(claim)) continue;
        claim.supersededPriorStatus = claim.status;
        claim.status = 'superseded';
        claim.supersededBy = newer._id;
        claim.flags = [...new Set([...(claim.flags || []), AUTO_SUPERSEDE_FLAG])];
        await claim.save();
        applied += 1;
      }
    }
  }
  return applied;
}

/**
 * Groups active decisions into topics and keeps only the components that
 * actually contradict. Uses the same deterministic grouping as supersession so
 * the two views agree about what belongs together.
 */
export function findSupersededPairs(claims) {
  const pairs = [];
  for (const group of groupDecisionTopics(claims)) {
    const members = [...group.claims].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    if (members.length < 2) continue;

    const parent = members.map((_, index) => index);
    const find = (index) => {
      let root = index;
      while (parent[root] !== root) root = parent[root];
      while (parent[index] !== root) {
        const next = parent[index];
        parent[index] = root;
        index = next;
      }
      return root;
    };
    const union = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) {
        parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
      }
    };
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        if (hasContradiction(members[i], members[j])) union(i, j);
      }
    }

    const components = new Map();
    members.forEach((claim, index) => {
      const root = find(index);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(claim);
    });
    for (const component of components.values()) {
      if (component.length < 2) continue;
      pairs.push({
        topicKey: group.topicKey,
        topic: group.topic,
        claims: component,
        possible: group.fuzzy,
      });
    }
  }
  return pairs.sort((a, b) => {
    const keyOrder = a.topicKey.localeCompare(b.topicKey);
    if (keyOrder !== 0) return keyOrder;
    return String(a.claims[0]._id).localeCompare(String(b.claims[0]._id));
  });
}
