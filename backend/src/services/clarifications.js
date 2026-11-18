import { createHash } from 'node:crypto';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { redactText } from '../lib/redaction.js';
import { keyOf, truncate } from '../lib/text.js';
import {
  Claim,
  Clarification,
  Document,
  Evidence,
  Project,
  Source,
  User,
} from '../models/index.js';
import { recordAudit } from './audit.js';
import { deliverOutbound } from './delivery.js';
import { leadIds, notify } from './notifications.js';
import { buildStateForUser, loadVisibleClaims } from './projectState.js';

const ANSWER_MAX = 1200;

export function serializeClarification(clarification, extras = {}) {
  const data =
    typeof clarification.toObject === 'function' ? clarification.toObject() : clarification;
  return {
    id: String(data._id),
    projectId: String(data.project),
    projectName: extras.projectName,
    claimId: data.claim ? String(data.claim) : null,
    kind: data.kind,
    prompt: data.prompt,
    status: data.status,
    askedBy: data.askedBy ? String(data.askedBy) : null,
    askedByName: data.askedByName || null,
    askedOf: data.askedOf ? String(data.askedOf) : null,
    askedOfName: data.askedOfName || null,
    answerOptions: data.answerOptions || [],
    answer: data.answer || null,
    answeredAt: data.answeredAt || null,
    declinedAt: data.declinedAt || null,
    declineNote: data.declineNote || null,
    resultClaimId: data.resultClaim ? String(data.resultClaim) : null,
    createdAt: data.createdAt,
  };
}

async function loadOutgoingMember(project) {
  const id = project.transition?.outgoingUserId;
  if (!id) return null;
  const user = await User.findById(id);
  if (!user) return null;
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    fallbackName: project.transition?.outgoingName || user.name,
  };
}

async function loadMembers(project) {
  const ids = (project.members || []).map((member) => member.user?._id ?? member.user);
  const users = await User.find({ _id: { $in: ids } }).select('name email').lean();
  const byId = new Map(users.map((user) => [String(user._id), user]));
  return (project.members || [])
    .map((member) => {
      const user = byId.get(String(member.user?._id ?? member.user));
      return user ? { id: user._id, name: user.name, email: user.email, role: member.role } : null;
    })
    .filter(Boolean);
}

function ownerOptions(project, members, outgoingId) {
  return members
    .filter((member) => String(member.id) !== String(outgoingId))
    .map((member) => member.name);
}

function promptForOwner(claim, outgoingName) {
  const subject = truncate(claim.statement, 160);
  return `Who owns "${subject}" after ${outgoingName} leaves?`;
}

function promptForConflict(conflictEntry) {
  return `Which decision is current for "${conflictEntry.topic}"? Only a departing member can settle the disagreement.`;
}

export async function buildClarificationCandidates({ project, actor }) {
  const outgoing = await loadOutgoingMember(project);
  if (!outgoing) {
    return {
      outgoing: null,
      canAsk: false,
      reason: 'No departing member is recorded for this project',
      candidates: [],
    };
  }

  const [members, leadState, outgoingView, openClarifications] = await Promise.all([
    loadMembers(project),
    buildStateForUser({ project, userId: actor._id }),
    loadVisibleClaims({ project, userId: outgoing.id }),
    Clarification.find({ project: project._id, status: 'open' }).lean(),
  ]);

  const outgoingCanRead = new Set(outgoingView.claims.map((claim) => String(claim._id)));
  const openByClaim = new Map(
    openClarifications
      .filter((entry) => entry.claim)
      .map((entry) => [String(entry.claim), entry]),
  );

  const base = (claim) => ({
    claimId: String(claim.id),
    claim: {
      id: String(claim.id),
      type: claim.type,
      statement: claim.statement,
      topic: claim.topic,
      status: claim.status,
      ownerName: claim.ownerName || null,
    },
    askable: outgoingCanRead.has(String(claim.id)),
    unaskableReason: outgoingCanRead.has(String(claim.id))
      ? null
      : 'outgoing_member_lacks_access',
    clarificationId: openByClaim.has(String(claim.id))
      ? String(openByClaim.get(String(claim.id))._id)
      : null,
  });

  const candidates = [];

  for (const claim of leadState.state.ownershipGaps) {
    candidates.push({
      ...base(claim),
      id: `missing_owner:${claim.id}`,
      kind: 'missing_owner',
      prompt: promptForOwner(claim, outgoing.fallbackName),
      answerOptions: ownerOptions(project, members, outgoing.id),
    });
  }

  for (const entry of leadState.state.conflicts) {
    const claimIds = entry.claimIds.map(String);
    const representative = entry.statements[0];
    const readable = claimIds.every((id) => outgoingCanRead.has(id));
    const existing = openClarifications.find(
      (item) =>
        item.kind === 'conflict' &&
        claimIds.includes(String(item.claim)) &&
        item.status === 'open',
    );
    candidates.push({
      id: `conflict:${claimIds[0]}`,
      kind: 'conflict',
      claimId: claimIds[0],
      claim: representative
        ? {
            id: String(representative.claimId),
            type: 'decision',
            statement: representative.statement,
            topic: entry.topic,
            status: 'active',
            ownerName: null,
          }
        : null,
      topic: entry.topic,
      statements: entry.statements.map((statement) => ({
        claimId: String(statement.claimId),
        statement: statement.statement,
      })),
      prompt: promptForConflict(entry),
      answerOptions: entry.statements.map((statement) => statement.statement),
      askable: readable,
      unaskableReason: readable ? null : 'outgoing_member_lacks_access',
      clarificationId: existing ? String(existing._id) : null,
      possible: Boolean(entry.possible),
    });
  }

  for (const claim of leadState.state.openQuestions) {
    candidates.push({
      ...base(claim),
      id: `open_question:${claim.id}`,
      kind: 'open_question',
      prompt: claim.statement,
      answerOptions: [],
    });
  }

  return {
    outgoing: { id: String(outgoing.id), name: outgoing.name },
    canAsk: candidates.some((candidate) => candidate.askable),
    members: members.map((member) => ({ id: String(member.id), name: member.name })),
    candidates,
  };
}

function candidateKey(kind, claimId) {
  return `${kind}:${claimId}`;
}

async function createClarificationRecord({ project, actor, outgoing, candidate, prompt }) {
  const record = await Clarification.create({
    project: project._id,
    claim: candidate.claimId,
    kind: candidate.kind,
    prompt: String(prompt || candidate.prompt).trim().slice(0, 500),
    status: 'open',
    askedBy: actor._id,
    askedByName: actor.name,
    askedOf: outgoing.id,
    askedOfName: outgoing.name,
    answerOptions: (candidate.answerOptions || []).slice(0, 20),
  });

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'clarification.asked',
    targetType: 'clarification',
    targetId: record._id,
    targetLabel: truncate(record.prompt, 120),
    meta: {
      kind: candidate.kind,
      claimId: String(candidate.claimId),
      askedOf: String(outgoing.id),
      askedOfName: outgoing.name,
    },
  });

  await notify({
    project,
    recipients: [outgoing.id],
    type: 'clarification.asked',
    entityType: 'clarification',
    entityId: record._id,
    actor,
  });

  await deliverOutbound({
    projectId: project._id,
    clarificationId: record._id,
    kind: 'clarification.asked',
    text: `A question about ${project.name} is waiting for ${outgoing.name || 'the departing member'} in Threadline.`,
    createdBy: actor._id,
  });

  return serializeClarification(record);
}

export async function askClarifications({
  project,
  actor,
  claimIds = [],
  askForAll = false,
  prompt,
}) {
  const { outgoing, candidates } = await buildClarificationCandidates({ project, actor });
  if (!outgoing) {
    throw new AppError(422, 'no_outgoing_member', 'No departing member is recorded for this project');
  }

  const byClaim = new Map();
  for (const candidate of candidates) {
    if (!candidate.claimId) continue;
    const key = candidateKey(candidate.kind, candidate.claimId);
    byClaim.set(key, candidate);
    byClaim.set(candidate.claimId, byClaim.get(candidate.claimId) || candidate);
  }

  const created = [];
  const skipped = [];

  if (askForAll) {
    for (const candidate of candidates) {
      if (!candidate.claimId) continue;
      if (candidate.clarificationId) {
        skipped.push({ id: candidate.id, reason: 'already_open' });
        continue;
      }
      if (!candidate.askable) {
        skipped.push({ id: candidate.id, reason: 'outgoing_member_lacks_access' });
        continue;
      }
      created.push(
        await createClarificationRecord({ project, actor, outgoing, candidate }),
      );
    }
    return { outgoing, clarifications: created, skipped };
  }

  const requested = [...new Set(claimIds.map(String))];
  if (requested.length === 0) {
    throw badRequest('Choose at least one gap to ask about');
  }
  if (prompt && requested.length > 1) {
    throw badRequest('A custom prompt can only be used when asking about a single item');
  }

  const selected = [];
  for (const claimId of requested) {
    const candidate = byClaim.get(claimId);
    if (!candidate) {
      throw new AppError(422, 'not_a_gap', 'The selected item is not an ownership gap, conflict or open question');
    }
    if (!candidate.askable) {
      throw forbidden(
        'The departing member cannot read this item, so they cannot be asked about it',
        { claimId, reason: 'outgoing_member_lacks_access' },
      );
    }
    if (candidate.clarificationId) {
      throw conflict('A question about this item is already open');
    }
    selected.push(candidate);
  }

  for (const candidate of selected) {
    created.push(
      await createClarificationRecord({ project, actor, outgoing, candidate, prompt }),
    );
  }
  return { outgoing, clarifications: created, skipped };
}

function sanitizeAnswer(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ANSWER_MAX);
}

function resolveOwner(answer, members, outgoingId) {
  const needle = answer.trim().toLowerCase();
  const eligible = members.filter((member) => String(member.id) !== String(outgoingId));
  const exact = eligible.filter(
    (member) =>
      member.name.toLowerCase() === needle || member.email.toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0];
  const firstNames = eligible.filter(
    (member) => member.name.split(/\s+/)[0]?.toLowerCase() === needle,
  );
  if (firstNames.length === 1) return firstNames[0];
  const partial = eligible.filter(
    (member) =>
      member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle),
  );
  if (partial.length === 1) return partial[0];
  return null;
}

function checksumOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function createConfirmation({
  project,
  clarification,
  actor,
  answer,
  type,
  statement,
  topic,
}) {
  const now = new Date();
  const leads = (project.members || [])
    .filter((member) => member.role === 'lead')
    .map((member) => String(member.user?._id ?? member.user));
  const users = [...new Set([String(actor._id), ...leads])];

  const source = await Source.create({
    project: project._id,
    kind: 'confirmation',
    name: `Confirmed answer: ${truncate(clarification.prompt, 90)}`,
    externalRef: String(clarification._id),
    visibility: { scope: 'users', roles: [], users },
    sensitivity: 'internal',
    status: 'ready',
    createdBy: clarification.askedBy,
    lastIngestedAt: now,
    stats: { documents: 1, claims: 1, unverifiedClaims: 0 },
  });

  const document = await Document.create({
    project: project._id,
    source: source._id,
    kind: 'confirmation',
    title: `Answer from ${actor.name}`,
    path: `clarification-${clarification._id}`,
    mime: 'text/plain',
    size: answer.length,
    checksum: checksumOf(answer),
    author: actor.name,
    occurredAt: now,
    locator: { externalId: String(clarification._id) },
    rawText: answer,
    chunks: [
      {
        index: 0,
        text: answer,
        start: 0,
        end: answer.length,
      },
    ],
    revision: 1,
    parseWarnings: [],
    meta: { clarificationId: String(clarification._id), personConfirmed: true },
  });

  const resultClaim = await Claim.create({
    project: project._id,
    source: source._id,
    document: document._id,
    type,
    statement: truncate(statement, 800),
    statementKey: keyOf(statement),
    topic: truncate(topic || '', 160),
    topicKey: keyOf(topic || ''),
    status: 'active',
    state: 'confirmed',
    confidence: 1,
    sensitivity: 'internal',
    origin: 'person_confirmed',
    confirmedBy: actor._id,
    confirmedByName: actor.name,
    confirmedAt: now,
    occurredAt: now,
    hasSourceDate: true,
    evidenceCount: 1,
    verifiedEvidenceCount: 0,
    flags: ['person_confirmed'],
    extraction: { method: 'heuristic', model: 'person-confirmation' },
  });

  await Evidence.create({
    project: project._id,
    claim: resultClaim._id,
    source: source._id,
    document: document._id,
    chunkId: document.chunks[0]?._id,
    quote: answer,
    charStart: 0,
    charEnd: answer.length,
    locale: { path: document.path, title: document.title },
    validation: 'person_confirmed',
    confirmedBy: actor._id,
    confirmedByName: actor.name,
    confirmedAt: now,
    answerRef: clarification._id,
  });

  return { source, document, resultClaim };
}

async function loadProjectForClarification(clarification) {
  const project = await Project.findById(clarification.project);
  if (!project) throw notFound('Project not found');
  return project;
}

export async function answerClarification({ clarificationId, actor, answer, req }) {
  const clarification = await Clarification.findById(clarificationId);
  if (!clarification) throw notFound('Clarification not found');

  if (String(clarification.askedOf) !== String(actor._id)) {
    throw forbidden('Only the person this question was addressed to can answer it');
  }
  if (clarification.status !== 'open') {
    throw conflict(`This question is already ${clarification.status}`);
  }

  const project = await loadProjectForClarification(clarification);
  const safeAnswer = sanitizeAnswer(answer);
  if (!safeAnswer) throw badRequest('An answer is required');

  const claim = clarification.claim
    ? await Claim.findOne({
        _id: clarification.claim,
        project: project._id,
        retiredAt: null,
      })
    : null;
  if (!claim) throw notFound('The item this question refers to no longer exists');

  let created;
  if (clarification.kind === 'missing_owner') {
    const members = await loadMembers(project);
    const owner = resolveOwner(safeAnswer, members, clarification.askedOf);
    if (!owner) {
      throw badRequest('Choose one of the project members listed for this question', {
        options: ownerOptions(project, members, clarification.askedOf),
      });
    }
    claim.ownerName = owner.name;
    claim.ownerUser = owner.id;
    await claim.save();

    await recordAudit({
      projectId: project._id,
      actor,
      action: 'claim.owner_assigned',
      targetType: 'claim',
      targetId: claim._id,
      targetLabel: claim.statement.slice(0, 120),
      meta: { ownerName: owner.name, via: 'clarification', clarificationId: String(clarification._id) },
      req,
    });

    created = await createConfirmation({
      project,
      clarification,
      actor,
      answer: safeAnswer,
      type: 'responsibility',
      statement: `${owner.name} owns ${claim.statement}`,
      topic: claim.topic || claim.statement,
    });
  } else if (clarification.kind === 'conflict') {
    created = await createConfirmation({
      project,
      clarification,
      actor,
      answer: safeAnswer,
      type: 'decision',
      statement: safeAnswer,
      topic: claim.topic || claim.statement,
    });

    await recordAudit({
      projectId: project._id,
      actor,
      action: 'claim.conflict_answer_received',
      targetType: 'claim',
      targetId: claim._id,
      targetLabel: `Conflict answer: ${truncate(claim.topic || claim.statement, 100)}`,
      meta: { clarificationId: String(clarification._id), answer: truncate(safeAnswer, 200) },
      req,
    });
  } else {
    claim.status = 'resolved';
    claim.resolution = {
      note: safeAnswer,
      by: actor._id,
      byName: actor.name,
      at: new Date(),
    };
    claim.flags = [...new Set([...(claim.flags || []), 'answered_by_clarification'])];
    await claim.save();

    await recordAudit({
      projectId: project._id,
      actor,
      action: 'claim.resolved',
      targetType: 'claim',
      targetId: claim._id,
      targetLabel: claim.statement.slice(0, 120),
      meta: { status: 'resolved', via: 'clarification', clarificationId: String(clarification._id) },
      req,
    });

    created = await createConfirmation({
      project,
      clarification,
      actor,
      answer: safeAnswer,
      type: 'decision',
      statement: `${claim.statement} — ${safeAnswer}`,
      topic: claim.topic || claim.statement,
    });
  }

  clarification.status = 'answered';
  clarification.answer = redactText(safeAnswer).text;
  clarification.answeredAt = new Date();
  clarification.resultClaim = created.resultClaim._id;
  await clarification.save();

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'clarification.answered',
    targetType: 'clarification',
    targetId: clarification._id,
    targetLabel: truncate(clarification.prompt, 120),
    meta: {
      kind: clarification.kind,
      claimId: String(claim._id),
      resultClaimId: String(created.resultClaim._id),
    },
    req,
  });

  await notify({
    project,
    recipients: [clarification.askedBy, ...leadIds(project)],
    type: 'clarification.answered',
    entityType: 'clarification',
    entityId: clarification._id,
    actor,
  });

  return {
    clarification: serializeClarification(clarification),
    resultClaimId: String(created.resultClaim._id),
    sourceId: String(created.source._id),
  };
}

export async function declineClarification({ clarificationId, actor, note, req }) {
  const clarification = await Clarification.findById(clarificationId);
  if (!clarification) throw notFound('Clarification not found');

  if (String(clarification.askedOf) !== String(actor._id)) {
    throw forbidden('Only the person this question was addressed to can decline it');
  }
  if (clarification.status !== 'open') {
    throw conflict(`This question is already ${clarification.status}`);
  }

  const project = await loadProjectForClarification(clarification);
  const safeNote = redactText(String(note || '').trim().slice(0, 600)).text;

  clarification.status = 'declined';
  clarification.declinedAt = new Date();
  clarification.declineNote = safeNote || undefined;
  await clarification.save();

  const claim = clarification.claim
    ? await Claim.findOne({ _id: clarification.claim, project: project._id, retiredAt: null })
    : null;
  if (claim) {
    claim.flags = [...new Set([...(claim.flags || []), 'clarification_declined'])];
    await claim.save();
  }

  await recordAudit({
    projectId: project._id,
    actor,
    action: 'clarification.declined',
    targetType: 'clarification',
    targetId: clarification._id,
    targetLabel: truncate(clarification.prompt, 120),
    meta: {
      kind: clarification.kind,
      claimId: clarification.claim ? String(clarification.claim) : null,
      note: safeNote || null,
    },
    req,
  });

  await notify({
    project,
    recipients: [clarification.askedBy, ...leadIds(project)],
    type: 'clarification.declined',
    entityType: 'clarification',
    entityId: clarification._id,
    actor,
  });

  return { clarification: serializeClarification(clarification) };
}

export async function listMyClarifications({ user, status }) {
  const projects = await Project.find({ 'members.user': user._id }).select('_id name').lean();
  const projectIds = projects.map((project) => project._id);
  const nameById = new Map(projects.map((project) => [String(project._id), project.name]));

  const query = { askedOf: user._id, project: { $in: projectIds } };
  if (status) query.status = status;

  const records = await Clarification.find(query).sort({ createdAt: -1 }).limit(100).lean();
  const claimIds = records.filter((record) => record.claim).map((record) => record.claim);
  const claims = await Claim.find({ _id: { $in: claimIds } })
    .select('type statement topic status ownerName')
    .lean();
  const claimById = new Map(claims.map((claim) => [String(claim._id), claim]));

  return records.map((record) => {
    const claim = record.claim ? claimById.get(String(record.claim)) : null;
    return {
      ...serializeClarification(record, { projectName: nameById.get(String(record.project)) }),
      claim: claim
        ? {
            id: String(claim._id),
            type: claim.type,
            statement: claim.statement,
            topic: claim.topic,
            status: claim.status,
            ownerName: claim.ownerName || null,
          }
        : null,
    };
  });
}

export async function listProjectClarifications({ project }) {
  const records = await Clarification.find({ project: project._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return records.map((record) => serializeClarification(record, { projectName: project.name }));
}
