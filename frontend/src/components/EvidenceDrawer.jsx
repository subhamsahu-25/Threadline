import { useEffect, useState } from 'react';
import { Link2, Copy, FileText, ShieldCheck, Clock3, ExternalLink, RotateCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, Button, Drawer, ErrorState, Spinner } from './ui.jsx';

const VALIDATION = {
  exact: { label: 'Exact quote match', tone: 'green' },
  normalized: { label: 'Normalized match', tone: 'blue' },
  failed: { label: 'Quote not matched', tone: 'red' },
  unchecked: { label: 'Not checked', tone: 'slate' },
};

function Highlighted({ text, start, end }) {
  if (typeof start !== 'number' || typeof end !== 'number') return text;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-[3px] bg-amber-200/70 px-0.5 font-medium text-ink">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

export default function EvidenceDrawer({ projectId, evidenceId, open, onClose }) {
  const toast = useToast();
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [documentState, setDocumentState] = useState({ loading: false, error: null, data: null });
  const [showDocument, setShowDocument] = useState(false);

  useEffect(() => {
    if (!open || !evidenceId) return undefined;
    let active = true;
    setState({ loading: true, error: null, data: null });
    setDocumentState({ loading: false, error: null, data: null });
    setShowDocument(false);
    api
      .get(`/api/projects/${projectId}/evidence/${evidenceId}`)
      .then((data) => {
        if (active) setState({ loading: false, error: null, data });
      })
      .catch((error) => {
        if (active) setState({ loading: false, error, data: null });
      });
    return () => {
      active = false;
    };
  }, [projectId, evidenceId, open]);

  const loadDocument = async () => {
    if (!state.data?.document?.id || documentState.data) {
      setShowDocument(true);
      return;
    }
    setShowDocument(true);
    setDocumentState({ loading: true, error: null, data: null });
    try {
      const data = await api.get(
        `/api/projects/${projectId}/documents/${state.data.document.id}`,
      );
      setDocumentState({ loading: false, error: null, data });
    } catch (error) {
      setDocumentState({ loading: false, error, data: null });
    }
  };

  const copyQuote = async () => {
    try {
      await navigator.clipboard.writeText(state.data.evidence.quote);
      toast.success('Quote copied');
    } catch {
      toast.error('Your browser blocked clipboard access');
    }
  };

  const validation = state.data
    ? VALIDATION[state.data.evidence.validation] || VALIDATION.unchecked
    : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Evidence"
      subtitle={state.data ? `${state.data.source.name} · ${state.data.document.title}` : 'Verifying quote against the source'}
      width="max-w-2xl"
      footer={
        state.data ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-muted">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              Access checked again when this evidence was opened
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" icon={Copy} onClick={copyQuote}>
                Copy quote
              </Button>
              <Button
                size="sm"
                variant={showDocument ? 'soft' : 'primary'}
                icon={FileText}
                onClick={() => (showDocument ? setShowDocument(false) : loadDocument())}
              >
                {showDocument ? 'Show context' : 'View full document'}
              </Button>
            </div>
          </div>
        ) : null
      }
    >
      {state.loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-muted">
          <Spinner className="h-6 w-6" />
          <p className="text-[12px]">Locating the verbatim passage…</p>
        </div>
      ) : state.error ? (
        <ErrorState
          title="Evidence could not be opened"
          error={state.error}
          onRetry={() => {
            setState({ loading: true, error: null, data: null });
            api
              .get(`/api/projects/${projectId}/evidence/${evidenceId}`)
              .then((data) => setState({ loading: false, error: null, data }))
              .catch((error) => setState({ loading: false, error, data: null }));
          }}
        />
      ) : state.data ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={validation.tone} dot>
              {validation.label}
            </Badge>
            <Badge tone="slate">{state.data.source.kind}</Badge>
            {state.data.document.revision > 1 && (
              <Badge tone="navy">Revision {state.data.document.revision}</Badge>
            )}
            <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10.5px] text-ink-muted">
              <Clock3 className="h-3 w-3" aria-hidden="true" />
              {formatDateTime(state.data.document.occurredAt)}
            </span>
          </div>

          {!showDocument ? (
            <>
              <section>
                <h3 className="eyebrow mb-2">Verbatim quote</h3>
                <blockquote className="evidence-quote whitespace-pre-wrap">
                  {state.data.evidence.quote}
                </blockquote>
                <p className="mt-2 font-mono text-[10px] text-ink-faint">
                  chars {state.data.evidence.charStart}–{state.data.evidence.charEnd} · id{' '}
                  {String(state.data.evidence.id).slice(-8)}
                </p>
              </section>

              <section>
                <h3 className="eyebrow mb-2">Surrounding context</h3>
                <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-slate-50/80 p-4 font-mono text-[11.5px] leading-6 text-ink-soft">
                  <Highlighted
                    text={state.data.context}
                    start={state.data.highlight?.start}
                    end={state.data.highlight?.end}
                  />
                </pre>
                <p className="mt-1.5 text-[10.5px] text-ink-muted">
                  Approximately 600 characters on either side of the cited passage.
                </p>
              </section>
            </>
          ) : (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="eyebrow">Full source document</h3>
                {documentState.loading && <Spinner className="h-4 w-4" />}
              </div>
              {documentState.error ? (
                <ErrorState
                  compact
                  title="Document could not be opened"
                  error={documentState.error}
                  onRetry={loadDocument}
                />
              ) : documentState.data ? (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge tone="navy">{documentState.data.document.title}</Badge>
                    <span className="font-mono text-[10px] text-ink-muted">
                      {documentState.data.document.kind} · rev {documentState.data.document.revision}
                    </span>
                  </div>
                  <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-white p-4 font-mono text-[11.5px] leading-6 text-ink-soft">
                    <Highlighted
                      text={documentState.data.rawText}
                      start={state.data.evidence.charStart}
                      end={state.data.evidence.charEnd}
                    />
                  </pre>
                  <p className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-ink-muted">
                    <RotateCw className="h-3 w-3" aria-hidden="true" />
                    The cited quote is highlighted in amber.
                  </p>
                </>
              ) : (
                <div className="flex items-center gap-2 py-8 text-ink-muted">
                  <Spinner className="h-4 w-4" />
                  <span className="text-[12px]">Loading document…</span>
                </div>
              )}
            </section>
          )}

          <section className="rounded-lg border border-line bg-slate-50/60 p-3.5">
            <h3 className="eyebrow mb-2.5">Provenance</h3>
            <dl className="grid gap-2.5 text-[11.5px] sm:grid-cols-2">
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-ink-faint">Source</dt>
                <dd className="mt-0.5 font-medium text-ink">{state.data.source.name}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-ink-faint">Document</dt>
                <dd className="mt-0.5 truncate font-mono text-[10.5px] text-ink-soft">
                  {state.data.document.path || state.data.document.title}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-ink-faint">Recorded</dt>
                <dd className="mt-0.5 font-mono text-[10.5px] text-ink-soft">
                  {formatDateTime(state.data.document.occurredAt)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-ink-faint">Reference</dt>
                <dd className="mt-0.5 flex items-center gap-1 font-mono text-[10.5px] text-ink-soft">
                  <Link2 className="h-3 w-3" aria-hidden="true" />
                  {String(state.data.document.id).slice(-10)}
                  {state.data.document.url && (
                    <a
                      href={state.data.document.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-1 inline-flex items-center gap-0.5 text-brand-700 hover:underline"
                    >
                      open
                      <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                    </a>
                  )}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
