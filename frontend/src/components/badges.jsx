import {
  AlertTriangle,
  ArrowRightCircle,
  CheckSquare,
  Flag,
  Gavel,
  HelpCircle,
  Link2,
  UserCheck,
} from 'lucide-react';
import { Badge } from './ui.jsx';
import {
  CLAIM_STATES,
  CLAIM_TYPES,
  DECISION_LABELS,
  HANDOVER_STATUS,
  PRIORITY,
  ROLE_LABELS,
  SENSITIVITY,
  SEVERITY,
  SOURCE_STATUS,
} from '../lib/constants.js';

const TYPE_ICONS = {
  decision: Gavel,
  task: CheckSquare,
  risk: AlertTriangle,
  dependency: Link2,
  question: HelpCircle,
  milestone: Flag,
  responsibility: UserCheck,
  next_action: ArrowRightCircle,
};

export function TypeIcon({ type, className = 'h-3.5 w-3.5' }) {
  const Icon = TYPE_ICONS[type] || HelpCircle;
  return <Icon className={className} aria-hidden="true" />;
}

export function TypeBadge({ type, showIcon = true }) {
  const meta = CLAIM_TYPES[type] || { label: type, tone: 'slate' };
  return (
    <Badge tone={meta.tone}>
      {showIcon && <TypeIcon type={type} className="h-3 w-3" />}
      {meta.label}
    </Badge>
  );
}

export function StateBadge({ state }) {
  const meta = CLAIM_STATES[state] || { label: state || 'Unknown', tone: 'slate' };
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

export function SensitivityBadge({ sensitivity }) {
  const meta = SENSITIVITY[sensitivity] || SENSITIVITY.internal;
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function RoleBadge({ role }) {
  const tones = { lead: 'navy', contributor: 'blue', observer: 'slate' };
  return <Badge tone={tones[role] || 'slate'}>{ROLE_LABELS[role] || role || 'No role'}</Badge>;
}

export function HandoverStatusBadge({ status }) {
  const meta = HANDOVER_STATUS[status] || { label: status, tone: 'slate' };
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

export function SourceStatusBadge({ status }) {
  const meta = SOURCE_STATUS[status] || { label: status, tone: 'slate' };
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

export function DecisionBadge({ decision }) {
  const tones = {
    pending: 'slate',
    accepted: 'green',
    edited: 'blue',
    rejected: 'red',
  };
  return <Badge tone={tones[decision] || 'slate'}>{DECISION_LABELS[decision] || decision}</Badge>;
}

export function SeverityBadge({ severity }) {
  const meta = SEVERITY[severity] || SEVERITY.info;
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

export function PriorityBadge({ priority }) {
  const meta = PRIORITY[priority] || PRIORITY.low;
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}
