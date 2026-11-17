import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/format.js';

const POLL_MS = 60_000;

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    try {
      if (!quiet) setLoading(true);
      const data = await api.get('/api/notifications');
      setItems(data.notifications || []);
      setUnread(data.unread || 0);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => load({ quiet: true }), POLL_MS);
    const onFocus = () => load({ quiet: true });
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event) => {
      if (buttonRef.current?.contains(event.target)) return;
      if (panelRef.current && !panelRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const openItem = async (item) => {
    setOpen(false);
    if (!item.readAt) {
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry,
        ),
      );
      setUnread((count) => Math.max(0, count - 1));
      api.post(`/api/notifications/${item.id}/read`).catch(() => load({ quiet: true }));
    }
    navigate(item.href);
  };

  const markAll = async () => {
    if (busy || unread === 0) return;
    setBusy(true);
    try {
      await api.post('/api/notifications/read-all');
      setItems((current) =>
        current.map((entry) => ({
          ...entry,
          readAt: entry.readAt || new Date().toISOString(),
        })),
      );
      setUnread(0);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          if (!open) load({ quiet: true });
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="relative rounded-lg p-1.5 text-ink-muted transition hover:bg-slate-100 hover:text-ink"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-800 px-1 font-mono text-[9px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-[calc(100%+10px)] z-[70] w-[min(360px,calc(100vw-2rem))] rounded-xl border border-line bg-white shadow-lift"
        >
          <div className="flex items-baseline justify-between border-b border-line px-3.5 py-2.5">
            <p className="eyebrow">Notifications</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-brand-800 transition hover:bg-brand-50 disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCheck className="h-3 w-3" aria-hidden="true" />
                )}
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-1.5">
            {loading && items.length === 0 ? (
              <div className="flex items-center gap-2 px-2.5 py-4 text-[11.5px] text-ink-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Checking for updates…
              </div>
            ) : failed && items.length === 0 ? (
              <div className="px-2.5 py-4">
                <p className="text-[11.5px] text-ink-muted">Could not check for updates.</p>
                <button
                  type="button"
                  onClick={() => load()}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-800 hover:underline"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" /> Try again
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="px-2.5 py-4">
                <p className="text-[12px] font-medium text-ink">Nothing new</p>
                <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">
                  Handover approvals, questions and access changes for you will appear here.
                </p>
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openItem(item)}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-slate-50"
                >
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      item.readAt ? 'bg-transparent' : 'bg-brand-700'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[12px] leading-4 ${
                        item.readAt ? 'font-medium text-ink-soft' : 'font-semibold text-ink'
                      }`}
                    >
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-ink-muted">
                      {item.detail}
                    </span>
                    <span className="mt-0.5 block font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
                      {item.projectKey} · {formatRelative(item.createdAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-line px-3.5 py-2">
            <p className="text-[10px] leading-4 text-ink-faint">
              Only what you are allowed to open is listed. Losing access removes the notice.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
