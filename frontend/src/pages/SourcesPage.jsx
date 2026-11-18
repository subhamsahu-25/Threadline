import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronRight,
  Clock3,
  Database,
  FileText,
  FileWarning,
  Github,
  HardDrive,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldAlert,
  Timer,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { api, errorMessage, uploadSource } from '../lib/api.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProject } from './ProjectLayout.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { SENSITIVITY, SOURCE_KINDS } from '../lib/constants.js';
import {
  formatBytes,
  formatDateTime,
  formatRelative,
  pluralize,
  titleCase,
} from '../lib/format.js';
import { SensitivityBadge, SourceStatusBadge } from '../components/badges.jsx';
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  Spinner,
} from '../components/ui.jsx';

const VISIBILITY_SCOPES = [
  { value: 'project', label: 'Everyone on the project' },
  { value: 'roles', label: 'Specific project roles' },
  { value: 'users', label: 'Specific people' },
];

export function visibilityLabel(visibility) {
  if (!visibility || visibility.scope === 'project') return 'Everyone on the project';
  if (visibility.scope === 'roles') {
    return visibility.roles?.length
      ? `Roles: ${visibility.roles.map((role) => titleCase(role)).join(', ')}`
      : 'No roles selected';
  }
  return `${visibility.users?.length || 0} specific ${visibility.users?.length === 1 ? 'person' : 'people'}`;
}

export function VisibilityFields({ visibility, onChange, members = [], compact = false }) {
  const setScope = (scope) => {
    onChange({
      scope,
      roles: scope === 'roles' ? visibility.roles || [] : [],
      users: scope === 'users' ? visibility.users || [] : [],
    });
  };
  const toggleRole = (role) => {
    const current = visibility.roles || [];
    onChange({
      ...visibility,
      roles: current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role],
    });
  };
  const toggleUser = (userId) => {
    const current = visibility.users || [];
    onChange({
      ...visibility,
      users: current.includes(userId)
        ? current.filter((entry) => entry !== userId)
        : [...current, userId],
    });
  };

  return (
    <div className={compact ? '' : 'rounded-lg border border-line bg-slate-50/60 p-3.5'}>
      <Field
        label="Who can read this source?"
        hint="Visibility is evaluated for every claim and handover item at read time."
      >
        <Select value={visibility.scope || 'project'} onChange={(event) => setScope(event.target.value)}>
          {VISIBILITY_SCOPES.map((scope) => (
            <option key={scope.value} value={scope.value}>
              {scope.label}
            </option>
          ))}
        </Select>
      </Field>

      {visibility.scope === 'roles' && (
        <fieldset className="mt-3">
          <legend className="mb-1.5 text-[11px] font-semibold text-ink-soft">Allowed roles</legend>
          <div className="flex flex-wrap gap-2">
            {['lead', 'contributor', 'observer'].map((role) => (
              <label
                key={role}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-white px-2.5 py-1.5 text-[11.5px] text-ink-soft"
              >
                <input
                  type="checkbox"
                  checked={(visibility.roles || []).includes(role)}
                  onChange={() => toggleRole(role)}
                  className="h-3.5 w-3.5 rounded border-line-strong text-brand-700 focus:ring-brand-200"
                />
                {titleCase(role)}
              </label>
            ))}
          </div>
          {(visibility.roles || []).length === 0 && (
            <p className="mt-1.5 text-[11px] text-amber-700">Choose at least one role.</p>
          )}
        </fieldset>
      )}

      {visibility.scope === 'users' && (
        <fieldset className="mt-3">
          <legend className="mb-1.5 text-[11px] font-semibold text-ink-soft">Allowed people</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {members.map((member) => (
              <label
                key={member.userId}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-2.5 py-1.5 text-[11.5px] text-ink-soft"
              >
                <input
                  type="checkbox"
                  checked={(visibility.users || []).includes(member.userId)}
                  onChange={() => toggleUser(member.userId)}
                  className="h-3.5 w-3.5 rounded border-line-strong text-brand-700 focus:ring-brand-200"
                />
                <span className="min-w-0 flex-1 truncate">{member.name || member.email}</span>
                <span className="font-mono text-[9px] uppercase text-ink-faint">{member.role}</span>
              </label>
            ))}
          </div>
          {(visibility.users || []).length === 0 && (
            <p className="mt-1.5 text-[11px] text-amber-700">Choose at least one person.</p>
          )}
        </fieldset>
      )}
    </div>
  );
}

function SourceIcon({ kind }) {
  const Icon = kind === 'github' ? Github : kind === 'drive' ? HardDrive : UploadCloud;
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-slate-50 text-ink-soft">
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  );
}

function DocumentDrawer({ projectId, source, open, onClose }) {
  const [list, setList] = useState({ loading: false, error: null, data: null });
  const [selected, setSelected] = useState(null);
  const [document, setDocument] = useState({ loading: false, error: null, data: null });

  useEffect(() => {
    if (!open || !source) return undefined;
    let active = true;
    setSelected(null);
    setDocument({ loading: false, error: null, data: null });
    setList({ loading: true, error: null, data: null });
    api
      .get(`/api/projects/${projectId}/documents?sourceId=${source.id}`)
      .then((data) => {
        if (active) setList({ loading: false, error: null, data });
      })
      .catch((error) => {
        if (active) setList({ loading: false, error, data: null });
      });
    return () => {
      active = false;
    };
  }, [projectId, source, open]);

  const openDocument = async (documentId) => {
    setSelected(documentId);
    setDocument({ loading: true, error: null, data: null });
    try {
      const data = await api.get(`/api/projects/${projectId}/documents/${documentId}`);
      setDocument({ loading: false, error: null, data });
    } catch (error) {
      setDocument({ loading: false, error, data: null });
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={selected ? document.data?.document.title || 'Document' : 'Source documents'}
      subtitle={source?.name}
      width="max-w-3xl"
      footer={
        <p className="text-[10.5px] text-ink-muted">
          Opening a document records a <span className="font-mono">document.viewed</span> audit event.
        </p>
      }
    >
      {selected ? (
        <div>
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setDocument({ loading: false, error: null, data: null });
            }}
            className="mb-4 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand-700 hover:text-brand-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to document list
          </button>
          {document.loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="h-6 w-6" />
            </div>
          ) : document.error ? (
            <ErrorState title="Document unavailable" error={document.error} />
          ) : document.data ? (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge tone="navy">{document.data.document.kind}</Badge>
                <Badge tone="slate">Revision {document.data.document.revision}</Badge>
                <span className="font-mono text-[10px] text-ink-muted">
                  {document.data.chunks.length} chunks · {formatBytes(document.data.document.size)}
                </span>
              </div>
              {document.data.document.parseWarnings?.length > 0 && (
                <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
                  {document.data.document.parseWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              )}
              <pre className="max-h-[62vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-white p-4 font-mono text-[11.5px] leading-6 text-ink-soft">
                {document.data.rawText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {list.loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="h-6 w-6" />
            </div>
          ) : list.error ? (
            <ErrorState title="Could not load documents" error={list.error} />
          ) : list.data?.documents?.length ? (
            <div className="space-y-2">
              {list.data.documents.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  onClick={() => openDocument(document.id)}
                  className="flex w-full items-start gap-3 rounded-lg border border-line bg-white px-3.5 py-3 text-left transition hover:border-brand-300 hover:bg-brand-50/30"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-ink-muted">
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-semibold text-ink">{document.title}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-ink-muted">
                      {document.kind} · {document.chunkCount} chunks ·{' '}
                      {formatDateTime(document.occurredAt)}
                    </span>
                    {document.parseWarnings?.length > 0 && (
                      <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-amber-700">
                        <FileWarning className="h-3 w-3" /> {document.parseWarnings.length} parse warning(s)
                      </span>
                    )}
                  </span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={FileText}
              title="No documents in this source"
              description="The source may still be queued, or its ingestion may have failed. Check the source status."
            />
          )}
        </>
      )}
    </Drawer>
  );
}

const EMPTY_VISIBILITY = { scope: 'project', roles: [], users: [] };

export default function SourcesPage() {
  const { projectId } = useParams();
  const { project } = useProject();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(
    () => api.get(`/api/projects/${projectId}/sources`),
    [projectId],
  );
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [mode, setMode] = useState('upload');
  const [files, setFiles] = useState([]);
  const [form, setForm] = useState({
    name: '',
    externalRef: '',
    sensitivity: 'internal',
    visibility: EMPTY_VISIBILITY,
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
  const [accessSource, setAccessSource] = useState(null);
  const [accessForm, setAccessForm] = useState({
    sensitivity: 'internal',
    visibility: EMPTY_VISIBILITY,
    allowExternal: true,
  });
  const [accessSaving, setAccessSaving] = useState(false);
  const [deleteSource, setDeleteSource] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [documentsSource, setDocumentsSource] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [syncSource, setSyncSource] = useState(null);
  const [syncForm, setSyncForm] = useState({ enabled: true, intervalMinutes: 5 });
  const [syncSaving, setSyncSaving] = useState(false);
  const [syncError, setSyncError] = useState('');

  const sources = data?.sources || [];
  const canContribute = project.canContribute;
  const canManage = project.role === 'lead';
  const active = sources.some((source) => ['queued', 'processing'].includes(source.status));

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(() => {
      reload({ quiet: true }).catch(() => {});
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [active, sources, reload]);

  const counts = useMemo(() => {
    const result = { all: sources.length, ready: 0, partial: 0, processing: 0, failed: 0 };
    for (const source of sources) {
      if (source.status === 'ready') result.ready += 1;
      else if (source.status === 'partial') result.partial += 1;
      else if (source.status === 'failed') result.failed += 1;
      else result.processing += 1;
    }
    return result;
  }, [sources]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return sources.filter((source) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'processing' && ['queued', 'processing'].includes(source.status)) ||
        source.status === filter;
      const matchesQuery =
        !term ||
        source.name.toLowerCase().includes(term) ||
        source.externalRef?.toLowerCase().includes(term);
      return matchesFilter && matchesQuery;
    });
  }, [sources, filter, query]);

  const resetAdd = () => {
    setMode('upload');
    setFiles([]);
    setForm({ name: '', externalRef: '', sensitivity: 'internal', visibility: EMPTY_VISIBILITY });
    setFormError('');
  };

  const addFiles = (incoming) => {
    setFiles((current) => {
      const merged = [...current];
      for (const file of incoming) {
        if (!merged.some((entry) => entry.name === file.name && entry.size === file.size)) {
          merged.push(file);
        }
      }
      return merged.slice(0, 20);
    });
  };

  const submitSource = async (event) => {
    event.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      if (mode === 'upload') {
        if (files.length === 0) throw new Error('Attach at least one file to upload.');
        await uploadSource(projectId, {
          files,
          name: form.name,
          sensitivity: form.sensitivity,
          visibility: form.visibility,
        });
        toast.success(
          `${pluralize(files.length, 'file')} queued for ingestion. Claims appear as the pipeline finishes.`,
        );
      } else {
        if (!form.externalRef.trim()) {
          throw new Error(mode === 'github' ? 'Enter a repository as owner/name.' : 'Enter a Drive file URL or id.');
        }
        await api.post(`/api/projects/${projectId}/sources`, {
          kind: mode,
          externalRef: form.externalRef.trim(),
          name: form.name.trim() || undefined,
          sensitivity: form.sensitivity,
          visibility: form.visibility,
        });
        toast.success('Connector source queued for ingestion.');
      }
      setAddOpen(false);
      resetAdd();
      await reload({ quiet: true });
    } catch (err) {
      if (err.message?.includes('roles') || err.message?.includes('people')) {
        setFormError(err.message);
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const openAccess = (source) => {
    setAccessSource(source);
    setAccessForm({
      sensitivity: source.sensitivity,
      visibility: {
        scope: source.visibility?.scope || 'project',
        roles: source.visibility?.roles || [],
        users: source.visibility?.users || [],
      },
      allowExternal: source.aiPolicy?.allowExternal ?? true,
    });
  };

  const saveAccess = async () => {
    if (!accessSource) return;
    setAccessSaving(true);
    try {
      await api.patch(`/api/projects/${projectId}/sources/${accessSource.id}`, {
        sensitivity: accessForm.sensitivity,
        visibility: accessForm.visibility,
        aiPolicy: { allowExternal: accessForm.allowExternal },
      });
      toast.success('Source access updated. Shared handovers will re-check permissions at read time.');
      setAccessSource(null);
      await reload({ quiet: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAccessSaving(false);
    }
  };

  const toggleHidden = async (source) => {
    setBusyId(source.id);
    try {
      await api.patch(`/api/projects/${projectId}/sources/${source.id}`, {
        hidden: !source.hidden,
      });
      toast.success(
        source.hidden
          ? 'Source restored. Its claims return to the project record.'
          : 'Source hidden. Its content and claims are removed from every reader’s view.',
      );
      await reload({ quiet: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const reingest = async (source) => {
    setBusyId(source.id);
    try {
      await api.post(`/api/projects/${projectId}/sources/${source.id}/reingest`);
      toast.success('Re-ingestion requested.');
      await reload({ quiet: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const requestSync = async (source) => {
    setSyncingId(source.id);
    try {
      await api.post(`/api/projects/${projectId}/sources/${source.id}/sync`);
      toast.success('Refresh queued. The source is re-read and compared with the stored copy.');
      await reload({ quiet: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSyncingId(null);
    }
  };

  const openSync = (source) => {
    setSyncSource(source);
    setSyncForm({
      enabled: source.sync?.enabled ?? true,
      intervalMinutes: source.sync?.intervalMinutes || 5,
    });
    setSyncError('');
  };

  const saveSync = async () => {
    if (!syncSource) return;
    setSyncSaving(true);
    setSyncError('');
    try {
      await api.patch(`/api/projects/${projectId}/sources/${syncSource.id}/sync`, {
        enabled: syncForm.enabled,
        intervalMinutes: Number(syncForm.intervalMinutes),
      });
      toast.success(
        syncForm.enabled
          ? `Automatic refresh on — checked every ${syncForm.intervalMinutes} minutes.`
          : 'Automatic refresh off. This source only changes when you refresh it manually.',
      );
      setSyncSource(null);
      await reload({ quiet: true });
    } catch (err) {
      setSyncError(errorMessage(err));
    } finally {
      setSyncSaving(false);
    }
  };

  const removeSource = async () => {
    if (!deleteSource) return;
    setDeleting(true);
    try {
      await api.del(`/api/projects/${projectId}/sources/${deleteSource.id}`);
      toast.success('Source removed. Documents are retained for audit history.');
      setDeleteSource(null);
      await reload({ quiet: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow={`${project.key} · Evidence pipeline`}
        title="Sources"
        description="Every claim originates from one of these sources. Visibility and sensitivity travel with the evidence all the way into a handover."
        actions={
          canContribute ? (
            <Button
              icon={Plus}
              onClick={() => {
                resetAdd();
                setAddOpen(true);
              }}
            >
              Add source
            </Button>
          ) : (
            <Badge tone="slate">Read-only role</Badge>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-start gap-2 rounded-lg border border-line bg-white/70 px-3.5 py-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-brand-700" aria-hidden="true" />
        <p className="flex-1 text-[11.5px] leading-5 text-ink-muted">
          <span className="font-semibold text-ink-soft">Fail closed:</span> a claim is returned only
          if every citation behind it resolves to a source you may read. Restricted items are absent,
          not greyed out. Connected sources are re-checked every five minutes, and approved handovers
          flip to outdated when their content changes.
        </p>
        {active && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-mono text-[10px] text-amber-800">
            <Spinner className="h-3 w-3" /> pipeline running
          </span>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          label="Filter sources"
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'ready', label: 'Ready', count: counts.ready },
            { value: 'partial', label: 'Partial', count: counts.partial },
            { value: 'processing', label: 'Processing', count: counts.processing },
            { value: 'failed', label: 'Failed', count: counts.failed },
          ]}
        />
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sources"
          className="w-full sm:w-64"
        />
      </div>

      {loading && !data ? (
        <LoadingBlock rows={3} />
      ) : error && !data ? (
        <ErrorState
          title="Could not load sources"
          error={error}
          onRetry={() => reload().catch(() => {})}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Database}
          title={sources.length === 0 ? 'No sources yet' : 'No sources match this filter'}
          description={
            sources.length === 0
              ? 'Upload handover notes, architecture decisions, sprint exports or incident reviews. PDF, DOCX, Markdown, CSV, JSON and TXT are supported.'
              : 'Try a different status filter or clear the search.'
          }
          action={
            sources.length === 0 && canContribute ? (
              <Button
                icon={Plus}
                onClick={() => {
                  resetAdd();
                  setAddOpen(true);
                }}
              >
                Add the first source
              </Button>
            ) : sources.length > 0 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setFilter('all');
                  setQuery('');
                }}
              >
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((source) => (
            <Card key={source.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <SourceIcon kind={source.kind} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h2 className="text-[13.5px] font-semibold leading-5">{source.name}</h2>
                      <SourceStatusBadge status={source.status} />
                      <SensitivityBadge sensitivity={source.sensitivity} />
                      {source.aiPolicy?.allowExternal === false && (
                        <Badge
                          tone="slate"
                          title="Document text is processed by the local extractor and is not sent to the external AI model."
                        >
                          Local AI only
                        </Badge>
                      )}
                      {source.hidden && <Badge tone="slate">Hidden</Badge>}
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-ink-muted">
                      {SOURCE_KINDS[source.kind] || source.kind}
                      {source.externalRef ? ` · ${source.externalRef}` : ''}
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
                      <span className="inline-flex items-center gap-1">
                        <LockKeyhole className="h-3 w-3 text-ink-faint" aria-hidden="true" />
                        {visibilityLabel(source.visibility)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="h-3 w-3 text-ink-faint" aria-hidden="true" />
                        {source.lastIngestedAt
                          ? `Ingested ${formatRelative(source.lastIngestedAt)}`
                          : 'Not ingested yet'}
                      </span>
                    </p>
                    {['github', 'drive'].includes(source.kind) && (
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
                        <span className="inline-flex items-center gap-1">
                          <Timer className="h-3 w-3 text-ink-faint" aria-hidden="true" />
                          {source.sync?.enabled
                            ? `Auto-refresh every ${source.sync.intervalMinutes || 5} min`
                            : 'Auto-refresh off'}
                        </span>
                        {source.sync?.lastCheckedAt && (
                          <span>Checked {formatRelative(source.sync.lastCheckedAt)}</span>
                        )}
                        {source.sync?.lastChangedAt && (
                          <span className="text-amber-700">
                            Changed {formatRelative(source.sync.lastChangedAt)}
                          </span>
                        )}
                        {source.sync?.lastError && (
                          <span className="text-red-600">Last refresh failed</span>
                        )}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDocumentsSource(source)}
                    disabled={source.stats?.documents === 0 && source.status !== 'ready'}
                  >
                    Documents
                  </Button>
                  {canContribute && ['github', 'drive'].includes(source.kind) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={RefreshCw}
                      loading={syncingId === source.id}
                      disabled={
                        syncingId === source.id ||
                        ['queued', 'processing'].includes(source.status)
                      }
                      onClick={() => requestSync(source)}
                    >
                      Check for changes
                    </Button>
                  )}
                  {canManage && ['github', 'drive'].includes(source.kind) && (
                    <Button variant="secondary" size="sm" icon={Timer} onClick={() => openSync(source)}>
                      Auto-refresh
                    </Button>
                  )}
                  {canContribute && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={RefreshCw}
                      loading={busyId === source.id}
                      onClick={() => reingest(source)}
                    >
                      {source.status === 'partial' ? 'Continue' : 'Re-ingest'}
                    </Button>
                  )}
                  {canManage && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => openAccess(source)}>
                        Access
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busyId === source.id}
                        onClick={() => toggleHidden(source)}
                      >
                        {source.hidden ? 'Unhide' : 'Hide'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        onClick={() => setDeleteSource(source)}
                        aria-label={`Remove ${source.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {source.statusMessage && (
                <p
                  className={`mt-3 rounded-md border px-2.5 py-1.5 text-[11px] leading-4 ${
                    source.status === 'failed'
                      ? 'border-red-200 bg-red-50 text-red-700'
                      : source.status === 'partial'
                        ? 'border-amber-200 bg-amber-50 text-amber-900'
                        : 'border-line bg-slate-50 text-ink-muted'
                  }`}
                >
                  {source.statusMessage}
                </p>
              )}

              {source.parseWarnings?.length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-1.5 text-[10.5px] leading-4 text-amber-900">
                  <FileWarning className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>
                    {source.parseWarnings.length} parser warning
                    {source.parseWarnings.length === 1 ? '' : 's'}: {source.parseWarnings[0]}
                    {source.parseWarnings.length > 1
                      ? ` (+${source.parseWarnings.length - 1} more in Documents)`
                      : ''}
                  </span>
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line pt-2.5 text-[10.5px] text-ink-muted">
                <span>
                  <span className="font-mono font-semibold text-ink">{source.stats?.documents || 0}</span>{' '}
                  documents
                </span>
                <span>
                  <span className="font-mono font-semibold text-ink">{source.stats?.claims || 0}</span>{' '}
                  claims
                </span>
                <span>
                  <span className="font-mono font-semibold text-ink">
                    {source.stats?.unverifiedClaims || 0}
                  </span>{' '}
                  unverified
                </span>
                {source.files?.length > 0 && (
                  <span className="min-w-0 truncate">
                    {source.files.map((file) => file.originalName).join(', ')}
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(syncSource)}
        onClose={() => setSyncSource(null)}
        title="Automatic refresh"
        description="Only connected GitHub and Drive sources can be refreshed in place. Everything else is refreshed by re-ingesting."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSyncSource(null)}>
              Cancel
            </Button>
            <Button loading={syncSaving} onClick={saveSync}>
              Save refresh settings
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-slate-50 px-3 py-2.5">
            <p className="text-[12px] font-semibold">{syncSource?.name}</p>
            <p className="mt-0.5 font-mono text-[10px] text-ink-muted">
              {SOURCE_KINDS[syncSource?.kind] || syncSource?.kind} · {syncSource?.externalRef}
            </p>
          </div>
          <Field label="Automatic refresh" htmlFor="sync-enabled">
            <Select
              id="sync-enabled"
              value={syncForm.enabled ? 'on' : 'off'}
              onChange={(event) =>
                setSyncForm((current) => ({ ...current, enabled: event.target.value === 'on' }))
              }
            >
              <option value="on">On — keep this source current</option>
              <option value="off">Off — refresh manually only</option>
            </Select>
          </Field>
          <Field
            label="Check every"
            htmlFor="sync-interval"
            hint="The scheduler runs once a minute; a source is only re-read when its own interval has elapsed."
          >
            <Select
              id="sync-interval"
              value={String(syncForm.intervalMinutes)}
              onChange={(event) =>
                setSyncForm((current) => ({
                  ...current,
                  intervalMinutes: Number(event.target.value),
                }))
              }
            >
              {[1, 5, 15, 30, 60, 240].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 1 ? '1 minute' : minutes === 60 ? '1 hour' : minutes === 240 ? '4 hours' : `${minutes} minutes`}
                </option>
              ))}
            </Select>
          </Field>
          <p className="rounded-md border border-line bg-white px-3 py-2 text-[10.5px] leading-4 text-ink-muted">
            When a check finds new content, the source is re-extracted and approved handovers built
            from it are marked outdated with a visible diff. Unchanged checks cost nothing and
            create no new evidence.
          </p>
          {syncError && (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700"
            >
              {syncError}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          setFormError('');
        }}
        title="Add a source"
        description="Uploaded files are parsed locally. Connector sources require server-side tokens."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="add-source" loading={saving}>
              Queue ingestion
            </Button>
          </>
        }
      >
        <form id="add-source" onSubmit={submitSource} className="space-y-4">
          <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-line bg-slate-50 p-1">
            {[
              { value: 'upload', label: 'Upload files', icon: UploadCloud },
              { value: 'github', label: 'GitHub repo', icon: Github },
              { value: 'drive', label: 'Google Drive', icon: HardDrive },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-[11.5px] font-semibold transition ${
                  mode === option.value
                    ? 'bg-white text-brand-800 shadow-sm ring-1 ring-line'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                <option.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {option.label}
              </button>
            ))}
          </div>

          {mode === 'upload' ? (
            <div>
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  addFiles(Array.from(event.dataTransfer.files || []));
                }}
                className={`rounded-lg border-2 border-dashed px-4 py-6 text-center transition ${
                  dragging ? 'border-brand-400 bg-brand-50/60' : 'border-line-strong bg-slate-50/50'
                }`}
              >
                <UploadCloud className="mx-auto h-7 w-7 text-ink-faint" aria-hidden="true" />
                <p className="mt-2 text-[12.5px] font-semibold">Drop files here or browse</p>
                <p className="mt-0.5 text-[10.5px] text-ink-muted">
                  TXT, MD, CSV, JSON, PDF or DOCX · up to 20 files, 15 MB each
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => fileInput.current?.click()}
                >
                  Choose files
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx"
                  className="sr-only"
                  onChange={(event) => addFiles(Array.from(event.target.files || []))}
                />
              </div>

              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((file, index) => (
                    <li
                      key={`${file.name}-${file.size}`}
                      className="flex items-center gap-2 rounded-md border border-line bg-white px-2.5 py-1.5 text-[11px]"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <span className="font-mono text-[9.5px] text-ink-faint">{formatBytes(file.size)}</span>
                      <button
                        type="button"
                        onClick={() => setFiles(files.filter((_, position) => position !== index))}
                        className="rounded p-0.5 text-ink-faint hover:bg-slate-100 hover:text-ink"
                        aria-label={`Remove ${file.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <Field
              label={mode === 'github' ? 'Repository' : 'Drive reference'}
              htmlFor="source-ref"
              required
              hint={
                mode === 'github'
                  ? 'owner/repo or a GitHub URL. Requires GITHUB_TOKEN on the server for private repositories.'
                  : 'A Drive file URL or file id. Requires GOOGLE_DRIVE_ACCESS_TOKEN on the server.'
              }
            >
              <Input
                id="source-ref"
                value={form.externalRef}
                onChange={(event) => setForm({ ...form, externalRef: event.target.value })}
                placeholder={
                  mode === 'github' ? 'zeusconquers/atlas-billing' : 'https://drive.google.com/file/d/…'
                }
                required
              />
            </Field>
          )}

          <Field label="Display name" htmlFor="source-name">
            <Input
              id="source-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder={mode === 'upload' ? 'Optional, defaults to the file name' : 'Optional connector label'}
              maxLength={120}
            />
          </Field>

          <Field label="Sensitivity" htmlFor="source-sensitivity">
            <Select
              id="source-sensitivity"
              value={form.sensitivity}
              onChange={(event) => setForm({ ...form, sensitivity: event.target.value })}
            >
              {Object.entries(SENSITIVITY).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </Select>
          </Field>

          <VisibilityFields
            visibility={form.visibility}
            onChange={(visibility) => setForm({ ...form, visibility })}
            members={project.members}
          />

          {formError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              {formError}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(accessSource)}
        onClose={() => setAccessSource(null)}
        title="Source access"
        description={accessSource?.name}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAccessSource(null)}>
              Cancel
            </Button>
            <Button loading={accessSaving} onClick={saveAccess}>
              Save access
            </Button>
          </>
        }
      >
        {accessSource && (
          <div className="space-y-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">
              Changing access takes effect immediately. Handovers already shared with a recipient
              re-evaluate permissions the next time they are opened.
            </div>
            <Field label="Sensitivity" htmlFor="access-sensitivity">
              <Select
                id="access-sensitivity"
                value={accessForm.sensitivity}
                onChange={(event) =>
                  setAccessForm({
                    ...accessForm,
                    sensitivity: event.target.value,
                    // Confidential sources do not go to the external model
                    // unless the lead re-checks the box on purpose.
                    allowExternal:
                      event.target.value === 'confidential'
                        ? false
                        : accessForm.allowExternal,
                  })
                }
              >
                {Object.entries(SENSITIVITY).map(([value, meta]) => (
                  <option key={value} value={value}>
                    {meta.label}
                  </option>
                ))}
              </Select>
            </Field>
            <VisibilityFields
              visibility={accessForm.visibility}
              onChange={(visibility) => setAccessForm({ ...accessForm, visibility })}
              members={project.members}
            />
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line bg-white px-3 py-2">
              <input
                type="checkbox"
                checked={accessForm.allowExternal}
                onChange={(event) =>
                  setAccessForm({ ...accessForm, allowExternal: event.target.checked })
                }
                className="mt-0.5 h-3.5 w-3.5 rounded border-line-strong text-brand-700 focus:ring-brand-200"
              />
              <span className="text-[11.5px] leading-5 text-ink-soft">
                <span className="font-semibold text-ink">
                  Send document text to the external AI model
                </span>
                <br />
                Off by default for confidential sources, which are then processed by the local
                extractor. Secret and personal values are redacted before any request. A change
                applies the next time this source is ingested, so use Re-ingest to apply it now.
              </span>
            </label>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(deleteSource)}
        onClose={() => setDeleteSource(null)}
        title="Remove this source?"
        description="Removing a source hides its claims from new views. Documents are retained for audit history."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteSource(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} onClick={removeSource}>
              Remove source
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] leading-6 text-ink-soft">
          <span className="font-semibold">{deleteSource?.name}</span> contributed{' '}
          {deleteSource?.stats?.claims || 0} claims and {deleteSource?.stats?.documents || 0}{' '}
          documents. Existing audit events are not deleted.
        </p>
      </Modal>

      <DocumentDrawer
        projectId={projectId}
        source={documentsSource}
        open={Boolean(documentsSource)}
        onClose={() => setDocumentsSource(null)}
      />
    </div>
  );
}
