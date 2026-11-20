import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, MailCheck, ShieldAlert } from 'lucide-react';
import { BrandMark } from '../components/AppShell.jsx';
import { Button, Field, Input } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, errorMessage } from '../lib/api.js';

/**
 * The landing page for the link in the confirmation mail. It lives outside the
 * signed-in layout: the person following the link may not have a session yet,
 * and the page must still work after the token expires.
 */
export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const token = params.get('token') || '';
  const [status, setStatus] = useState(token ? 'checking' : 'missing');
  const [message, setMessage] = useState('');
  const [resendEmail, setResendEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('missing');
      return undefined;
    }
    let active = true;
    setStatus('checking');
    api
      .post('/api/auth/verify-email', { token })
      .then(() => {
        if (active) setStatus('verified');
      })
      .catch((error) => {
        if (!active) return;
        setMessage(errorMessage(error));
        setStatus('invalid');
      });
    return () => {
      active = false;
    };
  }, [token]);

  const resend = async (event) => {
    event.preventDefault();
    if (resending) return;
    setResending(true);
    setResent('');
    try {
      const result = await api.post('/api/auth/verification/resend', {
        email: resendEmail.trim(),
      });
      setResent(
        result?.message ||
          'If that address needs confirmation, a new link has been sent.',
      );
    } catch (error) {
      setResent(errorMessage(error));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <main className="w-full max-w-[500px] rounded-2xl border border-line bg-white p-6 shadow-card">
        <div className="flex items-center gap-3">
          <BrandMark className="h-10 w-10" />
          <div>
            <p className="font-display text-[17px] font-semibold leading-5">Threadline</p>
            <p className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-faint">
              Email confirmation
            </p>
          </div>
        </div>

        {status === 'checking' && (
          <div className="mt-8">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Confirming your address…</h1>
            <p className="mt-2 text-[13px] leading-6 text-ink-muted" role="status">
              This takes a moment. Do not close this page.
            </p>
          </div>
        )}

        {status === 'verified' && (
          <div className="mt-8" role="status">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.02em]">
              Email confirmed
            </h1>
            <p className="mt-2 text-[13px] leading-6 text-ink-muted">
              {user
                ? `Your address is confirmed, ${user.name}. A project lead can now add you to a workspace.`
                : 'Your address is confirmed. Sign in and a project lead can add you to a workspace.'}
            </p>
            <Button className="mt-5" onClick={() => navigate('/')}>
              Continue to the workspace
            </Button>
          </div>
        )}

        {(status === 'invalid' || status === 'missing') && (
          <div className="mt-8">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-50 text-amber-600">
              <ShieldAlert className="h-6 w-6" aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.02em]">
              {status === 'missing' ? 'This link is incomplete' : 'This link has expired'}
            </h1>
            <p className="mt-2 text-[13px] leading-6 text-ink-muted">
              {status === 'missing'
                ? 'Open the full link from your confirmation mail, or ask for a new one below.'
                : message || 'Request a new link below and open it in this browser.'}
            </p>

            <form onSubmit={resend} className="mt-6 space-y-3 border-t border-line pt-5">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-ink-soft">
                <MailCheck className="h-4 w-4 text-brand-700" aria-hidden="true" />
                Send a new confirmation link
              </div>
              <Field label="Email address" htmlFor="verify-resend-email" required>
                <Input
                  id="verify-resend-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={resendEmail}
                  onChange={(event) => setResendEmail(event.target.value)}
                  placeholder="you@company.com"
                />
              </Field>
              <Button type="submit" size="sm" loading={resending}>
                Send a new link
              </Button>
              {resent && (
                <p
                  className="rounded-md border border-line bg-paper px-3 py-2 text-[12px] leading-5 text-ink-muted"
                  role="status"
                >
                  {resent}
                </p>
              )}
            </form>
          </div>
        )}

        <p className="mt-8 border-t border-line pt-4 text-[11.5px] text-ink-faint">
          <Link to="/login" className="font-semibold text-brand-700 hover:text-brand-900">
            Back to sign in
          </Link>
        </p>
      </main>
    </div>
  );
}
