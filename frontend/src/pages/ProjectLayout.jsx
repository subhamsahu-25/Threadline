import { useEffect } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { ArrowUpRight, CalendarClock, FileSignature, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAsync } from '../hooks/useAsync.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useWorkspace } from '../context/WorkspaceContext.jsx';
import { daysUntil, formatDate } from '../lib/format.js';
import { RoleBadge } from '../components/badges.jsx';
import {
  Avatar,
  Badge,
  Button,
  ErrorState,
  LoadingBlock,
} from '../components/ui.jsx';

export function useProject() {
  return useOutletContext();
}

export default function ProjectLayout() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { setCurrentProject, upsertProject } = useWorkspace();
  const { data, error, loading, reload } = useAsync(
    () => api.get(`/api/projects/${projectId}`),
    // Refetch when the signed-in identity changes: the project payload carries
    // the caller's role, so a persona switch must not reuse the old one.
    [projectId, user?.id],
  );

  const project = data?.project;

  useEffect(() => {
    if (!project) return;
    setCurrentProject(project);
    upsertProject(project);
  }, [project, setCurrentProject, upsertProject]);

  useEffect(
    () => () => {
      setCurrentProject(null);
    },
    [setCurrentProject],
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-[68px] rounded-card" />
        <LoadingBlock rows={3} />
      </div>
    );
  }

  if (error) {
    const denied = error.status === 403;
    return (
      <div className="mx-auto max-w-xl py-12">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-white text-amber-600 shadow-sm">
          <ShieldAlert className="h-5 w-5" aria-hidden="true" />
        </div>
        <h1 className="text-[24px] font-semibold">
          {denied ? 'You do not have access to this project' : 'Project not available'}
        </h1>
        <p className="mt-2 text-[13px] leading-6 text-ink-muted">
          {denied
            ? 'Membership is enforced on the server. Ask a project lead to add you, then reload.'
            : error.message}
        </p>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/')}>
            Back to projects
          </Button>
          <Button onClick={() => reload().catch(() => {})}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!project) return <ErrorState title="Project not found" error="The project could not be loaded." />;

  const incoming = Boolean(project.incoming);
  const section = location.pathname
    .slice(`/projects/${project.id}`.length)
    .replace(/^\/+/, '');
  const sectionAllowed =
    section === 'sources' ||
    section.startsWith('sources/') ||
    section === 'handovers' ||
    section.startsWith('handovers/');
  if (incoming && !sectionAllowed) {
    return <Navigate to={`/projects/${project.id}/handovers`} replace />;
  }

  const departure = daysUntil(project.transition?.plannedDepartureAt);
  const canPrepare = project.canContribute;
  const projectHome = incoming ? `/projects/${project.id}/handovers` : `/projects/${project.id}`;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <Link
            to={projectHome}
            className="inline-flex h-7 items-center rounded-md bg-brand-900 px-2 font-mono text-[10.5px] font-semibold tracking-wide text-white"
          >
            {project.key}
          </Link>
          <Link
            to={projectHome}
            className="max-w-[340px] truncate text-[13px] font-semibold text-ink transition hover:text-brand-800"
          >
            {project.name}
          </Link>
          {incoming ? (
            <Badge tone="green">Incoming recipient</Badge>
          ) : (
            <RoleBadge role={project.role} />
          )}
          <Badge tone={project.status === 'active' ? 'green' : 'slate'} dot>
            {project.status}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!incoming && project.transition?.plannedDepartureAt && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-[10.5px] font-medium text-ink-muted"
              title={`${project.transition.outgoingName || 'Outgoing owner'} departs ${formatDate(project.transition.plannedDepartureAt)}`}
            >
              <CalendarClock className="h-3 w-3 text-amber-600" aria-hidden="true" />
              <span className="hidden sm:inline">{project.transition.outgoingName} · </span>
              {departure >= 0 ? `T-${departure}d` : `${Math.abs(departure)}d overdue`}
            </span>
          )}
          {!incoming && (
            <Link
              to={`/projects/${project.id}/people`}
              className="flex -space-x-1.5 rounded-full outline-offset-2"
              aria-label={`${project.members.length} project members — open People`}
              title="Project members"
            >
              {project.members.slice(0, 4).map((member) => (
                <Avatar
                  key={member.userId}
                  name={member.name || member.email}
                  size="xs"
                  className="ring-2 ring-white"
                />
              ))}
              {project.members.length > 4 && (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 font-mono text-[9px] font-semibold text-ink-soft ring-2 ring-white">
                  +{project.members.length - 4}
                </span>
              )}
            </Link>
          )}
          {canPrepare && (
            <Button
              size="sm"
              icon={FileSignature}
              onClick={() => navigate(`/projects/${project.id}/handovers`, { state: { create: true } })}
            >
              <span className="hidden sm:inline">New handover</span>
              <span className="sm:hidden">Handover</span>
            </Button>
          )}
          {project.role === 'lead' && (
            <Link
              to={`/projects/${project.id}/people`}
              className="hidden items-center gap-1 text-[11.5px] font-semibold text-brand-700 hover:text-brand-900 sm:inline-flex"
            >
              Settings
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>

      <Outlet context={{ project, stats: data.stats, reloadProject: reload }} />
    </div>
  );
}
