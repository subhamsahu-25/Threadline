import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Server, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { wakeNoticeEnabled } from '../lib/wake.js';

const IDLE_MS = 2 * 60 * 1000;

function useHealth(health) {
  const [ownHealth, setOwnHealth] = useState(null);

  useEffect(() => {
    if (health !== undefined) return undefined;
    let active = true;
    let timer;
    const check = async () => {
      try {
        const data = await api.get('/api/health');
        if (!active) return;
        setOwnHealth(data);
        if (data.status !== 'ok') timer = setTimeout(check, 5000);
      } catch {
        if (!active) return;
        setOwnHealth({ status: 'offline' });
        timer = setTimeout(check, 5000);
      }
    };
    check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [health]);

  return health !== undefined ? health : ownHealth;
}

export function ColdStartNotice({
  health,
  onDismiss,
  footnote,
  eyebrow = 'Before you continue',
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dismissRef = useRef(null);
  const liveHealth = useHealth(health);

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

  const ready = liveHealth?.status === 'ok';
  const offline = liveHealth?.status === 'offline';

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-[#081422]/70 backdrop-blur-[3px]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onDismiss();
        }}
        aria-hidden="true"
      />
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
            {eyebrow}
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
            The workspace responds normally once it does.
          </p>

          <div className="mt-5 flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2.5 text-[12px]">
            {ready ? (
              <>
                <Check className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                <span className="text-emerald-200">API connected — you&apos;re ready to continue.</span>
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
            {footnote || 'Shown when the demo has been idle.'}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function IdleWakeNotice() {
  const enabled = wakeNoticeEnabled();
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const lastActivity = useRef(0);
  const paused = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    clear();
    if (!enabled || paused.current) return;
    timer.current = setTimeout(() => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        schedule();
        return;
      }
      paused.current = true;
      setOpen(true);
    }, IDLE_MS);
  }, [clear, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivity.current < 1000) return;
      lastActivity.current = now;
      schedule();
    };
    const onVisible = () => {
      if (!document.hidden) onActivity();
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];
    for (const event of events) window.addEventListener(event, onActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => {
      for (const event of events) window.removeEventListener(event, onActivity);
      document.removeEventListener('visibilitychange', onVisible);
      clear();
    };
  }, [clear, enabled, schedule]);

  const dismiss = useCallback(() => {
    paused.current = false;
    setOpen(false);
    lastActivity.current = Date.now();
    schedule();
  }, [schedule]);

  if (!open) return null;
  return <ColdStartNotice onDismiss={dismiss} />;
}
