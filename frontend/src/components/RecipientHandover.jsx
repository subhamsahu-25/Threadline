import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  Download,
  EyeOff,
  Flag,
  GitCompareArrows,
  Info,
  LockKeyhole,
  MessageSquare,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { errorMessage } from '../lib/api.js';
import { evidenceStatus, expectsOwner, formatDate, formatDateTime } from '../lib/format.js';
import { CLAIM_TYPES } from '../lib/constants.js';
import { TypeBadge, StateBadge, SensitivityBadge, SeverityBadge } from './badges.jsx';
import { CitationList } from './ClaimCard.jsx';
import EvidenceDrawer from './EvidenceDrawer.jsx';
import { Badge, Button, Card, EmptyState, Field, Modal, SectionHeading, Textarea } from './ui.jsx';

function ReadOnlyItem({ item, onEvidence, onFlag }) {
  const edited = item.decision === 'edited';
  const certainty = evidenceStatus(item);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <TypeBadge type={item.type} />
        <StateBadge state={item.state} />
        <Badge tone={certainty.tone} title={certainty.title}>
          {certainty.label}
        </Badge>
        {item.sensitivity === 'confidential' && <SensitivityBadge sensitivity="confidential" />}
        {item.origin === 'person_confirmed' && (
          <Badge tone="violet" title="Answered by a named teammate instead of a document quote.">
            <BadgeCheck className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
            Person-confirmed
          </Badge>
        )}
        {item.changedSinceApproval && (
          <Badge tone="amber" title="This item changed in the live project state after the handover was approved.">
            Changed since approval
          </Badge>
        )}
        {item.redactionCount > 0 && (
          <Badge
            tone="slate"
            title="Emails, phone numbers, credentials and 12-digit IDs were replaced with a typed marker before sharing."
          >
            {item.redactionCount} redacted
          </Badge>
        )}
        {edited && <Badge tone="blue">Reviewed wording</Badge>}
        {item.acceptedWithoutEvidence && <Badge tone="orange">Accepted without evidence</Badge>}
        <span className="ml-auto font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
          #{String(item.claimId).slice(-6)}
        </span>
      </div>
      <p className="mt-2.5 text-[13px] font-medium leading-6 text-ink">{item.statement}</p>
      {item.origin === 'person_confirmed' && (
        <p className="mt-1 flex items-center gap-1 text-[10.5px] text-violet-800">
          <BadgeCheck className="h-3 w-3" aria-hidden="true" />
          Confirmed by {item.confirmedByName || 'a teammate'}
          {item.confirmedAt ? ` · ${formatDate(item.confirmedAt)}` : ''}
        </p>
      )}
      {item.changedSinceApproval && (
        <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10.5px] leading-4 text-amber-900">
          Current state: {item.status}
          {item.previousStatus && item.previousStatus !== item.status
            ? ` (was ${item.previousStatus})`
            : ''}
          {item.previousOwnerName !== undefined &&
          (item.previousOwnerName || null) !== (item.ownerName || null)
            ? ` · owner ${item.ownerName || 'unassigned'} (was ${item.previousOwnerName || 'unassigned'})`
            : ''}
        </p>
      )}
      {item.resolutionNote && (
        <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/70 px-2.5 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-emerald-800">
            Closure note{item.resolutionByName ? ` · ${item.resolutionByName}` : ''}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-emerald-900">{item.resolutionNote}</p>
        </div>
      )}
      {edited && item.originalStatement && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10.5px] font-medium text-ink-muted">
            Original extracted wording
          </summary>
          <p className="mt-1 rounded-md border border-line bg-slate-50 px-2.5 py-2 text-[11px] leading-4 text-ink-muted">
            {item.originalStatement}
          </p>
        </details>
      )}
      {(expectsOwner(item) || item.dueAt || item.occurredAt) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
          {expectsOwner(item) && (
            <span className="inline-flex items-center gap-1">
              <UserRound className="h-3 w-3 text-ink-faint" aria-hidden="true" />
              {item.ownerName || 'No owner recorded'}
            </span>
          )}
          {item.dueAt && (
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="h-3 w-3" aria-hidden="true" />
              Due {formatDate(item.dueAt)}
            </span>
          )}
          {item.occurredAt && (
            <span className="ml-auto font-mono text-[9.5px] text-ink-faint">
              {formatDate(item.occurredAt)}
            </span>
          )}
        </div>
      )}
      <div className="mt-3 border-t border-line pt-2.5">
        <CitationList citations={item.citations || []} onEvidence={onEvidence} />
        {onFlag && (
          <button
            type="button"
            onClick={() => onFlag(item)}
            className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-semibold text-ink-muted transition hover:text-brand-800"
          >
            <Flag className="h-3 w-3" aria-hidden="true" />
            Flag this item
          </button>
        )}
      </div>
    </Card>
  );
}

export default function RecipientHandover({
  handover,
  projectId,
  onAcknowledge,
  acknowledging = false,
  showAcknowledge = true,
  onDownload,
  onFeedback,
}) {
  const [evidenceId, setEvidenceId] = useState(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [downloading, setDownloading] = useState(false);
  const [feedbackTarget, setFeedbackTarget] = useState(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState('');
  const [showAllOwn, setShowAllOwn] = useState(false);
  const [showAllBlocked, setShowAllBlocked] = useState(false);

  const counts = useMemo(() => {
    const result = {};
    for (const item of handover.items || []) {
      result[item.type] = (result[item.type] || 0) + 1;
    }
    return result;
  }, [handover.items]);

  const items = (handover.items || []).filter(
    (item) => typeFilter === 'all' || item.type === typeFilter,
  );

  const acknowledged = handover.status === 'acknowledged';
  const superseded = handover.status === 'superseded';
  const canAct = !superseded;
  const snapshot = handover.snapshot || {};
  const contentChanged = Boolean(handover.permissionRecheck?.contentChanged);
  const firstWeek = handover.firstWeek;

  const download = async () => {
    if (!onDownload) return;
    setDownloading(true);
    try {
      await onDownload();
    } finally {
      setDownloading(false);
    }
  };

  const openFeedback = (item = null) => {
    setFeedbackTarget(item ? { claimId: item.claimId, statement: item.statement } : { claimId: null });
    setFeedbackText('');
    setFeedbackError('');
    setFeedbackSent('');
  };

  const sendFeedback = async () => {
    if (!feedbackTarget || !onFeedback) return;
    if (feedbackText.trim().length < 5) {
      setFeedbackError('Write at least a short sentence so the team can act on it.');
      return;
    }
    setFeedbackSending(true);
    setFeedbackError('');
    try {
      await onFeedback({
        message: feedbackText.trim(),
        claimId: feedbackTarget.claimId || undefined,
      });
      setFeedbackTarget(null);
      setFeedbackSent(
        feedbackTarget.claimId
          ? 'Your note was sent to the project team with this item attached.'
          : 'Your note was sent to the project team.',
      );
    } catch (error) {
      setFeedbackError(errorMessage(error));
    } finally {
      setFeedbackSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      {superseded && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] leading-5 text-amber-900"
        >
          <p className="font-semibold">This handover was superseded</p>
          <p className="mt-0.5 text-amber-900/85">
            A newer handover replaced it
            {handover.supersededByVersion ? ` (v${handover.supersededByVersion})` : ''} and its
            share link was revoked. It stays here as read-only history, so you cannot acknowledge
            or comment on it.{' '}
            {handover.supersededById && (
              <Link
                to={`/projects/${projectId}/handovers/${handover.supersededById}`}
                className="font-semibold underline underline-offset-2"
              >
                Open the current handover
              </Link>
            )}
          </p>
        </div>
      )}
      <div className="mb-5 overflow-hidden rounded-card border border-line bg-white shadow-card">
        <div className="border-b border-line bg-brand-950 px-5 py-5 text-white sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-brand-200">
                {snapshot.projectKey || 'Handover'} · Prepared for {handover.recipientSnapshot?.name}
              </p>
              <h1 className="mt-1.5 font-display text-[23px] font-semibold leading-tight tracking-[-0.02em] text-white sm:text-[27px]">
                {snapshot.projectName || 'Project handover'}
              </h1>
              <p className="mt-1.5 max-w-2xl text-[12.5px] leading-5 text-brand-100/75">
                {snapshot.generatedSummary ||
                  'A reviewed handover containing only items whose evidence you are authorized to read.'}
              </p>
            </div>
            <Badge
              tone={superseded ? 'slate' : acknowledged ? 'green' : 'amber'}
              className="border-white/20 bg-white/10 text-white"
            >
              {superseded ? 'Superseded' : acknowledged ? 'Acknowledged' : 'Shared with you'}
            </Badge>
          </div>
        </div>

        <div className="grid gap-4 px-5 py-4 sm:grid-cols-3 sm:px-6">
          <div>
            <p className="eyebrow">Prepared by</p>
            <p className="mt-1 text-[12px] font-semibold">
              {handover.createdBySnapshot?.name || 'Project team'}
            </p>
            <p className="text-[10.5px] text-ink-muted">
              {snapshot.outgoingName && snapshot.plannedDepartureAt
                ? `${snapshot.outgoingName} rotates off ${formatDate(snapshot.plannedDepartureAt)}`
                : 'Reviewed before release'}
            </p>
          </div>
          <div>
            <p className="eyebrow">Approved</p>
            <p className="mt-1 text-[12px] font-semibold">
              {handover.approvedAt ? formatDateTime(handover.approvedAt) : 'Recorded as approved'}
            </p>
            <p className="text-[10.5px] text-ink-muted">Version {handover.version} · lead sign-off</p>
          </div>
          <div>
            <p className="eyebrow">Your access</p>
            <p className="mt-1 text-[12px] font-semibold">
              {handover.roleTemplate === 'executive'
                ? 'Executive summary'
                : handover.roleTemplate === 'audit'
                  ? 'Audit record'
                  : 'Onboarding handover'}
            </p>
            <p className="text-[10.5px] text-ink-muted">
              {handover.items?.length || 0} items · permissions rechecked now
            </p>
          </div>
        </div>
      </div>

      {handover.freshness?.status === 'outdated' && (
        <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 px-3.5 py-2.5 text-[12px] leading-5 text-orange-900">
          <div className="flex items-start gap-2">
            <GitCompareArrows className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                A connected source changed after this handover was approved
              </p>
              <p className="text-orange-800/90">
                The project moved on since approval, so some of the items below may differ from
                what the reviewer signed off. The change list shows only what you are allowed to
                read.
              </p>
              {(handover.freshness.changes || []).length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] font-semibold underline-offset-2 hover:underline">
                    View {handover.freshness.changes.length} change
                    {handover.freshness.changes.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-1.5 space-y-1.5">
                    {handover.freshness.changes.map((change) => (
                      <li
                        key={`${change.claimId}-${change.change}`}
                        className="rounded-md border border-orange-200/70 bg-white/70 px-2.5 py-1.5 text-[11px] leading-4"
                      >
                        <Badge tone={change.change === 'removed' ? 'red' : change.change === 'added' ? 'green' : 'amber'}>
                          {change.change}
                        </Badge>
                        <span className="ml-1.5 text-ink-soft">{change.statement}</span>
                        {change.change === 'updated' && (
                          <span className="mt-0.5 block font-mono text-[9.5px] text-ink-muted">
                            {change.fields
                              .map(
                                (field) =>
                                  `${field.field}: ${field.from ?? 'none'} → ${field.to ?? 'none'}`,
                              )
                              .join(' · ')}
                          </span>
                        )}
                        {change.change === 'removed' && change.reason && (
                          <span className="mt-0.5 block font-mono text-[9.5px] text-ink-muted">
                            {change.reason === 'source_removed'
                              ? 'source removed by the project lead'
                              : 'no longer part of the current record'}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        </div>
      )}

      {contentChanged ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-5 text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">Some items changed since this handover was approved</p>
            <p className="text-amber-800/90">
              {handover.permissionRecheck?.note ||
                'Your access to a source changed after this handover was shared. The affected items were removed when you opened this page.'}
            </p>
          </div>
        </div>
      ) : acknowledged ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[12px] text-emerald-900">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <p>
            You acknowledged this handover{' '}
            {handover.acknowledgedAt ? formatDateTime(handover.acknowledgedAt) : ''}. Your
            acknowledgement is recorded in the project audit trail.
          </p>
        </div>
      ) : (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-white/70 px-3.5 py-2.5 text-[11px] leading-5 text-ink-muted">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          <p>
            Access was rechecked when you opened this handover. Every item below links to a source
            your role can read; restricted items are not displayed at all.
          </p>
        </div>
      )}

      {handover.redactions?.count > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-white/70 px-3.5 py-2.5 text-[11px] leading-5 text-ink-muted">
          <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
          <p>
            <span className="font-semibold text-ink-soft">
              {handover.redactions.count === 1
                ? '1 sensitive value was redacted'
                : `${handover.redactions.count} sensitive values were redacted`}
            </span>{' '}
            before this handover was shared. Emails, phone numbers, credentials and 12-digit IDs
            are replaced with a typed marker; the source documents are unchanged.
          </p>
        </div>
      )}

      {handover.alerts?.length > 0 && (
        <div className="mb-4 space-y-2">
          {handover.alerts.map((alert, index) => (
            <div
              key={`${alert.code}-${index}`}
              className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12px] leading-5 ${
                alert.severity === 'critical'
                  ? 'border-red-200 bg-red-50 text-red-900'
                  : alert.severity === 'warning'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-blue-200 bg-blue-50 text-blue-900'
              }`}
            >
              {alert.severity === 'info' ? (
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              <div className="flex-1">
                <SeverityBadge severity={alert.severity} />
                <p className="mt-1">{alert.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {snapshot.transitionContext && (
        <Card className="mb-4 p-4">
          <p className="eyebrow mb-1.5">Transition context</p>
          <p className="text-[12px] leading-5 text-ink-soft">{snapshot.transitionContext}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {snapshot.phase && <Badge tone="navy">{snapshot.phase}</Badge>}
            {typeof snapshot.readinessScore === 'number' && (
              <Badge tone="slate">Readiness {snapshot.readinessScore}/100</Badge>
            )}
            {snapshot.lastActivityAt && (
              <Badge tone="slate">Last activity {formatDate(snapshot.lastActivityAt)}</Badge>
            )}
          </div>
        </Card>
      )}

      {firstWeek && (
        <Card className="mb-4 p-4">
          <SectionHeading
            eyebrow="Your first week"
            title="What you own, what is blocked, what to do first"
            description="Built from the approved items in this handover. Recommendations are prompts, not extracted facts."
          />
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="eyebrow mb-1.5">You own {firstWeek.youOwn.length}</p>
              {firstWeek.youOwn.length === 0 ? (
                <p className="text-[11px] leading-4 text-ink-muted">
                  No open item in this handover names you as the owner.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {firstWeek.youOwn.slice(0, showAllOwn ? undefined : 6).map((entry) => (
                    <li key={entry.claimId} className="rounded-md border border-line bg-slate-50/70 px-2.5 py-1.5">
                      <p className="text-[11.5px] font-medium leading-4">{entry.statement}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[9.5px] text-ink-muted">
                        <span>{CLAIM_TYPES[entry.type]?.label || entry.type}</span>
                        <span>{entry.dueAt ? `due ${formatDate(entry.dueAt)}` : 'no due date'}</span>
                        {entry.changedSinceApproval && <span className="text-amber-700">changed since approval</span>}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {firstWeek.youOwn.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAllOwn((value) => !value)}
                  aria-expanded={showAllOwn}
                  className="mt-1.5 text-[11px] font-semibold text-brand-700 hover:text-brand-900"
                >
                  {showAllOwn ? 'Show fewer' : `View all ${firstWeek.youOwn.length}`}
                </button>
              )}
            </div>
            <div>
              <p className="eyebrow mb-1.5">Blocked {firstWeek.blocked.length}</p>
              {firstWeek.blocked.length === 0 ? (
                <p className="text-[11px] leading-4 text-ink-muted">
                  Nothing in this handover is recorded as blocked.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {firstWeek.blocked.slice(0, showAllBlocked ? undefined : 6).map((entry) => (
                    <li key={entry.claimId} className="rounded-md border border-line bg-slate-50/70 px-2.5 py-1.5">
                      <p className="text-[11.5px] font-medium leading-4">{entry.statement}</p>
                      <p className="mt-0.5 font-mono text-[9.5px] text-ink-muted">
                        {CLAIM_TYPES[entry.type]?.label || entry.type}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {firstWeek.blocked.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAllBlocked((value) => !value)}
                  aria-expanded={showAllBlocked}
                  className="mt-1.5 text-[11px] font-semibold text-brand-700 hover:text-brand-900"
                >
                  {showAllBlocked ? 'Show fewer' : `View all ${firstWeek.blocked.length}`}
                </button>
              )}
            </div>
          </div>
          {firstWeek.doFirst.length > 0 && (
            <div className="mt-3.5 border-t border-line pt-2.5">
              <p className="eyebrow mb-1.5">Do first</p>
              <ol className="space-y-1.5">
                {firstWeek.doFirst.map((entry, index) => (
                  <li key={`${entry.kind}-${index}`} className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-900 font-mono text-[9px] font-semibold text-white">
                      {index + 1}
                    </span>
                    <div>
                      <p className="text-[11.5px] font-medium leading-4">{entry.title}</p>
                      <p className="text-[10.5px] leading-4 text-ink-muted">{entry.reason}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Card>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionHeading
          eyebrow="Approved content"
          title={`${handover.items?.length || 0} items`}
          description="Only items the reviewer accepted or edited are included."
        />
        <div className="flex flex-wrap items-center gap-2">
          {onDownload && (
            <Button
              variant="secondary"
              icon={Download}
              loading={downloading}
              onClick={download}
            >
              Download PDF
            </Button>
          )}
          {showAcknowledge && !acknowledged && canAct && (
            <Button
              icon={CheckCircle2}
              loading={acknowledging}
              onClick={() =>
                onAcknowledge?.(
                  'I confirm I have received and reviewed this handover.',
                )
              }
            >
              Acknowledge receipt
            </Button>
          )}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setTypeFilter('all')}
          className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition ${
            typeFilter === 'all'
              ? 'border-brand-300 bg-brand-50 text-brand-800'
              : 'border-line bg-white text-ink-muted hover:border-brand-200'
          }`}
        >
          All <span className="font-mono text-[9.5px]">{handover.items?.length || 0}</span>
        </button>
        {Object.entries(counts).map(([type, count]) => (
          <button
            key={type}
            type="button"
            onClick={() => setTypeFilter(type)}
            className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition ${
              typeFilter === type
                ? 'border-brand-300 bg-brand-50 text-brand-800'
                : 'border-line bg-white text-ink-muted hover:border-brand-200'
            }`}
          >
            {CLAIM_TYPES[type]?.label || type}
            <span className="font-mono text-[9.5px]">{count}</span>
          </button>
        ))}
      </div>

      <div className="space-y-2.5">
        {items.map((item) => (
          <ReadOnlyItem
            key={item.claimId}
            item={item}
            onEvidence={setEvidenceId}
            onFlag={onFeedback && canAct ? openFeedback : undefined}
          />
        ))}
        {items.length === 0 && (
          <EmptyState
            icon={LockKeyhole}
            title="No approved items in this view"
            description="No items of this type were approved for sharing, or your access changed."
          />
        )}
      </div>

      {onFeedback && canAct && (
        <Card className="mt-4 p-4" data-testid="recipient-feedback">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <SectionHeading
              eyebrow="Two-way handover"
              title="Something unclear or wrong?"
              description="Send a note straight to the project lead. Flag a specific item to keep the thread attached to it."
            />
            <Button
              variant="secondary"
              size="sm"
              icon={MessageSquare}
              onClick={() => openFeedback()}
            >
              Send a note
            </Button>
          </div>
          {feedbackSent && (
            <p
              role="status"
              className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] leading-4 text-emerald-900"
            >
              {feedbackSent}
            </p>
          )}
        </Card>
      )}

      {handover.recommendations?.length > 0 && (
        <Card className="mt-4 p-4">
          <SectionHeading
            eyebrow="Inferred · not extracted facts"
            title="Suggested next actions"
            description="Recommendations generated from the same reconstructed state. Treat them as prompts, not project facts."
          />
          <div className="mt-3 divide-y divide-line">
            {handover.recommendations.map((action) => (
              <div key={action.key} className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
                <Badge
                  tone={
                    action.priority === 'critical'
                      ? 'red'
                      : action.priority === 'high'
                        ? 'orange'
                        : 'amber'
                  }
                >
                  {action.priority}
                </Badge>
                <div>
                  <p className="text-[12px] font-medium leading-5">{action.title}</p>
                  <p className="mt-0.5 text-[10.5px] leading-4 text-ink-muted">{action.reason}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-4 rounded-card border border-line bg-slate-50/70 px-4 py-3">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" aria-hidden="true" />
          <p className="text-[10.5px] leading-4 text-ink-muted">
            This handover was assembled by Threadline and approved by a project lead. Every included
            claim is linked to a source quote
            {handover.redactions?.count > 0
              ? '; sensitive values were replaced before sharing.'
              : '.'}{' '}
            Items you are not authorized to see are never sent to this view.
          </p>
        </div>
      </div>

      {showAcknowledge && !acknowledged && canAct && (
        <div className="mt-4 flex justify-end">
          <Button
            size="lg"
            icon={CheckCircle2}
            loading={acknowledging}
            onClick={() => onAcknowledge?.('I confirm I have received and reviewed this handover.')}
          >
            Acknowledge receipt
          </Button>
        </div>
      )}

      <Modal
        open={Boolean(feedbackTarget)}
        onClose={() => {
          if (!feedbackSending) setFeedbackTarget(null);
        }}
        title={feedbackTarget?.claimId ? 'Flag this item' : 'Send a note to the project team'}
        description={
          feedbackTarget?.claimId
            ? 'The note is attached to the item below so the lead can see exactly what needs checking.'
            : 'The lead sees this note in the handover workspace. Please keep it to project details.'
        }
        footer={
          <>
            <Button
              variant="ghost"
              disabled={feedbackSending}
              onClick={() => setFeedbackTarget(null)}
            >
              Cancel
            </Button>
            <Button icon={Send} loading={feedbackSending} onClick={sendFeedback}>
              Send note
            </Button>
          </>
        }
      >
        {feedbackTarget?.statement && (
          <div className="mb-4 rounded-md border border-line bg-slate-50 px-3 py-2">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ink-muted">Item</p>
            <p className="mt-1 text-[12px] font-medium leading-5 text-ink-soft">
              {feedbackTarget.statement}
            </p>
          </div>
        )}
        <Field
          label="Your note"
          hint="Plain text, up to 1000 characters. Emails, phone numbers and credentials are redacted before the note is stored."
          error={feedbackError}
          htmlFor="recipient-feedback-message"
        >
          <Textarea
            id="recipient-feedback-message"
            value={feedbackText}
            onChange={(event) => setFeedbackText(event.target.value)}
            maxLength={1000}
            rows={5}
            autoFocus
            placeholder="What should the project team check?"
          />
        </Field>
      </Modal>

      <EvidenceDrawer
        projectId={projectId}
        handoverId={handover.id}
        evidenceId={evidenceId}
        open={Boolean(evidenceId)}
        onClose={() => setEvidenceId(null)}
      />
    </div>
  );
}
