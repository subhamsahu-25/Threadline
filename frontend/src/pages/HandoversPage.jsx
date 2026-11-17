import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileSignature,
  GitCompareArrows,
  LockKeyhole,
  Plus,
  RefreshCw,
  Send,
  Share2,
  ShieldCheck,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProject } from './ProjectLayout.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { HANDOVER_STATUS, TEMPLATES } from '../lib/constants.js';
import { formatRelative, pluralize } from '../lib/format.js';
import { HandoverStatusBadge, RoleBadge } from '../components/badges.jsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
} from '../components/ui.jsx';

function HandoverCard({ handover, projectId, currentUserId, onOpen }) {
  const received = String(handover.recipient) === String(currentUserId);
  const status = HANDOVER_STATUS[handover.status] || { label: handover.status };
  const actionable =
    handover.status === 'draft' || handover.status === 'in_review'
      ? handover.pendingCount
      : null;
  const showsReviewState = typeof handover.itemCount === 'number';
  const outdated = handover.freshness?.status === 'outdated';

  return (
    <Card className="p-4 transition hover:border-brand-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={handover.recipientSnapshot?.name} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="text-[14px] font-semibold leading-5">
                Handover for {handover.recipientSnapshot?.name || 'recipient'}
              </h2>
              <HandoverStatusBadge status={handover.status} />
              {outdated && (
                <Badge tone="orange" dot title="A connected source changed after this handover was reviewed">
                  Outdated
                </Badge>
              )}
              {received && <Badge tone="navy">Yours</Badge>}
            </div>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              {TEMPLATES[handover.roleTemplate]?.label || handover.roleTemplate} · v
              {handover.version} · updated {formatRelative(handover.updatedAt)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
              {showsReviewState && (
                <>
                  <span>{pluralize(handover.itemCount, 'reviewable item')}</span>
                  {handover.status === 'draft' || handover.status === 'in_review' ? (
                    <span
                      className={
                        handover.pendingCount > 0 ? 'font-medium text-amber-700' : 'text-emerald-700'
                      }
                    >
                      {handover.pendingCount > 0
                        ? `${handover.pendingCount} awaiting decision`
                        : 'All items decided'}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden="true" />
                      {status.label}
                    </span>
                  )}
                </>
              )}
              {handover.status === 'shared' && (
                <span className="inline-flex items-center gap-1">
                  <Send className="h-3 w-3" aria-hidden="true" />
                  Shared {formatRelative(handover.sharedAt)}
                </span>
              )}
              {handover.status === 'acknowledged' && (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                  Acknowledged {formatRelative(handover.acknowledgedAt)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {actionable > 0 && (
            <Badge tone="amber" dot>
              review
            </Badge>
          )}
          <Button
            size="sm"
            variant={received && ['shared', 'acknowledged'].includes(handover.status) ? 'primary' : 'secondary'}
            iconRight={ArrowRight}
            onClick={onOpen}
          >
            {received && ['shared', 'acknowledged'].includes(handover.status) ? 'Open received' : 'Open'}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2.5 font-mono text-[9.5px] text-ink-faint">
        <span className="inline-flex items-center gap-1">
          <Clock3 className="h-2.5 w-2.5" /> created {formatRelative(handover.createdAt)}
        </span>
        <span>#{String(handover.id).slice(-8)}</span>
        <span className="inline-flex items-center gap-1">
          <RoleBadge role={handover.recipientSnapshot?.role} />
        </span>
      </div>
    </Card>
  );
}

export default function HandoversPage() {
  const { projectId } = useParams();
  const { project } = useProject();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, error, loading, reload } = useAsync(
    () => api.get(`/api/handovers?projectId=${projectId}&scope=all`),
    [projectId],
  );
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [recipientId, setRecipientId] = useState('');
  const [template, setTemplate] = useState('onboarding');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const canPrepare = ['lead', 'contributor'].includes(project.role);
  const recipients = project.members.filter((member) => String(member.userId) !== String(user.id));
  const handovers = data?.handovers || [];

  useEffect(() => {
    if (location.state?.create && canPrepare) {
      setCreateOpen(true);
      setRecipientId(recipients[0]?.userId || '');
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, canPrepare]);

  const counts = useMemo(() => {
    const result = { all: handovers.length, active: 0, shared: 0, received: 0, rejected: 0 };
    for (const handover of handovers) {
      if (['draft', 'in_review'].includes(handover.status)) result.active += 1;
      if (['approved', 'shared', 'acknowledged'].includes(handover.status)) result.shared += 1;
      if (String(handover.recipient) === String(user.id)) result.received += 1;
      if (handover.status === 'rejected') result.rejected += 1;
    }
    return result;
  }, [handovers, user.id]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return handovers.filter((handover) => {
      if (filter === 'active' && !['draft', 'in_review'].includes(handover.status)) return false;
      if (filter === 'shared' && !['approved', 'shared', 'acknowledged'].includes(handover.status)) {
        return false;
      }
      if (filter === 'received' && String(handover.recipient) !== String(user.id)) return false;
      if (filter === 'rejected' && handover.status !== 'rejected') return false;
      if (!term) return true;
      return (
        handover.recipientSnapshot?.name?.toLowerCase().includes(term) ||
        handover.recipientSnapshot?.email?.toLowerCase().includes(term) ||
        handover.roleTemplate?.toLowerCase().includes(term)
      );
    });
  }, [handovers, filter, query, user.id]);

  const openCreate = () => {
    setCreateError('');
    setRecipientId(recipients[0]?.userId || '');
    setTemplate('onboarding');
    setCreateOpen(true);
  };

  const createHandover = async (event) => {
    event.preventDefault();
    if (!recipientId) {
      setCreateError('Choose a recipient who is a project member.');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const response = await api.post('/api/handovers', {
        projectId,
        recipientId,
        roleTemplate: template,
      });
      toast.success('Draft handover created. Review each item before submitting.');
      setCreateOpen(false);
      navigate(`/projects/${projectId}/handovers/${response.handover.id}`);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow={`${project.key} · Handover workflow`}
        title="Handovers"
        description="A handover is built per recipient. It contains only evidence that person may read, and nothing is shared until a lead approves it."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={loading}
              onClick={() => reload().catch(() => {})}
            >
              Refresh
            </Button>
            {canPrepare ? (
              <Button size="sm" icon={Plus} onClick={openCreate}>
                New handover
              </Button>
            ) : (
              <Badge tone="slate">Read-only role</Badge>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          label="Filter handovers"
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'active', label: 'In progress', count: counts.active },
            { value: 'shared', label: 'Shared', count: counts.shared },
            { value: 'received', label: 'For me', count: counts.received },
            { value: 'rejected', label: 'Rejected', count: counts.rejected },
          ]}
        />
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search recipients"
          className="w-full sm:w-64"
        />
      </div>

      {loading && !data ? (
        <LoadingBlock rows={3} />
      ) : error && !data ? (
        <ErrorState
          title="Could not load handovers"
          error={error}
          onRetry={() => reload().catch(() => {})}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FileSignature}
          title={handovers.length === 0 ? 'No handovers yet' : 'Nothing in this view'}
          description={
            handovers.length === 0
              ? 'Create a handover for an incoming team member. The draft is composed from the current state of record and filtered to their permissions.'
              : 'Try another filter or clear the recipient search.'
          }
          action={
            handovers.length === 0 && canPrepare ? (
              <Button icon={Plus} onClick={openCreate}>
                Prepare the first handover
              </Button>
            ) : handovers.length > 0 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setFilter('all');
                  setQuery('');
                }}
              >
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((handover) => (
            <HandoverCard
              key={handover.id}
              handover={handover}
              projectId={projectId}
              currentUserId={user.id}
              onOpen={() => navigate(`/projects/${projectId}/handovers/${handover.id}`)}
            />
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-2.5 sm:grid-cols-4">
        {[
          { icon: FileSignature, title: 'Draft', body: 'Author accepts, edits or rejects each item.' },
          { icon: Send, title: 'Submit', body: 'At least one item must be accepted or edited.' },
          { icon: CheckCircle2, title: 'Approve', body: 'A lead approves; the recipient cannot self-approve.' },
          { icon: Share2, title: 'Share', body: 'A 7-day link is issued. Access is rechecked at open.' },
        ].map((step) => (
          <div key={step.title} className="rounded-lg border border-line bg-white/60 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[10.5px] font-semibold text-ink-soft">
              <step.icon className="h-3 w-3 text-ink-faint" aria-hidden="true" />
              {step.title}
            </p>
            <p className="mt-1 text-[10px] leading-4 text-ink-muted">{step.body}</p>
          </div>
        ))}
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Prepare a handover"
        description="Threadline composes a recipient-specific draft from the current project state."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-handover"
              loading={creating}
              disabled={recipients.length === 0}
              title={recipients.length === 0 ? 'Add a second project member first' : undefined}
              icon={FileSignature}
            >
              Compose draft
            </Button>
          </>
        }
      >
        {recipients.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-[12px] leading-5 text-amber-900">
            This project has no other members. Add a recipient from{' '}
            <Link to={`/projects/${projectId}/people`} className="font-semibold underline">
              People &amp; settings
            </Link>{' '}
            before creating a handover.
          </div>
        ) : (
          <form id="create-handover" onSubmit={createHandover} className="space-y-4">
            <Field label="Recipient" htmlFor="handover-recipient" required hint="Must be a member of this project.">
              <Select
                id="handover-recipient"
                value={recipientId}
                onChange={(event) => setRecipientId(event.target.value)}
                required
              >
                {recipients.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name} — {member.email} ({member.role})
                  </option>
                ))}
              </Select>
            </Field>

            <fieldset>
              <legend className="mb-1.5 text-[12px] font-semibold text-ink-soft">Template</legend>
              <div className="space-y-1.5">
                {Object.entries(TEMPLATES).map(([value, meta]) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition ${
                      template === value
                        ? 'border-brand-300 bg-brand-50/60 ring-1 ring-brand-200'
                        : 'border-line bg-white hover:border-brand-200'
                    }`}
                  >
                    <input
                      type="radio"
                      name="template"
                      value={value}
                      checked={template === value}
                      onChange={() => setTemplate(value)}
                      className="mt-0.5 h-3.5 w-3.5 text-brand-700 focus:ring-brand-200"
                    />
                    <span>
                      <span className="block text-[12px] font-semibold text-ink">{meta.label}</span>
                      <span className="mt-0.5 block text-[10.5px] leading-4 text-ink-muted">
                        {meta.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex items-start gap-2 rounded-lg border border-line bg-slate-50 px-3 py-2 text-[10.5px] leading-4 text-ink-muted">
              <LockKeyhole className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              Items citing a source the recipient cannot read are excluded entirely. The withheld
              tally is recomputed on the handover page for whoever is viewing it.
            </div>

            {createError && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                {createError}
              </p>
            )}
          </form>
        )}
      </Modal>
    </div>
  );
}
