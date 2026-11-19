import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CalendarClock,
  Crown,
  Info,
  LockKeyhole,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api.js';
import { useProject } from './ProjectLayout.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useWorkspace } from '../context/WorkspaceContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { ROLE_LABELS } from '../lib/constants.js';
import { formatDate, formatIstIso, formatRelative, pluralize } from '../lib/format.js';
import { RoleBadge } from '../components/badges.jsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  SectionHeading,
  Select,
  Textarea,
} from '../components/ui.jsx';

const ROLE_CHOICES = [
  {
    value: 'lead',
    label: 'Project lead',
    description: 'Full governance: access rules, approvals, audit and team changes.',
  },
  {
    value: 'contributor',
    label: 'Contributor',
    description: 'Adds sources, prepares handovers and reviews items. Cannot approve or change access.',
  },
  {
    value: 'observer',
    label: 'Observer',
    description: 'Read-only. Sees only the sources and claims they are allowed to read.',
  },
];

const CAPABILITIES = [
  { capability: 'Read visible sources and claims', lead: true, contributor: true, observer: true },
  { capability: 'Add sources and re-ingest', lead: true, contributor: true, observer: false },
  { capability: 'Prepare and review a handover', lead: true, contributor: true, observer: false },
  { capability: 'Change source visibility', lead: true, contributor: false, observer: false },
  { capability: 'Approve or reject a handover', lead: true, contributor: false, observer: false },
  { capability: 'View the audit log and manage people', lead: true, contributor: false, observer: false },
];

function toDateInput(value) {
  return formatIstIso(value).slice(0, 10);
}

function settingsForm(project) {
  return {
    name: project.name || '',
    description: project.description || '',
    status: project.status || 'active',
    startedAt: toDateInput(project.startedAt),
    targetDate: toDateInput(project.targetDate),
    outgoingUserId: project.transition?.outgoingUserId
      ? String(project.transition.outgoingUserId)
      : '',
    outgoingName: project.transition?.outgoingName || '',
    plannedDepartureAt: toDateInput(project.transition?.plannedDepartureAt),
    context: project.transition?.context || '',
    requireSeparateApprover: Boolean(project.settings?.requireSeparateApprover),
  };
}

function CapabilityTick({ value }) {
  return value ? (
    <span className="font-mono text-[11px] font-semibold text-emerald-700">yes</span>
  ) : (
    <span className="font-mono text-[11px] text-ink-faint">no</span>
  );
}

export default function PeoplePage() {
  const { projectId } = useParams();
  const { project, reloadProject } = useProject();
  const { user } = useAuth();
  const { upsertProject, setCurrentProject } = useWorkspace();
  const toast = useToast();
  const isLead = project.role === 'lead';

  const [addOpen, setAddOpen] = useState(false);
  const [invite, setInvite] = useState({ email: '', role: 'contributor' });
  const [inviteError, setInviteError] = useState(null);
  const [lookup, setLookup] = useState(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [roleBusy, setRoleBusy] = useState(null);
  const [form, setForm] = useState(() => settingsForm(project));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    setForm(settingsForm(project));
  }, [project]);

  // Show the account's confirmation state before the lead commits, so an
  // unverified address is understood as a person-side step, not a failed add.
  useEffect(() => {
    const email = invite.email.trim();
    setLookup(null);
    if (!addOpen || !email.includes('@')) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      api
        .get(`/api/projects/${projectId}/member-lookup?email=${encodeURIComponent(email)}`)
        .then((data) => {
          if (alive) setLookup(data.lookup);
        })
        .catch(() => {});
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [addOpen, invite.email, projectId]);

  const lookupBlocksAdd = Boolean(
    lookup && (!lookup.found || !lookup.emailVerified || lookup.isMember),
  );

  const members = useMemo(
    () =>
      [...(project.members || [])].sort((a, b) => {
        const rank = { lead: 0, contributor: 1, observer: 2 };
        const byRole = (rank[a.role] ?? 3) - (rank[b.role] ?? 3);
        return byRole || (a.name || a.email || '').localeCompare(b.name || b.email || '');
      }),
    [project.members],
  );

  const owner = members.find((member) => member.userId === project.owner);
  const outgoing = members.find((member) => member.userId === String(project.transition?.outgoingUserId));
  const leadCount = members.filter((member) => member.role === 'lead').length;

  const applyProject = async (nextProject) => {
    upsertProject(nextProject);
    setCurrentProject(nextProject);
    await reloadProject({ quiet: true }).catch(() => {});
  };

  const addMember = async (event) => {
    event.preventDefault();
    setInviteError(null);
    setAdding(true);
    try {
      const data = await api.post(`/api/projects/${projectId}/members`, {
        email: invite.email.trim(),
        role: invite.role,
      });
      await applyProject(data.project);
      toast.success(
        `${data.project.members.find((member) => member.email === invite.email.trim().toLowerCase())?.name || invite.email} now has ${ROLE_LABELS[invite.role].toLowerCase()} access.`,
      );
      setInvite({ email: '', role: 'contributor' });
      setAddOpen(false);
    } catch (error) {
      setInviteError(error);
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await api.del(`/api/projects/${projectId}/members/${removing.userId}`);
      await reloadProject({ quiet: true });
      toast.success(`${removing.name || removing.email} was removed from ${project.key}.`);
      setRemoving(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRemoveBusy(false);
    }
  };

  const changeRole = async (member, role) => {
    if (!member || role === member.role || roleBusy) return;
    setRoleBusy(member.userId);
    try {
      const data = await api.patch(`/api/projects/${projectId}/members/${member.userId}`, {
        role,
      });
      await applyProject(data.project);
      toast.success(
        `${member.name || member.email} now has ${ROLE_LABELS[role].toLowerCase()} access from their next request.`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRoleBusy(null);
    }
  };

  const saveSettings = async (event) => {
    event.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        status: form.status,
      };
      if (form.startedAt) payload.startedAt = form.startedAt;
      if (form.targetDate) payload.targetDate = form.targetDate;

      const transition = {};
      if (form.outgoingUserId) transition.outgoingUserId = form.outgoingUserId;
      transition.outgoingName = form.outgoingName.trim();
      if (form.plannedDepartureAt) transition.plannedDepartureAt = form.plannedDepartureAt;
      transition.context = form.context.trim();
      payload.transition = transition;
      payload.settings = { requireSeparateApprover: Boolean(form.requireSeparateApprover) };

      const data = await api.patch(`/api/projects/${projectId}`, payload);
      await applyProject(data.project);
      toast.success('Project settings updated and written to the audit log.');
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow={`${project.key} · Team & governance`}
        title="People & settings"
        description="Membership decides what each person can read and do. Every change here is recorded in the audit log and applied at the next read."
        actions={
          isLead ? (
            <Button size="sm" icon={UserPlus} onClick={() => setAddOpen(true)}>
              Add member
            </Button>
          ) : (
            <Badge tone="slate">
              <LockKeyhole className="h-3 w-3" aria-hidden="true" />
              Lead-managed
            </Badge>
          )
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3.5">
              <div>
                <h2 className="text-[14px] font-semibold">Project members</h2>
                <p className="mt-0.5 text-[11.5px] text-ink-muted">
                  {pluralize(members.length, 'person', 'people')} · {leadCount} lead
                  {leadCount === 1 ? '' : 's'}
                </p>
              </div>
              {outgoing && (
                <Badge tone="amber">
                  <CalendarClock className="h-3 w-3" aria-hidden="true" />
                  outgoing: {outgoing.name || outgoing.email}
                </Badge>
              )}
            </div>

            <ul className="divide-y divide-line">
              {members.map((member) => {
                const isOwner = member.userId === project.owner;
                const isSelf = member.userId === String(user?.id);
                return (
                  <li key={member.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <Avatar name={member.name || member.email} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-[13px] font-semibold">
                          {member.name || member.email}
                          {isSelf && <span className="ml-1.5 text-[11px] font-normal text-ink-muted">(you)</span>}
                        </p>
                        {isOwner && (
                          <Badge tone="navy">
                            <Crown className="h-2.5 w-2.5" aria-hidden="true" />
                            owner
                          </Badge>
                        )}
                        {outgoing?.userId === member.userId && <Badge tone="amber">outgoing</Badge>}
                      </div>
                      <p className="truncate text-[11px] text-ink-muted">{member.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {isLead && !isOwner ? (
                        <Select
                          aria-label={`Change role for ${member.name || member.email}`}
                          value={member.role}
                          onChange={(event) => changeRole(member, event.target.value)}
                          disabled={roleBusy === member.userId}
                          className="h-8 w-[140px] py-0 text-[11.5px]"
                        >
                          {ROLE_CHOICES.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {choice.label}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <RoleBadge role={member.role} />
                      )}
                      {isLead && !isOwner && (
                        <button
                          type="button"
                          onClick={() => setRemoving(member)}
                          className="rounded-md p-1.5 text-ink-faint transition hover:bg-red-50 hover:text-red-600"
                          aria-label={`Remove ${member.name || member.email}`}
                          title="Remove from project"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {member.joinedAt && (
                      <p className="w-full font-mono text-[9.5px] text-ink-faint sm:w-auto">
                        joined {formatRelative(member.joinedAt)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="border-t border-line bg-slate-50/60 px-4 py-2.5 text-[10.5px] leading-4 text-ink-muted">
              The owner cannot be removed. Removing someone takes effect on their next request; content
              they could read disappears immediately.
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3.5">
              <SectionHeading
                title="Access capabilities"
                description="Roles are enforced on the server, not hidden in the interface."
              />
            </div>
            <div
              className="scroll-safe overflow-x-auto"
              role="region"
              aria-label="Access capabilities"
              tabIndex={0}
            >
              <table className="w-full min-w-[520px] text-left">
                <thead>
                  <tr className="border-b border-line bg-slate-50/60 text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                    <th className="px-4 py-2 font-semibold">Capability</th>
                    <th className="px-3 py-2 font-semibold">Lead</th>
                    <th className="px-3 py-2 font-semibold">Contributor</th>
                    <th className="px-3 py-2 font-semibold">Observer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {CAPABILITIES.map((row) => (
                    <tr key={row.capability} className="text-[11.5px] text-ink-soft">
                      <td className="px-4 py-2">{row.capability}</td>
                      <td className="px-3 py-2"><CapabilityTick value={row.lead} /></td>
                      <td className="px-3 py-2"><CapabilityTick value={row.contributor} /></td>
                      <td className="px-3 py-2"><CapabilityTick value={row.observer} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-[13px] font-semibold">What member changes do to handovers</h3>
                <p className="mt-1 text-[12px] leading-5 text-ink-muted">
                  A handover is re-filtered every time it is read. If a member loses access to a
                  source after a handover was shared, the affected items disappear from their next
                  read and the permission recheck records the revocation. Reviewer notes and
                  withheld details are never sent to recipients.
                </p>
              </div>
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="p-4">
            <SectionHeading
              eyebrow="Project record"
              title="Settings"
              description={
                isLead
                  ? 'Changes are audited. Dates are stored in UTC.'
                  : 'Only a project lead can edit these settings.'
              }
            />

            {!isLead ? (
              <div className="mt-4 rounded-lg border border-dashed border-line-strong bg-slate-50/60 p-4">
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-soft">
                  <LockKeyhole className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                  Read-only view
                </p>
                <dl className="mt-3 space-y-2 text-[11.5px]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Key</dt>
                    <dd className="font-mono">{project.key}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Status</dt>
                    <dd className="capitalize">{project.status}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Started</dt>
                    <dd>{formatDate(project.startedAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Target</dt>
                    <dd>{formatDate(project.targetDate)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Handover due</dt>
                    <dd>{formatDate(project.transition?.plannedDepartureAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Separate approver</dt>
                    <dd>{project.settings?.requireSeparateApprover ? 'required' : 'not required'}</dd>
                  </div>
                </dl>
                {owner && (
                  <p className="mt-3 border-t border-line pt-2.5 text-[11px] text-ink-muted">
                    Owner: <span className="font-medium text-ink-soft">{owner.name || owner.email}</span>
                  </p>
                )}
              </div>
            ) : (
              <form className="mt-4 space-y-3.5" onSubmit={saveSettings}>
                <Field label="Project name" htmlFor="project-name" required>
                  <Input
                    id="project-name"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    minLength={2}
                    maxLength={120}
                    required
                  />
                </Field>

                <Field label="Description" htmlFor="project-description" hint="Shown on the project card and overview.">
                  <Textarea
                    id="project-description"
                    rows={3}
                    maxLength={2000}
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Status" htmlFor="project-status">
                    <Select
                      id="project-status"
                      value={form.status}
                      onChange={(event) => setForm({ ...form, status: event.target.value })}
                    >
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="completed">Completed</option>
                    </Select>
                  </Field>
                  <Field label="Project key" htmlFor="project-key" hint="Immutable identifier.">
                    <Input id="project-key" value={project.key} disabled />
                  </Field>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Started" htmlFor="project-started">
                    <Input
                      id="project-started"
                      type="date"
                      value={form.startedAt}
                      onChange={(event) => setForm({ ...form, startedAt: event.target.value })}
                    />
                  </Field>
                  <Field label="Target date" htmlFor="project-target">
                    <Input
                      id="project-target"
                      type="date"
                      value={form.targetDate}
                      onChange={(event) => setForm({ ...form, targetDate: event.target.value })}
                    />
                  </Field>
                </div>

                <div className="rounded-lg border border-line bg-slate-50/60 p-3">
                  <p className="mb-1 text-[11.5px] font-semibold text-ink-soft">Approval policy</p>
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={Boolean(form.requireSeparateApprover)}
                      onChange={(event) =>
                        setForm({ ...form, requireSeparateApprover: event.target.checked })
                      }
                      className="mt-0.5 h-3.5 w-3.5 rounded text-brand-700 focus:ring-brand-200"
                    />
                    <span>
                      <span className="block text-[12px] text-ink-soft">
                        Require a different person to approve a handover
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-ink-muted">
                        With this on, the person who prepared a handover cannot also approve it. If
                        the author is your only lead, add a second lead before they submit.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="rounded-lg border border-line bg-slate-50/60 p-3">
                  <p className="mb-2.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-soft">
                    <CalendarClock className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                    Transition context
                  </p>
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Outgoing person" htmlFor="outgoing-user">
                        <Select
                          id="outgoing-user"
                          value={form.outgoingUserId}
                          onChange={(event) => {
                            const member = members.find(
                              (entry) => entry.userId === event.target.value,
                            );
                            setForm({
                              ...form,
                              outgoingUserId: event.target.value,
                              outgoingName: member?.name || form.outgoingName,
                            });
                          }}
                        >
                          <option value="">Not assigned</option>
                          {members.map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.name || member.email}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Display name" htmlFor="outgoing-name">
                        <Input
                          id="outgoing-name"
                          maxLength={120}
                          value={form.outgoingName}
                          onChange={(event) =>
                            setForm({ ...form, outgoingName: event.target.value })
                          }
                        />
                      </Field>
                    </div>

                    <Field label="Planned departure" htmlFor="departure-date">
                      <Input
                        id="departure-date"
                        type="date"
                        value={form.plannedDepartureAt}
                        onChange={(event) =>
                          setForm({ ...form, plannedDepartureAt: event.target.value })
                        }
                      />
                    </Field>

                    <Field
                      label="Context for the handover"
                      htmlFor="transition-context"
                      hint="Why this transition is happening, stated as context only — the pipeline never adds facts from here."
                    >
                      <Textarea
                        id="transition-context"
                        rows={3}
                        maxLength={2000}
                        value={form.context}
                        onChange={(event) => setForm({ ...form, context: event.target.value })}
                      />
                    </Field>
                  </div>
                </div>

                {saveError && <ErrorState compact title="Settings were not saved" error={saveError} />}

                <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                  <p className="flex items-center gap-1 text-[10.5px] text-ink-faint">
                    <Info className="h-3 w-3" aria-hidden="true" />
                    Dates cannot be cleared once set; choose a new date instead.
                  </p>
                  <Button type="submit" size="sm" loading={saving}>
                    Save settings
                  </Button>
                </div>
              </form>
            )}
          </Card>

          <Card className="p-4">
            <SectionHeading eyebrow="How access works" title="Fail closed by default" />
            <ul className="mt-3 space-y-2.5 text-[11.5px] leading-5 text-ink-muted">
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                A claim is visible only when every citation behind it resolves to a source you may
                read.
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                Restricted sources are filtered out of lists, counts and searches — not greyed out.
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                Every evidence open is audited, including the document you viewed and when.
              </li>
            </ul>
          </Card>
        </div>
      </div>

      <Modal
        open={addOpen}
        onClose={() => {
          if (adding) return;
          setAddOpen(false);
          setInviteError(null);
        }}
        title="Add a project member"
        description="The person needs an existing Threadline account. Their role determines what they can read and change from their next request."
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAddOpen(false)}
              disabled={adding}
            >
              Cancel
            </Button>
            <Button size="sm" icon={UserPlus} loading={adding} onClick={addMember} disabled={lookupBlocksAdd}>
              Add member
            </Button>
          </>
        }
      >
        <form onSubmit={addMember} className="space-y-4">
          <Field label="Email address" htmlFor="invite-email" required>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              value={invite.email}
              onChange={(event) => setInvite({ ...invite, email: event.target.value })}
              required
            />
          </Field>
          {lookup && (
            <p
              className={`rounded-lg border px-2.5 py-2 text-[11px] leading-4 ${
                lookup.isMember
                  ? 'border-line bg-paper text-ink-muted'
                  : !lookup.found
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : !lookup.emailVerified
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800'
              }`}
            >
              {lookup.isMember
                ? `${lookup.name || 'That account'} is already a member of this project.`
                : !lookup.found
                  ? 'No Threadline account uses this address yet. Ask them to register first.'
                  : !lookup.emailVerified
                    ? `${lookup.name} has not confirmed ${lookup.email} yet. Ask them to open the verification link before you add them.`
                    : `${lookup.name} has confirmed ${lookup.email}. Ready to add.`}
            </p>
          )}
          <Field label="Role" htmlFor="invite-role">
            <div className="space-y-1.5">
              {ROLE_CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  className={`flex cursor-pointer gap-2.5 rounded-lg border p-2.5 transition ${
                    invite.role === choice.value
                      ? 'border-brand-300 bg-brand-50/60 ring-1 ring-brand-200'
                      : 'border-line bg-white hover:border-brand-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="invite-role"
                    value={choice.value}
                    checked={invite.role === choice.value}
                    onChange={() => setInvite({ ...invite, role: choice.value })}
                    className="mt-0.5 h-3.5 w-3.5 text-brand-700 focus:ring-brand-200"
                  />
                  <span>
                    <span className="block text-[12px] font-semibold text-ink-soft">
                      {choice.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-ink-muted">
                      {choice.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          {inviteError && (
            <ErrorState compact title="Could not add that person" error={inviteError} />
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(removing)}
        onClose={() => {
          if (!removeBusy) setRemoving(null);
        }}
        title="Remove this person from the project?"
        description={
          removing
            ? `${removing.name || removing.email} will lose access to every source and handover in ${project.key}. This is audited and takes effect immediately.`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRemoving(null)}
              disabled={removeBusy}
            >
              Keep member
            </Button>
            <Button variant="danger" size="sm" icon={Trash2} loading={removeBusy} onClick={removeMember}>
              Remove access
            </Button>
          </>
        }
      >
        {removing && (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-slate-50 p-3">
            <Avatar name={removing.name || removing.email} size="md" />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold">{removing.name || removing.email}</p>
              <p className="truncate text-[11.5px] text-ink-muted">{removing.email}</p>
            </div>
            <RoleBadge role={removing.role} />
          </div>
        )}
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-5 text-ink-muted">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          To change someone’s role instead, add them back with the new role after removal.
        </p>
      </Modal>
    </div>
  );
}
