import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight,
  CalendarClock,
  Database,
  FileSignature,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MoreHorizontal,
  ScrollText,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useWorkspace } from '../context/WorkspaceContext.jsx';
import { daysUntil } from '../lib/format.js';
import { ROLE_LABELS } from '../lib/constants.js';
import { Avatar, Badge } from './ui.jsx';

export function BrandMark({ className = 'h-9 w-9' }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl bg-brand-900 text-white shadow-sm ${className}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
        <path
          d="M5.5 5.5h6.2a4.1 4.1 0 1 1 0 8.2H8.7a4.1 4.1 0 1 0 0 8.2h9.8"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <circle cx="5.5" cy="5.5" r="1.7" fill="currentColor" />
        <circle cx="18.5" cy="21.9" r="1.4" fill="currentColor" opacity="0.6" />
      </svg>
    </span>
  );
}

const PROJECT_NAV = [
  { to: '', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: 'sources', label: 'Sources', icon: Database },
  { to: 'claims', label: 'Claims', icon: ListChecks },
  { to: 'handovers', label: 'Handovers', icon: FileSignature },
  { to: 'audit', label: 'Audit log', icon: ScrollText, leadOnly: true },
  { to: 'people', label: 'People', icon: Users },
];

const MOBILE_NAV = PROJECT_NAV.filter((item) =>
  ['', 'sources', 'claims', 'handovers'].includes(item.to),
);

function NavItem({ item, projectId, onNavigate }) {
  const target = item.to ? `/projects/${projectId}/${item.to}` : `/projects/${projectId}`;
  return (
    <NavLink
      to={target}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `group flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition ${
          isActive
            ? 'bg-brand-50 text-brand-900 ring-1 ring-inset ring-brand-100'
            : 'text-ink-muted hover:bg-slate-50 hover:text-ink'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <item.icon
            className={`h-4 w-4 ${isActive ? 'text-brand-700' : 'text-ink-faint group-hover:text-ink-muted'}`}
            aria-hidden="true"
          />
          <span className="flex-1">{item.label}</span>
          {isActive && <span className="h-1.5 w-1.5 rounded-full bg-brand-600" aria-hidden="true" />}
        </>
      )}
    </NavLink>
  );
}

function ProjectSwitcher({ project, projects, onChange }) {
  return (
    <div className="rounded-card border border-line bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-900 font-mono text-[10px] font-semibold text-white">
          {project.key?.slice(0, 4)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold leading-4">{project.name}</p>
          <p className="text-[10.5px] text-ink-muted">{ROLE_LABELS[project.role] || 'Member'}</p>
        </div>
      </div>
      {projects.length > 1 && (
        <label className="mt-2.5 block">
          <span className="sr-only">Switch project</span>
          <select
            value={project.id}
            onChange={(event) => onChange(event.target.value)}
            className="h-8 w-full cursor-pointer rounded-md border border-line bg-slate-50 px-2 text-[11.5px] font-medium text-ink-soft focus:border-brand-500 focus:outline-none"
          >
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.key} · {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function Sidebar({ project, projects, user, logout, onNavigate }) {
  const navigate = useNavigate();
  const isLead = project?.role === 'lead';

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line bg-white/95 backdrop-blur lg:flex">
      <div className="flex h-16 items-center gap-3 px-5">
        <Link to="/" className="flex items-center gap-3" aria-label="Threadline home">
          <BrandMark />
          <span>
            <span className="block font-display text-[16px] font-semibold leading-5 tracking-tight">
              Threadline
            </span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-ink-muted">
              Knowledge handover
            </span>
          </span>
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <Link
          to="/"
          onClick={onNavigate}
          className="mb-3 flex h-8 items-center gap-2 rounded-lg px-3 text-[12.5px] font-medium text-ink-muted transition hover:bg-slate-50 hover:text-ink"
        >
          <FolderKanban className="h-3.5 w-3.5" aria-hidden="true" />
          All projects
          <span className="ml-auto font-mono text-[10px] text-ink-faint">{projects.length}</span>
        </Link>

        {project ? (
          <>
            <ProjectSwitcher
              project={project}
              projects={projects}
              onChange={(id) => {
                navigate(`/projects/${id}`);
                onNavigate?.();
              }}
            />
            <nav className="mt-4" aria-label="Project sections">
              <p className="eyebrow px-3 pb-1.5">{project.key} workspace</p>
              <div className="space-y-0.5">
                {PROJECT_NAV.filter((item) => !item.leadOnly || isLead).map((item) => (
                  <NavItem
                    key={item.label}
                    item={item}
                    projectId={project.id}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            </nav>

            <div className="mt-5 rounded-lg border border-line bg-slate-50/70 p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-soft">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                Fail-closed access
              </p>
              <p className="mt-1 text-[10.5px] leading-4 text-ink-muted">
                Evidence and handover items are filtered per person at read time.
              </p>
            </div>
          </>
        ) : (
          <nav aria-label="Workspace">
            <p className="eyebrow px-3 pb-1.5">Your workspace</p>
            <NavLink
              to="/"
              end
              onClick={onNavigate}
              className={({ isActive }) =>
                `flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium ${
                  isActive ? 'bg-brand-50 text-brand-900' : 'text-ink-muted hover:bg-slate-50'
                }`
              }
            >
              <FolderKanban className="h-4 w-4" aria-hidden="true" />
              Projects
            </NavLink>
            {projects.length > 0 && (
              <div className="mt-4">
                <p className="eyebrow px-3 pb-1.5">Recent</p>
                <div className="space-y-0.5">
                  {projects.slice(0, 5).map((entry) => (
                    <Link
                      key={entry.id}
                      to={`/projects/${entry.id}`}
                      onClick={onNavigate}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-ink-muted transition hover:bg-slate-50 hover:text-ink"
                    >
                      <span className="font-mono text-[9.5px] font-semibold text-brand-700">
                        {entry.key}
                      </span>
                      <span className="truncate">{entry.name}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </nav>
        )}
      </div>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-1 py-1">
          <Avatar name={user?.name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold leading-4">{user?.name}</p>
            <p className="truncate text-[10.5px] text-ink-muted">{user?.email}</p>
          </div>
          <button
            type="button"
            onClick={logout}
            className="rounded-md p-1.5 text-ink-faint transition hover:bg-slate-100 hover:text-ink"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function MobileMoreSheet({ open, onClose, project, logout, isLead }) {
  const navigate = useNavigate();
  if (!open) return null;
  const go = (path) => {
    onClose();
    navigate(path);
  };
  return (
    <div className="fixed inset-0 z-[65] lg:hidden">
      <div className="absolute inset-0 bg-[#081422]/50" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-x-0 bottom-0 animate-fade-up rounded-t-2xl border-t border-line bg-white p-4 pb-8 shadow-lift">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="font-display text-[15px] font-semibold">{project ? project.key : 'Threadline'}</p>
            <p className="text-[11.5px] text-ink-muted">{project ? project.name : 'Workspace menu'}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-ink-muted hover:bg-slate-100"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-1">
          {project && isLead && (
            <button
              type="button"
              onClick={() => go(`/projects/${project.id}/audit`)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-ink-soft hover:bg-slate-50"
            >
              <ScrollText className="h-4 w-4 text-ink-muted" /> Audit log
            </button>
          )}
          {project && (
            <button
              type="button"
              onClick={() => go(`/projects/${project.id}/people`)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-ink-soft hover:bg-slate-50"
            >
              <Users className="h-4 w-4 text-ink-muted" /> People & settings
            </button>
          )}
          <button
            type="button"
            onClick={() => go('/')}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-ink-soft hover:bg-slate-50"
          >
            <ArrowLeftRight className="h-4 w-4 text-ink-muted" /> Switch project
          </button>
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-red-600 hover:bg-red-50"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const { projects, currentProject } = useWorkspace();
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
  const routeProject = projectMatch
    ? projects.find((entry) => entry.id === projectMatch[1]) || currentProject
    : null;
  const project = routeProject;
  const isLead = project?.role === 'lead';
  const routeProjectId = project?.id || projectMatch?.[1] || null;
  const inProject = Boolean(routeProjectId);

  const departure = project?.transition?.plannedDepartureAt
    ? daysUntil(project.transition.plannedDepartureAt)
    : null;

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:shadow-lift"
      >
        Skip to content
      </a>

      <Sidebar
        project={project}
        projects={projects}
        user={user}
        logout={logout}
        onNavigate={() => setMoreOpen(false)}
      />

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-canvas/90 px-4 backdrop-blur lg:hidden">
        <Link to="/" className="flex min-w-0 items-center gap-2.5">
          <BrandMark className="h-8 w-8 rounded-lg" />
          <span className="font-display text-[15px] font-semibold leading-4">Threadline</span>
          {project && <Badge tone="navy">{project.key}</Badge>}
        </Link>
        <div className="flex items-center gap-1.5">
          {departure !== null && departure >= 0 && (
            <Badge tone="amber" title="Days until the planned departure">
              T-{departure}d
            </Badge>
          )}
          <Avatar name={user?.name} size="sm" title={user?.name} />
        </div>
      </header>

      <div className="hidden h-14 items-center justify-between border-b border-line bg-canvas/80 px-8 backdrop-blur lg:sticky lg:top-0 lg:z-30 lg:flex lg:pl-72">
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <Link to="/" className="font-medium text-ink-muted transition hover:text-ink">
            Projects
          </Link>
          {project && (
            <>
              <span className="text-line-strong">/</span>
              <Link
                to={`/projects/${project.id}`}
                className="max-w-[320px] truncate font-medium text-ink-muted transition hover:text-ink"
              >
                {project.name}
              </Link>
              <span className="text-line-strong">/</span>
              <span className="font-medium text-ink">
                {PROJECT_NAV.find((item) =>
                  item.to
                    ? location.pathname.includes(`/${item.to}`)
                    : location.pathname === `/projects/${project.id}`,
                )?.label || 'Handover'}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {departure !== null && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-mono text-[10.5px] font-medium text-amber-800">
              <CalendarClock className="h-3 w-3" aria-hidden="true" />
              {departure >= 0 ? `Handover due in ${departure}d` : `Handover ${Math.abs(departure)}d overdue`}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[10.5px] text-ink-muted">
            <ShieldCheck className="h-3 w-3 text-emerald-600" aria-hidden="true" />
            Permission-aware
          </span>
          <div className="flex items-center gap-2 border-l border-line pl-3">
            <Avatar name={user?.name} size="sm" />
            <div className="leading-tight">
              <p className="text-[11.5px] font-semibold">{user?.name}</p>
              <p className="text-[10px] text-ink-muted">
                {project ? ROLE_LABELS[project.role] : 'Workspace member'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <main id="main" className="lg:pl-64">
        <div
          className={`mx-auto w-full max-w-[1440px] px-4 pt-5 sm:px-6 lg:px-8 lg:pt-7 ${
            inProject ? 'pb-28 lg:pb-14' : 'pb-12'
          }`}
        >
          <Outlet />
        </div>
      </main>

      {inProject && (
        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
          aria-label="Project sections"
        >
          <div className="mx-auto grid max-w-lg grid-cols-5">
            {MOBILE_NAV.map((item) => {
              const target = item.to
                ? `/projects/${routeProjectId}/${item.to}`
                : `/projects/${routeProjectId}`;
              return (
                <NavLink
                  key={item.label}
                  to={target}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex flex-col items-center gap-1 py-2 text-[9.5px] font-semibold ${
                      isActive ? 'text-brand-800' : 'text-ink-muted'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={`flex h-7 w-9 items-center justify-center rounded-lg ${
                          isActive ? 'bg-brand-50' : ''
                        }`}
                      >
                        <item.icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      {item.label === 'Handovers' ? 'Handover' : item.label}
                    </>
                  )}
                </NavLink>
              );
            })}
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className="flex flex-col items-center gap-1 py-2 text-[9.5px] font-semibold text-ink-muted"
            >
              <span className="flex h-7 w-9 items-center justify-center rounded-lg">
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </span>
              More
            </button>
          </div>
        </nav>
      )}

      <MobileMoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        project={project}
        logout={logout}
        isLead={isLead}
      />
    </div>
  );
}
