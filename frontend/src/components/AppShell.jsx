import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight,
  CalendarClock,
  Check,
  ChevronsUpDown,
  Database,
  FileSignature,
  FolderKanban,
  Info,
  LayoutDashboard,
  ListChecks,
  Loader2,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useWorkspace } from '../context/WorkspaceContext.jsx';
import { api, errorMessage } from '../lib/api.js';
import { daysUntil } from '../lib/format.js';
import { DEMO_PASSWORD, DEMO_PERSONAS, ROLE_LABELS } from '../lib/constants.js';
import NotificationBell from './NotificationBell.jsx';
import { Avatar, Badge, Button, Modal } from './ui.jsx';

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
  { to: 'questions', label: 'Questions', icon: MessageSquareText },
  { to: 'handovers', label: 'Handovers', icon: FileSignature },
  { to: 'audit', label: 'Audit log', icon: ScrollText, leadOnly: true },
  { to: 'people', label: 'People', icon: Users },
];

const MOBILE_NAV = PROJECT_NAV.filter((item) =>
  ['', 'sources', 'claims', 'handovers'].includes(item.to),
);

function NavItem({ item, projectId, onNavigate, count = 0 }) {
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
          {count > 0 ? (
            <span
              className="rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-amber-800"
              aria-label={`${count} open questions for you`}
            >
              {count}
            </span>
          ) : (
            isActive && <span className="h-1.5 w-1.5 rounded-full bg-brand-600" aria-hidden="true" />
          )}
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
          <p className="text-[10.5px] text-ink-muted">
            {project.incoming ? 'Incoming recipient' : ROLE_LABELS[project.role] || 'Member'}
          </p>
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
  const [openQuestions, setOpenQuestions] = useState(0);

  useEffect(() => {
    let active = true;
    if (!project || !user?.id) {
      setOpenQuestions(0);
      return undefined;
    }
    api
      .get('/api/clarifications?status=open')
      .then((response) => {
        if (!active) return;
        const count = (response.clarifications || []).filter(
          (entry) =>
            String(entry.projectId) === String(project.id) &&
            String(entry.askedOf) === String(user.id),
        ).length;
        setOpenQuestions(count);
      })
      .catch(() => {
        if (active) setOpenQuestions(0);
      });
    return () => {
      active = false;
    };
  }, [project?.id, user?.id]);

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
                {PROJECT_NAV.filter(
                  (item) =>
                    (!item.leadOnly || isLead) &&
                    (!project.incoming || ['sources', 'handovers'].includes(item.to)),
                ).map((item) => (
                  <NavItem
                    key={item.label}
                    item={item}
                    projectId={project.id}
                    onNavigate={onNavigate}
                    count={item.to === 'questions' ? openQuestions : 0}
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
              onClick={() => go(`/projects/${project.id}/questions`)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-ink-soft hover:bg-slate-50"
            >
              <MessageSquareText className="h-4 w-4 text-ink-muted" /> Questions
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

function PersonaMenu({ open, onClose, user, switching, onSwitch, onReset, onLogout, canReset }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event) => {
      if (event.target.closest?.('[data-persona-toggle]')) return;
      // Both the mobile and desktop headers keep a menu mounted. Without this
      // guard the hidden menu's outside-click handler unmounts the open one
      // before a menu item can receive its click.
      if (event.target.closest?.('[data-persona-menu]')) return;
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Switch demo profile"
      data-persona-menu
      className="absolute right-0 top-[calc(100%+10px)] z-[70] w-[320px] rounded-xl border border-line bg-white p-2 shadow-lift"
    >
      <div className="flex items-baseline justify-between px-2 pb-1.5 pt-1">
        <p className="eyebrow">Viewing as</p>
        <p className="font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">Demo profiles</p>
      </div>
      <div className="space-y-0.5">
        {DEMO_PERSONAS.map((persona) => {
          const active = persona.email === user?.email;
          const loading = switching === persona.email;
          return (
            <button
              key={persona.email}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              disabled={Boolean(switching)}
              onClick={() => onSwitch(persona)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition ${
                active ? 'bg-brand-50 ring-1 ring-inset ring-brand-100' : 'hover:bg-slate-50'
              } disabled:cursor-wait disabled:opacity-60`}
            >
              <Avatar name={persona.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold text-ink">
                  {persona.name}
                </span>
                <span className="block truncate text-[10.5px] text-ink-muted">
                  {persona.tag} · {persona.abilities[0]}
                </span>
              </span>
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand-700" aria-hidden="true" />
              ) : (
                active && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-1 space-y-0.5 border-t border-line pt-1">
        {canReset && (
          <button
            type="button"
            role="menuitem"
            onClick={onReset}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12px] font-medium text-ink-soft transition hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
            Reset demo data
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={onLogout}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12px] font-medium text-red-600 transition hover:bg-red-50"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          Sign out
        </button>
      </div>
      <p className="px-2 pb-1 pt-1.5 text-[10px] leading-4 text-ink-faint">
        Switching re-checks every view live against the selected profile’s permissions.
      </p>
    </div>
  );
}

export default function AppShell() {
  const { user, logout, login } = useAuth();
  const { projects, currentProject, reloadProjects } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [switching, setSwitching] = useState(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [demoMode, setDemoMode] = useState(null);
  const location = useLocation();
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
  const routeProject = projectMatch
    ? projects.find((entry) => entry.id === projectMatch[1]) || currentProject
    : null;
  const project = routeProject;
  const isLead = project?.role === 'lead';
  const routeProjectId = project?.id || projectMatch?.[1] || null;
  const inProject = Boolean(routeProjectId);

  // Demo tools must never appear on a real deployment. The API decides whether
  // seeding is enabled; the project flag decides whether this workspace is the
  // synthetic one. Both must agree, so a real lead sees no demo controls.
  useEffect(() => {
    let active = true;
    api
      .get('/api/health')
      .then((data) => {
        if (active) setDemoMode(data?.demoSeedEnabled === true);
      })
      .catch(() => {
        if (active) setDemoMode(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const showDemoControls = demoMode === true && (project ? project.isDemo === true : true);
  const canResetDemo = showDemoControls && isLead && project?.isDemo === true;

  const switchTo = async (persona) => {
    if (switching) return;
    if (persona.email === user?.email) {
      setPersonaOpen(false);
      return;
    }
    setSwitching(persona.email);
    try {
      const next = await login(persona.email, DEMO_PASSWORD);
      toast.success(`Now viewing as ${next.name} · ${persona.tag.toLowerCase()}`);
      setPersonaOpen(false);
      navigate(inProject ? `/projects/${routeProjectId}` : '/');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSwitching(null);
    }
  };

  const openResetConfirm = () => {
    setPersonaOpen(false);
    setResetOpen(true);
  };

  const resetDemo = async () => {
    setResetting(true);
    try {
      await api.post('/api/demo/seed?reset=true');
      toast.success('Atlas demo sources rebuilt.');
      await reloadProjects();
      window.location.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setResetting(false);
      setResetOpen(false);
    }
  };

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
          {!project?.incoming && departure !== null && departure >= 0 && (
            <Badge tone="amber" title="Days until the planned departure">
              T-{departure}d
            </Badge>
          )}
          <NotificationBell />
          {showDemoControls ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setPersonaOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={personaOpen}
                aria-label={`${user?.name}. Switch demo profile`}
                data-persona-toggle
                className="flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-1 transition hover:bg-slate-100"
              >
                <Avatar name={user?.name} size="sm" />
                <ChevronsUpDown className="h-3 w-3 text-ink-faint" aria-hidden="true" />
              </button>
              <PersonaMenu
                open={personaOpen}
                onClose={() => setPersonaOpen(false)}
                user={user}
                switching={switching}
                onSwitch={switchTo}
                onReset={openResetConfirm}
                onLogout={logout}
                canReset={canResetDemo}
              />
            </div>
          ) : (
            <Avatar name={user?.name} size="sm" />
          )}
        </div>
      </header>

      <div
        role="region"
        aria-label="Project context"
        className="hidden h-14 items-center justify-between border-b border-line bg-canvas/80 px-8 backdrop-blur lg:sticky lg:top-0 lg:z-30 lg:flex lg:pl-72"
      >
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <Link to="/" className="font-medium text-ink-muted transition hover:text-ink">
            Projects
          </Link>
          {project && (
            <>
              <span className="text-line-strong">/</span>
              <Link
                to={project.incoming ? `/projects/${project.id}/handovers` : `/projects/${project.id}`}
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
        <div className="flex shrink-0 items-center gap-3">
          <NotificationBell />
          {!project?.incoming && departure !== null && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-mono text-[10.5px] font-medium text-amber-800">
              <CalendarClock className="h-3 w-3 shrink-0" aria-hidden="true" />
              {departure >= 0 ? `Handover due in ${departure}d` : `Handover ${Math.abs(departure)}d overdue`}
            </span>
          )}
          <span className="hidden items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[10.5px] text-ink-muted xl:inline-flex">
            <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden="true" />
            Permission-aware
          </span>
          <div className="relative flex shrink-0 items-center gap-2 border-l border-line pl-3">
            {showDemoControls ? (
              <>
                <button
                  type="button"
                  onClick={() => setPersonaOpen((value) => !value)}
                  aria-haspopup="menu"
                  aria-expanded={personaOpen}
                  title="Switch demo profile"
                  data-persona-toggle
                  className="flex items-center gap-2 whitespace-nowrap rounded-lg px-1.5 py-1 text-left transition hover:bg-slate-100"
                >
                  <Avatar name={user?.name} size="sm" />
                  <span className="leading-tight">
                    <span className="block text-[11.5px] font-semibold">{user?.name}</span>
                    <span className="block text-[10px] text-ink-muted">
                      {project
                        ? project.incoming
                          ? 'Incoming recipient'
                          : ROLE_LABELS[project.role]
                        : 'Workspace member'}
                    </span>
                  </span>
                  <ChevronsUpDown className="h-3.5 w-3.5 text-ink-faint" aria-hidden="true" />
                </button>
                <PersonaMenu
                  open={personaOpen}
                  onClose={() => setPersonaOpen(false)}
                  user={user}
                  switching={switching}
                  onSwitch={switchTo}
                  onReset={openResetConfirm}
                  onLogout={logout}
                  canReset={canResetDemo}
                />
              </>
            ) : (
              <span className="flex items-center gap-2 whitespace-nowrap px-1.5 py-1">
                <Avatar name={user?.name} size="sm" />
                <span className="leading-tight">
                  <span className="block text-[11.5px] font-semibold">{user?.name}</span>
                  <span className="block text-[10px] text-ink-muted">
                    {project
                      ? project.incoming
                        ? 'Incoming recipient'
                        : ROLE_LABELS[project.role]
                      : 'Workspace member'}
                  </span>
                </span>
              </span>
            )}
          </div>
        </div>
      </div>

      <main id="main" className="lg:pl-64">
        <div
          className={`mx-auto w-full max-w-[1440px] px-4 pt-5 sm:px-6 lg:px-8 lg:pt-7 ${
            inProject ? 'pb-28 lg:pb-14' : 'pb-12'
          }`}
        >
          {demoMode !== null && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50/80 px-3.5 py-2 text-[11px] leading-4 text-blue-900">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600" aria-hidden="true" />
              <div>
                {showDemoControls ? (
                  <p>
                    <span className="font-semibold">Shared demo workspace:</span> other evaluators
                    can see and change what you upload. Reset restores only the seeded sources;
                    nothing another visitor uploaded is erased.
                  </p>
                ) : (
                  <p>
                    <span className="font-semibold">Permission-aware workspace:</span> every item you
                    see is filtered live against the sources you may read.
                  </p>
                )}
              </div>
            </div>
          )}
          <Outlet />
        </div>
      </main>

      {inProject && (
        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
          aria-label="Project sections"
        >
          <div
            className={`mx-auto grid max-w-lg ${project?.incoming ? 'grid-cols-3' : 'grid-cols-5'}`}
          >
            {(project?.incoming
              ? MOBILE_NAV.filter((item) => ['sources', 'handovers'].includes(item.to))
              : MOBILE_NAV
            ).map((item) => {
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

      <Modal
        open={resetOpen}
        onClose={() => {
          if (!resetting) setResetOpen(false);
        }}
        title="Rebuild the seeded demo data?"
        description="This re-creates the seeded Atlas sources and their derived findings. It does not touch anything another visitor uploaded."
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)} disabled={resetting}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" icon={RefreshCw} loading={resetting} onClick={resetDemo}>
              Rebuild seeded data
            </Button>
          </>
        }
      >
        <ul className="space-y-2 text-[12px] leading-5 text-ink-soft">
          <li>· The six seeded sources are re-created and re-ingested, so their claims, evidence, and questions return to the seeded state.</li>
          <li>· Sources you or another evaluator uploaded, plus every handover, stay exactly as they are.</li>
          <li>· You stay signed in; the page reloads once the sources are queued.</li>
        </ul>
      </Modal>
    </div>
  );
}
