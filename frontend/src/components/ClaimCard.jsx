import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  FileSearch,
  UserRound,
} from 'lucide-react';
import { evidenceStatus, expectsOwner, formatDate } from '../lib/format.js';
import { TypeBadge, StateBadge, SensitivityBadge } from './badges.jsx';
import { Badge, Card } from './ui.jsx';

function ValidationIcon({ validation }) {
  if (validation === 'exact') {
    return <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-label="Exact quote match" />;
  }
  if (validation === 'person_confirmed') {
    return <BadgeCheck className="h-3 w-3 text-violet-600" aria-label="Person-confirmed answer" />;
  }
  if (validation === 'failed') {
    return <AlertTriangle className="h-3 w-3 text-red-500" aria-label="Quote not matched" />;
  }
  return <CircleDot className="h-3 w-3 text-blue-500" aria-label="Normalized quote match" />;
}

export function CitationList({ citations = [], onEvidence, className = '' }) {
  if (citations.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1 font-mono text-[10px] text-ink-faint">
        <FileSearch className="h-3 w-3" aria-hidden="true" />
        No evidence attached
      </span>
    );
  }
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`} aria-label="Evidence citations">
      {citations.map((citation, index) => (
        <button
          key={citation.evidenceId || index}
          type="button"
          onClick={() => onEvidence?.(citation.evidenceId)}
          className="group inline-flex max-w-full items-center gap-1.5 rounded border border-line bg-white px-2 py-1 font-mono text-[10.5px] text-ink-muted transition hover:border-brand-300 hover:bg-brand-50/60 hover:text-brand-800"
          title={`${citation.docTitle || 'Source document'} — ${citation.quote || ''}\nOpen evidence`}
        >
          <ValidationIcon validation={citation.validation} />
          <span className="text-brand-700">[{index + 1}]</span>
          <span className="max-w-[170px] truncate">{citation.sourceName || citation.docTitle}</span>
          <span className="hidden max-w-[150px] truncate text-ink-faint sm:inline">
            · {citation.docTitle}
          </span>
        </button>
      ))}
    </div>
  );
}

export default function ClaimCard({
  claim,
  onEvidence,
  actions,
  footer,
  className = '',
  compact = false,
}) {
  const overdue = claim.dueAt && new Date(claim.dueAt).getTime() < Date.now();
  const superseded = claim.status === 'superseded';
  const unverified = (claim.flags || []).includes('unverified_citation');
  const lowConfidence = (claim.flags || []).includes('low_confidence');
  const instructionLike = (claim.flags || []).includes('instruction_like');
  const personConfirmed = claim.origin === 'person_confirmed';
  const certainty = evidenceStatus(claim);

  return (
    <Card className={`${compact ? 'p-3.5' : 'p-4'} ${superseded ? 'border-dashed' : ''} ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <TypeBadge type={claim.type} />
        <StateBadge state={claim.state} />
        <Badge tone={certainty.tone} title={certainty.title}>
          {certainty.label}
        </Badge>
        {claim.status === 'blocked' && (
          <Badge tone="orange" title="This item is recorded as blocked.">
            Blocked
          </Badge>
        )}
        {lowConfidence && (
          <Badge
            tone="amber"
            title="The extractor was not confident about this item. A reviewer should check it."
          >
            Low confidence
          </Badge>
        )}
        {instructionLike && (
          <Badge
            tone="red"
            title="The passage looks like it tries to give instructions. It is kept as data and needs review."
          >
            Suspicious instruction
          </Badge>
        )}
        {claim.sensitivity === 'confidential' && <SensitivityBadge sensitivity="confidential" />}
        {personConfirmed && (
          <Badge tone="violet" title="Answered by a named teammate instead of a document quote.">
            <BadgeCheck className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
            Person-confirmed
          </Badge>
        )}
        {(claim.flags || []).includes('answered_by_clarification') && (
          <Badge tone="violet">Answered by departing member</Badge>
        )}
        {superseded && <Badge tone="slate">Superseded</Badge>}
        {claim.topic && (
          <span className="max-w-[180px] truncate font-mono text-[10px] text-ink-faint" title={claim.topic}>
            {claim.topic}
          </span>
        )}
        <span className="ml-auto font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
          #{String(claim.id).slice(-6)}
        </span>
      </div>

      <p
        className={`mt-2.5 font-medium leading-6 text-ink ${
          compact ? 'text-[12.5px]' : 'text-[13.5px]'
        }`}
      >
        {claim.statement}
      </p>

      {personConfirmed && (
        <p className="mt-1.5 flex items-center gap-1 text-[10.5px] text-violet-800">
          <BadgeCheck className="h-3 w-3" aria-hidden="true" />
          Confirmed by {claim.confirmedByName || 'a teammate'}
          {claim.confirmedAt ? ` · ${formatDate(claim.confirmedAt)}` : ''}
        </p>
      )}
      {claim.resolution?.note && (
        <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/70 px-2.5 py-1.5 text-[10.5px] leading-4 text-emerald-900">
          {claim.resolution.note}
          {claim.resolution.byName ? ` — ${claim.resolution.byName}` : ''}
        </p>
      )}

      {(expectsOwner(claim) || claim.dueAt || claim.occurredAt) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
          {expectsOwner(claim) && (
            <span className="inline-flex items-center gap-1">
              <UserRound className="h-3 w-3 text-ink-faint" aria-hidden="true" />
              {claim.ownerName || <span className="text-amber-700">No owner recorded</span>}
            </span>
          )}
          {claim.dueAt && (
            <span className={`inline-flex items-center gap-1 ${overdue ? 'font-semibold text-red-600' : ''}`}>
              <CalendarClock className="h-3 w-3" aria-hidden="true" />
              Due {formatDate(claim.dueAt)}
              {overdue ? ' · overdue' : ''}
            </span>
          )}
          {claim.occurredAt && (
            <span className="ml-auto font-mono text-[9.5px] text-ink-faint">
              {formatDate(claim.occurredAt)}
            </span>
          )}
        </div>
      )}

      {unverified && (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[10.5px] leading-4 text-amber-900">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          This item's quote could not be matched to the source text. A reviewer must confirm it.
        </p>
      )}

      {claim.citations?.length > 0 && (
        <div className="mt-3 border-t border-line pt-2.5">
          <CitationList citations={claim.citations} onEvidence={onEvidence} />
        </div>
      )}

      {actions && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">{actions}</div>}
      {footer}
    </Card>
  );
}
