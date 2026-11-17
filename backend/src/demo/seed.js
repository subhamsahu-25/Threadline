import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
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
import { hashPassword, signToken, verifyPassword } from '../services/auth.js';

export const DEMO_PASSWORD = 'Threadline#2026';
export const DEMO_PROJECT_KEY = 'ATLAS';

const DEMO_USERS = [
  { key: 'subham', name: 'Subham Sahu', email: 'subham@threadline.demo', role: 'lead' },
  { key: 'rohan', name: 'Rohan Mehta', email: 'rohan@threadline.demo', role: 'contributor' },
  { key: 'ananya', name: 'Ananya Rao', email: 'ananya@threadline.demo', role: 'contributor' },
  { key: 'vikram', name: 'Vikram Nair', email: 'vikram@threadline.demo', role: 'observer' },
];

const DEMO_DOCUMENTS = [
  {
    name: 'kickoff-notes.md',
    sensitivity: 'internal',
    visibility: { scope: 'project', roles: [], users: [] },
    content: `# Project Atlas - Kickoff notes

## Scope and goals
Decision: Move the billing ledger to a modular service so invoice generation can scale independently. (date: 2026-08-19, status: active)
Milestone: Beta migration complete by 2026-12-15. (date: 2026-08-19, status: planned)
Risk: The finance reconciliation job depends on an undocumented legacy stored procedure. (date: 2026-08-19, status: open)
Dependency: The payments team must ship settlement webhook v2 before beta. (date: 2026-08-19, status: open)

## Open items
Open question: Do we need to migrate invoices older than 24 months? (date: 2026-08-19, status: open)
Task: Write the invoice data backfill script (owner: Rohan, due: 2026-11-20, status: open)
Task: Publish the migration runbook (status: open)
`,
  },
  {
    name: 'architecture-decisions.md',
    sensitivity: 'internal',
    visibility: { scope: 'project', roles: [], users: [] },
    content: `# Architecture decisions - Atlas

## Database choice
Decision: Use PostgreSQL for the new ledger tables. (date: 2026-09-02, status: active)
Decision: Stay on MySQL for the ledger until Q1 2027 and revisit PostgreSQL after the beta; this supersedes the earlier PostgreSQL-only plan. (date: 2026-10-18, status: active)
Risk: Dual-writing to MySQL and PostgreSQL will cause reconciliation drift during the transition. (date: 2026-10-18, status: open)

## API versioning
Decision: Freeze the public invoice API at v1 for the beta. (date: 2026-09-10, status: active)
Dependency: The mobile app team needs a stable invoice download endpoint until their January release. (date: 2026-09-10, status: open)
`,
  },
  {
    name: 'sprint-board.csv',
    sensitivity: 'internal',
    visibility: { scope: 'project', roles: [], users: [] },
    content: `type,title,owner,due,status
task,Write billing smoke tests,Ananya,2026-11-12,open
task,Add ledger drift alerting,Sana,2026-11-08,open
task,Migrate invoice PDF templates,,2026-11-25,open
task,Update on-call documentation,Rohan,2026-10-30,done
question,Who owns reconciliation alerting after the handover?,,,open
`,
  },
  {
    name: 'incident-review.md',
    sensitivity: 'internal',
    visibility: { scope: 'project', roles: [], users: [] },
    content: `# Incident review - 18 October

## API versioning
Decision: Introduce v2 invoice endpoints before the beta. (date: 2026-10-20, status: active)
Risk: The v2 change breaks invoice downloads in the current mobile client until a new app release ships. (date: 2026-10-20, status: open)

## Reconciliation
Open question: Who owns the reconciliation drift alerting after Rohan leaves? (date: 2026-10-20, status: open)
Task: Record a runbook walkthrough with Rohan before their last day (owner: Subham, due: 2026-11-14, status: open)
`,
  },
  {
    name: 'handover-notes.txt',
    sensitivity: 'internal',
    visibility: { scope: 'roles', roles: ['lead', 'contributor'], users: [] },
    content: `# Rohan's handover notes

## Payment provider
Decision: Continue with Razorpay for the beta and review the enterprise contract after launch. (date: 2026-10-21, status: active)
Dependency: Finance must approve the vendor contract before the beta launch. (date: 2026-10-21, status: open)
Task: Send the vendor security questionnaire to finance (owner: Rohan, due: 2026-11-15, status: open)
Task: Hand over the Grafana dashboard access (owner: Rohan, status: open)
`,
  },
  {
    name: 'vendor-contract-summary.md',
    sensitivity: 'confidential',
    visibility: { scope: 'roles', roles: ['lead'], users: [] },
    content: `# Vendor contract summary - restricted

## Vendor risk
Risk: The Razorpay enterprise contract auto-renews with a 22 percent price increase if it is not renegotiated before 2026-12-01. (date: 2026-10-25, status: open)
Decision: Renegotiate the Razorpay contract before December instead of accepting auto-renewal. (date: 2026-10-25, status: active)
Task: Prepare the negotiation brief for the CFO (owner: Subham, due: 2026-11-18, status: open)
`,
  },
];

function mimeFor(name) {
  if (name.endsWith('.md')) return 'text/markdown';
  if (name.endsWith('.csv')) return 'text/csv';
  return 'text/plain';
}

async function ensureUser(definition, passwordHash) {
  let user = await User.findOne({ email: definition.email });
  if (!user) {
    user = await User.create({
      email: definition.email,
      name: definition.name,
      passwordHash,
    });
  } else {
    user.name = definition.name;
    await user.save();
    const withHash = await User.findOne({ email: definition.email }).select('+passwordHash');
    if (!(await verifyPassword(DEMO_PASSWORD, withHash.passwordHash))) {
      withHash.passwordHash = passwordHash;
      await withHash.save();
    }
  }
  return user;
}

const SEEDED_SOURCE_NAMES = DEMO_DOCUMENTS.map((document) => document.name);

/**
 * The demo workspace is shared by every visitor, so a reset must restore the
 * seeded corpus without erasing work someone else uploaded. Only sources whose
 * name matches a seeded document are removed, together with the claims and
 * evidence that came from them.
 */
async function removeSeededContent(project) {
  const seededSources = await Source.find({
    project: project._id,
    name: { $in: SEEDED_SOURCE_NAMES },
  });
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
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const users = {};
  for (const definition of DEMO_USERS) {
    users[definition.key] = await ensureUser(definition, passwordHash);
  }

  const members = DEMO_USERS.map((definition) => ({
    user: users[definition.key]._id,
    role: definition.role,
  }));
  const transition = {
    outgoingUserId: users.rohan._id,
    outgoingName: 'Rohan Mehta',
    plannedDepartureAt: new Date(Date.now() + 14 * 86_400_000),
    context:
      'Rohan is rotating off Atlas to lead the payments platform team. Ananya joins as their replacement in two weeks.',
  };

  let project = await Project.findOne({ key: DEMO_PROJECT_KEY });
  if (project && !reset) {
    return {
      alreadySeeded: true,
      project: { id: String(project._id), key: project.key, name: project.name },
      hint: 'Pass reset=true to rebuild the seeded sources',
    };
  }
  if (project && reset) {
    await removeSeededContent(project);
    await removeStaleDemoUsers();
  }

  if (!project) {
    project = await Project.create({
      key: DEMO_PROJECT_KEY,
      name: 'Project Atlas - Billing Service Migration',
      description:
        'Migration of the billing ledger and invoice pipeline to a modular service. Used as the Threadline demo project.',
      owner: users.subham._id,
      members,
      transition,
      startedAt: new Date('2026-08-19'),
      targetDate: new Date('2026-12-15'),
    });
  } else {
    project.name = 'Project Atlas - Billing Service Migration';
    project.description =
      'Migration of the billing ledger and invoice pipeline to a modular service. Used as the Threadline demo project.';
    project.owner = users.subham._id;
    project.members = members;
    project.transition = transition;
    project.settings = { requireSeparateApprover: false };
    project.startedAt = new Date('2026-08-19');
    project.targetDate = new Date('2026-12-15');
    await project.save();
  }

  const sourceIds = [];
  for (const document of DEMO_DOCUMENTS) {
    const file = await writeDocument(document);
    const source = await Source.create({
      project: project._id,
      kind: 'upload',
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
  const result = {
    project: {
      id: String(project._id),
      key: project.key,
      name: project.name,
      description: project.description,
    },
    users: DEMO_USERS.map((definition) => ({
      id: String(users[definition.key]._id),
      name: definition.name,
      email: definition.email,
      role: definition.role,
      password: DEMO_PASSWORD,
      token: signToken(users[definition.key]),
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
