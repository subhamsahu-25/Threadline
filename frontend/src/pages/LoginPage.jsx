import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Database,
  FileCheck2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import { BrandMark } from '../components/AppShell.jsx';
import { Avatar, Badge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api, errorMessage } from '../lib/api.js';
import { DEMO_PASSWORD, DEMO_PERSONAS } from '../lib/constants.js';

const PERSONA_RING = {
  navy: 'border-brand-200 bg-brand-50/60',
  amber: 'border-amber-200 bg-amber-50/60',
  green: 'border-emerald-200 bg-emerald-50/60',
  slate: 'border-slate-200 bg-slate-50/60',
};

const PERSONA_TONE = {
  navy: 'navy',
  amber: 'amber',
  green: 'green',
  slate: 'slate',
};

const COLD_START_KEY = 'threadline.cold-start-notice';

function shouldShowColdStart() {
  try {
    if (sessionStorage.getItem(COLD_START_KEY) === 'dismissed') return false;
  } catch {
    /* storage can be unavailable in private mode */
  }
  const host = window.location.hostname;
  return !(
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

function ColdStartNotice({ health, onDismiss }) {
  const titleId = useId();
  const descriptionId = useId();
  const dismissRef = useRef(null);

  useEffect(() => {
    dismissRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onDismiss]);

  const ready = health?.status === 'ok';
  const offline = health?.status === 'offline';

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#081422]/70 backdrop-blur-[3px]" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-10 w-full max-w-[440px] animate-fade-up overflow-hidden rounded-2xl border border-white/10 bg-brand-950 shadow-[0_30px_90px_-20px_rgba(2,12,27,0.95)]"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.09]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,.2) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.2) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
            maskImage: 'radial-gradient(ellipse at 20% 0%, black, transparent 70%)',
          }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -left-12 -top-16 h-44 w-44 rounded-full bg-amber-400/10 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative p-6">
          <div className="flex items-start justify-between gap-4">
            <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-400/15 ring-1 ring-amber-300/30">
              <Server className="h-5 w-5 text-amber-300" aria-hidden="true" />
              <span className="absolute -right-1 -top-1 flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-70" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-400" />
              </span>
            </span>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss wake-up notice"
              className="rounded-lg p-1.5 text-brand-200/60 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <p className="mt-5 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-amber-300">
            Before you sign in
          </p>
          <h2
            id={titleId}
            className="mt-1.5 font-display text-[24px] font-semibold leading-[1.2] tracking-[-0.02em] text-white"
          >
            The demo backend is waking up.
          </h2>
          <p id={descriptionId} className="mt-2.5 text-[13px] leading-6 text-brand-100/75">
            Threadline&apos;s API runs on Render&apos;s free tier. After a quiet spell the instance
            sleeps, so the first request can take{' '}
            <span className="font-semibold text-white">30–60 seconds</span> to load and connect.
            Profiles sign in normally once it does.
          </p>

          <div className="mt-5 flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2.5 text-[12px]">
            {ready ? (
              <>
                <Check className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                <span className="text-emerald-200">API connected — you&apos;re ready to enter.</span>
              </>
            ) : (
              <>
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-300" aria-hidden="true" />
                <span className="text-brand-100/85">
                  {offline
                    ? 'Still starting up — give it a few more seconds.'
                    : 'Contacting the API…'}
                </span>
              </>
            )}
          </div>

          <button
            ref={dismissRef}
            type="button"
            onClick={onDismiss}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-brand-950 transition hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
          >
            {ready ? 'Continue' : "Got it — I'll wait"}
          </button>
          <p className="mt-3 text-center text-[10px] text-brand-200/45">
            This notice appears once per browser session.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function BrandPanel() {
  return (
    <div className="relative hidden overflow-hidden bg-brand-950 lg:flex lg:w-[54%] lg:flex-col lg:justify-between lg:p-12">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.14]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.16) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.16) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse at 30% 20%, black, transparent 75%)',
        }}
        aria-hidden="true"
      />
      <svg
        viewBox="0 0 600 600"
        className="pointer-events-none absolute -right-32 top-1/4 h-[520px] w-[520px] text-brand-400/20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M80 320C180 120 340 120 420 240s120 260 20 300"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <path
          d="M40 380C180 220 300 240 380 300s130 180 140 240"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="4 8"
        />
        <circle cx="80" cy="320" r="5" fill="currentColor" />
        <circle cx="420" cy="240" r="5" fill="currentColor" />
        <circle cx="380" cy="300" r="4" fill="currentColor" />
      </svg>

      <div className="relative">
        <div className="flex items-center gap-3 text-white">
          <BrandMark className="h-10 w-10 bg-white/10 ring-1 ring-white/20" />
          <div>
            <p className="font-display text-[18px] font-semibold leading-5">Threadline</p>
            <p className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-brand-200">
              Institutional knowledge handover
            </p>
          </div>
        </div>

        <h1 className="mt-16 max-w-xl font-display text-[40px] font-semibold leading-[1.14] tracking-[-0.025em] text-white">
          Knowledge that outlives the handover.
        </h1>
        <p className="mt-4 max-w-lg text-[14.5px] leading-7 text-brand-100/80">
          Threadline turns scattered project activity into a permission-aware, evidence-linked
          handover. Every decision, risk and open question stays attached to the source it came
          from.
        </p>

        <ul className="mt-9 space-y-4">
          {[
            {
              icon: FileCheck2,
              title: 'Traceable to the exact quote',
              body: 'Each extracted item links to a verbatim passage, its document and its source.',
            },
            {
              icon: LockKeyhole,
              title: 'Permissions hold at read time',
              body: 'A claim appears only when every citation resolves to a source the reader may access.',
            },
            {
              icon: ShieldCheck,
              title: 'A human signs the handover',
              body: 'Reviewers accept, edit or reject items before a lead approves and shares anything.',
            },
          ].map((item) => (
            <li key={item.title} className="flex gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-brand-100 ring-1 ring-white/10">
                <item.icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-[13px] font-semibold text-white">{item.title}</p>
                <p className="mt-0.5 max-w-md text-[12px] leading-5 text-brand-100/65">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative mt-10 text-[10.5px] text-brand-200/45">
        Demo workspace uses synthetic data only. No enterprise systems are connected.
      </p>
    </div>
  );
}

export default function LoginPage() {
  const { user, login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [coldStartOpen, setColdStartOpen] = useState(shouldShowColdStart);

  const dismissColdStart = useCallback(() => {
    setColdStartOpen(false);
    try {
      sessionStorage.setItem(COLD_START_KEY, 'dismissed');
    } catch {
      /* storage can be unavailable in private mode */
    }
  }, []);

  const destination = location.state?.from && location.state.from !== '/login' ? location.state.from : '/';

  useEffect(() => {
    let active = true;
    let timer;
    const check = async () => {
      try {
        const data = await api.get('/api/health');
        if (!active) return;
        setHealth(data);
        if (data.status !== 'ok') timer = setTimeout(check, 5000);
      } catch {
        if (!active) return;
        setHealth({ status: 'offline' });
        timer = setTimeout(check, 5000);
      }
    };
    check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  if (user) return <Navigate to={destination} replace />;

  const enterAs = async (persona) => {
    if (pending) return;
    setPending(persona.email);
    setError('');
    try {
      let signedIn;
      try {
        signedIn = await login(persona.email, DEMO_PASSWORD);
      } catch (err) {
        if (err?.status !== 401) throw err;
        // Seed only an empty workspace. A 401 must never wipe existing data.
        await api.post('/api/demo/seed');
        signedIn = await login(persona.email, DEMO_PASSWORD);
        toast.success('Atlas demo workspace created — six synthetic sources ingested.');
      }
      toast.success(`Signed in as ${signedIn.name}`);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  const prepareDemo = async () => {
    if (resetting) return;
    setResetting(true);
    setError('');
    try {
      const result = await api.post('/api/demo/seed');
      toast.success(
        result?.alreadySeeded
          ? 'Atlas demo workspace is already in place.'
          : 'Atlas demo workspace created — six synthetic sources ingested.',
      );
      setHealth((current) => ({ ...(current || {}), demoSeedEnabled: true, demoProjectReady: true }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  const busy = Boolean(pending) || resetting;

  return (
    <div className="flex min-h-screen bg-canvas">
      <BrandPanel />

      <div className="flex min-h-screen w-full flex-col lg:w-[46%]">
        <div className="flex items-center justify-between border-b border-line bg-brand-950 px-5 py-4 text-white lg:hidden">
          <div className="flex items-center gap-2.5">
            <BrandMark className="h-8 w-8 bg-white/10 ring-1 ring-white/15" />
            <div>
              <p className="font-display text-[15px] font-semibold leading-4">Threadline</p>
              <p className="text-[9px] uppercase tracking-[0.16em] text-brand-200">
                Knowledge handover
              </p>
            </div>
          </div>
          <Badge tone="green" dot className="border-white/20 bg-white/10 text-emerald-200">
            Synthetic demo
          </Badge>
        </div>

        <div className="flex flex-1 items-start justify-center px-4 py-8 sm:px-8 lg:items-center lg:py-10">
          <div className="w-full max-w-[520px]">
            <div className="mb-5">
              <p className="eyebrow mb-1.5">Hackathon demo</p>
              <h2 className="text-[27px] font-semibold leading-tight tracking-[-0.02em]">
                Choose a profile to enter
              </h2>
              <p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
                Four seeded profiles share one Atlas workspace. One click signs you in — the same
                project looks different depending on who is reading it.
              </p>
            </div>

            <section aria-labelledby="personas-heading">
              <div className="mb-2 flex items-center justify-between">
                <h3 id="personas-heading" className="eyebrow">
                  Demo profiles
                </h3>
                {health?.demoProjectReady === false && (
                  <button
                    type="button"
                    onClick={prepareDemo}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand-700 transition hover:text-brand-900 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${resetting ? 'animate-spin' : ''}`} aria-hidden="true" />
                    {resetting ? 'Preparing Atlas…' : 'Create demo workspace'}
                  </button>
                )}
              </div>

              <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-900">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
                <p>
                  <span className="font-semibold">Demo mode.</span> Synthetic data only. All four
                  profiles share one seeded workspace; rebuilding it requires the lead profile.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {DEMO_PERSONAS.map((persona) => {
                  const loading = pending === persona.email;
                  return (
                    <button
                      key={persona.email}
                      type="button"
                      onClick={() => enterAs(persona)}
                      disabled={busy}
                      aria-label={`Enter the Atlas workspace as ${persona.name}, ${persona.tag.toLowerCase()}`}
                      className={`group flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition ${PERSONA_RING[persona.accent]} hover:border-brand-300 hover:bg-white hover:shadow-card disabled:cursor-wait disabled:opacity-60`}
                    >
                      <span className="flex w-full items-center gap-2.5">
                        <Avatar name={persona.name} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-ink">
                            {persona.name}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-ink-muted">
                            {persona.email}
                          </span>
                        </span>
                        {loading ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-700" aria-hidden="true" />
                        ) : (
                          <ArrowRight
                            className="h-4 w-4 shrink-0 text-brand-600 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100"
                            aria-hidden="true"
                          />
                        )}
                      </span>

                      <Badge tone={PERSONA_TONE[persona.accent]}>{persona.tag}</Badge>

                      <span className="text-[11.5px] leading-4 text-ink-muted">
                        {persona.description}
                      </span>

                      <span className="mt-auto flex flex-wrap gap-1 pt-1">
                        {persona.abilities.map((ability) => (
                          <span
                            key={ability}
                            className="inline-flex items-center gap-1 rounded border border-line bg-white/80 px-1.5 py-0.5 text-[9.5px] font-medium text-ink-soft"
                          >
                            <Check className="h-2.5 w-2.5 text-emerald-600" aria-hidden="true" />
                            {ability}
                          </span>
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {error && (
              <p
                role="alert"
                className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700"
              >
                {error}
              </p>
            )}

            <div className="mt-4 flex items-center justify-between gap-3 text-[11.5px]">
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-muted">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    health?.status === 'ok'
                      ? 'bg-emerald-500'
                      : health?.status === 'offline'
                        ? 'bg-red-500'
                        : 'bg-amber-400'
                  }`}
                />
                {health?.status === 'ok'
                  ? `API online · ${health.extraction?.enabled ? 'Gemini extraction' : 'deterministic extraction'}`
                  : health?.status === 'offline'
                    ? 'API unreachable'
                    : 'Checking API…'}
              </span>
              <span className="font-mono text-[10px] text-ink-faint">
                {health?.demoSeedEnabled === false ? 'Demo seeding disabled' : 'Demo accounts · synthetic data'}
              </span>
            </div>

            <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-line bg-white/60 px-3 py-2.5 text-[11px] leading-4 text-ink-muted">
              <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
              <p>
                The Atlas demo contains six synthetic source documents. Demo sign-in is applied
                automatically and only works for these seeded accounts — never for a real
                workspace.
              </p>
            </div>
          </div>
        </div>
      </div>

      {coldStartOpen && <ColdStartNotice health={health} onDismiss={dismissColdStart} />}
    </div>
  );
}
