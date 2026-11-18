import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  BadgeCheck,
  CheckCircle2,
  CircleHelp,
  MessageSquareText,
  Send,
  Sparkles,
  UserRoundX,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api.js';
import { useProject } from './ProjectLayout.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { formatDateTime, formatRelative, pluralize, truncate } from '../lib/format.js';
import { TypeBadge } from '../components/badges.jsx';
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
  SectionHeading,
  Textarea,
} from '../components/ui.jsx';

const KIND_LABEL = {
  missing_owner: 'Missing owner',
  conflict: 'Conflicting decisions',
  open_question: 'Open question',
};

const STATUS_TONE = {
  open: 'amber',
  answered: 'green',
  declined: 'slate',
  closed: 'slate',
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || kind;
}

function AnswerForm({ clarification, onAnswered }) {
  const toast = useToast();
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!answer.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await api.post(`/api/clarifications/${clarification.id}/answer`, {
        answer: answer.trim(),
      });
      toast.success(
        response.resultClaimId
          ? 'Answer recorded. A person-confirmed claim and its evidence were created.'
          : 'Answer recorded.',
      );
      setAnswer('');
      onAnswered?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      {clarification.answerOptions?.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {clarification.answerOptions.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setAnswer(option)}
              className={`inline-flex max-w-full items-center rounded-md border px-2 py-1 text-left text-[10.5px] leading-4 transition ${
                answer === option
                  ? 'border-brand-300 bg-brand-50 text-brand-800'
                  : 'border-line bg-white text-ink-muted hover:border-brand-200 hover:text-brand-800'
              }`}
            >
              <span className="truncate">{option}</span>
            </button>
          ))}
        </div>
      )}
      <Field label="Your answer" htmlFor={`answer-${clarification.id}`}>
        <Textarea
          id={`answer-${clarification.id}`}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          rows={3}
          maxLength={1200}
          placeholder={
            clarification.kind === 'missing_owner'
              ? 'Name who owns this now — a project member works best.'
              : clarification.kind === 'conflict'
                ? 'State which version is current and why.'
                : 'Answer from what you know; write "unknown" if nothing was ever recorded.'
          }
        />
      </Field>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={Send} loading={saving} disabled={!answer.trim()} onClick={submit}>
          Submit answer
        </Button>
        <span className="text-[10px] text-ink-muted">
          Stored as person-confirmed evidence, labelled as such and excluded from quote-accuracy
          metrics.
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export default function QuestionsPage() {
  const { projectId } = useParams();
  const { project } = useProject();
  const { user } = useAuth();
  const toast = useToast();
  const [mine, setMine] = useState({ loading: true, error: null, data: [] });
  const [team, setTeam] = useState({ loading: true, error: null, data: [] });
  const [candidates, setCandidates] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState(null);
  const [declineTarget, setDeclineTarget] = useState(null);
  const [declineNote, setDeclineNote] = useState('');
  const [declineError, setDeclineError] = useState('');

  const canAsk = project.canContribute;

  const loadMine = useCallback(async () => {
    try {
      const response = await api.get('/api/clarifications');
      setMine({
        loading: false,
        error: null,
        data: (response.clarifications || []).filter(
          (entry) => String(entry.projectId) === String(projectId),
        ),
      });
    } catch (err) {
      setMine({ loading: false, error: err, data: [] });
    }
  }, [projectId]);

  const loadTeam = useCallback(async () => {
    if (!canAsk) {
      setTeam({ loading: false, error: null, data: [] });
      return;
    }
    try {
      const response = await api.get(`/api/clarifications?projectId=${projectId}`);
      setTeam({ loading: false, error: null, data: response.clarifications || [] });
    } catch (err) {
      setTeam({ loading: false, error: err, data: [] });
    }
  }, [canAsk, projectId]);

  const loadCandidates = useCallback(async () => {
    if (!canAsk) {
      setCandidates({ loading: false, error: null, data: null });
      return;
    }
    try {
      const response = await api.get(`/api/projects/${projectId}/clarifications/candidates`);
      setCandidates({ loading: false, error: null, data: response });
    } catch (err) {
      setCandidates({ loading: false, error: err, data: null });
    }
  }, [canAsk, projectId]);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadMine(), loadTeam(), loadCandidates()]);
  }, [loadMine, loadTeam, loadCandidates]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  const forMe = useMemo(
    () => mine.data.filter((entry) => String(entry.askedOf) === String(user.id)),
    [mine.data, user.id],
  );
  const openForMe = forMe.filter((entry) => entry.status === 'open');

  const ask = async (candidate, askForAll = false) => {
    setBusy(candidate?.id || 'all');
    try {
      const response = await api.post(`/api/projects/${projectId}/clarifications`, {
        askForAll,
        claimIds: askForAll ? undefined : [candidate.claimId].filter(Boolean),
      });
      const created = response.clarifications?.length || 0;
      const skipped = response.skipped?.length || 0;
      toast.success(
        created === 0
          ? 'Nothing new to ask — every gap is already covered by an open question.'
          : `${pluralize(created, 'question')} sent to ${response.outgoing?.name || 'the departing member'}${
              skipped ? `; ${skipped} skipped` : ''
            }.`,
      );
      await reloadAll();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    if (!declineTarget) return;
    setDeclineError('');
    setBusy(declineTarget.id);
    try {
      await api.post(`/api/clarifications/${declineTarget.id}/decline`, {
        note: declineNote.trim() || undefined,
      });
      toast.success('Question declined. The gap stays flagged in the project record.');
      setDeclineTarget(null);
      setDeclineNote('');
      await reloadAll();
    } catch (err) {
      setDeclineError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const outgoing = candidates.data?.outgoing;
  const candidateList = candidates.data?.candidates || [];
  const askable = candidateList.filter((candidate) => candidate.askable);
  const stillAsky = askable.filter((candidate) => !candidate.clarificationId);
  const openCount = team.data.filter((entry) => entry.status === 'open').length;
  const answeredCount = team.data.filter((entry) => entry.status === 'answered').length;
  const declinedCount = team.data.filter((entry) => entry.status === 'declined').length;

  const loading = mine.loading && team.loading && candidates.loading;

  return (
    <div>
      <PageHeader
        eyebrow={`${project.key} · Missing details`}
        title="Questions"
        description="Ask the departing member what the sources never recorded. Their answers become person-confirmed evidence — labelled as such, never blended into extracted facts."
        actions={
          canAsk && stillAsky.length > 0 ? (
            <Button
              icon={MessageSquareText}
              loading={busy === 'all'}
              disabled={Boolean(busy)}
              onClick={() => ask(null, true)}
            >
              Ask all open gaps ({stillAsky.length})
            </Button>
          ) : null
        }
      />

      {loading ? (
        <LoadingBlock rows={3} />
      ) : (
        <div className="space-y-4">
          {openForMe.length > 0 && (
            <section>
              <SectionHeading
                eyebrow="For you"
                title={`Questions for you (${openForMe.length})`}
                description={`Asked by ${project.name} because only you can settle them before you leave.`}
                action={<Badge tone="amber" dot>Needs your answer</Badge>}
              />
              <div className="mt-3 space-y-2.5">
                {openForMe.map((entry) => (
                  <Card key={entry.id} className="p-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="violet">{kindLabel(entry.kind)}</Badge>
                      <span className="font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
                        Asked {formatRelative(entry.createdAt)}
                      </span>
                      <span className="ml-auto text-[10.5px] text-ink-muted">
                        by {entry.askedByName || 'a teammate'}
                      </span>
                    </div>
                    <p className="mt-2 text-[13px] font-medium leading-6 text-ink">{entry.prompt}</p>
                    <AnswerForm clarification={entry} onAnswered={reloadAll} />
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setDeclineTarget(entry);
                          setDeclineNote('');
                          setDeclineError('');
                        }}
                        className="text-[10.5px] font-medium text-ink-muted hover:text-red-700"
                      >
                        Can't answer this
                      </button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {canAsk && (
            <section>
              <SectionHeading
                eyebrow="Coverage"
                title="Ask the departing member"
                description={
                  outgoing
                    ? `${outgoing.name} reads this project. Asking turns an unresolved gap into a direct question they can answer.`
                    : 'Record a departing member on People so Threadline knows who to ask.'
                }
                action={
                  team.loading ? null : (
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="amber">{openCount} open</Badge>
                      <Badge tone="green">{answeredCount} answered</Badge>
                      <Badge tone="slate">{declinedCount} declined</Badge>
                    </div>
                  )
                }
              />

              {candidates.loading ? (
                <LoadingBlock rows={2} className="mt-3" />
              ) : candidates.error ? (
                <div className="mt-3">
                  <ErrorState
                    title="Could not load the gaps"
                    error={candidates.error}
                    onRetry={() => loadCandidates()}
                  />
                </div>
              ) : !outgoing ? (
                <EmptyState
                  className="mt-3"
                  icon={UserRoundX}
                  title="No departing member is recorded"
                  description="Threadline asks a specific person, not a mailing list. Set the outgoing owner in People, then come back."
                />
              ) : candidateList.length === 0 ? (
                <Card className="mt-3 p-5 text-center">
                  <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-600" aria-hidden="true" />
                  <p className="mt-2 text-[13px] font-semibold">No gaps to ask about</p>
                  <p className="mt-1 text-[11.5px] text-ink-muted">
                    There are no ownership gaps, conflicting decisions or open questions the
                    departing member can read right now.
                  </p>
                </Card>
              ) : (
                <div className="mt-3 space-y-2.5">
                  {candidateList.map((candidate) => {
                    const asked = Boolean(candidate.clarificationId);
                    return (
                      <Card key={candidate.id} className="p-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={candidate.kind === 'conflict' ? 'red' : 'violet'}>
                            {kindLabel(candidate.kind)}
                          </Badge>
                          {candidate.claim?.type && <TypeBadge type={candidate.claim.type} />}
                          {asked && <Badge tone="green">Asked</Badge>}
                          {!candidate.askable && (
                            <Badge tone="slate" title={candidate.unaskableReason}>
                              Not readable by {outgoing.name}
                            </Badge>
                          )}
                          <span className="ml-auto font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
                            #{String(candidate.claimId || candidate.id).slice(-6)}
                          </span>
                        </div>
                        <p className="mt-2 text-[13px] font-medium leading-6 text-ink">
                          {candidate.prompt}
                        </p>
                        {candidate.kind === 'conflict' && candidate.statements?.length > 0 && (
                          <ul className="mt-1.5 space-y-1">
                            {candidate.statements.map((statement, index) => (
                              <li
                                key={statement.claimId}
                                className="rounded-md border border-line bg-slate-50 px-2.5 py-1.5 text-[11px] leading-4 text-ink-muted"
                              >
                                <span className="mr-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-faint">
                                  {String.fromCharCode(65 + index)}
                                </span>
                                {truncate(statement.statement, 180)}
                              </li>
                            ))}
                          </ul>
                        )}
                        {candidate.kind === 'missing_owner' && candidate.claim?.statement && (
                          <p className="mt-1.5 text-[11px] leading-4 text-ink-muted">
                            {truncate(candidate.claim.statement, 180)}
                          </p>
                        )}
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant={asked ? 'secondary' : 'primary'}
                            icon={MessageSquareText}
                            disabled={asked || !candidate.askable || Boolean(busy)}
                            loading={busy === candidate.id}
                            onClick={() => ask(candidate)}
                          >
                            {asked ? 'Question already open' : 'Ask this'}
                          </Button>
                          {!candidate.askable && (
                            <span className="text-[10.5px] text-ink-muted">
                              {outgoing.name} cannot see this item, so asking would leak it. Ask a
                              lead to widen their access first.
                            </span>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {canAsk && (
            <section>
              <SectionHeading
                eyebrow="Record"
                title="Asked and answered"
                description="Every question and answer is kept in the project audit trail."
              />
              {team.error ? (
                <div className="mt-3">
                  <ErrorState
                    title="Could not load the questions"
                    error={team.error}
                    onRetry={() => loadTeam()}
                  />
                </div>
              ) : team.data.length === 0 ? (
                <Card className="mt-3 flex items-start gap-2.5 p-4 text-[11.5px] leading-5 text-ink-muted">
                  <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
                  <p>
                    No questions have been asked in this project yet. Ask about an ownership gap, a
                    conflicting decision or an open question above.
                  </p>
                </Card>
              ) : (
                <div className="mt-3 divide-y divide-line overflow-hidden rounded-card border border-line bg-white shadow-card">
                  {team.data.map((entry) => (
                    <div key={entry.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={STATUS_TONE[entry.status] || 'slate'} dot>
                          {entry.status}
                        </Badge>
                        <Badge tone="violet">{kindLabel(entry.kind)}</Badge>
                        <span className="text-[10px] text-ink-faint">
                          {entry.askedByName || 'Someone'} → {entry.askedOfName || 'departing member'}
                        </span>
                        <span className="ml-auto font-mono text-[9.5px] text-ink-faint">
                          {formatDateTime(entry.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[12px] font-medium leading-5 text-ink">
                        {entry.prompt}
                      </p>
                      {entry.status === 'answered' && (
                        <div className="mt-2 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5">
                          <p className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-violet-800">
                            <BadgeCheck className="h-3 w-3" aria-hidden="true" /> Person-confirmed
                          </p>
                          <p className="mt-0.5 text-[11.5px] leading-4 text-ink-soft">{entry.answer}</p>
                          <p className="mt-0.5 font-mono text-[9.5px] text-ink-faint">
                            {entry.askedOfName || 'Departing member'}
                            {entry.answeredAt ? ` · ${formatDateTime(entry.answeredAt)}` : ''}
                          </p>
                        </div>
                      )}
                      {entry.status === 'declined' && (
                        <p className="mt-1.5 text-[11px] leading-4 text-ink-muted">
                          Declined{entry.declineNote ? `: ${entry.declineNote}` : ' without a note'}.
                          The underlying gap stays flagged.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {!canAsk && forMe.length === 0 && (
            <EmptyState
              icon={Sparkles}
              title="Nothing waiting on you"
              description="Questions a lead asks you will appear here with a place to answer."
            />
          )}
        </div>
      )}

      <Modal
        open={Boolean(declineTarget)}
        onClose={() => setDeclineTarget(null)}
        title="Decline this question"
        description="The gap stays flagged in the project record so a lead can follow up another way."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeclineTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy === declineTarget?.id} onClick={decline}>
              Decline question
            </Button>
          </>
        }
      >
        <Field label="Why can't you answer? (optional)" htmlFor="decline-note">
          <Textarea
            id="decline-note"
            value={declineNote}
            onChange={(event) => setDeclineNote(event.target.value)}
            rows={3}
            maxLength={600}
            placeholder="e.g. that decision was made by someone else"
          />
        </Field>
        {declineError && (
          <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
            {declineError}
          </p>
        )}
      </Modal>
    </div>
  );
}
