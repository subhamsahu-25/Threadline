import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Database,
  Eye,
  EyeOff,
  FileCheck2,
  LockKeyhole,
  Mail,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { BrandMark } from '../components/AppShell.jsx';
import { Avatar, Badge, Button, Field, Input } from '../components/ui.jsx';
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

      <div className="relative mt-12 max-w-lg rounded-2xl border border-white/15 bg-white/[0.06] p-4 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-white/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-brand-100">
            Decision
          </span>
          <span className="font-mono text-[10px] text-brand-200/70">REF · architecture-decisions.md</span>
        </div>
        <p className="mt-2.5 text-[13.5px] font-medium leading-6 text-white">
          Stay on MySQL for the ledger until Q1 2027 and revisit PostgreSQL after the beta; this
          supersedes the earlier PostgreSQL-only plan.
        </p>
        <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
          <span className="inline-flex items-center gap-1 rounded border border-emerald-300/25 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[9.5px] text-emerald-200">
            <Check className="h-2.5 w-2.5" /> Exact quote
          </span>
          <span className="font-mono text-[10px] text-brand-200/60">2026-10-18 · verified</span>
        </div>
      </div>

      <p className="relative mt-10 text-[10.5px] text-brand-200/45">
        Demo workspace uses synthetic data only. No enterprise systems are connected.
      </p>
    </div>
  );
}

export default function LoginPage() {
  const { user, login, register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);

  const destination = location.state?.from && location.state.from !== '/login' ? location.state.from : '/';

  useEffect(() => {
    let active = true;
    api
      .get('/api/health')
      .then((data) => {
        if (active) setHealth(data);
      })
      .catch(() => {
        if (active) setHealth({ status: 'offline' });
      });
    return () => {
      active = false;
    };
  }, []);

  if (user) return <Navigate to={destination} replace />;

  const selectPersona = (persona) => {
    setMode('login');
    setEmail(persona.email);
    setPassword(DEMO_PASSWORD);
    setError('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (mode === 'register') {
        await register({ name, email, password });
        toast.success('Account created. Create or join a project to get started.');
      } else {
        const signedIn = await login(email.trim(), password);
        toast.success(`Signed in as ${signedIn.name}`);
      }
      navigate(destination, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const loadDemo = async () => {
    setSeeding(true);
    setError('');
    try {
      await api.post('/api/demo/seed?reset=true');
      setEmail('aarav@threadline.demo');
      setPassword(DEMO_PASSWORD);
      toast.success('Atlas demo workspace is ready — six synthetic sources ingested. Pick a persona.');
      setHealth((current) => ({ ...(current || {}), demoSeedEnabled: true }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSeeding(false);
    }
  };

  const selectedPersona = DEMO_PERSONAS.find((persona) => persona.email === email);

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
          <div className="w-full max-w-[460px]">
            <div className="mb-6">
              <p className="eyebrow mb-1.5">Secure access</p>
              <h2 className="text-[27px] font-semibold leading-tight tracking-[-0.02em]">
                {mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}
              </h2>
              <p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
                {mode === 'login'
                  ? 'Choose a demo persona or use your own credentials.'
                  : 'You will start with no projects. Create one after signing in.'}
              </p>
            </div>

            {mode === 'login' && (
              <section aria-labelledby="personas-heading" className="mb-5">
                <div className="mb-2 flex items-center justify-between">
                  <h3 id="personas-heading" className="eyebrow">
                    Demo personas
                  </h3>
                  <button
                    type="button"
                    onClick={loadDemo}
                    disabled={seeding}
                    className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand-700 transition hover:text-brand-900 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${seeding ? 'animate-spin' : ''}`} aria-hidden="true" />
                    {seeding ? 'Building Atlas workspace…' : 'Load / reset demo data'}
                  </button>
                </div>
                <div className="grid gap-1.5">
                  {DEMO_PERSONAS.map((persona) => {
                    const active = selectedPersona?.email === persona.email;
                    return (
                      <button
                        key={persona.email}
                        type="button"
                        aria-pressed={active}
                        onClick={() => selectPersona(persona)}
                        className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                          active
                            ? 'border-brand-300 bg-brand-50/80 ring-1 ring-brand-200'
                            : `${PERSONA_RING[persona.accent]} hover:border-brand-200 hover:bg-white`
                        }`}
                      >
                        <Avatar name={persona.name} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[12.5px] font-semibold text-ink">{persona.name}</span>
                            <Badge
                              tone={
                                persona.role === 'lead'
                                  ? 'navy'
                                  : persona.role === 'observer'
                                    ? 'slate'
                                    : persona.accent === 'green'
                                      ? 'green'
                                      : 'amber'
                              }
                            >
                              {persona.tag}
                            </Badge>
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-ink-muted">
                            {persona.description}
                          </span>
                        </span>
                        {active && (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white">
                            <Check className="h-3 w-3" aria-hidden="true" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
              {mode === 'register' && (
                <Field label="Full name" htmlFor="name" required>
                  <div className="relative">
                    <UserRound
                      className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                      aria-hidden="true"
                    />
                    <Input
                      id="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Your name"
                      autoComplete="name"
                      required
                      minLength={2}
                      className="pl-9"
                    />
                  </div>
                </Field>
              )}

              <Field label="Work email" htmlFor="email" required>
                <div className="relative">
                  <Mail
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                    aria-hidden="true"
                  />
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    autoComplete="email"
                    required
                    className="pl-9"
                  />
                </div>
              </Field>

              <Field
                label="Password"
                htmlFor="password"
                required
                hint={mode === 'login' ? 'Demo personas use the synthetic password automatically.' : 'Use at least 8 characters.'}
              >
                <div className="relative">
                  <LockKeyhole
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                    aria-hidden="true"
                  />
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Enter your password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    required
                    className="pl-9 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-ink-faint transition hover:bg-slate-100 hover:text-ink"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </Field>

              {error && (
                <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                size="lg"
                loading={submitting}
                iconRight={ArrowRight}
                className="w-full"
              >
                {submitting
                  ? mode === 'login'
                    ? 'Signing in…'
                    : 'Creating account…'
                  : mode === 'login'
                    ? selectedPersona
                      ? `Sign in as ${selectedPersona.name.split(' ')[0]}`
                      : 'Sign in to Threadline'
                    : 'Create account'}
              </Button>
            </form>

            <div className="mt-4 flex items-center justify-between text-[12px]">
              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setError('');
                }}
                className="font-semibold text-brand-700 hover:text-brand-900"
              >
                {mode === 'login' ? 'Create an account' : 'Back to sign in'}
              </button>
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-muted">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    health?.status === 'ok' ? 'bg-emerald-500' : health?.status === 'offline' ? 'bg-red-500' : 'bg-amber-400'
                  }`}
                />
                {health?.status === 'ok'
                  ? `API online · ${health.extraction?.enabled ? 'Gemini extraction' : 'deterministic extraction'}`
                  : health?.status === 'offline'
                    ? 'API unreachable'
                    : 'Checking API…'}
              </span>
            </div>

            <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-line bg-white/60 px-3 py-2.5 text-[11px] leading-4 text-ink-muted">
              <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
              <p>
                The Atlas demo contains six synthetic source documents. Credentials shown here are
                for this local demo only and must never be used for a real account.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
