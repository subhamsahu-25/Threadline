import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Info,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { formatDate, formatDateTime } from '../lib/format.js';
import { CLAIM_TYPES } from '../lib/constants.js';
import { TypeBadge, StateBadge, SensitivityBadge, SeverityBadge } from './badges.jsx';
import { CitationList } from './ClaimCard.jsx';
import EvidenceDrawer from './EvidenceDrawer.jsx';
import { Badge, Button, Card, EmptyState, SectionHeading } from './ui.jsx';

function ReadOnlyItem({ item, onEvidence }) {
  const edited = item.decision === 'edited';
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <TypeBadge type={item.type} />
        <StateBadge state={item.state} />
        {item.sensitivity === 'confidential' && <SensitivityBadge sensitivity="confidential" />}
        {edited && <Badge tone="blue">Reviewed wording</Badge>}
        {item.acceptedWithoutEvidence && <Badge tone="orange">Accepted without evidence</Badge>}
        <span className="ml-auto font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
          #{String(item.claimId).slice(-6)}
        </span>
      </div>
      <p className="mt-2.5 text-[13px] font-medium leading-6 text-ink">{item.statement}</p>
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
      {(item.ownerName || item.dueAt || item.occurredAt) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <UserRound className="h-3 w-3 text-ink-faint" aria-hidden="true" />
            {item.ownerName || 'No owner recorded'}
          </span>
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
}) {
  const [evidenceId, setEvidenceId] = useState(null);
  const [typeFilter, setTypeFilter] = useState('all');

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
  const snapshot = handover.snapshot || {};
  const revoked = handover.permissionRecheck?.revokedItems || 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5 overflow-hidden rounded-card border border-line bg-white shadow-card">
        <div className="border-b border-line bg-brand-950 px-5 py-5 text-white sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-brand-200">
                {snapshot.projectKey || 'Handover'} · Prepared for {handover.recipientSnapshot?.name}
              </p>
              <h1 className="mt-1.5 font-display text-[23px] font-semibold leading-tight tracking-[-0.02em] sm:text-[27px]">
                {snapshot.projectName || 'Project handover'}
              </h1>
              <p className="mt-1.5 max-w-2xl text-[12.5px] leading-5 text-brand-100/75">
                {snapshot.generatedSummary ||
                  'A reviewed handover containing only items whose evidence you are authorized to read.'}
              </p>
            </div>
            <Badge
              tone={acknowledged ? 'green' : 'amber'}
              className="border-white/20 bg-white/10 text-white"
            >
              {acknowledged ? 'Acknowledged' : 'Shared with you'}
            </Badge>
          </div>
        </div>

        <div className="grid gap-4 px-5 py-4 sm:grid-cols-3 sm:px-6">
          <div>
            <p className="eyebrow">Prepared by</p>
            <p className="mt-1 text-[12px] font-semibold">
              {snapshot.outgoingName || 'Project team'}
            </p>
            <p className="text-[10.5px] text-ink-muted">
              {snapshot.plannedDepartureAt
                ? `Departure ${formatDate(snapshot.plannedDepartureAt)}`
                : 'Project handover'}
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

      {revoked > 0 ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-5 text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">Some items are no longer shown</p>
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

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionHeading
          eyebrow="Approved content"
          title={`${handover.items?.length || 0} items`}
          description="Only items the reviewer accepted or edited are included."
        />
        {showAcknowledge && !acknowledged && (
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
          <ReadOnlyItem key={item.claimId} item={item} onEvidence={setEvidenceId} />
        ))}
        {items.length === 0 && (
          <EmptyState
            icon={LockKeyhole}
            title="No approved items in this view"
            description="No items of this type were approved for sharing, or your access changed."
          />
        )}
      </div>

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
            claim is linked to a verbatim source quote. Items you are not authorized to see are never
            sent to this view.
          </p>
        </div>
      </div>

      {showAcknowledge && !acknowledged && (
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

      <EvidenceDrawer
        projectId={projectId}
        evidenceId={evidenceId}
        open={Boolean(evidenceId)}
        onClose={() => setEvidenceId(null)}
      />
    </div>
  );
}
