import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  Claim,
  Clarification,
  Document,
  Evidence,
  Project,
  Source,
  User,
} from '../models/index.js';
import { enqueue, whenIdle } from '../services/queue.js';
import { hashPassword, issueSession } from '../services/auth.js';
import { parseFile } from '../services/ingest/parsers.js';

export const DEMO_PROJECT_KEY = 'ATLAS';

export const DEMO_USERS = [
  { key: 'subham', name: 'Subham Sahu', email: 'subham@threadline.demo', role: 'lead' },
  { key: 'rohan', name: 'Rohan Mehta', email: 'rohan@threadline.demo', role: 'contributor' },
  { key: 'ananya', name: 'Ananya Rao', email: 'ananya@threadline.demo', role: 'contributor', incoming: true },
  { key: 'vikram', name: 'Vikram Nair', email: 'vikram@threadline.demo', role: 'observer' },
];

// Seeded dates are relative to the day the workspace is created, so a demo
// that is seeded months from now still shows a believable mix of fresh,
// aging, overdue and upcoming items instead of everything being stale.
function dayIso(now, offsetDays) {
  const date = new Date(now);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function buildDemoDocuments({ now = new Date() } = {}) {
  const day = (offsetDays) => dayIso(now, offsetDays);
  return [
  {
    name: 'kickoff-notes.md',
    sensitivity: 'internal',
    visibility: { scope: 'project', roles: [], users: [] },
    content: `# Project Atlas - Kickoff notes

## Scope and goals
Decision: Move the billing ledger to a modular service so invoice generation can scale independently. (date: ${day(-92)}, status: active)
Milestone: Beta migration complete by ${day(26)}. (date: ${day(-92)}, status: planned)
Risk: The finance reconciliation job depends on an undocumented legacy stored procedure. (date: ${day(-92)}, status: open)
Dependency: The payments team must ship settlement webhook v2 before beta. (date: ${day(-92)}, status: open)

## Open items
Open question: Do we need to migrate invoices older than 24 months? (date: ${day(-92)}, status: open)
Task: Write the invoice data backfill script (owner: Rohan Mehta, due: ${day(1)}, status: open)
Task: Publish the migration runbook (status: open)
`,
  },
  {
    name: 'architecture-decisions.md',
    sensitivity: 'internal',
    visibility: { scope: 'project', roles: [], users: [] },
    content: `# Architecture decisions - Atlas

## Database choice
Decision: Use PostgreSQL for the new ledger tables. (date: ${day(-78)}, status: active)
Decision: Stay on MySQL for the ledger until the next quarter and revisit PostgreSQL after the beta; this supersedes the earlier PostgreSQL-only plan. (date: ${day(-30)}, status: active)
Risk: Dual-writing to MySQL and PostgreSQL will cause reconciliation drift during the transition. (date: ${day(-30)}, status: open)

## API versioning
Decision: Freeze the public invoice API at v1 for the beta. (date: ${day(-70)}, status: active)
Dependency: The mobile app team needs a stable invoice download endpoint until their next major release. (date: ${day(-70)}, status: open)
`,
  },
  {
    name: 'sprint-board.csv',
    sensitivity: 'internal',
    visibility: { scope: 'project', roles: [], users: [] },
    content: `type,title,owner,due,status
task,Write billing smoke tests,Ananya Rao,${day(-7)},open
task,Add ledger drift alerting,Sana,${day(-11)},open
task,Migrate invoice PDF templates,,${day(6)},open
task,Update on-call documentation,Rohan Mehta,${day(-20)},done
question,Who owns reconciliation alerting after the handover?,,,open
`,
  },
  {
    name: 'incident-review.md',
    sensitivity: 'internal',
    visibility: { scope: 'project', roles: [], users: [] },
    content: `# Incident review - API release window

## API versioning
Decision: Introduce v2 invoice endpoints before the beta. (date: ${day(-30)}, status: active)
Risk: The v2 change breaks invoice downloads in the current mobile client until a new app release ships. (date: ${day(-30)}, status: open)

## Reconciliation
Open question: Who owns the reconciliation drift alerting after Rohan leaves? (date: ${day(-30)}, status: open)
Task: Record a runbook walkthrough with Rohan before their last day (owner: Subham Sahu, due: ${day(-5)}, status: open)
`,
  },
  {
    name: 'handover-notes.txt',
    sensitivity: 'internal',
    visibility: { scope: 'roles', roles: ['lead', 'contributor'], users: [] },
    content: `# Rohan's handover notes

## Payment provider
Decision: Continue with Razorpay for the beta and review the enterprise contract after launch. (date: ${day(-29)}, status: active)
Dependency: Finance must approve the vendor contract before the beta launch. (date: ${day(-29)}, status: open)
Task: Send the vendor security questionnaire to finance (owner: Rohan Mehta, due: ${day(-4)}, status: open)
Task: Hand over the Grafana dashboard access (owner: Rohan Mehta, status: open)
`,
  },
  {
    name: 'vendor-contract-summary.md',
    sensitivity: 'confidential',
    visibility: { scope: 'roles', roles: ['lead'], users: [] },
    content: `# Vendor contract summary - restricted

## Vendor risk
Risk: The Razorpay enterprise contract auto-renews with a 22 percent price increase if it is not renegotiated before ${day(12)}. (date: ${day(-25)}, status: open)
Decision: Renegotiate the Razorpay contract before renewal instead of accepting auto-renewal. (date: ${day(-25)}, status: active)
Task: Prepare the negotiation brief for the CFO (owner: Subham Sahu, due: ${day(-1)}, status: open)
`,
  },
  ];
}

function mimeFor(name) {
  if (name.endsWith('.md')) return 'text/markdown';
  if (name.endsWith('.csv')) return 'text/csv';
  return 'text/plain';
}

async function ensureUser(definition, passwordHash, { rotate = false } = {}) {
  // A create-only seed never resets credentials that are in use. A reset is
  // lead-gated, and it rotates the demo accounts onto the new unknown password
  // so an old, published demo credential stops working.
  let user = await User.findOne({ email: definition.email });
  if (!user) {
    user = await User.create({
      email: definition.email,
      name: definition.name,
      passwordHash,
      isDemo: true,
      emailVerifiedAt: new Date(),
    });
  } else {
    const patch = {};
    if (rotate) patch.passwordHash = passwordHash;
    // Workspaces seeded before the flag existed carry ordinary accounts.
    if (!user.isDemo) patch.isDemo = true;
    // Demo personas are operated by the deployment; there is no mailbox to
    // confirm, and membership checks fail closed on this field.
    if (!user.emailVerifiedAt) patch.emailVerifiedAt = new Date();
    if (Object.keys(patch).length > 0) {
      await User.updateOne({ _id: user._id }, { $set: patch });
      user = await User.findById(user._id);
    }
  }
  return user;
}

function projectSummary(project) {
  return {
    id: String(project._id),
    key: project.key,
    name: project.name,
    description: project.description,
    isDemo: Boolean(project.isDemo),
  };
}

// Seeded dates move with the day the workspace was created, so text written
// by an earlier seed differs only in its dates. Compare date-blind.
function normalizeSeededText(text) {
  return String(text ?? '').replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>');
}

/**
 * Workspaces seeded before the `seeded` flag existed carry no marker. Match
 * their stored text against the documents this seed writes, so a reset can
 * adopt them without deleting a visitor upload that shares a filename.
 */
async function tagLegacySeededSources(project) {
  const legacy = await Source.find({ project: project._id, seeded: { $ne: true } }).select('_id');
  if (legacy.length === 0) return;

  const expected = new Set(
    await Promise.all(
      buildDemoDocuments().map(async (document) => {
        const parsed = await parseFile({
          buffer: Buffer.from(document.content, 'utf8'),
          filename: document.name,
        });
        return normalizeSeededText(parsed.text);
      }),
    ),
  );
  const documents = await Document.find({ source: { $in: legacy.map((source) => source._id) } })
    .select('source rawText')
    .lean();
  const matching = new Set();
  for (const document of documents) {
    if (expected.has(normalizeSeededText(document.rawText))) matching.add(String(document.source));
  }
  if (matching.size > 0) {
    await Source.updateMany({ _id: { $in: [...matching] } }, { $set: { seeded: true } });
  }
}

/**
 * The demo workspace is shared by every visitor, so a reset must restore the
 * seeded corpus without erasing work someone else uploaded. Only sources the
 * seed itself created are removed, together with their claims and evidence.
 */
async function removeSeededContent(project) {
  await tagLegacySeededSources(project);
  const seededSources = await Source.find({ project: project._id, seeded: true });
  if (seededSources.length === 0) return;

  const sourceIds = seededSources.map((source) => source._id);
  const seededClaims = await Claim.find({ project: project._id, source: { $in: sourceIds } })
    .select('_id')
    .lean();
  const claimIds = seededClaims.map((claim) => claim._id);

  await Evidence.deleteMany({ project: project._id, source: { $in: sourceIds } });
  await Clarification.deleteMany({ project: project._id, claim: { $in: claimIds } });
  await Claim.deleteMany({ project: project._id, source: { $in: sourceIds } });
  await Document.deleteMany({ project: project._id, source: { $in: sourceIds } });

  for (const source of seededSources) {
    for (const file of source.files || []) {
      await fs.rm(path.join(env.uploadDir, file.storedName), { force: true }).catch(() => {});
    }
  }
  await Source.deleteMany({ project: project._id, _id: { $in: sourceIds } });
}

async function removeStaleDemoUsers() {
  await User.deleteMany({
    email: { $regex: '@threadline\\.demo$', $nin: DEMO_USERS.map((user) => user.email) },
  });
}

async function writeDocument(file) {
  await fs.mkdir(env.uploadDir, { recursive: true });
  const extension = path.extname(file.name);
  const storedName = `${Date.now()}-${randomUUID()}${extension}`;
  const buffer = Buffer.from(file.content, 'utf8');
  await fs.writeFile(path.join(env.uploadDir, storedName), buffer);
  return {
    originalName: file.name,
    storedName,
    mime: mimeFor(file.name),
    size: buffer.length,
  };
}

export async function seedDemo({ reset = true } = {}) {
  const seedNow = new Date();
  const existing = await Project.findOne({ key: DEMO_PROJECT_KEY });

  // Strictly create-only. An existing workspace is returned untouched: its
  // members, owner, transition and account passwords belong to whoever
  // already uses them, and a real project that happens to be keyed ATLAS is
  // never adopted as the demo.
  if (existing && (!reset || !existing.isDemo)) {
    // A create-only seed does not touch an existing workspace, but the demo
    // accounts may still be the ones an earlier release created. Repair them
    // here too, so a deployment that never restarts is not left broken.
    const repairedUsers = existing.isDemo ? await repairDemoAccounts(existing) : 0;
    return {
      alreadySeeded: true,
      project: projectSummary(existing),
      repairedUsers,
      hint: existing.isDemo
        ? 'Pass reset=true to rebuild the seeded sources'
        : 'That project is not the demo workspace and was left untouched',
    };
  }

  // Demo accounts never have a published password: one random value per seed,
  // held only as a hash, is enough because sign-in goes through
  // POST /api/demo/session on deployments that enable demo mode.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  const users = {};
  for (const definition of DEMO_USERS) {
    users[definition.key] = await ensureUser(definition, passwordHash, {
      rotate: Boolean(existing),
    });
  }

  let project = existing;
  if (project) {
    await removeSeededContent(project);
    await removeStaleDemoUsers();
    // A reset months later must not leave the workspace on its original dates.
    project.startedAt = new Date(dayIso(seedNow, -92));
    project.targetDate = new Date(dayIso(seedNow, 26));
    await project.save();
  } else {
    const members = DEMO_USERS.map((definition) => ({
      user: users[definition.key]._id,
      role: definition.role,
      incoming: Boolean(definition.incoming),
    }));
    project = await Project.create({
      key: DEMO_PROJECT_KEY,
      name: 'Project Atlas - Billing Service Migration',
      description:
        'Migration of the billing ledger and invoice pipeline to a modular service. Used as the Threadline demo project.',
      isDemo: true,
      owner: users.subham._id,
      members,
      transition: {
        outgoingUserId: users.rohan._id,
        outgoingName: 'Rohan Mehta',
        plannedDepartureAt: new Date(Date.now() + 14 * 86_400_000),
        context:
          'Rohan is rotating off Atlas to lead the payments platform team. Ananya joins as their replacement in two weeks.',
      },
      startedAt: new Date(dayIso(seedNow, -92)),
      targetDate: new Date(dayIso(seedNow, 26)),
    });
  }

  const sourceIds = [];
  for (const document of buildDemoDocuments({ now: seedNow })) {
    const file = await writeDocument(document);
    const source = await Source.create({
      project: project._id,
      kind: 'upload',
      seeded: true,
      name: document.name,
      externalRef: '',
      visibility: document.visibility,
      sensitivity: document.sensitivity,
      createdBy: users.subham._id,
      status: 'queued',
      files: [file],
    });
    sourceIds.push(source._id);
    enqueue('ingest_source', { sourceId: String(source._id) });
  }

  await whenIdle({ timeoutMs: 180_000 });

  const sources = await Source.find({ _id: { $in: sourceIds } }).lean();
  const tokens = await Promise.all(
    DEMO_USERS.map((definition) => issueSession(users[definition.key])),
  );
  const result = {
    project: projectSummary(project),
    users: DEMO_USERS.map((definition, index) => ({
      id: String(users[definition.key]._id),
      name: definition.name,
      email: definition.email,
      role: definition.role,
      token: tokens[index],
    })),
    sources: sources.map((source) => ({
      id: String(source._id),
      name: source.name,
      status: source.status,
      statusMessage: source.statusMessage,
      visibility: source.visibility,
      sensitivity: source.sensitivity,
      stats: source.stats,
    })),
    suggestedFlow: [
      'Open the workspace as Ananya (incoming contributor) to see the recipient experience.',
      'Open it as Subham (project lead) and create a handover for Ananya.',
      'Review pending items, accept or reject them, then submit for review.',
      'Approve the handover, share it, then switch to Ananya and open the share link.',
      'Change the visibility of handover-notes.txt and reload Ananya\'s handover to see live permission re-checks.',
    ],
    resetScope:
      'Reset restores only the seeded sources. Uploads and handovers created by other visitors are preserved.',
  };

  if (sources.some((source) => source.status === 'failed')) {
    result.warning =
      'One or more demo sources failed to ingest. Check source statusMessage for details.';
  }

  return result;
}

/**
 * Accounts created before the demo flags existed look like ordinary accounts
 * and still carry the published demo password. Give each one the flag, the
 * verified marker and a fresh random hash nobody sees. Only members whose
 * address ends in @threadline.demo are touched, and only while they still
 * lack a flag, so a second run changes nothing.
 */
async function repairDemoAccounts(project) {
  const memberIds = [project.owner, ...(project.members || []).map((member) => member.user)]
    .filter(Boolean)
    .map(String);
  if (memberIds.length === 0) return 0;

  const users = await User.find({ _id: { $in: memberIds } })
    .select('email isDemo emailVerifiedAt')
    .lean();
  const legacy = users.filter(
    (user) =>
      /@threadline\.demo$/i.test(user.email || '') &&
      (!user.isDemo || !user.emailVerifiedAt),
  );
  if (legacy.length === 0) return 0;

  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  for (const user of legacy) {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          isDemo: true,
          emailVerifiedAt: user.emailVerifiedAt || new Date(),
          passwordHash,
        },
      },
    );
  }
  logger.info(
    { count: legacy.length, emails: legacy.map((user) => user.email) },
    'Migrated legacy demo accounts off the published password',
  );
  return legacy.length;
}

/**
 * Repairs an existing demo workspace after a deploy without touching its
 * sources, claims or members. The project flag and the member accounts are
 * both migrated, and only when the workspace is provably the seeded one (an
 * @threadline.demo owner or the demo flag). A missing workspace is left alone
 * so a fresh database still starts empty until someone explicitly loads the
 * demo.
 */
export async function reconcileDemoWorkspace() {
  const existing = await Project.findOne({ key: DEMO_PROJECT_KEY });
  if (!existing) return null;

  const owner = await User.findById(existing.owner).select('email').lean();
  const isDemoWorkspace =
    Boolean(existing.isDemo) || /@threadline\.demo$/i.test(owner?.email || '');
  if (!isDemoWorkspace) return null;

  const repairedUsers = await repairDemoAccounts(existing);
  const adopted = !existing.isDemo;
  if (adopted) {
    existing.isDemo = true;
    await existing.save();
  }

  return {
    alreadySeeded: true,
    ...(adopted ? { adopted: true } : {}),
    repairedUsers,
    project: projectSummary(existing),
  };
}
