export const DEMO_PASSWORD = 'Threadline#2026';

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
    name: 'Soumyajit Jena',
    email: 'soumyajit@threadline.demo',
    role: 'contributor',
    tag: 'OUTGOING · T-14',
    description: 'Rotating off Atlas. Their notes and decisions are the handover’s source material.',
    accent: 'amber',
    abilities: ['Upload sources', 'Review items'],
  },
  {
    name: 'Partho Prateem Satypatty',
    email: 'partho@threadline.demo',
    role: 'contributor',
    tag: 'INCOMING',
    description: 'The handover recipient. Sees only items backed by sources they may read.',
    accent: 'green',
    abilities: ['Open shared link', 'Acknowledge'],
  },
  {
    name: 'Sabyasachi Behera',
    email: 'sabyasachi@threadline.demo',
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

export const CLAIM_STATUS_LABELS = {
  open: 'Open',
  active: 'Active',
  planned: 'Planned',
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

export const AUDIT_ACTION_LABELS = {
  'auth.registered': 'Account registered',
  'project.created': 'Project created',
  'project.updated': 'Project updated',
  'member.added': 'Member added',
  'member.removed': 'Member removed',
  'source.created': 'Source added',
  'source.ingested': 'Source ingested',
  'source.ingest_failed': 'Source ingestion failed',
  'source.access_changed': 'Source access changed',
  'source.deleted': 'Source removed',
  'source.reingest_requested': 'Re-ingestion requested',
  'claim.conflict_resolved': 'Decision conflict resolved',
  'document.viewed': 'Document opened',
  'handover.created': 'Handover created',
  'handover.item_reviewed': 'Handover item reviewed',
  'handover.submitted': 'Handover submitted',
  'handover.approved': 'Handover approved',
  'handover.rejected': 'Handover rejected',
  'handover.shared': 'Handover shared',
  'handover.acknowledged': 'Handover acknowledged',
  'handover.recipient_viewed': 'Handover opened by recipient',
  'handover.permissions_rechecked': 'Permissions rechecked',
};

export const PRIORITY = {
  critical: { label: 'Critical', tone: 'red' },
  high: { label: 'High', tone: 'orange' },
  medium: { label: 'Medium', tone: 'amber' },
  low: { label: 'Low', tone: 'slate' },
};
