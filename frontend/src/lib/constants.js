export const DEMO_PERSONAS = [
  {
    name: 'Subham Sahu',
    email: 'subham@threadline.demo',
    role: 'lead',
    tag: 'PROJECT LEAD',
    description: 'Full governance: sources, approvals, audit and handover sign-off.',
    accent: 'navy',
    abilities: ['Approve', 'Share', 'Restrict sources', 'Audit log'],
  },
  {
    name: 'Rohan Mehta',
    email: 'rohan@threadline.demo',
    role: 'contributor',
    tag: 'OUTGOING · T-14',
    description: 'Rotating off Atlas. Their notes and decisions are the handover’s source material.',
    accent: 'amber',
    abilities: ['Upload sources', 'Review items'],
  },
  {
    name: 'Ananya Rao',
    email: 'ananya@threadline.demo',
    role: 'contributor',
    tag: 'INCOMING',
    description: 'The handover recipient. Sees only items backed by sources they may read.',
    accent: 'green',
    abilities: ['Open shared link', 'Acknowledge'],
  },
  {
    name: 'Vikram Nair',
    email: 'vikram@threadline.demo',
    role: 'observer',
    tag: 'OBSERVER',
    description: 'Read-only oversight. Cannot upload, review, approve or edit project content.',
    accent: 'slate',
    abilities: ['Read-only access'],
  },
];

export const ROLE_LABELS = {
  lead: 'Project lead',
  contributor: 'Contributor',
  observer: 'Observer',
};

export const CLAIM_TYPES = {
  decision: { label: 'Decision', tone: 'indigo' },
  task: { label: 'Task', tone: 'blue' },
  risk: { label: 'Risk', tone: 'red' },
  dependency: { label: 'Dependency', tone: 'violet' },
  question: { label: 'Question', tone: 'amber' },
  milestone: { label: 'Milestone', tone: 'teal' },
  responsibility: { label: 'Responsibility', tone: 'slate' },
  next_action: { label: 'Next action', tone: 'sky' },
};

export const CLAIM_STATES = {
  confirmed: { label: 'Confirmed', tone: 'green' },
  inferred: { label: 'Inferred', tone: 'amber' },
  needs_review: { label: 'Needs review', tone: 'orange' },
};

// Mirrors CLAIM_STATUSES in backend/src/models/index.js. A status that is
// still in play expects an owner even when it is blocked.
export const OPEN_CLAIM_STATUSES = ['open', 'active', 'planned', 'blocked', 'unknown'];

export const CLAIM_STATUS_LABELS = {
  open: 'Open',
  active: 'Active',
  planned: 'Planned',
  blocked: 'Blocked',
  done: 'Done',
  resolved: 'Resolved',
  superseded: 'Superseded',
  unknown: 'Status unknown',
};

export const SENSITIVITY = {
  public: { label: 'Public', tone: 'slate' },
  internal: { label: 'Internal', tone: 'blue' },
  confidential: { label: 'Confidential', tone: 'red' },
};

export const HANDOVER_STATUS = {
  draft: { label: 'Draft', tone: 'slate' },
  in_review: { label: 'In review', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  shared: { label: 'Shared', tone: 'blue' },
  acknowledged: { label: 'Acknowledged', tone: 'teal' },
  rejected: { label: 'Rejected', tone: 'red' },
  superseded: { label: 'Superseded', tone: 'slate' },
};

export const TEMPLATES = {
  onboarding: {
    label: 'Onboarding handover',
    description: 'Every visible decision, task, risk, question and next action.',
  },
  executive: {
    label: 'Executive summary',
    description: 'Decisions, milestones, risks and dependencies. Tasks and questions are excluded.',
  },
  audit: {
    label: 'Audit record',
    description: 'Full evidence trail for compliance review, including all item types.',
  },
};

export const SEVERITY = {
  info: { label: 'Info', tone: 'blue' },
  warning: { label: 'Attention', tone: 'amber' },
  critical: { label: 'Critical', tone: 'red' },
};

export const SOURCE_STATUS = {
  queued: { label: 'Queued', tone: 'slate' },
  processing: { label: 'Processing', tone: 'amber' },
  ready: { label: 'Ready', tone: 'green' },
  partial: { label: 'Partial', tone: 'orange' },
  failed: { label: 'Failed', tone: 'red' },
};

export const SOURCE_KINDS = {
  upload: 'Uploaded file',
  github: 'GitHub repository',
  drive: 'Google Drive',
};

export const DECISION_LABELS = {
  pending: 'Pending',
  accepted: 'Accepted',
  edited: 'Edited',
  rejected: 'Rejected',
};

// One entry per action the backend can write. backend/tests/audit-labels.test.js
// fails if an emitted action is missing here or a listed action is never written.
export const AUDIT_ACTION_LABELS = {
  'auth.lockout': 'Account locked after failed sign-ins',
  'auth.logged_out': 'Signed out',
  'auth.registered': 'Account registered',
  'auth.registration_duplicate': 'Registration attempted for an existing account',
  'auth.email_verified': 'Email address confirmed',
  'auth.session_revoked': 'Another device signed out',
  'auth.verification_resent': 'Verification link re-sent',
  'claim.conflict_answer_received': 'Conflict answer received',
  'claim.conflict_resolved': 'Decision conflict resolved',
  'claim.note_added': 'Note added to item',
  'claim.owner_assigned': 'Item owner assigned',
  'claim.resolved': 'Item resolved',
  'claim.shared_with_project': 'Handover item shared with project',
  'clarification.answered': 'Question answered',
  'clarification.asked': 'Question asked',
  'clarification.closed': 'Question closed',
  'clarification.declined': 'Question declined',
  'document.viewed': 'Document opened',
  'handover.acknowledged': 'Handover acknowledged',
  'handover.approved': 'Handover approved',
  'handover.created': 'Handover created',
  'handover.feedback_received': 'Recipient feedback received',
  'handover.feedback_resolved': 'Recipient feedback resolved',
  'handover.item_reviewed': 'Handover item reviewed',
  'handover.items_reviewed': 'Handover items reviewed in bulk',
  'handover.marked_outdated': 'Handover marked outdated',
  'handover.permissions_rechecked': 'Permissions rechecked',
  'handover.recipient_viewed': 'Handover opened by recipient',
  'handover.regenerated': 'Handover regenerated',
  'handover.rejected': 'Handover rejected',
  'handover.reopened': 'Handover reopened',
  'handover.share_revoked': 'Share link revoked',
  'handover.share_rotated': 'Share link rotated',
  'handover.shared': 'Handover shared',
  'handover.submitted': 'Handover submitted',
  'handover.superseded': 'Handover superseded by a newer version',
  'member.added': 'Member added',
  'member.removed': 'Member removed',
  'member.role_changed': 'Member role changed',
  'project.created': 'Project created',
  'project.updated': 'Project updated',
  'source.access_changed': 'Source access changed',
  'source.ai_policy_changed': 'Source AI policy changed',
  'source.created': 'Source added',
  'source.failed': 'Source ingestion failed',
  'source.hidden': 'Source hidden',
  'source.ingested': 'Source ingested',
  'source.partial': 'Source partly ingested',
  'source.purged': 'Source purged',
  'source.reingest_requested': 'Re-ingestion requested',
  'source.sync_requested': 'Source sync requested',
  'source.sync_updated': 'Source sync completed',
  'source.unhidden': 'Source unhidden',
};

export const PRIORITY = {
  critical: { label: 'Critical', tone: 'red' },
  high: { label: 'High', tone: 'orange' },
  medium: { label: 'Medium', tone: 'amber' },
  low: { label: 'Low', tone: 'slate' },
};
