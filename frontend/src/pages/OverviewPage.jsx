import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleHelp,
  FileWarning,
  GitCompareArrows,
  ListChecks,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sparkles,
  Timer,
  UserRoundX,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api.js';
import { useAsync } from '../hooks/useAsync.js';
import { useToast } from '../context/ToastContext.jsx';
import { useProject } from './ProjectLayout.jsx';
import { formatDate, formatRelative, pluralize, truncate } from '../lib/format.js';
import { TypeIcon } from '../components/badges.jsx';
import EvidenceDrawer from '../components/EvidenceDrawer.jsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  ReadinessRing,
  SectionHeading,
  Select,
  Stat,
  Textarea,
} from '../components/ui.jsx';

const ACTION_MODES = {
  assign_owner: { mode: 'owner', label: 'Assign owner', title: 'Assign an owner' },
  resolve_question: { mode: 'resolve', label: 'Answer', title: 'Answer this open question' },
  mitigate_risk: { mode: 'resolve', label: 'Mitigate', title: 'Record a mitigation' },
  overdue_task: { mode: 'done', label: 'Mark done', title: 'Mark this task done' },
  continue_task: { mode: 'done', label: 'Mark done', title: 'Mark this task done' },
  stale_item: { mode: 'stale', label: 'Resolve', title: 'Close out this stale item' },
  resolve_conflict: { mode: 'jump', label: 'Review conflict', title: 'Confirm the current decision' },
};

function readinessCopy(score) {
  if (score >= 85) return 'Ready for reviewer sign-off';
  if (score >= 65) return 'Mostly ready — close the remaining gaps';
  if (score >= 40) return 'Material gaps remain before handover';
  return 'Not ready to hand over yet';
}

export default function OverviewPage() {
  const { projectId } = useParams();
  const { project, stats } = useProject();
  const navigate = useNavigate();
  const toast = useToast();
  const [evidenceId, setEvidenceId] = useState(null);
  const [resolving, setResolving] = useState(null);
  const [actionTarget, setActionTarget] = useState(null);
  const [actionForm, setActionForm] = useState({ ownerName: '', note: '' });
  const [savingAction, setSavingAction] = useState(false);
  const { data, error, loading, reload } = useAsync(
    () => api.get(`/api/projects/${projectId}/state`),
    [projectId],
  );

  const derived = useMemo(() => {
    if (!data) return null;
    const counts = data.summary?.counts || {};
    const claimById = new Map((data.timeline || []).map((claim) => [claim.id, claim]));
    const evidenceTotal = (data.timeline || []).reduce(
      (sum, claim) => sum + (claim.evidenceCount || 0),
      0,
    );
    const verifiedTotal = (data.timeline || []).reduce(
      (sum, claim) => sum + (claim.verifiedEvidenceCount || 0),
      0,
    );
    return {
      counts,
      claimById,
      evidenceTotal,
      verifiedTotal,
      verificationRate: evidenceTotal > 0 ? Math.round((verifiedTotal / evidenceTotal) * 100) : 0,
    };
  }, [data]);

  const evidenceForClaim = (claim) => claim?.citations?.[0]?.evidenceId;

  const goToClaims = (params = {}) => {
    const search = new URLSearchParams(params).toString();
    navigate(`/projects/${projectId}/claims${search ? `?${search}` : ''}`);
  };

  const resolveConflict = async (conflict, statement) => {
    if (resolving) return;
    const confirmed = window.confirm(
      `Keep "${truncate(statement.statement, 90)}" as the current decision on "${
        conflict.topic || 'this topic'
      }"?\n\nThe other statement(s) will be marked superseded and left out of future handovers.`,
    );
    if (!confirmed) return;

    setResolving(String(statement.claimId));
    try {
      const result = await api.post(`/api/projects/${projectId}/conflicts/resolve`, {
        topicKey: conflict.topicKey,
        keepClaimId: statement.claimId,
      });
      toast.success(
        `Decision confirmed — ${pluralize(
          result.supersededClaimIds?.length || 0,
          'other statement',
        )} marked superseded`,
      );
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setResolving(null);
    }
  };

  const openAction = (action, claim) => {
    const config = ACTION_MODES[action.kind];
    if (!config || !claim) return;
    if (config.mode === 'jump') {
      document.getElementById('conflicts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setActionForm({ ownerName: '', note: '' });
    setActionTarget({ action, claim, config });
  };

  const submitAction = async (event) => {
    event.preventDefault();
    if (!actionTarget || savingAction) return;
    const { action, claim, config } = actionTarget;
    const payload = {};
    if (config.mode === 'owner') {
      if (!actionForm.ownerName.trim()) {
        toast.error('Choose who should own this item');
        return;
      }
      payload.ownerName = actionForm.ownerName.trim();
    } else if (config.mode === 'done') {
      payload.status = 'done';
    } else {
      payload.status = 'resolved';
    }
    if (actionForm.note.trim()) payload.note = actionForm.note.trim();

    setSavingAction(true);
    try {
      await api.post(`/api/projects/${projectId}/claims/${claim.id}/resolve`, payload);
      toast.success(
        config.mode === 'owner'
          ? `Owner recorded — ${actionForm.ownerName.trim()} is now accountable`
          : config.mode === 'done'
            ? 'Task marked done'
            : 'Item resolved — the project state will update on reload',
      );
      setActionTarget(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingAction(false);
    }
  };

  if (loading && !data) {
    return (
      <div>
        <div className="skeleton mb-6 h-16 w-2/3 rounded-lg" />
        <LoadingBlock rows={4} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <ErrorState
        title="Could not reconstruct the project state"
        error={error}
        onRetry={() => reload().catch(() => {})}
      />
    );
  }

  const summary = data.summary;
  const counts = derived.counts;
  const readiness = summary.readinessScore;
  const attentionCount =
    (data.conflicts?.length || 0) + (data.ownershipGaps?.length || 0) + (data.unverified?.length || 0);
  const canPrepare = ['lead', 'contributor'].includes(project.role);
  const canResolve = project.role === 'lead';
  const canAct = ['lead', 'contributor'].includes(project.role);

  return (
    <div>
      <PageHeader
        eyebrow={`${project.key} · State of record`}
        title="Project overview"
        description={`Reconstructed from ${summary.counts.total} visible claims across ${stats?.sources ?? '—'} sources. Counts and evidence are filtered to what your role may read.`}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              onClick={() => reload().catch(() => {})}
              loading={loading}
            >
              Refresh
            </Button>
            <Button variant="secondary" size="sm" icon={ListChecks} onClick={() => goToClaims()}>
              All claims
            </Button>
            {canPrepare && (
              <Button
                size="sm"
                icon={ArrowUpRight}
                onClick={() => navigate(`/projects/${projectId}/handovers`, { state: { create: true } })}
              >
                Prepare handover
              </Button>
            )}
          </>
        }
      />

      {attentionCount > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-[12px] text-amber-900">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
          <p className="flex-1">
            <span className="font-semibold">{attentionCount} state issue{attentionCount === 1 ? '' : 's'} need attention</span>
            <span className="text-amber-800/80">
              {' '}
              — {pluralize(data.conflicts?.length || 0, 'conflict')},{' '}
              {pluralize(data.ownershipGaps?.length || 0, 'ownership gap')}, and{' '}
              {pluralize(data.unverified?.length || 0, 'unverified item')}.
            </span>
          </p>
          <span className="font-mono text-[10px] text-amber-700/80">
            generated {formatRelative(data.generatedAt)}
          </span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="p-5 lg:col-span-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="eyebrow">Handover readiness</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge tone="navy">{summary.phase}</Badge>
                <Badge tone="slate">{project.key}</Badge>
              </div>
            </div>
            <ShieldCheck className="h-4 w-4 text-ink-faint" aria-hidden="true" />
          </div>

          <div className="mt-4 flex items-center gap-5">
            <ReadinessRing score={readiness} />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold leading-5">{readinessCopy(readiness)}</p>
              <p className="mt-1 text-[11.5px] leading-5 text-ink-muted">
                A deterministic score from unresolved conflicts, ownership gaps, unverified evidence
                and stale open work.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2 border-t border-line pt-3.5">
            {[
              { label: 'Conflicting decisions', value: data.conflicts?.length || 0, penalty: 10, tone: 'red' },
              { label: 'Tasks without an owner', value: data.ownershipGaps?.length || 0, penalty: 8, tone: 'amber' },
              { label: 'Items needing verification', value: data.unverified?.length || 0, penalty: 3, tone: 'orange' },
              { label: 'Stale open items', value: data.stale?.length || 0, penalty: 0, tone: 'slate' },
            ].map((factor) => (
              <div key={factor.label} className="flex items-center justify-between gap-2 text-[11.5px]">
                <span className="text-ink-muted">{factor.label}</span>
                <span className="flex items-center gap-1.5">
                  {factor.penalty > 0 && factor.value > 0 && (
                    <span className="font-mono text-[9.5px] text-ink-faint">
                      −{Math.min(factor.penalty * factor.value, 30)}
                    </span>
                  )}
                  <Badge tone={factor.value > 0 ? factor.tone : 'green'}>
                    {factor.value === 0 ? 'clear' : factor.value}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5 lg:col-span-8">
          <SectionHeading
            eyebrow="Institutional ledger"
            title="What the project record contains"
            description={`Activity window ${formatDate(summary.activityWindow?.start)} to ${formatDate(summary.activityWindow?.end)}. Last activity ${formatRelative(summary.lastActivityAt)}.`}
          />
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Total claims" value={counts.total || 0} hint="Visible to you" />
            <Stat
              label="Active decisions"
              value={counts.activeDecisions || 0}
              hint={`${counts.byType?.decision || 0} extracted in total`}
            />
            <Stat
              label="Open tasks"
              value={counts.openTasks || 0}
              hint={`${counts.doneTasks || 0} marked done`}
            />
            <Stat
              label="Open risks"
              value={counts.openRisks || 0}
              hint={counts.openRisks > 0 ? 'Require mitigation' : 'No open risks'}
              tone={counts.openRisks > 0 ? 'text-orange-700' : 'text-ink'}
            />
            <Stat
              label="Open questions"
              value={counts.openQuestions || 0}
              hint={counts.openQuestions > 0 ? 'Unresolved in sources' : 'All answered'}
            />
            <Stat
              label="Milestones"
              value={counts.milestones || 0}
              hint="Recorded checkpoints"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-slate-50/70 px-3 py-2.5">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              {derived.verifiedTotal} of {derived.evidenceTotal} citations matched verbatim (
              {derived.verificationRate}%)
            </span>
            <button
              type="button"
              onClick={() => goToClaims()}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 hover:text-brand-900"
            >
              Inspect the ledger <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        </Card>

        {data.conflicts?.length > 0 && (
          <div className="space-y-3 lg:col-span-8" id="conflicts">
            <SectionHeading
              eyebrow="Decision integrity"
              title="Conflicting decisions"
              description="Threadline surfaces the disagreement. It never decides which statement is current — a human must confirm it."
              action={<Badge tone="red" dot>{data.conflicts.length} unresolved</Badge>}
            />
            {data.conflicts.slice(0, 3).map((conflict) => (
              <Card key={conflict.topicKey || conflict.topic} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 border-b border-line bg-red-50/50 px-4 py-2.5">
                  <GitCompareArrows className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
                  <p className="text-[12px] font-semibold text-red-900">
                    Sources disagree about “{conflict.topic || 'this topic'}”
                  </p>
                  <Badge tone="red" className="ml-auto">
                    {conflict.statements.length} statements
                  </Badge>
                </div>
                <div className="divide-y divide-line">
                  {conflict.statements.map((statement, index) => {
                    const claim = derived.claimById.get(String(statement.claimId));
                    const citation = claim?.citations?.[0];
                    return (
                      <div key={statement.claimId} className="px-4 py-3">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-faint">
                            Statement {String.fromCharCode(65 + index)}
                          </span>
                          <span className="font-mono text-[9.5px] text-ink-faint">
                            {formatDate(statement.occurredAt)}
                          </span>
                          {claim?.status === 'superseded' && <Badge tone="slate">Superseded</Badge>}
                          {citation && (
                            <button
                              type="button"
                              onClick={() => setEvidenceId(citation.evidenceId)}
                              className="ml-auto inline-flex items-center gap-1 rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[9.5px] text-brand-700 hover:border-brand-300 hover:bg-brand-50"
                            >
                              <Scale className="h-2.5 w-2.5" aria-hidden="true" />
                              {citation.sourceName}
                            </button>
                          )}
                        </div>
                        <p className="text-[12.5px] leading-5 text-ink-soft">{statement.statement}</p>
                        {canResolve && conflict.topicKey && (
                          <div className="mt-2 flex justify-end">
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={CheckCircle2}
                              loading={resolving === String(statement.claimId)}
                              disabled={Boolean(resolving)}
                              onClick={() => resolveConflict(conflict, statement)}
                            >
                              Keep as current
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-slate-50/70 px-4 py-2.5">
                  <p className="text-[10.5px] text-ink-muted">
                    {canResolve
                      ? 'Confirm the current decision — superseded statements are excluded from future handovers.'
                      : 'Confirm the current decision before this handover is approved.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => goToClaims({ q: conflict.topic || '' })}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 hover:text-brand-900"
                  >
                    Compare in claims <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}

        <div className="space-y-3 lg:col-span-4">
          <Card className="p-4">
            <SectionHeading
              eyebrow="Trace"
              title="Recent activity"
              action={
                <button
                  type="button"
                  onClick={() => goToClaims()}
                  className="text-[11px] font-semibold text-brand-700 hover:text-brand-900"
                >
                  View all
                </button>
              }
            />
            <ol className="mt-3 space-y-0.5">
              {(data.timeline || []).slice(0, 7).map((claim) => {
                const evidence = evidenceForClaim(claim);
                return (
                  <li key={claim.id}>
                    <button
                      type="button"
                      onClick={() => evidence && setEvidenceId(evidence)}
                      disabled={!evidence}
                      className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-slate-50 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-white text-ink-muted">
                        <TypeIcon type={claim.type} className="h-3 w-3" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11.5px] leading-4 text-ink-soft">
                          {truncate(claim.statement, 92)}
                        </span>
                        <span className="mt-0.5 block font-mono text-[9.5px] text-ink-faint">
                          {formatDate(claim.occurredAt)} · {claim.citations?.[0]?.sourceName || 'source'}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {(data.timeline || []).length === 0 && (
                <li className="px-2 py-3 text-[11.5px] text-ink-muted">No claims extracted yet.</li>
              )}
            </ol>
          </Card>

          <Card className="p-4">
            <SectionHeading eyebrow="Open work" title="Questions & risks" />
            <div className="mt-3 space-y-3">
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  <CircleHelp className="h-3 w-3" aria-hidden="true" /> Open questions
                </p>
                {(data.openQuestions || []).slice(0, 3).map((claim) => (
                  <button
                    key={claim.id}
                    type="button"
                    onClick={() => {
                      const evidence = evidenceForClaim(claim);
                      if (evidence) setEvidenceId(evidence);
                    }}
                    className="mb-1 flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-[11.5px] leading-4 text-ink-soft hover:bg-slate-50"
                  >
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                    {truncate(claim.statement, 110)}
                  </button>
                ))}
                {(data.openQuestions || []).length === 0 && (
                  <p className="px-1.5 text-[11px] text-ink-muted">None recorded.</p>
                )}
              </div>
              <div className="border-t border-line pt-2.5">
                <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Open risks
                </p>
                {(data.openRisks || []).slice(0, 3).map((claim) => (
                  <button
                    key={claim.id}
                    type="button"
                    onClick={() => {
                      const evidence = evidenceForClaim(claim);
                      if (evidence) setEvidenceId(evidence);
                    }}
                    className="mb-1 flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-[11.5px] leading-4 text-ink-soft hover:bg-slate-50"
                  >
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-red-500" />
                    {truncate(claim.statement, 110)}
                  </button>
                ))}
                {(data.openRisks || []).length === 0 && (
                  <p className="px-1.5 text-[11px] text-ink-muted">None recorded.</p>
                )}
              </div>
            </div>
          </Card>
        </div>

        {data.conflicts?.length === 0 && (
          <Card className="p-4 lg:col-span-8">
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
                <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-[13px] font-semibold">No conflicting decisions detected</p>
                <p className="mt-0.5 text-[11.5px] leading-5 text-ink-muted">
                  The reconstruction found no active decisions that disagree on the same topic among
                  the claims you can read.
                </p>
              </div>
            </div>
          </Card>
        )}

        {data.ownershipGaps?.length > 0 && (
          <div className="space-y-2.5 lg:col-span-8" id="gaps">
            <SectionHeading
              eyebrow="Accountability"
              title="Ownership gaps"
              description="Open tasks with no recorded owner. Threadline flags them; it does not invent an assignee."
              action={<Badge tone="amber" dot>{data.ownershipGaps.length}</Badge>}
            />
            <div className="grid gap-2.5 sm:grid-cols-2">
              {data.ownershipGaps.map((claim) => (
                <Card key={claim.id} className="p-3.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-50 text-amber-700">
                      <UserRoundX className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                      No owner
                    </span>
                    <span className="ml-auto font-mono text-[9.5px] text-ink-faint">
                      #{String(claim.id).slice(-6)}
                    </span>
                  </div>
                  <p className="mt-2 text-[12px] leading-5 text-ink-soft">{claim.statement}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[9.5px] text-ink-faint">
                      {claim.dueAt ? `Due ${formatDate(claim.dueAt)}` : 'No due date'}
                    </span>
                    {evidenceForClaim(claim) && (
                      <button
                        type="button"
                        onClick={() => setEvidenceId(evidenceForClaim(claim))}
                        className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-brand-700 hover:text-brand-900"
                      >
                        Inspect evidence <ArrowRight className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {data.unverified?.length > 0 && (
          <div className="space-y-2.5 lg:col-span-8" id="unverified">
            <SectionHeading
              eyebrow="Evidence quality"
              title="Needs verification"
              description="The extracted statement could not be matched to a verbatim passage. A reviewer must confirm or reject it."
              action={<Badge tone="orange" dot>{data.unverified.length}</Badge>}
            />
            {data.unverified.slice(0, 4).map((claim) => (
              <Card key={claim.id} className="p-3.5">
                <div className="flex items-start gap-2.5">
                  <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] leading-5 text-ink-soft">{claim.statement}</p>
                    <p className="mt-1 font-mono text-[9.5px] text-ink-faint">
                      {claim.type} · #{String(claim.id).slice(-6)} ·{' '}
                      {claim.citations?.[0]?.sourceName || 'source'}
                    </p>
                  </div>
                  {evidenceForClaim(claim) ? (
                    <button
                      type="button"
                      onClick={() => setEvidenceId(evidenceForClaim(claim))}
                      className="shrink-0 text-[10.5px] font-semibold text-brand-700 hover:text-brand-900"
                    >
                      Inspect
                    </button>
                  ) : (
                    <span className="shrink-0 font-mono text-[9.5px] text-ink-faint">No citation</span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}

        <div className="lg:col-span-8">
          <Card className="p-4">
            <SectionHeading
              eyebrow="Inferred · separate from facts"
              title="Suggested next actions"
              description="Generated from the reconstructed state. These are recommendations, not claims extracted from a source."
              action={<Badge tone="violet">{data.nextActions?.length || 0}</Badge>}
            />
            <div className="mt-3 divide-y divide-line">
              {(data.nextActions || []).slice(0, 6).map((action) => {
                const claim = action.claimIds
                  ?.map((id) => derived.claimById.get(String(id)))
                  .find(Boolean);
                const citation = claim?.citations?.[0];
                return (
                  <div key={action.key} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
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
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-medium leading-5 text-ink">{action.title}</p>
                      <p className="mt-0.5 text-[10.5px] leading-4 text-ink-muted">{action.reason}</p>
                    </div>
                    {citation && (
                      <button
                        type="button"
                        onClick={() => setEvidenceId(citation.evidenceId)}
                        className="shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[9.5px] text-ink-muted hover:border-brand-300 hover:text-brand-800"
                      >
                        evidence
                      </button>
                    )}
                    {canAct && claim && ACTION_MODES[action.kind] && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        onClick={() => openAction(action, claim)}
                      >
                        {ACTION_MODES[action.kind].label}
                      </Button>
                    )}
                  </div>
                );
              })}
              {(data.nextActions || []).length === 0 && (
                <p className="py-3 text-[12px] text-ink-muted">
                  No follow-up actions inferred from the current state.
                </p>
              )}
            </div>
          </Card>
        </div>

        <Card className="p-4 lg:col-span-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
              <Timer className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <p className="text-[12px] font-semibold">Access &amp; evidence integrity</p>
          </div>
          <dl className="mt-3 space-y-2 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Visible claims</dt>
              <dd className="font-mono font-medium text-ink">{summary.counts.total}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Verbatim matches</dt>
              <dd className="font-mono font-medium text-emerald-700">
                {derived.verifiedTotal}/{derived.evidenceTotal}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Withheld from you</dt>
              <dd className="font-mono font-medium text-ink">not disclosed</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">State generated</dt>
              <dd className="font-mono font-medium text-ink">{formatRelative(data.generatedAt)}</dd>
            </div>
          </dl>
          <p className="mt-3 border-t border-line pt-3 text-[10.5px] leading-4 text-ink-muted">
            Hidden sources are never counted here. The API returns only claims whose citations all
            resolve to sources your role can read.
          </p>
        </Card>
      </div>

      {counts.total === 0 && (
        <EmptyState
          className="mt-4"
          icon={Sparkles}
          title="No visible claims yet"
          description="Add a source document or wait for ingestion to finish. Once claims are extracted, the state of record appears here."
          action={
            <Button onClick={() => navigate(`/projects/${projectId}/sources`)}>
              Open sources
            </Button>
          }
        />
      )}

      <Modal
        open={Boolean(actionTarget)}
        onClose={() => {
          if (!savingAction) setActionTarget(null);
        }}
        title={actionTarget?.config.title || 'Update item'}
        description={
          actionTarget
            ? truncate(actionTarget.claim.statement, 140)
            : undefined
        }
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActionTarget(null)}
              disabled={savingAction}
            >
              Cancel
            </Button>
            <Button form="claim-action-form" type="submit" size="sm" disabled={savingAction}>
              {savingAction ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {actionTarget && (
          <form id="claim-action-form" onSubmit={submitAction} className="space-y-4">
            {actionTarget.config.mode === 'owner' ? (
              <Field
                label="Owner"
                htmlFor="action-owner"
                required
                hint="Recorded on the claim and audited. This closes the ownership gap in the readiness score."
              >
                <Select
                  id="action-owner"
                  value={actionForm.ownerName}
                  onChange={(event) =>
                    setActionForm((form) => ({ ...form, ownerName: event.target.value }))
                  }
                >
                  <option value="">Select a project member…</option>
                  {(project.members || []).map((member) => (
                    <option key={member.userId} value={member.name || member.email}>
                      {member.name || member.email} · {member.role}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field
                label="Resolution note"
                htmlFor="action-note"
                hint="Optional. Stored with the item so the reviewer and recipient can see how it was closed out."
              >
                <Textarea
                  id="action-note"
                  rows={3}
                  maxLength={600}
                  placeholder="What was decided, agreed or completed?"
                  value={actionForm.note}
                  onChange={(event) =>
                    setActionForm((form) => ({ ...form, note: event.target.value }))
                  }
                />
              </Field>
            )}
            <p className="rounded-lg border border-line bg-slate-50 px-3 py-2 text-[10.5px] leading-4 text-ink-muted">
              {actionTarget.config.mode === 'done'
                ? 'The item stays in the record with its citation; only its state changes to done.'
                : actionTarget.config.mode === 'owner'
                  ? 'Assignment is audited and does not change what the source said.'
                  : 'Resolving records a human decision. The original extracted statement and quote stay intact.'}
            </p>
          </form>
        )}
      </Modal>

      <EvidenceDrawer
        projectId={projectId}
        evidenceId={evidenceId}
        open={Boolean(evidenceId)}
        onClose={() => setEvidenceId(null)}
      />
    </div>
  );
}
