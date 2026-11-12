import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

const TONE_STYLES = {
  success: {
    icon: CheckCircle2,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-950',
    iconClass: 'text-emerald-600',
  },
  error: {
    icon: AlertTriangle,
    className: 'border-red-200 bg-red-50 text-red-950',
    iconClass: 'text-red-600',
  },
  info: {
    icon: Info,
    className: 'border-blue-200 bg-blue-50 text-blue-950',
    iconClass: 'text-blue-600',
  },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const push = useCallback(
    (message, tone = 'info') => {
      const id = ++counter.current;
      setToasts((current) => [...current.slice(-3), { id, message, tone }]);
      window.setTimeout(() => dismiss(id), 5200);
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      push,
      success: (message) => push(message, 'success'),
      error: (message) => push(message, 'error'),
      info: (message) => push(message, 'info'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[80] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:left-auto sm:right-6 sm:items-end"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((toast) => {
          const tone = TONE_STYLES[toast.tone] || TONE_STYLES.info;
          const Icon = tone.icon;
          return (
            <div
              key={toast.id}
              className={`pointer-events-auto flex w-full max-w-md animate-fade-up items-start gap-3 rounded-xl border px-4 py-3 shadow-lift ${tone.className}`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.iconClass}`} aria-hidden="true" />
              <p className="flex-1 text-[13px] leading-5">{toast.message}</p>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="rounded p-0.5 opacity-50 transition hover:opacity-100"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
