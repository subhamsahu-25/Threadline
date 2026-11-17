import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Clock3,
  FileSignature,
  LockKeyhole,
  LogIn,
  LogOut,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAsync } from '../hooks/useAsync.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { BrandMark } from '../components/AppShell.jsx';
import RecipientHandover from '../components/RecipientHandover.jsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingScreen,
} from '../components/ui.jsx';

function SharedShell({ children }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-3" aria-label="Threadline home">
            <BrandMark />
            <span>
              <span className="block font-display text-[16px] font-semibold leading-5 tracking-tight">
                Threadline
              </span>
              <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                Permission-aware handover
              </span>
            </span>
          </Link>
          <Badge tone="navy">
            <LockKeyhole className="h-3 w-3" aria-hidden="true" />
            Read-only share link
          </Badge>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-10 text-center text-[10.5px] text-ink-faint sm:px-6">
        This view is filtered for the named recipient and rechecked on every open. Nothing is
        shown that the recipient is not entitled to read.
      </footer>
    </div>
  );
}

function LinkProblem({ error }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const expired = error?.code === 'share_expired' || error?.status === 410;
  const wrongRecipient = error?.status === 403 && Boolean(user);
  const signInRequired = error?.status === 403 && !user;

  const title = expired
    ? 'This share link has expired'
    : wrongRecipient
      ? 'This link belongs to a different recipient'
      : signInRequired
        ? 'Sign in to open this link'
        : error?.status === 404
          ? 'This share link is not valid'
          : 'The shared handover could not be opened';

  const description = expired
    ? 'Share links expire automatically. Ask the handover owner to share an updated version from the project workspace.'
    : wrongRecipient
      ? `You are signed in as ${user?.email || 'another account'}. Share links open only for the named recipient. Sign out and use the recipient’s account, or ask the sender for a new link.`
      : signInRequired
        ? 'This link belongs to a private project. Sign in as the person it was prepared for, or ask the sender for a new link.'
        : error?.status === 404
          ? 'The link may have been mistyped or replaced by a newer share. Ask the sender to resend it.'
          : error?.message;

  return (
    <SharedShell>
      <Card className="mx-auto max-w-xl p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-200 bg-amber-50 text-amber-700">
          <ShieldAlert className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="text-[20px] font-semibold">{title}</h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-6 text-ink-muted">{description}</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {signInRequired && (
            <Button icon={LogIn} onClick={() => navigate('/login')}>
              Sign in
            </Button>
          )}
          {wrongRecipient && (
            <Button
              icon={LogOut}
              onClick={async () => {
                await logout();
                navigate('/login', { replace: true });
              }}
            >
              Sign out and switch account
            </Button>
          )}
          {user && (
            <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate('/')}>
              Go to my workspace
            </Button>
          )}
        </div>
        {error?.code && (
          <p className="mt-4 font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
            {error.status} · {error.code}
          </p>
        )}
      </Card>
    </SharedShell>
  );
}

export default function SharedHandoverPage() {
  const { token } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(
    () => api.get(`/api/handovers/shared/${token}`),
    [token],
  );
  const [handover, setHandover] = useState(null);
  const [acknowledging, setAcknowledging] = useState(false);

  useEffect(() => {
    if (data?.handover) setHandover(data.handover);
  }, [data]);

  const acknowledge = async () => {
    if (!handover) return;
    setAcknowledging(true);
    try {
      const response = await api.post(`/api/handovers/shared/${token}/acknowledge`);
      setHandover(response.handover);
      toast.success('Acknowledgement recorded. The sender can see that the handover was reviewed.');
    } catch (err) {
      toast.error(err?.message || 'The acknowledgement could not be recorded.');
    } finally {
      setAcknowledging(false);
    }
  };

  if (loading && !handover) return <LoadingScreen label="Opening your shared handover" />;
  if (error && !handover) return <LinkProblem error={error} />;

  if (!handover) {
    return (
      <SharedShell>
        <ErrorState
          title="The handover could not be loaded"
          error="The response did not include a handover."
          onRetry={() => reload().catch(() => {})}
        />
      </SharedShell>
    );
  }

  const recipientName =
    data?.recipientName || handover.recipientSnapshot?.name || 'Recipient';

  return (
    <SharedShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={recipientName} size="md" />
          <div>
            <p className="text-[11px] text-ink-muted">Prepared for</p>
            <p className="text-[13px] font-semibold leading-4">{recipientName}</p>
          </div>
          {handover.status === 'acknowledged' && (
            <Badge tone="green">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Acknowledged
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[10px] text-ink-muted">
            <FileSignature className="h-3 w-3 text-brand-600" aria-hidden="true" />
            v{handover.version}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[10px] text-ink-muted">
            <Clock3 className="h-3 w-3" aria-hidden="true" />
            rechecked {handover.permissionRecheck?.checkedAt ? 'just now' : 'on open'}
          </span>
          {user && handover.projectId && (
            <Link
              to={`/projects/${handover.projectId}/handovers`}
              className="inline-flex h-8 items-center rounded-md border border-line-strong bg-white px-3 text-[12px] font-semibold text-ink-soft transition hover:border-brand-300 hover:text-brand-800"
            >
              Back to project
            </Link>
          )}
        </div>
      </div>

      {data?.publicPreview && (
        <p className="mb-4 rounded-md border border-line bg-white px-3 py-2 text-[11px] leading-5 text-ink-muted">
          Demo preview: this link opens without an account so it can be evaluated freely. In a
          real project, only the named recipient can open it after signing in.
        </p>
      )}

      <RecipientHandover
        handover={handover}
        projectId={handover.projectId}
        onAcknowledge={acknowledge}
        acknowledging={acknowledging}
      />
    </SharedShell>
  );
}
