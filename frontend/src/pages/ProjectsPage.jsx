import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CalendarClock,
  CalendarDays,
  FolderPlus,
  Layers,
  RefreshCw,
  Search,
  Users,
  Waypoints,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useWorkspace } from '../context/WorkspaceContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api, errorMessage } from '../lib/api.js';
import { DEMO_PERSONAS, ROLE_LABELS } from '../lib/constants.js';
import { daysUntil, formatDate, formatRelative } from '../lib/format.js';
import { RoleBadge } from '../components/badges.jsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  Textarea,
} from '../components/ui.jsx';

const EMPTY_FORM = {
  key: '',
  name: '',
  description: '',
  startedAt: new Date().toISOString().slice(0, 10),
  targetDate: '',
  outgoingName: '',
  plannedDepartureAt: '',
  context: '',
};

function ProjectCard({ project }) {
  const departure = daysUntil(project.transition?.plannedDepartureAt);
  return (
    <Link
      to={`/projects/${project.id}`}
      className="group relative flex flex-col rounded-card border border-line bg-surface p-5 shadow-card transition duration-150 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-lift focus-visible:-translate-y-0.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 items-center rounded-md bg-brand-900 px-2 font-mono text-[10.5px] font-semibold tracking-wide text-white">
            {project.key}
          </span>
          <RoleBadge role={project.role} />
        </div>
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-white text-ink-faint transition group-hover:border-brand-200 group-hover:text-brand-700">
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>

      <h2 className="mt-3 font-display text-[18px] font-semibold leading-6 tracking-[-0.015em]">
        {project.name}
      </h2>
      <p className="mt-1.5 line-clamp-2 min-h-[40px] text-[12.5px] leading-5 text-ink-muted">
        {project.description || 'No project description yet.'}
      </p>

      {project.transition?.outgoingName ? (
        <div className="mt-4 rounded-lg border border-line bg-slate-50/80 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-soft">
            <CalendarClock className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
            {project.transition.outgoingName} is rotating off
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-ink-muted">
              {formatDate(project.transition.plannedDepartureAt)}
            </span>
            {departure !== null && (
              <Badge tone={departure <= 7 ? 'red' : 'amber'}>
                {departure >= 0 ? `T-${departure} days` : `${Math.abs(departure)}d overdue`}
              </Badge>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-line px-3 py-2.5 text-[10.5px] text-ink-faint">
          No transition scheduled
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <div className="flex items-center gap-2">
          <div className="flex -space-x-1.5">
            {project.members.slice(0, 3).map((member) => (
              <Avatar
                key={member.userId}
                name={member.name || member.email}
                size="xs"
                className="ring-2 ring-white"
              />
            ))}
          </div>
          <span className="text-[10.5px] text-ink-muted">
            {project.members.length} {project.members.length === 1 ? 'member' : 'members'}
          </span>
        </div>
        <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-faint">
          <CalendarDays className="h-3 w-3" aria-hidden="true" />
          {formatRelative(project.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

export default function ProjectsPage() {
  const { user } = useAuth();
  const {
    projects,
    loading,
    error: projectsError,
    reloadProjects,
    upsertProject,
    setCurrentProject,
  } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [invites, setInvites] = useState([]);

  useEffect(() => {
    setCurrentProject(null);
  }, [setCurrentProject]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(term) ||
        project.key.toLowerCase().includes(term) ||
        project.description?.toLowerCase().includes(term),
    );
  }, [projects, query]);

  const canManageDemo = useMemo(
    () => projects.some((project) => project.role === 'lead'),
    [projects],
  );

  const totals = useMemo(() => {
    const people = new Set();
    for (const project of projects) {
      for (const member of project.members) people.add(member.userId);
    }
    const transitions = projects.filter((project) => project.transition?.outgoingName).length;
    return { people: people.size, transitions };
  }, [projects]);

  const resetDemo = async () => {
    setSeeding(true);
    setError('');
    try {
      await api.post('/api/demo/seed?reset=true');
      await reloadProjects();
      setDemoOpen(false);
      toast.success('Atlas demo workspace rebuilt with fresh synthetic sources.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSeeding(false);
    }
  };

  const createProject = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const data = await api.post('/api/projects', {
        key: form.key.trim().toUpperCase(),
        name: form.name.trim(),
        description: form.description.trim(),
        startedAt: form.startedAt || undefined,
        targetDate: form.targetDate || undefined,
        members: invites.filter((invite) => invite.email.trim()).map((invite) => ({
          email: invite.email.trim(),
          role: invite.role,
        })),
        transition: form.outgoingName
          ? {
              outgoingName: form.outgoingName.trim(),
              plannedDepartureAt: form.plannedDepartureAt || undefined,
              context: form.context.trim() || undefined,
            }
          : undefined,
      });
      upsertProject(data.project);
      setModalOpen(false);
      setForm(EMPTY_FORM);
      setInvites([]);
      toast.success(`${data.project.key} created`);
      navigate(`/projects/${data.project.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const updateInvite = (index, patch) => {
    setInvites((current) =>
      current.map((invite, position) => (position === index ? { ...invite, ...patch } : invite)),
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${user?.name?.split(' ')[0] || 'there'}`}
        description="Each project turns authorized activity into an evidence-linked state of record, then into handovers that people can review and trust."
        actions={
          <>
            {canManageDemo && (
              <Button variant="secondary" icon={RefreshCw} onClick={() => setDemoOpen(true)}>
                Demo data
              </Button>
            )}
            <Button icon={FolderPlus} onClick={() => setModalOpen(true)}>
              New project
            </Button>
          </>
        }
      >
        <div className="mt-6 grid grid-cols-3 gap-2 sm:max-w-xl sm:gap-3">
          {[
            { label: 'Projects', value: projects.length, icon: Layers },
            { label: 'Active transitions', value: totals.transitions, icon: Waypoints },
            { label: 'People', value: totals.people, icon: Users },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-card border border-line bg-white/80 px-3.5 py-3 shadow-sm"
            >
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                <stat.icon className="h-3 w-3" aria-hidden="true" />
                {stat.label}
              </div>
              <p className="mt-1 font-display text-[22px] font-semibold leading-none">{stat.value}</p>
            </div>
          ))}
        </div>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink-soft">
          {query ? `Results for “${query}”` : 'All projects'}
        </h2>
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search projects"
          className="w-full sm:w-64"
        />
      </div>

      {projectsError && projects.length === 0 ? (
        <ErrorState
          title="Could not load your projects"
          error={projectsError}
          onRetry={() => reloadProjects().catch(() => {})}
        />
      ) : loading ? (
        <LoadingBlock rows={2} />
      ) : filtered.length === 0 && projects.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No projects yet"
          description="Create a project and invite the people who will hand it over. Or load the synthetic Atlas demo to explore the full workflow instantly."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon={FolderPlus} onClick={() => setModalOpen(true)}>
                Create a project
              </Button>
              <Button variant="secondary" icon={RefreshCw} onClick={resetDemo} loading={seeding}>
                Load Atlas demo
              </Button>
            </div>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching projects"
          description="Try a different name or project key."
          action={
            <Button variant="secondary" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line-strong bg-white/40 px-5 text-center transition hover:border-brand-300 hover:bg-brand-50/40"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white text-ink-muted shadow-sm">
              <FolderPlus className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-[13px] font-semibold">Start a new project</span>
            <span className="max-w-[220px] text-[11px] leading-4 text-ink-muted">
              You become the project lead and can invite contributors and observers.
            </span>
          </button>
        </div>
      )}

      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {[
          {
            title: '1 · Ingest',
            body: 'Upload documents or connect a repository. Each source carries its own visibility and sensitivity.',
          },
          {
            title: '2 · Reconstruct',
            body: 'The pipeline extracts decisions, tasks, risks and questions, then verifies every quote against the source text.',
          },
          {
            title: '3 · Hand over',
            body: 'Authors review items, leads approve, and recipients see only what they are authorized to read.',
          },
        ].map((step) => (
          <Card key={step.title} className="p-4">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-brand-700">
              {step.title}
            </p>
            <p className="mt-1.5 text-[11.5px] leading-5 text-ink-muted">{step.body}</p>
          </Card>
        ))}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setError('');
        }}
        title="Create a project"
        description="You become the project lead. Invitations require an existing Threadline account."
        size="lg"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setModalOpen(false);
                setError('');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-project" loading={saving}>
              Create project
            </Button>
          </>
        }
      >
        <form id="create-project" onSubmit={createProject} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <Field label="Project key" htmlFor="project-key" required hint="Short and unique.">
              <Input
                id="project-key"
                value={form.key}
                onChange={(event) =>
                  setForm({ ...form, key: event.target.value.toUpperCase().slice(0, 16) })
                }
                placeholder="ATLAS"
                required
                pattern="[A-Za-z0-9-]{2,16}"
              />
            </Field>
            <Field label="Project name" htmlFor="project-name" required>
              <Input
                id="project-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Billing service migration"
                required
                minLength={2}
                maxLength={120}
              />
            </Field>
          </div>

          <Field label="Description" htmlFor="project-description">
            <Textarea
              id="project-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              rows={2}
              placeholder="What is this project responsible for?"
              maxLength={2000}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Started" htmlFor="project-start">
              <Input
                id="project-start"
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

          <div className="rounded-lg border border-line bg-slate-50/60 p-3.5">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
              Handover transition (optional)
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Outgoing person" htmlFor="outgoing-name">
                <Input
                  id="outgoing-name"
                  value={form.outgoingName}
                  onChange={(event) => setForm({ ...form, outgoingName: event.target.value })}
                  placeholder="Who is leaving the project?"
                  maxLength={120}
                />
              </Field>
              <Field label="Planned departure" htmlFor="outgoing-date">
                <Input
                  id="outgoing-date"
                  type="date"
                  value={form.plannedDepartureAt}
                  onChange={(event) => setForm({ ...form, plannedDepartureAt: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Transition context" htmlFor="outgoing-context" className="mt-3">
              <Textarea
                id="outgoing-context"
                value={form.context}
                onChange={(event) => setForm({ ...form, context: event.target.value })}
                rows={2}
                placeholder="Where are they going, who replaces them, what must not be lost?"
                maxLength={2000}
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[12px] font-semibold text-ink-soft">Invite members</p>
              <button
                type="button"
                onClick={() => setInvites([...invites, { email: '', role: 'contributor' }])}
                className="text-[11.5px] font-semibold text-brand-700 hover:text-brand-900"
              >
                + Add person
              </button>
            </div>
            {invites.length === 0 ? (
              <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-[11.5px] text-ink-muted">
                You can invite people now or add them later from People &amp; settings.
              </p>
            ) : (
              <div className="space-y-2">
                {invites.map((invite, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      type="email"
                      value={invite.email}
                      onChange={(event) => updateInvite(index, { email: event.target.value })}
                      placeholder="teammate@company.com"
                      aria-label={`Invite email ${index + 1}`}
                    />
                    <Select
                      value={invite.role}
                      onChange={(event) => updateInvite(index, { role: event.target.value })}
                      aria-label={`Invite role ${index + 1}`}
                      className="w-36"
                    >
                      <option value="contributor">Contributor</option>
                      <option value="observer">Observer</option>
                      <option value="lead">Project lead</option>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setInvites(invites.filter((_, position) => position !== index))}
                      aria-label="Remove invitation"
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">
              {error}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={demoOpen}
        onClose={() => {
          setDemoOpen(false);
          setError('');
        }}
        title="Load the Atlas demo workspace"
        description="This rebuilds the synthetic ATLAS project from scratch."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDemoOpen(false)}>
              Cancel
            </Button>
            <Button icon={RefreshCw} loading={seeding} onClick={resetDemo}>
              Rebuild demo
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[12.5px] leading-6 text-ink-soft">
          <p>
            Six synthetic source documents are ingested, parsed and turned into claims with verbatim
            evidence. Four demo accounts are created or refreshed:
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {DEMO_PERSONAS.map((persona) => (
              <div
                key={persona.email}
                className="flex items-center gap-2 rounded-lg border border-line bg-slate-50/60 px-2.5 py-2"
              >
                <Avatar name={persona.name} size="sm" />
                <div className="min-w-0">
                  <p className="text-[11.5px] font-semibold">{persona.name}</p>
                  <p className="text-[10px] text-ink-muted">{ROLE_LABELS[persona.role]}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-5 text-amber-900">
            Rebuilding deletes the existing ATLAS demo project and its handovers. Other projects are
            not touched.
          </p>
          {error && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
