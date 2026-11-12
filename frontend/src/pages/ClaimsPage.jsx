import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight,
  FilterX,
  ListChecks,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProject } from './ProjectLayout.jsx';
import { CLAIM_TYPES } from '../lib/constants.js';
import { pluralize } from '../lib/format.js';
import ClaimCard from '../components/ClaimCard.jsx';
import EvidenceDrawer from '../components/EvidenceDrawer.jsx';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  SearchInput,
  Select,
} from '../components/ui.jsx';

export default function ClaimsPage() {
  const { projectId } = useParams();
  const { project } = useProject();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, error, loading, reload } = useAsync(
    () => api.get(`/api/projects/${projectId}/claims?limit=500`),
    [projectId],
  );

  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [type, setType] = useState(searchParams.get('type') || 'all');
  const [state, setState] = useState(searchParams.get('state') || 'all');
  const [source, setSource] = useState(searchParams.get('source') || 'all');
  const [sort, setSort] = useState('newest');
  const [unverifiedOnly, setUnverifiedOnly] = useState(searchParams.get('flag') === 'unverified');
  const [evidenceId, setEvidenceId] = useState(null);

  useEffect(() => {
    const next = new URLSearchParams();
    if (query.trim()) next.set('q', query.trim());
    if (type !== 'all') next.set('type', type);
    if (state !== 'all') next.set('state', state);
    if (source !== 'all') next.set('source', source);
    if (unverifiedOnly) next.set('flag', 'unverified');
    setSearchParams(next, { replace: true });
  }, [query, type, state, source, unverifiedOnly, setSearchParams]);

  const claims = data?.claims || [];

  const sources = useMemo(() => {
    const names = new Set();
    for (const claim of claims) {
      for (const citation of claim.citations || []) {
        if (citation.sourceName) names.add(citation.sourceName);
      }
    }
    return [...names].sort();
  }, [claims]);

  const stateCounts = useMemo(() => {
    const counts = { confirmed: 0, inferred: 0, needs_review: 0 };
    for (const claim of claims) counts[claim.state] = (counts[claim.state] || 0) + 1;
    return counts;
  }, [claims]);

  const unverifiedCount = useMemo(
    () =>
      claims.filter(
        (claim) =>
          (claim.flags || []).includes('unverified_citation') ||
          (claim.verifiedEvidenceCount ?? 0) === 0,
      ).length,
    [claims],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    const result = claims.filter((claim) => {
      if (type !== 'all' && claim.type !== type) return false;
      if (state !== 'all' && claim.state !== state) return false;
      if (
        source !== 'all' &&
        !(claim.citations || []).some((citation) => citation.sourceName === source)
      ) {
        return false;
      }
      if (
        unverifiedOnly &&
        !(
          (claim.flags || []).includes('unverified_citation') ||
          (claim.verifiedEvidenceCount ?? 0) === 0
        )
      ) {
        return false;
      }
      if (!term) return true;
      return (
        claim.statement.toLowerCase().includes(term) ||
        claim.topic?.toLowerCase().includes(term) ||
        claim.ownerName?.toLowerCase().includes(term)
      );
    });

    result.sort((a, b) => {
      if (sort === 'oldest') {
        return new Date(a.occurredAt || 0) - new Date(b.occurredAt || 0);
      }
      if (sort === 'review') {
        const rank = { needs_review: 0, inferred: 1, confirmed: 2 };
        return (rank[a.state] ?? 3) - (rank[b.state] ?? 3);
      }
      if (sort === 'confidence') return (b.confidence || 0) - (a.confidence || 0);
      return new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0);
    });
    return result;
  }, [claims, type, state, source, unverifiedOnly, query, sort]);

  const activeFilters =
    Boolean(query.trim()) || type !== 'all' || state !== 'all' || source !== 'all' || unverifiedOnly;

  const clearFilters = () => {
    setQuery('');
    setType('all');
    setState('all');
    setSource('all');
    setUnverifiedOnly(false);
    setSort('newest');
  };

  const canPrepare = ['lead', 'contributor'].includes(project.role);

  return (
    <div>
      <PageHeader
        eyebrow={`${project.key} · Extracted record`}
        title="Claims ledger"
        description="Every statement the pipeline extracted from sources you can read. Open a citation to inspect the verbatim passage it came from."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={loading}
              onClick={() => reload().catch(() => {})}
            >
              Refresh
            </Button>
            {canPrepare && (
              <Button
                size="sm"
                icon={ArrowUpRight}
                onClick={() => navigate(`/projects/${projectId}/handovers`, { state: { create: true } })}
              >
                Prepare handover
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-4">
        {[
          { key: 'all', label: 'Visible claims', value: claims.length, tone: 'navy' },
          { key: 'confirmed', label: 'Confirmed', value: stateCounts.confirmed, tone: 'green' },
          { key: 'inferred', label: 'Inferred', value: stateCounts.inferred, tone: 'amber' },
          { key: 'needs_review', label: 'Needs review', value: stateCounts.needs_review, tone: 'orange' },
        ].map((stat) => (
          <button
            key={stat.key}
            type="button"
            onClick={() => setState(stat.key === 'all' ? 'all' : stat.key)}
            className={`rounded-lg border px-3 py-2.5 text-left transition ${
              state === stat.key
                ? 'border-brand-300 bg-brand-50/70 ring-1 ring-brand-200'
                : 'border-line bg-white hover:border-brand-200'
            }`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
              {stat.label}
            </p>
            <p className="mt-1 font-display text-[20px] font-semibold leading-none">{stat.value}</p>
          </button>
        ))}
      </div>

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search statements, topics or owners"
            className="min-w-[220px] flex-1"
          />
          <Select
            value={type}
            onChange={(event) => setType(event.target.value)}
            aria-label="Filter by claim type"
            className="w-auto min-w-[140px]"
          >
            <option value="all">All types</option>
            {Object.entries(CLAIM_TYPES).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
          <Select
            value={source}
            onChange={(event) => setSource(event.target.value)}
            aria-label="Filter by source"
            className="w-auto min-w-[150px]"
          >
            <option value="all">All sources</option>
            {sources.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          <Select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            aria-label="Sort claims"
            className="w-auto min-w-[140px]"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="review">Needs review first</option>
            <option value="confidence">Highest confidence</option>
          </Select>
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-white px-2.5 text-[11.5px] text-ink-soft">
            <input
              type="checkbox"
              checked={unverifiedOnly}
              onChange={(event) => setUnverifiedOnly(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-line-strong text-brand-700 focus:ring-brand-200"
            />
            Unverified only
            <span className="rounded bg-orange-50 px-1 font-mono text-[9.5px] text-orange-700">
              {unverifiedCount}
            </span>
          </label>
          {activeFilters && (
            <Button variant="ghost" size="sm" icon={FilterX} onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>
      </Card>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] text-ink-muted">
          Showing <span className="font-semibold text-ink">{filtered.length}</span> of{' '}
          {pluralize(claims.length, 'visible claim')}
          {activeFilters ? ' after filters' : ''}.
        </p>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
          <ShieldCheck className="h-3 w-3 text-emerald-600" aria-hidden="true" />
          all citations readable by you
        </span>
      </div>

      {loading && !data ? (
        <LoadingBlock rows={4} />
      ) : error && !data ? (
        <ErrorState
          title="Could not load claims"
          error={error}
          onRetry={() => reload().catch(() => {})}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={activeFilters ? Search : ListChecks}
          title={activeFilters ? 'No claims match these filters' : 'No visible claims yet'}
          description={
            activeFilters
              ? 'Clear the filters to see the full visible ledger.'
              : 'Once sources finish ingesting, extracted statements appear here with verbatim citations.'
          }
          action={
            activeFilters ? (
              <Button variant="secondary" icon={FilterX} onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <Button onClick={() => navigate(`/projects/${projectId}/sources`)}>Open sources</Button>
            )
          }
        />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {filtered.map((claim) => (
            <ClaimCard key={claim.id} claim={claim} onEvidence={setEvidenceId} />
          ))}
        </div>
      )}

      {data?.total > claims.length && (
        <p className="mt-4 text-[11px] text-ink-muted">
          Showing the first {claims.length} of {data.total} matching claims.
        </p>
      )}

      <EvidenceDrawer
        projectId={projectId}
        evidenceId={evidenceId}
        open={Boolean(evidenceId)}
        onClose={() => setEvidenceId(null)}
      />
    </div>
  );
}
