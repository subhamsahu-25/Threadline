import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { truncate } from '../../lib/text.js';

const API = 'https://api.github.com';
const MAX_DOC_CHARS = 40_000;
// One page of 100 issues or 50 pull requests keeps the check at a handful of
// calls while covering far more history than the old 25/15 caps.
const MAX_ISSUES = 100;
const MAX_PULLS = 50;
const MAX_ISSUE_THREADS = 10;

// GitHub's real limits: owners are 1-39 alphanumeric/hyphen characters (no
// leading or trailing hyphen); repository names are up to 100 characters of
// letters, numbers, dots, underscores and hyphens.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function invalidRef(message) {
  return new AppError(400, 'invalid_github_ref', message);
}

export function assertRepoAllowed(fullName) {
  if (env.githubAllowedRepos.length === 0) {
    throw new AppError(
      403,
      'connector_not_configured',
      'GitHub ingestion is not configured on this deployment. Set GITHUB_ALLOWED_REPOS to list the repositories that may be connected.',
    );
  }
  if (!env.githubAllowedRepos.includes(fullName.toLowerCase())) {
    throw new AppError(
      403,
      'repo_not_allowlisted',
      `Repository ${fullName} is not on the GITHUB_ALLOWED_REPOS allowlist`,
    );
  }
}

function assertSafeSegment(segment, label) {
  if (segment === '.' || segment === '..') {
    throw invalidRef(`The ${label} cannot be "." or ".."`);
  }
  if (segment.startsWith('.') || segment.endsWith('.')) {
    throw invalidRef(`The ${label} cannot start or end with a dot`);
  }
  if (segment.includes('%') || segment.includes('\\')) {
    throw invalidRef(`The ${label} contains characters GitHub does not allow`);
  }
}

export function parseRepoRef(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw invalidRef('A GitHub repository reference is required');

  const urlMatch = raw.match(/^https?:\/\/(?:www\.)?github\.com(\/.*)?$/i);
  if (urlMatch) {
    // Pasted pages such as /tree/main or /issues are common; only the first
    // two path segments name the repository.
    raw = urlMatch[1] || '';
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw invalidRef('Only github.com references are accepted');
  }

  raw = raw.split('#')[0].split('?')[0];
  const segments = raw.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw invalidRef('Use the form owner/repository (or a github.com URL) for the repository');
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  assertSafeSegment(owner, 'owner');
  assertSafeSegment(repo, 'repository name');
  if (!OWNER_RE.test(owner)) {
    throw invalidRef('The owner must be 1-39 letters, numbers or hyphens, without a leading or trailing hyphen');
  }
  if (!REPO_RE.test(repo)) {
    throw invalidRef('The repository name may only contain letters, numbers, dots, underscores and hyphens (up to 100 characters)');
  }

  const fullName = `${owner}/${repo}`;
  assertRepoAllowed(fullName);
  return { owner, repo, fullName };
}

/**
 * Every GitHub request must stay inside /repos/<owner>/<repo>. Building the URL
 * through the WHATWG parser and checking the normalized path catches encoded
 * or relative traversal before any network call is made.
 */
function apiUrl(path) {
  let url;
  try {
    url = new URL(path, API);
  } catch {
    throw new AppError(500, 'github_error', 'Invalid GitHub API path');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    url.origin !== API ||
    segments[0] !== 'repos' ||
    segments.length < 3 ||
    !OWNER_RE.test(segments[1]) ||
    !REPO_RE.test(segments[2])
  ) {
    throw new AppError(500, 'github_error', 'Refusing to call a GitHub API path outside a repository');
  }
  return url;
}

async function ghFetch(path, { accept = 'application/vnd.github+json', cache = null, cacheKey = null } = {}) {
  const url = apiUrl(path);
  const headers = {
    accept,
    'user-agent': 'threadline-handover',
    'x-github-api-version': '2022-11-28',
  };
  if (env.githubToken) headers.authorization = `Bearer ${env.githubToken}`;
  // A 304 response is free and costs no quota, so an unchanged repository
  // needs no re-download.
  if (cache && cacheKey && cache[cacheKey]) headers['if-none-match'] = cache[cacheKey];

  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new AppError(502, 'github_unreachable', `Could not reach GitHub: ${error.message}`);
  }

  if (response.status === 304) return { notModified: true };

  if (!response.ok) {
    if (response.status === 404) {
      throw new AppError(
        404,
        'github_not_found',
        'Repository or resource not found, or it is private and the configured token cannot see it',
      );
    }
    if (response.status === 401) {
      throw new AppError(401, 'github_unauthorized', 'GitHub rejected the configured token');
    }
    if (response.status === 403 || response.status === 429) {
      // A 403 is only a rate limit when the quota is actually exhausted or the
      // body says so; otherwise it is a permission or SSO problem and telling
      // the user "rate limit" hides the real cause.
      const remaining = response.headers.get('x-ratelimit-remaining');
      const resetAt = Number(response.headers.get('x-ratelimit-reset'));
      const retryAfter = Number(response.headers.get('retry-after'));
      let body = '';
      try {
        body = (await response.text()).slice(0, 1_000);
      } catch {
        body = '';
      }
      const rateLimited =
        response.status === 429 || remaining === '0' || /rate limit|secondary rate/i.test(body);

      if (rateLimited) {
        const error = new AppError(
          429,
          'github_rate_limited',
          `GitHub rate limit reached${remaining === '0' ? ' (quota exhausted)' : ''}. Configure GITHUB_TOKEN for higher limits.`,
        );
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1_000
            : Number.isFinite(resetAt) && resetAt > 0
              ? resetAt * 1_000 - Date.now()
              : 0;
        if (waitMs > 0) error.retryAt = new Date(Date.now() + waitMs);
        throw error;
      }

      if (/saml|sso/i.test(body)) {
        throw new AppError(
          403,
          'github_sso_required',
          'The configured token is not authorized for this organization’s SSO policy. Authorize it and try again.',
        );
      }
      throw new AppError(
        403,
        'github_forbidden',
        'GitHub refused access. The token may lack permission for this repository.',
      );
    }
    throw new AppError(502, 'github_error', `GitHub API returned ${response.status}`);
  }

  if (cache && cacheKey) {
    const etag = response.headers.get('etag');
    if (etag) cache[cacheKey] = etag;
  }
  return response;
}

async function fetchPaged(path, { max, perPage = 100, cache = null, cacheKey = null }) {
  const items = [];
  for (let page = 1; items.length < max; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await ghFetch(`${path}${separator}per_page=${perPage}&page=${page}`, {
      cache,
      cacheKey: page === 1 ? cacheKey : null,
    });
    if (response.notModified) return { notModified: true, items: [] };
    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < perPage) break;
  }
  return { notModified: false, items: items.slice(0, max) };
}

function doc({ kind, title, rawText, author, occurredAt, url, meta = {}, warnings = [] }) {
  const fullText = String(rawText ?? '').replace(/\r\n?/g, '\n');
  const truncated = fullText.length > MAX_DOC_CHARS;
  const text = truncate(fullText, MAX_DOC_CHARS);
  const parseWarnings = [...warnings];
  if (truncated) {
    parseWarnings.push(
      `Truncated from ${fullText.length.toLocaleString('en-US')} to ${MAX_DOC_CHARS.toLocaleString('en-US')} characters`,
    );
  }
  return {
    kind,
    title,
    path: title,
    mime: 'text/markdown',
    author: author || null,
    occurredAt: occurredAt ? new Date(occurredAt) : null,
    locator: { url },
    rawText: text,
    size: text.length,
    parseWarnings,
    meta,
  };
}

function attachWarning(documents, warning) {
  if (documents.length === 0) return;
  documents[0].parseWarnings = [...(documents[0].parseWarnings || []), warning];
}

async function collectIssues(fullName, { cache } = {}) {
  const page = await fetchPaged(
    `/repos/${fullName}/issues?state=all&sort=updated&direction=desc`,
    { max: MAX_ISSUES, cache, cacheKey: 'issues' },
  );
  if (page.notModified) return { notModified: true, documents: [] };

  const issues = page.items.filter((item) => !item.pull_request).slice(0, MAX_ISSUES);
  const docs = [];
  let threadsFetched = 0;

  for (const issue of issues) {
    const labels = (issue.labels || []).map((label) => label.name).join(', ');
    // Only text the author actually wrote goes into the document. The old
    // connector wrote a synthetic "Task: <title>" line, so a "verbatim" quote
    // could point at a sentence no human ever wrote.
    const lines = [
      `# Issue #${issue.number}: ${issue.title}`,
      `State: ${issue.state}`,
      `Author: ${issue.user?.login || 'unknown'}`,
      `Created: ${(issue.created_at || '').slice(0, 10)}`,
      `Labels: ${labels || 'none'}`,
      `URL: ${issue.html_url}`,
      '',
      'Body:',
      truncate(issue.body || '(no description provided)', 8_000),
    ];

    let comments = [];
    if (issue.comments > 0 && threadsFetched < MAX_ISSUE_THREADS) {
      threadsFetched += 1;
      try {
        const commentResponse = await ghFetch(
          `/repos/${fullName}/issues/${issue.number}/comments?per_page=20`,
        );
        comments = await commentResponse.json();
      } catch (error) {
        if (error.status === 429) throw error;
      }
    }
    if (comments.length > 0) {
      lines.push('', 'Discussion:');
      for (const comment of comments.slice(0, 20)) {
        lines.push(
          `- ${comment.user?.login || 'unknown'} (${(comment.created_at || '').slice(0, 10)}): ${truncate(
            String(comment.body || '').replace(/\s+/g, ' '),
            700,
          )}`,
        );
      }
    }

    // The title, state, assignee and labels come from the provider's API.
    // Extraction records them as metadata evidence: the quote is the real
    // title, and the claim is labelled connector_metadata.
    const risk = /blocker|risk|incident/i.test(labels);
    const connectorItem = {
      type: risk ? 'risk' : 'task',
      statement: issue.title,
      status: issue.state === 'closed' ? (risk ? 'resolved' : 'done') : 'open',
      owner: issue.assignee?.login || null,
      quote: issue.title,
      confidence: 0.9,
      metadataEvidence: true,
    };

    docs.push(
      doc({
        kind: 'github_issue',
        title: `Issue #${issue.number}: ${issue.title}`,
        rawText: lines.join('\n'),
        author: issue.user?.login,
        occurredAt: issue.created_at,
        url: issue.html_url,
        meta: { number: issue.number, state: issue.state, connectorItems: [connectorItem] },
      }),
    );
  }

  return { notModified: false, documents: docs };
}

async function collectPullRequests(fullName, { cache } = {}) {
  const page = await fetchPaged(`/repos/${fullName}/pulls?state=all&sort=updated&direction=desc`, {
    max: MAX_PULLS,
    cache,
    cacheKey: 'pulls',
  });
  if (page.notModified) return { notModified: true, documents: [] };

  const pulls = page.items.slice(0, MAX_PULLS);
  return {
    notModified: false,
    documents: pulls.map((pull) => {
      const status = pull.merged_at ? 'done' : pull.state === 'closed' ? 'resolved' : 'open';
      const lines = [
        `# Pull request #${pull.number}: ${pull.title}`,
        `State: ${pull.state}${pull.merged_at ? ' (merged)' : ''}`,
        `Author: ${pull.user?.login || 'unknown'}`,
        `Created: ${(pull.created_at || '').slice(0, 10)}`,
        `URL: ${pull.html_url}`,
        '',
        'Body:',
        truncate(pull.body || '(no description provided)', 6_000),
      ];
      const connectorItem = {
        type: 'task',
        statement: pull.title,
        status,
        owner: pull.user?.login || null,
        quote: pull.title,
        confidence: 0.9,
        metadataEvidence: true,
      };
      return doc({
        kind: 'github_pr',
        title: `PR #${pull.number}: ${pull.title}`,
        rawText: lines.join('\n'),
        author: pull.user?.login,
        occurredAt: pull.created_at,
        url: pull.html_url,
        meta: {
          number: pull.number,
          merged: Boolean(pull.merged_at),
          connectorItems: [connectorItem],
        },
      });
    }),
  };
}

async function collectCommits(fullName, { cache } = {}) {
  const response = await ghFetch(`/repos/${fullName}/commits?per_page=30`, {
    cache,
    cacheKey: 'commits',
  });
  if (response.notModified) return { notModified: true, document: null };
  const commits = await response.json();
  if (!Array.isArray(commits) || commits.length === 0) return { notModified: false, document: null };

  const lines = ['# Recent commits', ''];
  for (const entry of commits) {
    const message = String(entry.commit?.message || '').split('\n')[0];
    lines.push(
      `- ${(entry.sha || '').slice(0, 7)} ${(entry.commit?.author?.date || '').slice(0, 10)} ${
        entry.author?.login || entry.commit?.author?.name || 'unknown'
      }: ${truncate(message, 200)}`,
    );
  }
  return {
    notModified: false,
    document: doc({
      kind: 'github_commits',
      title: 'Recent commits',
      rawText: lines.join('\n'),
      occurredAt: commits[0]?.commit?.author?.date,
      url: `https://github.com/${fullName}/commits`,
      warnings:
        commits.length >= 30 ? ['Only the latest 30 commits were ingested'] : [],
    }),
  };
}

/**
 * Collects the repository's documents. Pass `cache` (the source's
 * sync.cursor.httpCache) to enable conditional requests and `loadPrevious`
 * to reuse stored documents for sections GitHub answered 304 for.
 */
export async function collectGithubDocuments(ref, { cache = null, loadPrevious = null } = {}) {
  const { fullName } = parseRepoRef(ref);

  let repo;
  const repoResponse = await ghFetch(`/repos/${fullName}`, { cache, cacheKey: 'repo' });
  if (repoResponse.notModified) {
    repo = cache?.repoMeta;
    if (!repo) {
      const fresh = await ghFetch(`/repos/${fullName}`);
      repo = await fresh.json();
    }
  } else {
    repo = await repoResponse.json();
    if (cache) cache.repoMeta = { pushed_at: repo.pushed_at, html_url: repo.html_url };
  }

  const documents = [];
  const previous = async (kinds) => (loadPrevious ? loadPrevious(kinds) : []);

  try {
    const readmeResponse = await ghFetch(`/repos/${fullName}/readme`, {
      accept: 'application/vnd.github.raw',
      cache,
      cacheKey: 'readme',
    });
    if (readmeResponse.notModified) {
      documents.push(...(await previous(['github_readme'])));
    } else {
      const readme = await readmeResponse.text();
      if (readme.trim()) {
        documents.push(
          doc({
            kind: 'github_readme',
            title: `README (${fullName})`,
            rawText: readme,
            occurredAt: repo.pushed_at,
            url: `${repo.html_url}#readme`,
          }),
        );
      }
    }
  } catch (error) {
    if (error.status === 429) throw error;
  }

  const issues = await collectIssues(fullName, { cache });
  if (issues.notModified) {
    documents.push(...(await previous(['github_issue'])));
  } else {
    documents.push(...issues.documents);
    if (issues.documents.length >= MAX_ISSUES) {
      attachWarning(documents, `Only the ${MAX_ISSUES} most recently updated issues were ingested`);
    }
  }

  try {
    const pulls = await collectPullRequests(fullName, { cache });
    if (pulls.notModified) {
      documents.push(...(await previous(['github_pr'])));
    } else {
      if (pulls.documents.length >= MAX_PULLS) {
        attachWarning(
          pulls.documents,
          `Only the ${MAX_PULLS} most recently updated pull requests were ingested`,
        );
      }
      documents.push(...pulls.documents);
    }
  } catch (error) {
    if (error.status === 429) throw error;
  }

  try {
    const commits = await collectCommits(fullName, { cache });
    if (commits.notModified) {
      documents.push(...(await previous(['github_commits'])));
    } else if (commits.document) {
      documents.push(commits.document);
    }
  } catch (error) {
    if (error.status === 429) throw error;
  }

  return documents;
}
