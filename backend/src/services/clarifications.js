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
import { canContribute } from './access/policy.js';
import { recordAudit } from './audit.js';
import { deliverOutbound } from './delivery.js';
import { leadIds, notify } from './notifications.js';
import { buildStateForUser, loadVisibleClaims } from './projectState.js';

const ANSWER_MAX = 1200;
const RESTRICTED_LABEL = 'Restricted item';

export function serializeClarification(clarification, extras = {}) {
  const data =
    typeof clarification.toObject === 'function' ? clarification.toObject() : clarification;
  const base = {
    id: String(data._id),
    projectId: String(data.project),
    projectName: extras.projectName,
    kind: data.kind,
    status: data.status,
    askedBy: data.askedBy ? String(data.askedBy) : null,
    askedByName: data.askedByName || null,
    askedOf: data.askedOf ? String(data.askedOf) : null,
    askedOfName: data.askedOfName || null,
    createdAt: data.createdAt,
  };

  // The prompt, conflict options and answer quote the underlying claim. When
  // the viewer may no longer read that claim's evidence they get a stub, not
  // the text that used to accompany it.
  if (extras.restricted) {
    return {
      ...base,
      claimId: null,
      prompt: RESTRICTED_LABEL,
      answerOptions: [],
      answer: null,
      answeredAt: data.answeredAt || null,
      declinedAt: data.declinedAt || null,
      declineNote: null,
      resultClaimId: null,
      restricted: true,
    };
  }

  return {
    ...base,
    claimId: data.claim ? String(data.claim) : null,
    prompt: data.prompt,
    answerOptions: data.answerOptions || [],
    answer: data.answer || null,
    answeredAt: data.answeredAt || null,
    declinedAt: data.declinedAt || null,
    declineNote: data.declineNote || null,
    resultClaimId: data.resultClaim ? String(data.resultClaim) : null,
    restricted: false,
  };
}

async function visibleClaimIds({ project, userId, claimIds }) {
  const requested = new Set(claimIds.filter(Boolean).map(String));
  if (requested.size === 0) return requested;
  const { claims } = await loadVisibleClaims({ project, userId });
  return new Set(
    claims.map((claim) => String(claim._id)).filter((id) => requested.has(id)),
  );
}

function isRestricted(record, visibleIds) {
  return Boolean(record.claim) && !visibleIds.has(String(record.claim));
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
  // The offered names must be the same set the answer is checked against:
  // only leads and contributors can take on ownership.
  return members
    .filter(
      (member) =>
        String(member.id) !== String(outgoingId) &&
        ['lead', 'contributor'].includes(member.role),
    )
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
    critical: true,
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
  // Answers are stored and displayed as plain text; React escapes on render.
  // Stripping angle brackets used to mangle legitimate text such as
  // "x < y and y > z", so only whitespace is normalised and the length capped.
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ANSWER_MAX);
}

function resolveOwner(answer, members, outgoingId) {
  const needle = answer.trim().toLowerCase();
  // Only people who can actually act on the work may own it: leads and
  // contributors. An observer assigned a task would be stuck with it.
  const eligible = members.filter(
    (member) =>
      String(member.id) !== String(outgoingId) &&
      ['lead', 'contributor'].includes(member.role),
  );
  const exact = eligible.filter(
    (member) =>
      member.name.toLowerCase() === needle || member.email.toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0];
  // A unique first name is an intentional shorthand. Substring matching was
  // not: typing "an" could silently pick any one name containing it.
  const firstNames = eligible.filter(
    (member) => member.name.split(/\s+/)[0]?.toLowerCase() === needle,
  );
  if (firstNames.length === 1) return firstNames[0];
  return null;
}

function checksumOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function deleteConfirmation(created) {
  if (!created) return;
  await Evidence.deleteMany({ claim: created.resultClaim._id }).catch(() => {});
  await Claim.deleteOne({ _id: created.resultClaim._id }).catch(() => {});
  await Document.deleteOne({ _id: created.document._id }).catch(() => {});
  await Source.deleteOne({ _id: created.source._id }).catch(() => {});
}

async function createConfirmation({
  project,
  clarification,
  actor,
  answer,
  type,
  statement,
  context,
  topic,
  ownerName,
  ownerUserId,
}) {
  const now = new Date();
  const leads = (project.members || [])
    .filter((member) => member.role === 'lead')
    .map((member) => String(member.user?._id ?? member.user));
  const users = [...new Set([String(actor._id), ...leads])];

  let source;
  let document;
  let resultClaim;
  try {
    source = await Source.create({
      project: project._id,
      kind: 'confirmation',
      // The source name is shown to every lead. It must not repeat the
      // question, which may quote a claim restricted to other people.
      name: 'Confirmed answer',
      externalRef: String(clarification._id),
      visibility: { scope: 'users', roles: [], users },
      sensitivity: 'internal',
      status: 'ready',
      createdBy: clarification.askedBy,
      lastIngestedAt: now,
      stats: { documents: 1, claims: 1, unverifiedClaims: 0 },
    });

    document = await Document.create({
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

    resultClaim = await Claim.create({
      project: project._id,
      source: source._id,
      document: document._id,
      type,
      // The answer is the statement; the question it settles is context with
      // its own field and its own limit, so a long question can never cut the
      // answer in half.
      statement: truncate(statement, ANSWER_MAX),
      context: context ? truncate(context, 2000) : undefined,
      statementKey: keyOf(statement),
      topic: truncate(topic || '', 160),
      topicKey: keyOf(topic || ''),
      status: 'active',
      state: 'confirmed',
      confidence: 1,
      sensitivity: 'internal',
      ownerName,
      ownerUser: ownerUserId,
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
  } catch (error) {
    // A half-written confirmation would otherwise survive the failed answer
    // and pollute the project's claims.
    if (resultClaim && source && document) {
      await deleteConfirmation({ source, document, resultClaim });
    } else {
      if (resultClaim) await Claim.deleteOne({ _id: resultClaim._id }).catch(() => {});
      if (document) await Document.deleteOne({ _id: document._id }).catch(() => {});
      if (source) await Source.deleteOne({ _id: source._id }).catch(() => {});
    }
    throw error;
  }
}

async function loadProjectForClarification(clarification) {
  const project = await Project.findById(clarification.project);
  if (!project) throw notFound('Project not found');
  return project;
}

function restoreClaimState(claimId, previous) {
  const $set = { status: previous.status };
  const $unset = {};
  for (const field of ['ownerName', 'ownerUser', 'resolution', 'flags']) {
    if (previous[field] === undefined) $unset[field] = '';
    else $set[field] = previous[field];
  }
  const update = { $set };
  if (Object.keys($unset).length > 0) update.$unset = $unset;
  return Claim.updateOne({ _id: claimId }, update);
}

async function releaseClarification(clarificationId) {
  await Clarification.updateOne(
    { _id: clarificationId, status: 'answering' },
    { $set: { status: 'open' } },
  ).catch(() => {});
}

export async function answerClarification({ clarificationId, actor, answer, req }) {
  const existing = await Clarification.findById(clarificationId);
  if (!existing) throw notFound('Clarification not found');

  if (String(existing.askedOf) !== String(actor._id)) {
    throw forbidden('Only the person this question was addressed to can answer it');
  }

  const project = await loadProjectForClarification(existing);
  // A member removed (or demoted to observer) since the question was asked
  // must not keep writing into the project.
  if (!canContribute(project, actor)) {
    throw forbidden('Only current contributors can answer this question');
  }
  if (existing.status !== 'open') {
    throw conflict(`This question is already ${existing.status}`);
  }

  const safeAnswer = sanitizeAnswer(answer);
  if (!safeAnswer) throw badRequest('An answer is required');

  // Atomically move the question out of "open" before any dependent write, so
  // a double submission cannot create two confirmations or orphan records.
  const clarification = await Clarification.findOneAndUpdate(
    { _id: existing._id, status: 'open' },
    { $set: { status: 'answering' } },
    { new: true },
  );
  if (!clarification) {
    throw conflict('This question has already been answered or declined');
  }

  let claim = null;
  let previousClaim = null;
  let created = null;

  try {
    claim = clarification.claim
      ? await Claim.findOne({
          _id: clarification.claim,
          project: project._id,
          retiredAt: null,
        })
      : null;
    if (!claim) throw notFound('The item this question refers to no longer exists');

    // Access may have been revoked between asking and answering.
    const readable = await visibleClaimIds({
      project,
      userId: actor._id,
      claimIds: [claim._id],
    });
    if (!readable.has(String(claim._id))) {
      throw forbidden('You can no longer read the item this question refers to');
    }

    previousClaim = {
      ownerName: claim.ownerName,
      ownerUser: claim.ownerUser,
      status: claim.status,
      resolution: claim.resolution,
      flags: claim.flags,
    };

    if (clarification.kind === 'missing_owner') {
      const members = await loadMembers(project);
      const owner = resolveOwner(safeAnswer, members, clarification.askedOf);
      if (!owner) {
        throw badRequest('Choose one of the project members listed for this question', {
          options: ownerOptions(project, members, clarification.askedOf),
        });
      }

      created = await createConfirmation({
        project,
        clarification,
        actor,
        answer: safeAnswer,
        type: 'responsibility',
        statement: `${owner.name} owns ${claim.statement}`,
        context: claim.statement,
        topic: claim.topic || claim.statement,
        ownerName: owner.name,
        ownerUserId: owner.id,
      });

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
        meta: {
          ownerName: owner.name,
          via: 'clarification',
          clarificationId: String(clarification._id),
        },
        req,
        critical: true,
      });
    } else if (clarification.kind === 'conflict') {
      created = await createConfirmation({
        project,
        clarification,
        actor,
        answer: safeAnswer,
        type: 'decision',
        statement: safeAnswer,
        context: claim.statement,
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
        critical: true,
      });
    } else {
      created = await createConfirmation({
        project,
        clarification,
        actor,
        answer: safeAnswer,
        type: 'decision',
        // Answer first. The question lives in context so it cannot crowd the
        // answer out of the statement limit.
        statement: safeAnswer,
        context: claim.statement,
        topic: claim.topic || claim.statement,
      });

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
        meta: {
          status: 'resolved',
          via: 'clarification',
          clarificationId: String(clarification._id),
        },
        req,
        critical: true,
      });
    }

    clarification.status = 'answered';
    clarification.answer = redactText(safeAnswer).text;
    clarification.answeredAt = new Date();
    clarification.resultClaim = created.resultClaim._id;
    await clarification.save();
  } catch (error) {
    // Leave no confirmation, no claim mutation and no stuck "answering" row
    // behind, so a retry starts from a clean open question.
    if (created) await deleteConfirmation(created);
    if (claim && previousClaim) {
      await restoreClaimState(claim._id, previousClaim).catch(() => {});
    }
    await releaseClarification(clarification._id);
    throw error;
  }

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
    critical: true,
  });

  await notify({
    project,
    recipients: [clarification.askedBy, ...leadIds(project)],
    type: 'clarification.answered',
    entityType: 'clarification',
    entityId: clarification._id,
    actor,
  });

  // A confirmed answer can change a claim's status and add a new person-
  // confirmed item, which makes released handovers older than the record.
  try {
    const { refreshOutdatedHandovers } = await import('./handover/workflow.js');
    await refreshOutdatedHandovers({ projectId: project._id, req });
  } catch {
    // Freshness refresh must never fail the answer itself.
  }

  return {
    clarification: serializeClarification(clarification),
    resultClaimId: String(created.resultClaim._id),
    sourceId: String(created.source._id),
  };
}

export async function declineClarification({ clarificationId, actor, note, req }) {
  const existing = await Clarification.findById(clarificationId);
  if (!existing) throw notFound('Clarification not found');

  if (String(existing.askedOf) !== String(actor._id)) {
    throw forbidden('Only the person this question was addressed to can decline it');
  }

  const project = await loadProjectForClarification(existing);
  if (!canContribute(project, actor)) {
    throw forbidden('Only current contributors can decline this question');
  }
  if (existing.status !== 'open') {
    throw conflict(`This question is already ${existing.status}`);
  }

  const safeNote = redactText(String(note || '').trim().slice(0, 600)).text;
  // Atomic with the answer path: exactly one of "answered" and "declined"
  // can win, even when both are submitted at once.
  const clarification = await Clarification.findOneAndUpdate(
    { _id: existing._id, status: 'open' },
    {
      $set: {
        status: 'declined',
        declinedAt: new Date(),
        ...(safeNote ? { declineNote: safeNote } : {}),
      },
    },
    { new: true },
  );
  if (!clarification) {
    throw conflict('This question has already been answered or declined');
  }

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
    critical: true,
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

/**
 * Called when a member is removed. Questions still waiting for them would
 * otherwise stay open forever, so they are closed and the asker is told.
 */
export async function closeOpenClarificationsForMember({ project, userId, actor, req }) {
  const open = await Clarification.find({
    project: project._id,
    askedOf: userId,
    status: 'open',
  });
  if (open.length === 0) return 0;

  await Clarification.updateMany(
    { _id: { $in: open.map((record) => record._id) }, status: 'open' },
    { $set: { status: 'closed' } },
  );

  for (const record of open) {
    await recordAudit({
      projectId: project._id,
      actor,
      action: 'clarification.closed',
      targetType: 'clarification',
      targetId: record._id,
      targetLabel: truncate(record.prompt, 120),
      meta: {
        kind: record.kind,
        claimId: record.claim ? String(record.claim) : null,
        reason: 'member_removed',
      },
      req,
      critical: true,
    });

    if (record.askedBy) {
      await notify({
        project,
        recipients: [record.askedBy],
        type: 'clarification.closed',
        entityType: 'clarification',
        entityId: record._id,
        actor,
      });
    }
  }
  return open.length;
}

export async function listMyClarifications({ user, status }) {
  const projects = await Project.find({ 'members.user': user._id }).lean();
  const projectIds = projects.map((project) => project._id);
  const projectById = new Map(projects.map((project) => [String(project._id), project]));

  const query = { askedOf: user._id, project: { $in: projectIds } };
  if (status) query.status = status;

  const records = await Clarification.find(query).sort({ createdAt: -1 }).limit(100).lean();
  const claimIds = records.filter((record) => record.claim).map((record) => record.claim);
  const claims = await Claim.find({ _id: { $in: claimIds } })
    .select('type statement topic status ownerName')
    .lean();
  const claimById = new Map(claims.map((claim) => [String(claim._id), claim]));

  // Access may have changed since the question was asked, so visibility is
  // evaluated now, once per project.
  const visibleByProject = new Map();
  for (const projectId of new Set(records.map((record) => String(record.project)))) {
    const project = projectById.get(projectId);
    if (!project) continue;
    const requested = records
      .filter((record) => String(record.project) === projectId && record.claim)
      .map((record) => record.claim);
    visibleByProject.set(
      projectId,
      await visibleClaimIds({ project, userId: user._id, claimIds: requested }),
    );
  }

  return records.map((record) => {
    const project = projectById.get(String(record.project));
    if (!project) return null;
    const restricted = isRestricted(
      record,
      visibleByProject.get(String(record.project)) || new Set(),
    );
    const claim = !restricted && record.claim ? claimById.get(String(record.claim)) : null;
    return {
      ...serializeClarification(record, { projectName: project.name, restricted }),
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
  }).filter(Boolean);
}

export async function listProjectClarifications({ project, viewer }) {
  const records = await Clarification.find({ project: project._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  if (!viewer) {
    throw forbidden('A viewer is required to read clarifications');
  }
  const visibleIds = await visibleClaimIds({
    project,
    userId: viewer._id,
    claimIds: records.filter((record) => record.claim).map((record) => record.claim),
  });
  return records.map((record) =>
    serializeClarification(record, {
      projectName: project.name,
      restricted: isRestricted(record, visibleIds),
    }),
  );
}
