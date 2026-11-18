import { useEffect, useId, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ChevronRight, Inbox, Loader2, Search, X } from 'lucide-react';
import { initials } from '../lib/format.js';

const BUTTON_VARIANTS = {
  primary:
    'bg-brand-800 text-white shadow-sm hover:bg-brand-900 active:bg-brand-950 disabled:bg-brand-800/50',
  secondary:
    'border border-line-strong bg-white text-ink-soft shadow-sm hover:border-brand-300 hover:text-brand-800 disabled:text-ink-faint',
  soft: 'bg-brand-50 text-brand-800 hover:bg-brand-100 disabled:text-brand-300',
  ghost: 'text-ink-muted hover:bg-slate-100 hover:text-ink disabled:text-ink-faint',
  danger: 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50',
  dark: 'bg-ink text-white hover:bg-ink-soft disabled:opacity-50',
};

const BUTTON_SIZES = {
  sm: 'h-8 gap-1.5 px-3 text-[12px]',
  md: 'h-9 gap-2 px-4 text-[13px]',
  lg: 'h-11 gap-2 px-5 text-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon: Icon,
  iconRight: IconRight,
  className = '',
  children,
  type = 'button',
  disabled,
  ...props
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-semibold transition duration-150 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {children}
      {IconRight && !loading && <IconRight className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  );
}

export function IconButton({ label, icon: Icon, className = '', ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition hover:bg-slate-100 hover:text-ink disabled:opacity-40 ${className}`}
      {...props}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

export function Card({ as: Tag = 'div', className = '', children, ...props }) {
  return (
    <Tag
      className={`rounded-card border border-line bg-surface shadow-card ${className}`}
      {...props}
    >
      {children}
    </Tag>
  );
}

export function SectionHeading({ eyebrow, title, description, action, className = '' }) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h2 className="text-[17px] font-semibold leading-6">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-[13px] leading-5 text-ink-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions, children }) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-3xl">
          {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] sm:text-[30px]">
            {title}
          </h1>
          {description && (
            <p className="mt-2 text-[13.5px] leading-6 text-ink-muted">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

const BADGE_TONES = {
  slate: 'border-slate-200 bg-slate-50 text-slate-600',
  navy: 'border-brand-200 bg-brand-50 text-brand-800',
  blue: 'border-blue-200 bg-blue-50 text-blue-700',
  indigo: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  violet: 'border-violet-200 bg-violet-50 text-violet-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  orange: 'border-orange-200 bg-orange-50 text-orange-800',
  red: 'border-red-200 bg-red-50 text-red-700',
  green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  teal: 'border-teal-200 bg-teal-50 text-teal-700',
  sky: 'border-sky-200 bg-sky-50 text-sky-700',
};

const DOT_TONES = {
  slate: 'bg-slate-400',
  navy: 'bg-brand-600',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
  green: 'bg-emerald-500',
  teal: 'bg-teal-500',
  sky: 'bg-sky-500',
};

export function Badge({ tone = 'slate', dot = false, className = '', children, title }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] ${BADGE_TONES[tone] || BADGE_TONES.slate} ${className}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONES[tone] || DOT_TONES.slate}`} />}
      {children}
    </span>
  );
}

const AVATAR_TONES = [
  'bg-brand-100 text-brand-800',
  'bg-emerald-100 text-emerald-800',
  'bg-amber-100 text-amber-900',
  'bg-violet-100 text-violet-800',
  'bg-rose-100 text-rose-800',
  'bg-sky-100 text-sky-800',
];

export function Avatar({ name = '?', size = 'md', className = '', title }) {
  const tone = useMemo(() => {
    const total = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return AVATAR_TONES[total % AVATAR_TONES.length];
  }, [name]);
  const sizes = {
    xs: 'h-6 w-6 text-[9px]',
    sm: 'h-8 w-8 text-[10px]',
    md: 'h-9 w-9 text-[11px]',
    lg: 'h-11 w-11 text-[13px]',
    xl: 'h-14 w-14 text-base',
  };
  return (
    <span
      title={title || name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${sizes[size]} ${tone} ${className}`}
      aria-hidden={!title}
    >
      {initials(name) || '?'}
    </span>
  );
}

export function Spinner({ className = 'h-5 w-5' }) {
  return <Loader2 className={`animate-spin text-brand-600 ${className}`} aria-hidden="true" />;
}

export function LoadingBlock({ label = 'Loading', rows = 3, className = '' }) {
  return (
    <div className={`space-y-3 ${className}`} role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="rounded-card border border-line bg-surface p-5">
          <div className="skeleton mb-3 h-3 w-24" />
          <div className="skeleton mb-2 h-4 w-3/4" />
          <div className="skeleton h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function LoadingScreen({ label = 'Preparing your workspace' }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-ink-muted">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-white shadow-card">
        <Spinner />
      </div>
      <p className="text-[13px]">{label}…</p>
    </div>
  );
}

export function ErrorState({ title = 'That did not work', error, onRetry, compact = false }) {
  const message =
    error?.message || (typeof error === 'string' ? error : 'The request could not be completed.');
  return (
    <div
      className={`rounded-card border border-red-200 bg-red-50/60 ${compact ? 'p-4' : 'p-6'}`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-red-900">{title}</p>
          <p className="mt-1 text-[12.5px] leading-5 text-red-800/80">{message}</p>
          {onRetry && (
            <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className = '' }) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-card border border-dashed border-line-strong bg-white/60 px-6 py-12 text-center ${className}`}
    >
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-white text-ink-muted shadow-sm">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-1 max-w-md text-[12.5px] leading-5 text-ink-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-[#081422]/55 backdrop-blur-[2px]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose?.();
        }}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative z-10 flex max-h-[92vh] w-full animate-fade-up flex-col rounded-t-2xl border border-line bg-surface shadow-lift sm:rounded-2xl ${sizes[size]}`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id={titleId} className="text-[16px] font-semibold leading-6">
              {title}
            </h2>
            {description && <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">{description}</p>}
          </div>
          <IconButton label="Close" icon={X} onClick={onClose} />
        </div>
        <div className="scroll-safe flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-slate-50/70 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-xl' }) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70]">
      <div
        className="absolute inset-0 bg-[#081422]/50 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`absolute inset-y-0 right-0 flex w-full flex-col border-l border-line bg-surface shadow-drawer sm:w-[92vw] ${width} animate-slide-in`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[16px] font-semibold">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-muted">{subtitle}</p>}
          </div>
          <IconButton label="Close evidence panel" icon={X} onClick={onClose} />
        </div>
        <div className="scroll-safe flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {footer && <div className="border-t border-line bg-slate-50/70 px-5 py-3 sm:px-6">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}

export function ProgressBar({ value = 0, tone = 'brand', className = '', label }) {
  const tones = {
    brand: 'bg-brand-600',
    green: 'bg-emerald-600',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  };
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-slate-100 ${className}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-label={label}
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ${tones[tone] || tones.brand}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function ReadinessRing({ score = 0, size = 128, label = 'readiness' }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const hasScore = typeof score === 'number' && Number.isFinite(score);
  const tone = !hasScore ? '#94a3b8' : score >= 80 ? '#15803d' : score >= 60 ? '#d97706' : '#dc2626';
  const offset = hasScore
    ? circumference * (1 - Math.min(100, Math.max(0, score)) / 100)
    : circumference;
  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="64" cy="64" r={radius} fill="none" stroke="#e7ecf2" strokeWidth="9" />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-[30px] font-semibold leading-none text-ink">
          {hasScore ? score : '—'}
        </span>
        <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-muted">
          {label}
        </span>
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, icon: Icon, tone = 'text-ink', className = '' }) {
  return (
    <div className={`rounded-lg border border-line bg-white px-3.5 py-3 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
          {label}
        </p>
        {Icon && <Icon className="h-3.5 w-3.5 text-ink-faint" aria-hidden="true" />}
      </div>
      <p className={`mt-1.5 font-display text-2xl font-semibold leading-none ${tone}`}>{value}</p>
      {hint && <p className="mt-1.5 text-[11.5px] leading-4 text-ink-muted">{hint}</p>}
    </div>
  );
}

export function Field({ label, hint, error, htmlFor, required, children, className = '' }) {
  const id = htmlFor || undefined;
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-[12px] font-semibold text-ink-soft">
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="mt-1.5 text-[11.5px] text-red-600">{error}</p>
      ) : (
        hint && <p className="mt-1.5 text-[11.5px] leading-4 text-ink-muted">{hint}</p>
      )}
    </div>
  );
}

export const inputClass =
  'h-9 w-full rounded-md border border-line-strong bg-white px-3 text-[13px] text-ink placeholder:text-ink-faint transition focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-ink-muted';

export const textareaClass =
  'w-full rounded-md border border-line-strong bg-white px-3 py-2.5 text-[13px] leading-5 text-ink placeholder:text-ink-faint transition focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50';

export function Input({ className = '', ...props }) {
  return <input className={`${inputClass} ${className}`} {...props} />;
}

export function Textarea({ className = '', ...props }) {
  return <textarea className={`${textareaClass} ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }) {
  return (
    <select className={`${inputClass} cursor-pointer pr-8 ${className}`} {...props}>
      {children}
    </select>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search', className = '' }) {
  return (
    <div className={`relative ${className}`}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`${inputClass} pl-9`}
      />
    </div>
  );
}

export function SegmentedControl({ options, value, onChange, label = 'Filter' }) {
  return (
    <div
      className="flex flex-wrap gap-1 rounded-lg border border-line bg-white p-1"
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition ${
              active
                ? 'bg-brand-800 text-white shadow-sm'
                : 'text-ink-muted hover:bg-slate-100 hover:text-ink'
            }`}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={`rounded px-1 font-mono text-[10px] ${
                  active ? 'bg-white/15 text-white' : 'bg-slate-100 text-ink-muted'
                }`}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function LinkArrow({ children, ...props }) {
  return (
    <span className="inline-flex items-center gap-1 font-semibold text-brand-700" {...props}>
      {children}
      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}
