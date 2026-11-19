import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  FileSignature,
  FileText,
  FolderPlus,
  LogIn,
  MessageSquare,
  Pencil,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Trash2,
  UserMinus,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProject } from './ProjectLayout.jsx';
import { AUDIT_ACTION_LABELS } from '../lib/constants.js';
import { formatDate, formatDateTime, formatIstIso, formatRelative, pluralize } from '../lib/format.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  SearchInput,
  Select,
} from '../components/ui.jsx';

const ACTION_META = {
  'auth.registered': { icon: LogIn, tone: 'navy' },
  'project.created': { icon: FolderPlus, tone: 'green' },
  'project.updated': { icon: Pencil, tone: 'blue' },
  'member.added': { icon: UserPlus, tone: 'green' },
  'member.removed': { icon: UserMinus, tone: 'red' },
  'member.role_changed': { icon: SlidersHorizontal, tone: 'amber' },
  'source.created': { icon: Database, tone: 'blue' },
  'source.ingested': { icon: ShieldCheck, tone: 'green' },
  'source.ingest_failed': { icon: XCircle, tone: 'red' },
  'source.access_changed': { icon: SlidersHorizontal, tone: 'amber' },
  'source.deleted': { icon: Trash2, tone: 'red' },
  'source.reingest_requested': { icon: RefreshCw, tone: 'amber' },
  'claim.conflict_resolved': { icon: CheckCircle2, tone: 'teal' },
  'claim.owner_assigned': { icon: UserPlus, tone: 'blue' },
  'claim.resolved': { icon: CheckCircle2, tone: 'green' },
  'document.viewed': { icon: FileText, tone: 'slate' },
  'handover.created': { icon: FileSignature, tone: 'navy' },
  'handover.item_reviewed': { icon: CheckCircle2, tone: 'blue' },
  'handover.submitted': { icon: Send, tone: 'amber' },
  'handover.approved': { icon: CheckCircle2, tone: 'green' },
  'handover.rejected': { icon: XCircle, tone: 'red' },
  'handover.reopened': { icon: RefreshCw, tone: 'amber' },
  'handover.shared': { icon: Send, tone: 'blue' },
  'handover.share_renewed': { icon: RefreshCw, tone: 'blue' },
  'handover.acknowledged': { icon: ShieldCheck, tone: 'teal' },
  'handover.recipient_viewed': { icon: FileText, tone: 'slate' },
  'handover.feedback_received': { icon: MessageSquare, tone: 'blue' },
  'handover.feedback_resolved': { icon: CheckCircle2, tone: 'green' },
  'handover.permissions_rechecked': { icon: ShieldCheck, tone: 'amber' },
};

const TONE_STYLES = {
  navy: 'border-brand-200 bg-brand-50 text-brand-700',
  blue: 'border-blue-200 bg-blue-50 text-blue-700',
  green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-700',
  red: 'border-red-200 bg-red-50 text-red-700',
  teal: 'border-teal-200 bg-teal-50 text-teal-700',
  slate: 'border-slate-200 bg-slate-50 text-slate-600',
};

function metaSummary(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const parts = [];
  if (meta.from && meta.to) parts.push(`role: ${meta.from} → ${meta.to}`);
  else if (meta.role) parts.push(`role: ${meta.role}`);
  if (meta.changed) parts.push(`changed: ${[].concat(meta.changed).join(', ')}`);
  if (meta.files) parts.push(`${meta.files.length} file${meta.files.length === 1 ? '' : 's'}`);
  if (meta.visibility?.scope) parts.push(`visible to: ${meta.visibility.scope}`);
  if (meta.before && meta.after) parts.push('access rule changed');
  if (meta.decision) parts.push(`decision: ${meta.decision}`);
  if (typeof meta.withheld === 'number') parts.push(`${meta.withheld} withheld`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function csvCell(value) {
  if (value === undefined || value === null) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function EventRow({ event }) {
  const [open, setOpen] = useState(false);
  const config = ACTION_META[event.action] || { icon: ScrollText, tone: 'slate' };
  const Icon = config.icon;
  const label = AUDIT_ACTION_LABELS[event.action] || event.action;
  const summary = metaSummary(event.meta);
  const hasMeta = event.meta && Object.keys(event.meta).length > 0;

  return (
    <li className="relative pl-10">
      <span
        className={`absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full border ${TONE_STYLES[config.tone]}`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="pb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-[12.5px] leading-5 text-ink-soft">
            <span className="font-semibold text-ink">{event.actorName || 'System'}</span>{' '}
            <span className="text-ink-muted">{label.toLowerCase()}</span>
            {event.targetLabel && (
              <>
                {' '}
                <span className="font-medium text-ink">“{event.targetLabel}”</span>
              </>
            )}
          </p>
          <span
            className="font-mono text-[10px] text-ink-faint"
            title={formatDateTime(event.createdAt)}
          >
            {formatRelative(event.createdAt)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[9.5px] text-ink-faint">
          <span>{event.action}</span>
          {event.targetType && <span className="text-line-strong">·</span>}
          {event.targetType && <span>{event.targetType}</span>}
          {event.ip && <span className="text-line-strong">·</span>}
          {event.ip && <span>{event.ip}</span>}
          {summary && (
            <>
              <span className="text-line-strong">·</span>
              <span className="font-sans text-[10px] normal-case tracking-normal text-ink-muted">
                {summary}
              </span>
            </>
          )}
          {hasMeta && (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-sans text-[10px] font-medium normal-case tracking-normal text-brand-700 hover:bg-brand-50"
              aria-expanded={open}
            >
              {open ? 'Hide details' : 'Details'}
              <ChevronDown
                className={`h-3 w-3 transition ${open ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
          )}
        </div>
        {open && hasMeta && (
          <pre className="scroll-safe mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-slate-50 p-3 font-mono text-[10.5px] leading-5 text-ink-soft">
            {JSON.stringify(event.meta, null, 2)}
          </pre>
        )}
      </div>
    </li>
  );
}

export default function AuditPage() {
  const { projectId } = useParams();
  const { project } = useProject();
  const isLead = project.role === 'lead';
  const [query, setQuery] = useState('');
  const [action, setAction] = useState('all');
  const [actor, setActor] = useState('all');

  const { data, error, loading, reload } = useAsync(
    () =>
      isLead
        ? api.get(`/api/projects/${projectId}/audit?limit=200`)
        : Promise.resolve({ events: [] }),
    [projectId, isLead],
  );

  const events = data?.events || [];

  const actions = useMemo(
    () => [...new Set(events.map((event) => event.action))].sort(),
    [events],
  );
  const actors = useMemo(
    () => [...new Set(events.map((event) => event.actorName).filter(Boolean))].sort(),
    [events],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return events.filter((event) => {
      if (action !== 'all' && event.action !== action) return false;
      if (actor !== 'all' && event.actorName !== actor) return false;
      if (!term) return true;
      return (
        (event.actorName || '').toLowerCase().includes(term) ||
        (event.targetLabel || '').toLowerCase().includes(term) ||
        (AUDIT_ACTION_LABELS[event.action] || event.action).toLowerCase().includes(term) ||
        (event.ip || '').toLowerCase().includes(term)
      );
    });
  }, [events, query, action, actor]);

  const grouped = useMemo(() => {
    const groups = new Map();
    for (const event of filtered) {
      const key = formatDate(event.createdAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    return [...groups.entries()];
  }, [filtered]);

  // The CSV is built from the rows this screen already received from the
  // lead-only, redaction-filtered audit endpoint. It never reads the database
  // and never adds an event the viewer cannot see.
  const exportCsv = () => {
    if (filtered.length === 0) return;
    const header = [
      'timestamp',
      'actor',
      'action',
      'label',
      'target_type',
      'target_id',
      'ip',
      'details',
    ];
    const rows = filtered.map((event) => [
      formatIstIso(event.createdAt),
      event.actorName,
      event.action,
      event.targetLabel,
      event.targetType,
      event.targetId,
      event.ip,
      event.meta && Object.keys(event.meta).length > 0 ? JSON.stringify(event.meta) : '',
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.key.toLowerCase()}-audit-${formatIstIso(new Date()).slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  if (!isLead) {
    return (
      <div>
        <PageHeader
          eyebrow={`${project.key} · Governance`}
          title="Audit log"
          description="Every access change, review decision and share action is recorded for the project lead."
        />
        <Card className="mx-auto max-w-xl p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-slate-50 text-ink-muted">
            <ShieldX className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2 className="text-[15px] font-semibold">The audit log is restricted to project leads</h2>
          <p className="mx-auto mt-2 max-w-sm text-[12.5px] leading-5 text-ink-muted">
            You are signed in as {project.role === 'observer' ? 'an observer' : 'a contributor'} on{' '}
            {project.name}. Ask the project lead if you need an export of governance events.
          </p>
          <Badge tone="slate" className="mt-4">
            server-enforced · 403
          </Badge>
        </Card>
      </div>
    );
  }

  const lastEvent = events[0];
  const activeFilters = query.trim() || action !== 'all' || actor !== 'all';

  return (
    <div>
      <PageHeader
        eyebrow={`${project.key} · Governance`}
        title="Audit log"
        description="An append-only record of who did what, when, from where. Use it to prove that restricted material stayed restricted and that a handover was reviewed before release."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              disabled={filtered.length === 0}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={loading}
              onClick={() => reload().catch(() => {})}
            >
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
            Recorded events
          </p>
          <p className="mt-1 font-display text-[22px] font-semibold leading-none">
            {events.length}
          </p>
          <p className="mt-1 text-[11px] text-ink-muted">Newest 200 retained in this view</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
            Distinct actors
          </p>
          <p className="mt-1 font-display text-[22px] font-semibold leading-none">
            {actors.length}
          </p>
          <p className="mt-1 text-[11px] text-ink-muted">
            {pluralize(actions.length, 'event type')} observed
          </p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
            Latest activity
          </p>
          <p className="mt-1 font-display text-[22px] font-semibold leading-none">
            {lastEvent ? formatRelative(lastEvent.createdAt) : '—'}
          </p>
          <p className="mt-1 truncate text-[11px] text-ink-muted">
            {lastEvent
              ? `${lastEvent.actorName} · ${AUDIT_ACTION_LABELS[lastEvent.action] || lastEvent.action}`
              : 'No events recorded yet'}
          </p>
        </Card>
      </div>

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actor, target or IP"
            className="min-w-[220px] flex-1"
          />
          <Select
            value={action}
            onChange={(event) => setAction(event.target.value)}
            aria-label="Filter by event type"
            className="w-auto min-w-[180px]"
          >
            <option value="all">All event types</option>
            {actions.map((value) => (
              <option key={value} value={value}>
                {AUDIT_ACTION_LABELS[value] || value}
              </option>
            ))}
          </Select>
          <Select
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            aria-label="Filter by actor"
            className="w-auto min-w-[160px]"
          >
            <option value="all">All actors</option>
            {actors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          {activeFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery('');
                setAction('all');
                setActor('all');
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </Card>

      {loading && !data ? (
        <LoadingBlock rows={4} />
      ) : error ? (
        <ErrorState
          title="Could not load the audit log"
          error={error}
          onRetry={() => reload().catch(() => {})}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={activeFilters ? Search : ScrollText}
          title={activeFilters ? 'No events match these filters' : 'No audit events yet'}
          description={
            activeFilters
              ? 'Clear the filters to see the full governance record.'
              : 'Adding members, changing source access, reviewing and sharing handovers will appear here.'
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line bg-slate-50/60 px-4 py-2.5">
            <p className="text-[11.5px] text-ink-muted">
              Showing <span className="font-semibold text-ink">{filtered.length}</span> of{' '}
              {pluralize(events.length, 'event')} · the CSV export uses the same filtered rows
            </p>
            <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] text-ink-faint">
              <ShieldCheck className="h-3 w-3 text-emerald-600" aria-hidden="true" />
              append-only · visible to leads
            </span>
          </div>
          <div className="px-4 pt-4">
            {grouped.map(([day, dayEvents]) => (
              <section key={day} className="mb-2">
                <h2 className="mb-2.5 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                  {day}
                  <span className="h-px flex-1 bg-line" aria-hidden="true" />
                  <span className="font-mono text-[9.5px] font-normal text-ink-faint">
                    {dayEvents.length}
                  </span>
                </h2>
                <ol className="relative border-l border-line/80 pl-0">
                  {dayEvents.map((event) => (
                    <EventRow key={event.id} event={event} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
