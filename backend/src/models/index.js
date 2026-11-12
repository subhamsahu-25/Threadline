import mongoose from 'mongoose';

const { Schema } = mongoose;

function baseTransform(_doc, ret) {
  ret.id = String(ret._id);
  delete ret._id;
  delete ret.__v;
  return ret;
}

export const jsonOptions = {
  virtuals: true,
  versionKey: false,
  transform: baseTransform,
};

export const CLAIM_TYPES = [
  'decision',
  'task',
  'risk',
  'dependency',
  'question',
  'milestone',
  'responsibility',
  'next_action',
];

export const CLAIM_STATUSES = [
  'open',
  'active',
  'planned',
  'done',
  'resolved',
  'superseded',
  'unknown',
];

export const CLAIM_STATES = ['confirmed', 'inferred', 'needs_review'];

export const SENSITIVITIES = ['public', 'internal', 'confidential'];
const SENSITIVITY_RANK = new Map(SENSITIVITIES.map((value, index) => [value, index]));

export function highestSensitivity(values) {
  let best = 'public';
  for (const value of values) {
    if ((SENSITIVITY_RANK.get(value) ?? 0) > (SENSITIVITY_RANK.get(best) ?? 0)) best = value;
  }
  return best;
}

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    platformRole: { type: String, enum: ['admin', 'user'], default: 'user' },
    lastLoginAt: Date,
  },
  { timestamps: true, toJSON: jsonOptions },
);

export const User = mongoose.model('User', userSchema);

const membershipSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['lead', 'contributor', 'observer'], required: true },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const projectSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    status: { type: String, enum: ['active', 'paused', 'completed'], default: 'active' },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: { type: [membershipSchema], default: [] },
    transition: {
      outgoingUserId: { type: Schema.Types.ObjectId, ref: 'User' },
      outgoingName: String,
      plannedDepartureAt: Date,
      context: String,
    },
    startedAt: Date,
    targetDate: Date,
  },
  { timestamps: true, toJSON: jsonOptions },
);

projectSchema.index({ 'members.user': 1 });

projectSchema.methods.roleOf = function roleOf(userId) {
  const id = String(userId);
  const membership = (this.members || []).find(
    (entry) => String(entry.user?._id ?? entry.user) === id,
  );
  return membership ? membership.role : null;
};

export const Project = mongoose.model('Project', projectSchema);

const sourceVisibilitySchema = new Schema(
  {
    scope: { type: String, enum: ['project', 'roles', 'users'], default: 'project' },
    roles: { type: [String], default: [] },
    users: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { _id: false },
);

const sourceSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    kind: { type: String, enum: ['upload', 'github', 'drive'], required: true },
    name: { type: String, required: true, trim: true },
    externalRef: { type: String, default: '' },
    visibility: { type: sourceVisibilitySchema, default: () => ({}) },
    sensitivity: { type: String, enum: SENSITIVITIES, default: 'internal' },
    status: {
      type: String,
      enum: ['queued', 'processing', 'ready', 'failed'],
      default: 'queued',
    },
    statusMessage: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    files: {
      type: [
        {
          _id: false,
          originalName: String,
          storedName: String,
          mime: String,
          size: Number,
        },
      ],
      default: [],
    },
    lastIngestedAt: Date,
    deletedAt: Date,
    stats: {
      documents: { type: Number, default: 0 },
      claims: { type: Number, default: 0 },
      unverifiedClaims: { type: Number, default: 0 },
    },
  },
  { timestamps: true, toJSON: jsonOptions },
);

sourceSchema.index({ project: 1, deletedAt: 1 });

export const Source = mongoose.model('Source', sourceSchema);

const chunkSchema = new Schema(
  {
    index: { type: Number, required: true },
    text: { type: String, required: true },
    start: { type: Number, required: true },
    end: { type: Number, required: true },
  },
  { _id: true },
);

const documentSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    source: { type: Schema.Types.ObjectId, ref: 'Source', required: true, index: true },
    kind: { type: String, required: true },
    title: { type: String, required: true },
    path: { type: String, default: '' },
    mime: { type: String, default: 'text/plain' },
    size: { type: Number, default: 0 },
    checksum: { type: String, index: true },
    author: String,
    occurredAt: Date,
    locator: {
      url: String,
      path: String,
      externalId: String,
    },
    rawText: { type: String, required: true },
    chunks: { type: [chunkSchema], default: [] },
    revision: { type: Number, default: 1 },
    retiredAt: Date,
    parseWarnings: { type: [String], default: [] },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, toJSON: jsonOptions },
);

documentSchema.index({ source: 1, retiredAt: 1 });

export const Document = mongoose.model('Document', documentSchema);

const claimSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    source: { type: Schema.Types.ObjectId, ref: 'Source', required: true, index: true },
    document: { type: Schema.Types.ObjectId, ref: 'Document' },
    type: { type: String, enum: CLAIM_TYPES, required: true },
    statement: { type: String, required: true },
    statementKey: { type: String, required: true },
    topic: { type: String, default: '' },
    topicKey: { type: String, default: '' },
    status: { type: String, enum: CLAIM_STATUSES, default: 'unknown' },
    state: { type: String, enum: CLAIM_STATES, default: 'confirmed' },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 },
    sensitivity: { type: String, enum: SENSITIVITIES, default: 'internal' },
    ownerName: String,
    ownerUser: { type: Schema.Types.ObjectId, ref: 'User' },
    dueAt: Date,
    occurredAt: Date,
    flags: { type: [String], default: [] },
    evidenceCount: { type: Number, default: 0 },
    verifiedEvidenceCount: { type: Number, default: 0 },
    supersededBy: { type: Schema.Types.ObjectId, ref: 'Claim' },
    extraction: {
      method: { type: String, enum: ['llm', 'heuristic'], default: 'heuristic' },
      model: String,
    },
    retiredAt: Date,
  },
  { timestamps: true, toJSON: jsonOptions },
);

claimSchema.index({ project: 1, retiredAt: 1, type: 1 });
claimSchema.index({ project: 1, topicKey: 1 });
claimSchema.index({ source: 1, statementKey: 1, type: 1 });

export const Claim = mongoose.model('Claim', claimSchema);

const evidenceSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', required: true, index: true },
    source: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    document: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    chunkId: { type: Schema.Types.ObjectId },
    quote: { type: String, required: true },
    charStart: { type: Number, required: true },
    charEnd: { type: Number, required: true },
    locale: {
      path: String,
      url: String,
      title: String,
    },
    validation: {
      type: String,
      enum: ['exact', 'normalized', 'failed', 'unchecked'],
      default: 'unchecked',
    },
    validationNote: String,
  },
  { timestamps: true, toJSON: jsonOptions },
);

evidenceSchema.index({ claim: 1, document: 1, charStart: 1, charEnd: 1 }, { unique: true });

export const Evidence = mongoose.model('Evidence', evidenceSchema);

const citationSchema = new Schema(
  {
    evidenceId: { type: Schema.Types.ObjectId, ref: 'Evidence' },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document' },
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source' },
    sourceName: String,
    sourceKind: String,
    docTitle: String,
    quote: String,
    charStart: Number,
    charEnd: Number,
    locator: { path: String, url: String },
    validation: String,
    occurredAt: Date,
  },
  { _id: false },
);

const handoverItemSchema = new Schema(
  {
    claimId: { type: Schema.Types.ObjectId, ref: 'Claim' },
    type: { type: String, enum: CLAIM_TYPES, required: true },
    statement: { type: String, required: true },
    topic: String,
    status: { type: String, enum: CLAIM_STATUSES },
    state: { type: String, enum: CLAIM_STATES },
    confidence: Number,
    sensitivity: { type: String, enum: SENSITIVITIES },
    ownerName: String,
    dueAt: Date,
    occurredAt: Date,
    flags: { type: [String], default: [] },
    citations: { type: [citationSchema], default: [] },
    decision: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'edited'],
      default: 'pending',
    },
    editedStatement: String,
    reviewerNote: String,
    acceptedWithoutEvidence: { type: Boolean, default: false },
  },
  { _id: false },
);

const alertSchema = new Schema(
  {
    code: { type: String, required: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
    message: { type: String, required: true },
    topic: String,
    audience: { type: String, enum: ['recipient', 'reviewer'], default: 'recipient' },
    claimIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
);

const recommendationSchema = new Schema(
  {
    key: { type: String, required: true },
    kind: { type: String, required: true },
    priority: { type: String, enum: ['critical', 'high', 'medium', 'low'], required: true },
    title: { type: String, required: true },
    reason: String,
    claimIds: { type: [Schema.Types.ObjectId], default: [] },
    inferred: { type: Boolean, default: true },
  },
  { _id: false },
);

const handoverSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    recipientSnapshot: {
      name: String,
      email: String,
      role: String,
    },
    roleTemplate: {
      type: String,
      enum: ['onboarding', 'executive', 'audit'],
      default: 'onboarding',
    },
    status: {
      type: String,
      enum: ['draft', 'in_review', 'approved', 'shared', 'acknowledged', 'rejected'],
      default: 'draft',
      index: true,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewer: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    approvedBySnapshot: { name: String, email: String },
    rejectedAt: Date,
    rejectionNote: String,
    reviewNote: String,
    sharedAt: Date,
    acknowledgedAt: Date,
    shareToken: { type: String, index: true, sparse: true },
    shareExpiresAt: Date,
    version: { type: Number, default: 1 },
    items: { type: [handoverItemSchema], default: [] },
    alerts: { type: [alertSchema], default: [] },
    recommendations: { type: [recommendationSchema], default: [] },
    withheld: {
      total: { type: Number, default: 0 },
      byType: { type: Schema.Types.Mixed, default: {} },
      byReason: {
        permissions: { type: Number, default: 0 },
        template: { type: Number, default: 0 },
        unverified: { type: Number, default: 0 },
      },
    },
    snapshot: {
      projectName: String,
      projectKey: String,
      description: String,
      phase: String,
      readinessScore: Number,
      lastActivityAt: Date,
      activityWindow: { start: Date, end: Date },
      counts: { type: Schema.Types.Mixed, default: {} },
      outgoingName: String,
      plannedDepartureAt: Date,
      transitionContext: String,
      generatedSummary: String,
    },
    generation: {
      method: String,
      model: String,
      generatedAt: Date,
      durationMs: Number,
    },
    permissionsCheckedAt: Date,
    lastAccessedAt: Date,
  },
  { timestamps: true, toJSON: jsonOptions },
);

handoverSchema.index({ project: 1, recipient: 1, status: 1 });

export const Handover = mongoose.model('Handover', handoverSchema);

const handoverVersionSchema = new Schema(
  {
    handover: { type: Schema.Types.ObjectId, ref: 'Handover', required: true, index: true },
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    version: { type: Number, required: true },
    reason: { type: String, required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: String,
    snapshot: { type: Schema.Types.Mixed },
  },
  { timestamps: true, toJSON: jsonOptions },
);

handoverVersionSchema.index({ handover: 1, version: 1 }, { unique: true });

export const HandoverVersion = mongoose.model('HandoverVersion', handoverVersionSchema);

const auditEventSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: String,
    action: { type: String, required: true, index: true },
    targetType: String,
    targetId: { type: Schema.Types.ObjectId },
    targetLabel: String,
    meta: { type: Schema.Types.Mixed, default: {} },
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON: jsonOptions },
);

auditEventSchema.index({ project: 1, createdAt: -1 });

export const AuditEvent = mongoose.model('AuditEvent', auditEventSchema);
