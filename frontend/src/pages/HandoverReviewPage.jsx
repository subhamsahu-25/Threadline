import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CalendarClock,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  FileSignature,
  GitCompareArrows,
  History,
  Info,
  Link2Off,
  LockKeyhole,
  MessageSquare,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { api, downloadFile, errorMessage } from '../lib/api.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProject } from './ProjectLayout.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import {
  HANDOVER_STATUS,
  TEMPLATES,
} from '../lib/constants.js';
import { evidenceStatus, expectsOwner, formatDate, formatDateTime, formatRelative, pluralize, truncate } from '../lib/format.js';
import {
  DecisionBadge,
  HandoverStatusBadge,
  SensitivityBadge,
  SeverityBadge,
  StateBadge,
  TypeBadge,
} from '../components/badges.jsx';
import { CitationList } from '../components/ClaimCard.jsx';
import EvidenceDrawer from '../components/EvidenceDrawer.jsx';
import RecipientHandover from '../components/RecipientHandover.jsx';
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
  ProgressBar,
  SearchInput,
  SegmentedControl,
  Textarea,
} from '../components/ui.jsx';

const STEPS = [
  { key: 'draft', label: 'Draft' },
  { key: 'in_review', label: 'In review' },
  { key: 'approved', label: 'Approved' },
  { key: 'shared', label: 'Shared' },
  { key: 'acknowledged', label: 'Acknowledged' },
];

function WorkflowStepper({ status }) {
  const rejected = status === 'rejected';
  const current = rejected ? -1 : STEPS.findIndex((step) => step.key === status);
  return (
    <div className="flex items-start">
      {STEPS.map((step, index) => {
        const done = !rejected && index < current;
        const active = !rejected && index === current;
        return (
          <div key={step.key} className="flex flex-1 flex-col items-center">
            <div className="flex w-full items-center">
              <span
                className={`h-px flex-1 ${index === 0 ? 'bg-transparent' : done || active ? 'bg-brand-300' : 'bg-line'}`}
              />
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[9px] font-semibold ${
                  done
                    ? 'border-brand-600 bg-brand-700 text-white'
                    : active
                      ? 'border-brand-500 bg-white text-brand-700 ring-2 ring-brand-100'
                      : rejected
                        ? 'border-red-200 bg-red-50 text-red-500'
                        : 'border-line bg-white text-ink-faint'
                }`}
              >
                {done ? <Check className="h-3 w-3" /> : index + 1}
              </span>
              <span
                className={`h-px flex-1 ${index === STEPS.length - 1 ? 'bg-transparent' : done ? 'bg-brand-300' : 'bg-line'}`}
              />
            </div>
            <span
              className={`mt-1 text-[9.5px] font-medium ${
                active ? 'text-brand-800' : done ? 'text-ink-soft' : 'text-ink-faint'
              }`}
            >
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ReviewItem({
  item,
  canReview,
  canShareAnswer,
  busy,
  onDecision,
  onEdit,
  onEvidence,
  onShare,
}) {
  const edited = item.decision === 'edited';
  const current = item.statement;
  const certainty = evidenceStatus(item);
  const buttonBase =
    'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[10.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <Card className={`p-4 ${item.decision === 'rejected' ? 'opacity-75' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <TypeBadge type={item.type} />
        <StateBadge state={item.state} />
        <Badge tone={certainty.tone} title={certainty.title}>
          {certainty.label}
        </Badge>
        <DecisionBadge decision={item.decision} />
        {item.origin === 'person_confirmed' && (
          <Badge tone="violet" title="Answered by a named teammate instead of a document quote.">
            <BadgeCheck className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
            Person-confirmed
          </Badge>
        )}
        {item.sensitivity === 'confidential' && <SensitivityBadge sensitivity="confidential" />}
        {item.redactionCount > 0 && (
          <Badge
            tone="slate"
            title="Emails, phone numbers, credentials and 12-digit IDs were replaced with a typed marker when this draft was composed."
          >
            {item.redactionCount} redacted
          </Badge>
        )}
        {edited && <Badge tone="blue">Edited</Badge>}
        {item.changedSinceReview && (
          <Badge
            tone="amber"
            title="The statement, status, owner or evidence changed after this item was reviewed. Its earlier decision was not carried over."
          >
            Changed since your review
          </Badge>
        )}
        {item.acceptedWithoutEvidence && <Badge tone="orange">No verified evidence</Badge>}
        {item.topic && (
          <span className="max-w-[180px] truncate font-mono text-[10px] text-ink-faint">
            {item.topic}
          </span>
        )}
        <span className="ml-auto font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
          #{String(item.claimId).slice(-6)}
        </span>
      </div>

      <p className="mt-2.5 text-[13px] font-medium leading-6 text-ink">{current}</p>
      {item.origin === 'person_confirmed' && (
        <p className="mt-1 flex items-center gap-1 text-[10.5px] text-violet-800">
          <BadgeCheck className="h-3 w-3" aria-hidden="true" />
          Confirmed by {item.confirmedByName || 'a teammate'}
          {item.confirmedAt ? ` · ${formatDate(item.confirmedAt)}` : ''}
        </p>
      )}

      {item.origin === 'person_confirmed' && canReview && (
        item.restrictedToRecipient ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-1.5">
            <p className="text-[10.5px] leading-4 text-amber-900">
              The recipient cannot open this answer until it is shared with the project.
            </p>
            {canShareAnswer ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onShare(item)}
                className={`${buttonBase} border-amber-300 bg-white text-amber-900 hover:border-amber-400`}
              >
                Share with project
              </button>
            ) : (
              <span className="text-[10px] text-amber-800">A project lead must share it</span>
            )}
          </div>
        ) : (
          <p className="mt-1 text-[10.5px] text-emerald-800">Shared with the project</p>
        )
      )}

      {edited && item.originalStatement && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[10px] font-medium text-ink-muted">
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
              {item.ownerName || <span className="text-amber-700">No owner recorded</span>}
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

      {item.resolutionNote && (
        <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/70 px-2.5 py-1.5 text-[10.5px] leading-4 text-emerald-900">
          <span className="font-semibold">Closure note:</span> {item.resolutionNote}
          {item.resolutionByName ? ` — ${item.resolutionByName}` : ''}
        </p>
      )}

      {item.reviewerNote && (
        <p className="mt-2 rounded-md border border-line bg-slate-50 px-2.5 py-1.5 text-[10.5px] leading-4 text-ink-muted">
          <span className="font-semibold text-ink-soft">Reviewer note:</span> {item.reviewerNote}
        </p>
      )}

      {item.citations?.length > 0 && (
        <div className="mt-3 border-t border-line pt-2.5">
          <CitationList citations={item.citations} onEvidence={onEvidence} />
        </div>
      )}

      {canReview && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision(item, 'accepted')}
            className={`${buttonBase} ${
              item.decision === 'accepted'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                : 'border-line bg-white text-ink-muted hover:border-emerald-200 hover:text-emerald-800'
            }`}
          >
            <Check className="h-3 w-3" /> Accept
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onEdit(item)}
            className={`${buttonBase} ${
              item.decision === 'edited'
                ? 'border-blue-300 bg-blue-50 text-blue-800'
                : 'border-line bg-white text-ink-muted hover:border-blue-200 hover:text-blue-800'
            }`}
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision(item, 'rejected')}
            className={`${buttonBase} ${
              item.decision === 'rejected'
                ? 'border-red-300 bg-red-50 text-red-800'
                : 'border-line bg-white text-ink-muted hover:border-red-200 hover:text-red-700'
            }`}
          >
            <X className="h-3 w-3" /> Reject
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision(item, 'pending')}
            className={`${buttonBase} ${
              item.decision === 'pending'
                ? 'border-amber-300 bg-amber-50 text-amber-800'
                : 'border-line bg-white text-ink-muted hover:border-amber-200 hover:text-amber-800'
            }`}
          >
            <Clock className="h-3 w-3" /> Pending
          </button>
          {busy && <span className="text-[10px] text-ink-muted">Saving…</span>}
        </div>
      )}
    </Card>
  );
}

export default function HandoverReviewPage() {
  const { projectId, handoverId } = useParams();
  const { project } = useProject();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAsync(
    () => api.get(`/api/handovers/${handoverId}`),
    [handoverId],
  );
  const [handover, setHandover] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [evidenceId, setEvidenceId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [busyItem, setBusyItem] = useState(null);
  const [working, setWorking] = useState(null);
  const [editItem, setEditItem] = useState(null);
  const [editText, setEditText] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveNote, setApproveNote] = useState('');
  const [approveError, setApproveError] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectError, setRejectError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [shareExpiresAt, setShareExpiresAt] = useState(null);
  const [shareRenewal, setShareRenewal] = useState(false);
  const [shareError, setShareError] = useState('');
  const [cachedShare, setCachedShare] = useState('');
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState({ loading: false, error: null, data: null });
  const [acknowledging, setAcknowledging] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState('');
  const [diffVersion, setDiffVersion] = useState(null);
  const [diff, setDiff] = useState({ loading: false, error: null, data: null });
  const [freshnessOpen, setFreshnessOpen] = useState(false);
  const [acceptAllOpen, setAcceptAllOpen] = useState(false);
  const [resolvingFeedback, setResolvingFeedback] = useState(null);
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);

  useEffect(() => {
    if (data?.handover) {
      setHandover(data.handover);
      setViewer(data.viewer);
    }
  }, [data]);

  useEffect(() => {
    try {
      setCachedShare(localStorage.getItem(`threadline.share.${handoverId}`) || '');
    } catch {
      setCachedShare('');
    }
  }, [handoverId, handover?.status]);

  const isLead = project.role === 'lead';

  const items = handover?.items || [];
  const counts = useMemo(() => {
    const result = { total: items.length, pending: 0, accepted: 0, edited: 0, rejected: 0 };
    for (const item of items) result[item.decision] = (result[item.decision] || 0) + 1;
    return result;
  }, [items]);
  const decided = counts.accepted + counts.edited;

  const filteredItems = useMemo(() => {
    const term = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.decision !== filter) return false;
      if (!term) return true;
      return (
        item.statement.toLowerCase().includes(term) ||
        item.topic?.toLowerCase().includes(term) ||
        item.ownerName?.toLowerCase().includes(term)
      );
    });
  }, [items, filter, query]);

  const update = (next) => setHandover(next);

  // Review calls return only the items that changed plus the new version and
  // counts, so merge instead of replacing the whole handover (which would also
  // drop local UI state such as filters and open dialogs).
  const applyReviewResults = (response) => {
    const replacements = new Map(
      (response.items || (response.item ? [response.item] : [])).map((entry) => [
        String(entry.claimId),
        entry,
      ]),
    );
    setHandover((current) => {
      if (!current) return current;
      return {
        ...current,
        version: response.version ?? current.version,
        counts: response.counts ?? current.counts,
        items: (current.items || []).map((entry) =>
          replacements.has(String(entry.claimId))
            ? { ...entry, ...replacements.get(String(entry.claimId)) }
            : entry,
        ),
      };
    });
  };

  const decide = async (item, decision) => {
    setBusyItem(item.claimId);
    try {
      const response = await api.patch(`/api/handovers/${handoverId}/items/${item.claimId}`, {
        decision,
      });
      applyReviewResults(response);
      const labels = { accepted: 'accepted', rejected: 'rejected', pending: 'set to pending' };
      toast.success(`Item ${labels[decision] || decision}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyItem(null);
    }
  };

  const shareAnswer = async (item) => {
    setBusyItem(item.claimId);
    try {
      const decision = ['accepted', 'edited'].includes(item.decision)
        ? item.decision
        : 'accepted';
      const body = { decision, shareWithProject: true };
      if (decision === 'edited') body.editedStatement = item.statement;
      await api.patch(`/api/handovers/${handoverId}/items/${item.claimId}`, body);
      // Sharing reveals the item's source to the whole project, which can
      // change withheld lists and alerts beyond this one item.
      await reload({ quiet: true });
      toast.success('Confirmed answer shared with the project. The recipient can now open it.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyItem(null);
    }
  };

  const isVerified = (item) => {
    const citations = item.citations || [];
    if (citations.length === 0) return false;
    return citations.every((citation) => citation.validation !== 'failed');
  };

  const verifiedPending = items.filter(
    (item) => item.decision === 'pending' && isVerified(item) && !item.conflicting,
  );

  const acceptAll = async () => {
    const pending = verifiedPending;
    if (pending.length === 0) {
      setAcceptAllOpen(false);
      toast.error('No pending items are fully verified. Review the rest individually.');
      return;
    }
    setAcceptAllOpen(false);
    setWorking('accept-all');
    try {
      // One request, one recorded version. The previous loop sent one PATCH
      // per item and wrote one full version snapshot for each.
      const response = await api.post(`/api/handovers/${handoverId}/items/bulk`, {
        decisions: pending.map((item) => ({ claimId: item.claimId, decision: 'accepted' })),
      });
      applyReviewResults(response);
      toast.success(
        `${pending.length} verified item${pending.length === 1 ? '' : 's'} accepted.`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const openEdit = (item) => {
    setEditItem(item);
    setEditText(item.statement);
    setEditNote(item.reviewerNote || '');
  };

  const saveEdit = async () => {
    if (!editItem) return;
    if (!editText.trim()) {
      toast.error('The edited statement cannot be empty');
      return;
    }
    setEditSaving(true);
    try {
      const response = await api.patch(`/api/handovers/${handoverId}/items/${editItem.claimId}`, {
        decision: 'edited',
        editedStatement: editText.trim(),
        note: editNote.trim() || undefined,
      });
      applyReviewResults(response);
      setEditItem(null);
      toast.success('Item updated. A new version was recorded.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setEditSaving(false);
    }
  };

  const submit = async () => {
    setWorking('submit');
    try {
      const response = await api.post(`/api/handovers/${handoverId}/submit`);
      update(response.handover);
      toast.success('Submitted for lead review.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const approve = async () => {
    setWorking('approve');
    setApproveError('');
    try {
      const response = await api.post(`/api/handovers/${handoverId}/approve`, {
        note: approveNote.trim() || undefined,
      });
      update(response.handover);
      setApproveOpen(false);
      setApproveNote('');
      toast.success('Handover approved. It can now be shared with the recipient.');
    } catch (err) {
      setApproveError(errorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const reject = async () => {
    setWorking('reject');
    setRejectError('');
    try {
      const response = await api.post(`/api/handovers/${handoverId}/reject`, {
        note: rejectNote.trim(),
      });
      update(response.handover);
      setRejectOpen(false);
      setRejectNote('');
      toast.success('Handover rejected. The author can reopen it as a draft.');
    } catch (err) {
      setRejectError(errorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const reopen = async () => {
    setWorking('reopen');
    try {
      const response = await api.post(`/api/handovers/${handoverId}/reopen`);
      update(response.handover);
      toast.success('Reopened as a draft. Edit the items, then resubmit for review.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const regenerate = async () => {
    setWorking('regenerate');
    try {
      const response = await api.post(`/api/handovers/${handoverId}/regenerate`);
      const nextId = String(response.handover?.id || '');
      if (response.createdNew && nextId && nextId !== String(handoverId)) {
        toast.success(
          `A new draft was built from the current state: ${response.carried} kept, ${response.added} new, ${response.dropped} dropped, ${response.changed || 0} changed since review. The shared version stays live until you approve and share the replacement.`,
        );
        navigate(`/projects/${projectId}/handovers/${nextId}`, { replace: true });
        return;
      }
      update(response.handover);
      toast.success(
        `Rebuilt from the current state: ${response.carried} kept, ${response.added} new, ${response.dropped} dropped, ${response.changed || 0} changed since review. Review and resubmit.`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const share = async () => {
    const renewing = handover.status === 'shared';
    setShareRenewal(renewing);
    setWorking('share');
    setShareError('');
    try {
      const response = await api.post(`/api/handovers/${handoverId}/share`, {
        confirmRotation: renewing,
      });
      const token = response.sharePath?.split('/').pop();
      if (!token) {
        setShareError(
          'The server did not return a share link. Reload the page and try again before sending anything.',
        );
        await reload({ quiet: true });
        return;
      }
      const link = `${window.location.origin}/shared/${token}`;
      setShareLink(link);
      setShareExpiresAt(response.shareExpiresAt);
      setCachedShare(link);
      try {
        localStorage.setItem(`threadline.share.${handoverId}`, link);
      } catch {
        /* storage optional */
      }
      await reload({ quiet: true });
      toast.success(
        renewing
          ? 'Share link renewed. The previous link no longer works.'
          : 'Handover shared. Copy the link and send it to the recipient.',
      );
    } catch (err) {
      setShareError(errorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const copyShareLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Share link copied');
    } catch {
      toast.error('Clipboard access was blocked');
    }
  };

  const revokeShare = async () => {
    setWorking('revoke');
    setRevokeError('');
    try {
      const response = await api.post(`/api/handovers/${handoverId}/share/revoke`, {
        reason: revokeReason.trim() || undefined,
      });
      update(response.handover);
      setCachedShare('');
      try {
        localStorage.removeItem(`threadline.share.${handoverId}`);
      } catch {
        /* storage optional */
      }
      setRevokeOpen(false);
      setRevokeReason('');
      toast.success(
        response.idempotent
          ? 'No active share link remained.'
          : 'Share link revoked. The old link no longer opens this handover.',
      );
    } catch (err) {
      setRevokeError(errorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const openDiff = async (version) => {
    setDiffVersion(version);
    setDiff({ loading: true, error: null, data: null });
    try {
      const response = await api.get(`/api/handovers/${handoverId}/versions/${version.number}`);
      setDiff({ loading: false, error: null, data: response.diff });
    } catch (err) {
      setDiff({ loading: false, error: err, data: null });
    }
  };

  const openVersions = async () => {
    setVersionsOpen(true);
    setVersions({ loading: true, error: null, data: null });
    try {
      const response = await api.get(`/api/handovers/${handoverId}/versions`);
      setVersions({ loading: false, error: null, data: response.versions });
    } catch (err) {
      setVersions({ loading: false, error: err, data: null });
    }
  };

  const acknowledge = async () => {
    setAcknowledging(true);
    try {
      const response = await api.post(`/api/handovers/${handoverId}/acknowledge`);
      update(response.handover);
      toast.success('Acknowledgement recorded.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAcknowledging(false);
    }
  };

  const downloadHandover = async () => {
    try {
      await downloadFile(`/api/handovers/${handoverId}/export`, 'handover.pdf');
      toast.success('Download started. The file matches the view on this screen.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const sendRecipientFeedback = async ({ message, claimId }) => {
    try {
      await api.post(`/api/handovers/${handoverId}/feedback`, { message, claimId });
      toast.success('Your note was sent to the project team.');
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const resolveFeedback = async (entry) => {
    setResolvingFeedback(entry.id);
    try {
      await api.patch(`/api/handovers/${handoverId}/feedback/${entry.id}`, {});
      toast.success('Feedback marked as resolved.');
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setResolvingFeedback(null);
    }
  };

  if (loading && !handover) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-20 rounded-card" />
        <LoadingBlock rows={4} />
      </div>
    );
  }

  if (error && !handover) {
    const denied = error.status === 403;
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-white text-amber-600 shadow-sm">
          <LockKeyhole className="h-5 w-5" aria-hidden="true" />
        </div>
        <h1 className="text-[23px] font-semibold">
          {denied ? 'This handover is not available to you' : 'Handover could not be loaded'}
        </h1>
        <p className="mt-2 text-[13px] leading-6 text-ink-muted">{error.message}</p>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" onClick={() => navigate(`/projects/${projectId}/handovers`)}>
            Back to handovers
          </Button>
          <Button onClick={() => reload().catch(() => {})}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!handover) return null;

  if (viewer === 'recipient') {
    return (
      <div>
        <Link
          to={`/projects/${projectId}/handovers`}
          className="mb-4 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to handovers
        </Link>
        <RecipientHandover
          handover={handover}
          projectId={projectId}
          onAcknowledge={acknowledge}
          acknowledging={acknowledging}
          onDownload={downloadHandover}
          onFeedback={sendRecipientFeedback}
        />
      </div>
    );
  }

  const isAuthor = String(handover.createdBy) === String(user.id);
  const canReviewItems =
    ['draft', 'in_review'].includes(handover.status) && (isAuthor || isLead);
  const canSubmit = handover.status === 'draft' && (isAuthor || isLead);
  const canApprove = handover.status === 'in_review' && isLead;
  const canReject = ['draft', 'in_review'].includes(handover.status) && isLead;
  const canReopen = handover.status === 'rejected' && (isLead || isAuthor);
  const canShare = ['approved', 'shared'].includes(handover.status) && (isLead || isAuthor);
  const serverShareUrl = handover.sharePath
    ? `${window.location.origin}/shared/${handover.sharePath.split('/').pop()}`
    : '';
  const shareUrl = cachedShare || serverShareUrl;
  const statusMeta = HANDOVER_STATUS[handover.status] || { label: handover.status };
  const snapshot = handover.snapshot || {};
  const withheld = handover.withheld || { total: 0, byType: {}, byReason: {} };
  const decisionsLeft = counts.pending + counts.rejected;
  const openFeedbackCount = (handover.feedback || []).filter(
    (entry) => entry.status === 'open',
  ).length;

  return (
    <div>
      <Link
        to={`/projects/${projectId}/handovers`}
        className="mb-4 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to handovers
      </Link>

      <PageHeader
        eyebrow={`Handover dossier · v${handover.version}`}
        title={`Handover for ${handover.recipientSnapshot?.name || 'recipient'}`}
        description={
          snapshot.generatedSummary ||
          'A recipient-specific handover composed from the current state of record.'
        }
        actions={
          <>
            {(isAuthor || isLead) && (
              <Button variant="secondary" size="sm" icon={History} onClick={openVersions}>
                History
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              onClick={downloadHandover}
            >
              Download PDF
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              onClick={() => reload().catch(() => {})}
              loading={loading}
            >
              Refresh
            </Button>
            {canReject && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setRejectError('');
                  setRejectOpen(true);
                }}
              >
                Reject
              </Button>
            )}
            {canSubmit && (
              <Button
                size="sm"
                icon={Send}
                loading={working === 'submit'}
                disabled={decided === 0}
                title={decided === 0 ? 'Accept or edit at least one item first' : undefined}
                onClick={submit}
              >
                Submit for review
              </Button>
            )}
            {canApprove && (
              <Button
                size="sm"
                icon={ShieldCheck}
                onClick={() => {
                  setApproveError('');
                  setApproveOpen(true);
                }}
              >
                Approve
              </Button>
            )}
            {canReopen && (
              <Button
                size="sm"
                icon={RotateCcw}
                loading={working === 'reopen'}
                onClick={reopen}
              >
                Reopen as draft
              </Button>
            )}
            {canShare && (
              <Button size="sm" icon={Send} onClick={() => setShareOpen(true)}>
                {handover.status === 'shared' ? 'Renew share link' : 'Share'}
              </Button>
            )}
            {canShare && handover.status === 'shared' && (
              <Button
                variant="secondary"
                size="sm"
                icon={Link2Off}
                onClick={() => {
                  setRevokeError('');
                  setRevokeOpen(true);
                }}
              >
                Revoke link
              </Button>
            )}
          </>
        }
      >
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <HandoverStatusBadge status={handover.status} />
          <Badge tone="navy">{TEMPLATES[handover.roleTemplate]?.label || handover.roleTemplate}</Badge>
          <Badge tone="slate">
            {isAuthor ? 'You are the author' : isLead ? 'You are reviewing as lead' : 'Reviewer'}
          </Badge>
          {handover.approvedAt && (
            <Badge tone="green" dot>
              Approved {formatRelative(handover.approvedAt)} by{' '}
              {handover.approvedBySnapshot?.name || 'lead'}
            </Badge>
          )}
          {handover.status === 'shared' && (
            <Badge tone="blue">
              Share expires {formatDate(handover.shareExpiresAt)}
            </Badge>
          )}
          {handover.freshness?.status === 'outdated' && (
            <Badge tone="orange" dot>
              Outdated · source changed
            </Badge>
          )}
          {handover.redactions?.count > 0 && (
            <Badge
              tone="slate"
              title="Emails, phone numbers, credentials and 12-digit IDs were replaced with a typed marker when this draft was composed."
            >
              {handover.redactions.count} redacted
            </Badge>
          )}
          {shareUrl && ['shared', 'acknowledged'].includes(handover.status) && (
            <button
              type="button"
              onClick={() => copyShareLink(shareUrl)}
              className="inline-flex items-center gap-1 rounded border border-line bg-white px-2 py-0.5 font-mono text-[10px] text-brand-700 hover:border-brand-300"
            >
              <Copy className="h-2.5 w-2.5" /> Copy share link
            </button>
          )}
        </div>
      </PageHeader>

      {handover.status === 'superseded' && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-5 text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">This handover was superseded</p>
            <p className="text-amber-800/90">
              A newer handover replaced it
              {handover.supersededByVersion ? ` (v${handover.supersededByVersion})` : ''} and its
              share link was revoked. It stays read-only as history.{' '}
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
        </div>
      )}

      {handover.status === 'rejected' && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12px] leading-5 text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">This handover was rejected</p>
            <p className="text-red-800/90">
              {handover.rejectionNote || 'No rejection note was recorded.'} Rejected{' '}
              {formatRelative(handover.rejectedAt)}. The author or a lead can reopen it as a draft,
              make changes and resubmit.
            </p>
          </div>
        </div>
      )}

      {handover.status === 'draft' && handover.reopenedAt && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-5 text-amber-900">
          <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">Reopened after rejection</p>
            <p className="text-amber-800/90">
              {handover.rejectionNote || 'No rejection note was recorded.'} Edit the items below,
              then submit for review again.
            </p>
          </div>
        </div>
      )}

      {handover.status === 'shared' && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[12px] leading-5 text-blue-900">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />
          <p>
            Shared {formatRelative(handover.sharedAt)}. The recipient opens the link signed in as
            themselves; permissions are re-evaluated on every open. The link expires{' '}
            {formatDate(handover.shareExpiresAt)} — renew it if the recipient loses access.
          </p>
        </div>
      )}

      {handover.status === 'acknowledged' && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[12px] leading-5 text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <p>
            {handover.recipientSnapshot?.name || 'The recipient'} acknowledged this handover{' '}
            {formatRelative(handover.acknowledgedAt)}. The acknowledgement is in the audit trail.
          </p>
        </div>
      )}

      {handover.freshness?.status === 'outdated' && handover.status !== 'superseded' && (
        <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 px-3.5 py-2.5 text-[12px] leading-5 text-orange-900">
          <div className="flex items-start gap-2">
            <GitCompareArrows className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                This handover is outdated — a connected source changed
              </p>
              <p className="text-orange-800/90">
                Detected {formatRelative(handover.freshness.checkedAt)}. The live project state no
                longer matches what was reviewed. Regenerating rebuilds the draft from current
                state and sends it back through review.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(isAuthor || isLead) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={RefreshCw}
                    loading={working === 'regenerate'}
                    onClick={regenerate}
                  >
                    Regenerate from current state
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setFreshnessOpen((open) => !open)}
                >
                  {freshnessOpen ? 'Hide changes' : 'View changes'}
                </Button>
              </div>
              {freshnessOpen && (
                <ul className="mt-2 space-y-1.5">
                  {(handover.freshness.changes || []).map((change) => (
                    <li
                      key={`${change.claimId}-${change.change}`}
                      className="rounded-md border border-orange-200/70 bg-white/80 px-2.5 py-1.5 text-[11px] leading-4"
                    >
                      <Badge
                        tone={
                          change.change === 'removed'
                            ? 'red'
                            : change.change === 'added'
                              ? 'green'
                              : 'amber'
                        }
                      >
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
                            ? 'source removed by a lead'
                            : 'no longer part of the current record'}
                        </span>
                      )}
                    </li>
                  ))}
                  {(handover.freshness.changes || []).length === 0 && (
                    <li className="text-[10.5px] text-ink-muted">
                      No individual change details were stored for this check.
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="p-4 lg:col-span-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">Review progress</p>
              <p className="mt-1 font-display text-[22px] font-semibold leading-none">
                {counts.total - counts.pending} <span className="text-[13px] font-medium text-ink-muted">/ {counts.total} decided</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="green">{counts.accepted} accepted</Badge>
              <Badge tone="blue">{counts.edited} edited</Badge>
              <Badge tone="red">{counts.rejected} rejected</Badge>
              <Badge tone="amber">{counts.pending} pending</Badge>
            </div>
          </div>
          <ProgressBar
            className="mt-3"
            value={counts.total > 0 ? ((counts.total - counts.pending) / counts.total) * 100 : 0}
            tone={counts.pending > 0 ? 'amber' : 'green'}
            label="Review progress"
          />
          <div className="mt-3">
            <WorkflowStepper status={handover.status} />
          </div>
          {canReviewItems && counts.pending > 0 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-slate-50 px-2.5 py-1.5">
              <span className="text-[10.5px] text-ink-muted">
                {verifiedPending.length > 0
                  ? `${pluralize(verifiedPending.length, 'pending item')} have every quote matched and can be accepted in one pass. Review the rest individually.`
                  : 'No pending item is fully verified. Review each one individually.'}
              </span>
              <Button
                size="sm"
                variant="secondary"
                icon={CheckCheck}
                loading={working === 'accept-all'}
                disabled={Boolean(working) || verifiedPending.length === 0}
                onClick={() => setAcceptAllOpen(true)}
              >
                Accept all verified ({verifiedPending.length})
              </Button>
            </div>
          )}
          {canSubmit && decided === 0 && (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[10.5px] text-amber-900">
              Accept or edit at least one item before submitting. Pending items block approval later.
            </p>
          )}
          {canSubmit && counts.pending > 0 && (
            <p className="mt-3 text-[10.5px] text-ink-muted">
              {pluralize(counts.pending, 'item')} still pending. A lead cannot approve until every
              item has a decision.
            </p>
          )}
        </Card>

        <Card className="p-4 lg:col-span-4">
          <p className="eyebrow mb-2.5">Recipient &amp; provenance</p>
          <div className="flex items-center gap-2.5">
            <Avatar name={handover.recipientSnapshot?.name} size="md" />
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold">
                {handover.recipientSnapshot?.name}
              </p>
              <p className="truncate text-[10.5px] text-ink-muted">
                {handover.recipientSnapshot?.email} · {handover.recipientSnapshot?.role}
              </p>
            </div>
          </div>
          <dl className="mt-3 space-y-1.5 border-t border-line pt-2.5 text-[10.5px]">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Template</dt>
              <dd className="font-medium">{handover.roleTemplate}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Composed</dt>
              <dd className="font-medium">
                {handover.generation?.method || 'deterministic'}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Created</dt>
              <dd className="font-medium">{formatRelative(handover.createdAt)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Permissions checked</dt>
              <dd className="font-medium">
                {handover.permissionsCheckedAt
                  ? formatRelative(handover.permissionsCheckedAt)
                  : 'At compose time'}
              </dd>
            </div>
            {handover.shareOpenCount > 0 ? (
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">Share link</dt>
                <dd className="font-medium">
                  opened {handover.shareOpenCount}×
                </dd>
              </div>
            ) : (
              handover.shareActive && (
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">Share link</dt>
                  <dd className="font-medium">not opened yet</dd>
                </div>
              )
            )}
            {handover.shareOpenedAt && (
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">First opened</dt>
                <dd className="font-medium">{formatRelative(handover.shareOpenedAt)}</dd>
              </div>
            )}
            {handover.shareLastOpenedAt && (
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">Last opened</dt>
                <dd className="font-medium">{formatRelative(handover.shareLastOpenedAt)}</dd>
              </div>
            )}
            {handover.reminderSentAt && (
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">Reminder sent</dt>
                <dd className="font-medium">{formatRelative(handover.reminderSentAt)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Evidence items</dt>
              <dd className="font-medium">
                {counts.total - (counts.pending || 0)} accepted/edited
              </dd>
            </div>
          </dl>
          <p className="mt-2.5 border-t border-line pt-2 text-[10px] leading-4 text-ink-muted">
            {snapshot.phase && `${snapshot.phase} · `}
            readiness {snapshot.readinessScore ?? '—'}/100
          </p>
        </Card>
      </div>

      {handover.alerts?.length > 0 && (
        <div className="mt-4 space-y-2">
          {handover.alerts.map((alert, index) => (
            <div
              key={`${alert.code}-${index}`}
              className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[11.5px] leading-5 ${
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <SeverityBadge severity={alert.severity} />
                  <Badge tone={alert.audience === 'reviewer' ? 'slate' : 'navy'}>
                    {alert.audience === 'reviewer' ? 'reviewer only' : 'recipient-facing'}
                  </Badge>
                </div>
                <p className="mt-1">{alert.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl
              value={filter}
              onChange={setFilter}
              label="Filter handover items"
              options={[
                { value: 'all', label: 'All', count: counts.total },
                { value: 'pending', label: 'Pending', count: counts.pending },
                { value: 'accepted', label: 'Accepted', count: counts.accepted },
                { value: 'edited', label: 'Edited', count: counts.edited },
                { value: 'rejected', label: 'Rejected', count: counts.rejected },
              ]}
            />
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search items"
              className="w-full sm:w-56"
            />
          </div>

          {decisionsLeft > 0 && counts.pending > 0 && (
            <p className="mb-2 text-[10.5px] text-ink-muted">
              {pluralize(counts.pending, 'pending item')} must be decided before a lead can approve.
            </p>
          )}

          <div className="space-y-2.5">
            {filteredItems.map((item) => (
              <ReviewItem
                key={item.claimId}
                item={item}
                canReview={canReviewItems}
                canShareAnswer={isLead}
                busy={busyItem === item.claimId}
                onDecision={decide}
                onEdit={openEdit}
                onEvidence={setEvidenceId}
                onShare={shareAnswer}
              />
            ))}
            {filteredItems.length === 0 && (
              <EmptyState
                icon={FileSignature}
                title={items.length === 0 ? 'No items in this handover' : 'No items in this filter'}
                description={
                  items.length === 0
                    ? 'Every candidate item was withheld by permissions or by the selected template.'
                    : 'Choose another decision filter or clear the search.'
                }
              />
            )}
          </div>
        </div>

        <div className="space-y-3 lg:col-span-4">
          {withheld.total > 0 && (
            <Card className="overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line bg-slate-50/80 px-4 py-2.5">
                <LockKeyhole className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                <p className="text-[11.5px] font-semibold">
                  {withheld.total} item{withheld.total === 1 ? '' : 's'} withheld
                </p>
                <Badge tone="slate" className="ml-auto">
                  confidentiality
                </Badge>
              </div>
              <div className="px-4 py-3">
                <p className="text-[10.5px] leading-4 text-ink-muted">
                  Withheld content is never included in this payload. Counts cover only withheld
                  items you are authorized to read — recipients never see this panel.
                </p>
                <dl className="mt-3 space-y-1.5 text-[10.5px]">
                  {[
                    ['Permissions', withheld.byReason?.permissions || 0],
                    ['Author access', withheld.byReason?.author_permissions || 0],
                    ['Template exclusions', withheld.byReason?.template || 0],
                    ['Unverified evidence', withheld.byReason?.unverified || 0],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-2">
                      <dt className="text-ink-muted">{label}</dt>
                      <dd className="font-mono font-semibold">{value}</dd>
                    </div>
                  ))}
                </dl>
                {Object.keys(withheld.byType || {}).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {Object.entries(withheld.byType).map(([type, count]) => (
                      <Badge key={type} tone="slate">
                        {type} {count}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="mt-3 border-t border-line pt-2 text-[9.5px] leading-4 text-ink-faint">
                  Details are intentionally hidden to avoid leaking restricted context.
                </p>
              </div>
            </Card>
          )}

          {handover.viewerLimits?.someItemsHiddenByPermissions && withheld.total === 0 && (
            <Card className="p-4">
              <div className="flex items-center gap-1.5">
                <LockKeyhole className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                <p className="text-[11.5px] font-semibold">Some items are hidden</p>
              </div>
              <p className="mt-2 text-[10.5px] leading-4 text-ink-muted">
                {handover.viewerLimits.note ||
                  'Some items reference sources you are not authorized to read. They are excluded from this view.'}
              </p>
            </Card>
          )}

          <Card className="overflow-hidden" data-testid="handover-feedback">
            <div className="flex items-center gap-2 border-b border-line bg-slate-50/80 px-4 py-2.5">
              <MessageSquare className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
              <p className="text-[11.5px] font-semibold">Recipient feedback</p>
              <Badge tone={openFeedbackCount > 0 ? 'amber' : 'slate'} className="ml-auto">
                {openFeedbackCount > 0 ? `${openFeedbackCount} open` : 'none open'}
              </Badge>
            </div>
            <div className="px-4 py-3">
              {(handover.feedback || []).length === 0 ? (
                <p className="text-[10.5px] leading-4 text-ink-muted">
                  The recipient can flag an item or send a general note from the share link. Notes
                  arrive here and in the notification bell.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {handover.feedback.map((entry) => (
                    <li
                      key={entry.id}
                      className="rounded-md border border-line bg-white px-2.5 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10.5px] font-semibold">{entry.authorName}</span>
                        <span className="font-mono text-[9px] text-ink-faint">
                          {formatRelative(entry.createdAt)}
                        </span>
                        {entry.claimId && (
                          <span className="font-mono text-[9px] text-ink-faint">
                            · item #{String(entry.claimId).slice(-6)}
                          </span>
                        )}
                        <Badge
                          tone={entry.status === 'resolved' ? 'green' : 'amber'}
                          className="ml-auto"
                        >
                          {entry.status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-ink-soft">{entry.message}</p>
                      {entry.status === 'resolved' ? (
                        <p className="mt-1 text-[9.5px] leading-4 text-emerald-800">
                          Resolved
                          {entry.resolutionNote ? ` · ${entry.resolutionNote}` : ''}
                        </p>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mt-1.5"
                          loading={resolvingFeedback === entry.id}
                          onClick={() => resolveFeedback(entry)}
                        >
                          Mark resolved
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {(handover.deliveries || []).length > 0 && (
            <Card className="overflow-hidden" data-testid="handover-deliveries">
              <div className="flex items-center gap-2 border-b border-line bg-slate-50/80 px-4 py-2.5">
                <Send className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                <p className="text-[11.5px] font-semibold">Outbound delivery</p>
                <Badge tone="slate" className="ml-auto">
                  webhook
                </Badge>
              </div>
              <div className="px-4 py-3">
                <p className="text-[10.5px] leading-4 text-ink-muted">
                  In-app notices are always sent. The webhook mirror is optional and is only marked
                  sent when a message actually left the server.
                </p>
                <ul className="mt-2.5 space-y-2">
                  {handover.deliveries.map((entry) => (
                    <li key={entry.id} className="rounded-md border border-line px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          tone={
                            entry.status === 'sent'
                              ? 'green'
                              : entry.status === 'failed'
                                ? 'red'
                                : 'slate'
                          }
                        >
                          {entry.status}
                        </Badge>
                        <span className="font-mono text-[9.5px] text-ink-muted">
                          {entry.kind}
                        </span>
                        <span className="ml-auto font-mono text-[9px] text-ink-faint">
                          {formatRelative(entry.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] leading-4 text-ink-muted">{entry.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          )}

          {handover.recommendations?.length > 0 && (
            <Card className="p-4">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-violet-600" aria-hidden="true" />
                <p className="text-[11.5px] font-semibold">Suggested next actions</p>
                <Badge tone="violet" className="ml-auto">
                  inferred
                </Badge>
              </div>
              <div className="mt-2.5 divide-y divide-line">
                {handover.recommendations
                  .slice(0, showAllRecommendations ? undefined : 6)
                  .map((action) => (
                  <div key={action.key} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex items-start gap-1.5">
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
                      <p className="text-[11px] font-medium leading-4 text-ink-soft">
                        {truncate(action.title, 120)}
                      </p>
                    </div>
                    <p className="mt-1 pl-0.5 text-[9.5px] leading-4 text-ink-faint">
                      {action.reason}
                    </p>
                  </div>
                ))}
                {handover.recommendations.length > 6 && (
                  <div className="mt-1 border-t border-line pt-2">
                    <button
                      type="button"
                      onClick={() => setShowAllRecommendations((value) => !value)}
                      aria-expanded={showAllRecommendations}
                      className="text-[11px] font-semibold text-brand-700 hover:text-brand-900"
                    >
                      {showAllRecommendations
                        ? 'Show fewer'
                        : `View all ${handover.recommendations.length} actions`}
                    </button>
                  </div>
                )}
              </div>
            </Card>
          )}

          {snapshot.transitionContext && (
            <Card className="p-4">
              <p className="eyebrow mb-1.5">Transition context</p>
              <p className="text-[11px] leading-5 text-ink-soft">{snapshot.transitionContext}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {snapshot.outgoingName && <Badge tone="amber">Outgoing: {snapshot.outgoingName}</Badge>}
                {snapshot.plannedDepartureAt && (
                  <Badge tone="slate">Departs {formatDate(snapshot.plannedDepartureAt)}</Badge>
                )}
              </div>
            </Card>
          )}

          <Card className="p-4">
            <p className="eyebrow mb-2">Approval trail</p>
            <ul className="space-y-2 text-[10.5px] leading-4 text-ink-muted">
              <li className="flex justify-between gap-2">
                <span>Created</span>
                <span className="font-mono">{formatDateTime(handover.createdAt)}</span>
              </li>
              {handover.approvedAt && (
                <li className="flex justify-between gap-2">
                  <span>Approved by {handover.approvedBySnapshot?.name}</span>
                  <span className="font-mono">{formatDateTime(handover.approvedAt)}</span>
                </li>
              )}
              {handover.sharedAt && (
                <li className="flex justify-between gap-2">
                  <span>Shared</span>
                  <span className="font-mono">{formatDateTime(handover.sharedAt)}</span>
                </li>
              )}
              {handover.acknowledgedAt && (
                <li className="flex justify-between gap-2 text-emerald-700">
                  <span>Acknowledged</span>
                  <span className="font-mono">{formatDateTime(handover.acknowledgedAt)}</span>
                </li>
              )}
              {!handover.approvedAt && !handover.sharedAt && (
                <li>No approval or share events recorded yet.</li>
              )}
            </ul>
          </Card>
        </div>
      </div>

      <EvidenceDrawer
        projectId={projectId}
        handoverId={handover.id}
        evidenceId={evidenceId}
        open={Boolean(evidenceId)}
        onClose={() => setEvidenceId(null)}
      />

      <Modal
        open={acceptAllOpen}
        onClose={() => setAcceptAllOpen(false)}
        title="Accept all verified items?"
        description="Only items whose quotes all matched the source are accepted. Unverified or conflicting items stay pending for individual review."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAcceptAllOpen(false)}>
              Cancel
            </Button>
            <Button icon={CheckCheck} loading={working === 'accept-all'} onClick={acceptAll}>
              Accept {pluralize(verifiedPending.length, 'item')}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-[11.5px] leading-5 text-ink-muted">
          <p>
            This accepts <span className="font-semibold text-ink">{verifiedPending.length}</span>{' '}
            verified item{verifiedPending.length === 1 ? '' : 's'} in one pass. Rejection is never
            automatic, and every decision is written to the audit trail.
          </p>
          {counts.pending - verifiedPending.length > 0 && (
            <p>
              {counts.pending - verifiedPending.length} pending item
              {counts.pending - verifiedPending.length === 1 ? '' : 's'} will remain for manual
              review.
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(editItem)}
        onClose={() => setEditItem(null)}
        title="Edit this item"
        description="The edited wording is what the recipient will see. The original remains in the record."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditItem(null)}>
              Cancel
            </Button>
            <Button loading={editSaving} onClick={saveEdit}>
              Save edited item
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-md border border-line bg-slate-50 px-3 py-2 text-[11px] leading-4 text-ink-muted">
            <span className="font-semibold text-ink-soft">Original: </span>
            {editItem?.originalStatement || editItem?.statement}
          </div>
          <Field label="Recipient-facing statement" htmlFor="edited-statement" required>
            <Textarea
              id="edited-statement"
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              rows={5}
              maxLength={1200}
            />
          </Field>
          <Field
            label="Reviewer note"
            htmlFor="reviewer-note"
            hint="Visible to reviewers only. The recipient never sees this note."
          >
            <Textarea
              id="reviewer-note"
              value={editNote}
              onChange={(event) => setEditNote(event.target.value)}
              rows={2}
              maxLength={600}
              placeholder="Why did you change the wording?"
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Approve this handover"
        description="Approval is a lead-only action. The recipient cannot approve their own handover."
        footer={
          <>
            <Button variant="ghost" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button icon={ShieldCheck} loading={working === 'approve'} onClick={approve}>
              Approve handover
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {counts.pending > 0 && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-5 text-amber-900">
              {pluralize(counts.pending, 'item')} still need a decision. Approval will be rejected by
              the server until every item is decided.
            </p>
          )}
          <Field label="Approval note (optional)" htmlFor="approval-note">
            <Textarea
              id="approval-note"
              value={approveNote}
              onChange={(event) => setApproveNote(event.target.value)}
              rows={3}
              maxLength={600}
              placeholder="Anything the team should know about this approval?"
            />
          </Field>
          {approveError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
              {approveError}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject this handover"
        description="The author or a lead can reopen it as a draft and resubmit. A reason is required and recorded in the audit log."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={working === 'reject'}
              onClick={reject}
              disabled={!rejectNote.trim()}
            >
              Reject handover
            </Button>
          </>
        }
      >
        <Field label="Rejection reason" htmlFor="reject-note" required>
          <Textarea
            id="reject-note"
            value={rejectNote}
            onChange={(event) => setRejectNote(event.target.value)}
            rows={4}
            maxLength={600}
            placeholder="Explain what must change before this can be approved."
          />
        </Field>
        {rejectError && (
          <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
            {rejectError}
          </p>
        )}
      </Modal>

      <Modal
        open={shareOpen}
        onClose={() => {
          setShareOpen(false);
          setShareLink('');
          setShareRenewal(false);
          setShareError('');
        }}
        title={
          shareLink
            ? shareRenewal
              ? 'Share link renewed'
              : 'Handover shared'
            : 'Share this handover'
        }
        description={
          shareLink
            ? 'Give this link to the recipient. It opens read-only, and the demo workspace link needs no sign-in.'
            : handover.status === 'shared'
              ? 'Renewing replaces the current link and resets the expiry. The previous link stops working.'
              : 'Sharing creates a time-limited, read-only link. The named recipient signs in first, except in the demo workspace.'
        }
        footer={
          shareLink ? (
            <>
              <Button variant="ghost" onClick={() => setShareOpen(false)}>
                Close
              </Button>
              <Button icon={Copy} onClick={() => copyShareLink(shareLink)}>
                Copy link
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setShareOpen(false)}>
                Cancel
              </Button>
              <Button icon={Send} loading={working === 'share'} onClick={share}>
                {handover.status === 'shared' ? 'Renew link' : 'Create share link'}
              </Button>
            </>
          )
        }
      >
        {shareLink ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-line bg-slate-50 px-3 py-2.5">
              <p className="eyebrow mb-1">Recipient share link</p>
              <p className="break-all font-mono text-[10.5px] text-ink-soft">{shareLink}</p>
            </div>
            <p className="text-[11.5px] leading-5 text-ink-muted">
              Expires {formatDateTime(shareExpiresAt)}. The link only works for{' '}
              <span className="font-semibold text-ink">
                {handover.recipientSnapshot?.name}
              </span>{' '}
              after they sign in.
            </p>
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[10.5px] leading-4 text-amber-900">
              You can copy this link again from this page while the handover is shared. Renewing
              later issues a new link and invalidates this one.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {handover.status === 'shared' && shareUrl && (
              <div className="rounded-lg border border-line bg-slate-50 px-3 py-2.5">
                <p className="eyebrow mb-1">Current share link</p>
                <p className="break-all font-mono text-[10.5px] text-ink-soft">{shareUrl}</p>
                <p className="mt-1.5 text-[10.5px] text-ink-muted">
                  Expires {formatDateTime(handover.shareExpiresAt)}. Renewing replaces it.
                </p>
              </div>
            )}
            <div className="flex items-center gap-2.5 rounded-lg border border-line bg-slate-50 px-3 py-2.5">
              <Avatar name={handover.recipientSnapshot?.name} size="md" />
              <div>
                <p className="text-[12px] font-semibold">{handover.recipientSnapshot?.name}</p>
                <p className="text-[10.5px] text-ink-muted">{handover.recipientSnapshot?.email}</p>
              </div>
            </div>
            <ul className="space-y-1.5 text-[11px] leading-5 text-ink-muted">
              <li className="flex gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                Only accepted and edited items are included.
              </li>
              <li className="flex gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                Permissions are re-evaluated every time the recipient opens the link.
              </li>
              <li className="flex gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                The recipient can acknowledge receipt, which is written to the audit trail.
              </li>
            </ul>
            {shareError && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
                {shareError}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={revokeOpen}
        onClose={() => {
          setRevokeOpen(false);
          setRevokeReason('');
          setRevokeError('');
        }}
        title="Revoke the share link"
        description="The recipient's current link stops working immediately. This is recorded in the audit trail."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setRevokeOpen(false);
                setRevokeReason('');
                setRevokeError('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={Link2Off}
              loading={working === 'revoke'}
              disabled={Boolean(working)}
              onClick={revokeShare}
            >
              Revoke link
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-5 text-amber-900">
            Revoking does not change the handover's decisions or its approved content. It only
            invalidates the link. You can share it again later, which issues a new link.
          </p>
          <Field
            label="Reason (optional)"
            htmlFor="revoke-reason"
            hint="Recorded in the audit trail so the team knows why access was withdrawn."
          >
            <Textarea
              id="revoke-reason"
              value={revokeReason}
              onChange={(event) => setRevokeReason(event.target.value)}
              rows={3}
              maxLength={400}
              placeholder="e.g. recipient moved to a different project"
            />
          </Field>
          {revokeError && (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700"
            >
              {revokeError}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(diffVersion)}
        onClose={() => {
          setDiffVersion(null);
          setDiff({ loading: false, error: null, data: null });
        }}
        title={
          diff.data
            ? `v${diff.data.version} compared with ${diff.data.previousVersion ? `v${diff.data.previousVersion}` : 'an empty draft'}`
            : `Version ${diffVersion?.version ?? ''} changes`
        }
        description="A human-readable diff between this snapshot and the one before it."
        size="lg"
      >
        {diff.loading ? (
          <div className="flex items-center justify-center py-10">
            <RefreshCw className="h-5 w-5 animate-spin text-brand-600" />
          </div>
        ) : diff.error ? (
          <ErrorState
            title="Could not load this version"
            error={diff.error}
            onRetry={() => diffVersion && openDiff(diffVersion)}
          />
        ) : diff.data ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="navy">v{diff.data.version}</Badge>
              <span className="text-[11.5px] text-ink-muted">{diff.data.reason}</span>
              <span className="ml-auto font-mono text-[9.5px] text-ink-faint">
                {diff.data.actorName || 'System'} · {formatDateTime(diff.data.createdAt)}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="green">{diff.data.counts.added} added</Badge>
              <Badge tone="amber">{diff.data.counts.updated} updated</Badge>
              <Badge tone="red">{diff.data.counts.removed} removed</Badge>
            </div>
            {diff.data.changes.length === 0 ? (
              <p className="rounded-md border border-line bg-slate-50 px-3 py-2 text-[11.5px] text-ink-muted">
                No item-level changes were recorded between these snapshots.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {diff.data.changes.map((change) => (
                  <li
                    key={`${change.claimId}-${change.change}`}
                    className="rounded-md border border-line bg-white px-2.5 py-2 text-[11.5px] leading-4"
                  >
                    <Badge
                      tone={
                        change.change === 'removed'
                          ? 'red'
                          : change.change === 'added'
                            ? 'green'
                            : 'amber'
                      }
                    >
                      {change.change}
                    </Badge>
                    <span className="ml-1.5 text-ink-soft">{change.statement}</span>
                    {change.change === 'updated' && (
                      <span className="mt-1 block font-mono text-[9.5px] text-ink-muted">
                        {change.fields
                          .map(
                            (field) =>
                              `${field.field}: ${field.from ?? 'none'} → ${field.to ?? 'none'}`,
                          )
                          .join(' · ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        title="Version history"
        description="Every review decision, submission, approval and share creates an immutable snapshot."
        size="lg"
      >
        {versions.loading ? (
          <div className="flex items-center justify-center py-10">
            <RefreshCw className="h-5 w-5 animate-spin text-brand-600" />
          </div>
        ) : versions.error ? (
          <ErrorState title="Could not load versions" error={versions.error} onRetry={openVersions} />
        ) : (
          <ol className="space-y-2">
            {(versions.data || []).map((version) => (
              <li
                key={version.version}
                className="flex items-start gap-3 rounded-lg border border-line bg-white px-3 py-2.5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-50 font-mono text-[10px] font-semibold text-brand-800">
                  v{version.version}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11.5px] font-medium text-ink">{version.reason}</p>
                  <p className="mt-0.5 font-mono text-[9.5px] text-ink-faint">
                    {version.actorName || 'System'} · {formatDateTime(version.createdAt)}
                  </p>
                </div>
                {version.version === handover.version && <Badge tone="navy">current</Badge>}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={GitCompareArrows}
                  onClick={() => openDiff(version)}
                >
                  Compare
                </Button>
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </div>
  );
}
