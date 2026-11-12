import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { truncate } from '../../lib/text.js';

const API = 'https://api.github.com';
const MAX_DOC_CHARS = 40_000;
const MAX_ISSUES = 25;
const MAX_PULLS = 15;
const MAX_ISSUE_THREADS = 10;

export function parseRepoRef(input) {
  const raw = String(input ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const match = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    throw new AppError(
      400,
      'invalid_github_ref',
      'Use the form owner/repository (or a github.com URL) for the repository',
    );
  }
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

async function ghFetch(path, { accept = 'application/vnd.github+json' } = {}) {
  const headers = {
    accept,
    'user-agent': 'threadline-handover',
    'x-github-api-version': '2022-11-28',
  };
  if (env.githubToken) headers.authorization = `Bearer ${env.githubToken}`;

  let response;
  try {
    response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new AppError(502, 'github_unreachable', `Could not reach GitHub: ${error.message}`);
  }

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
      const remaining = response.headers.get('x-ratelimit-remaining');
      throw new AppError(
        429,
        'github_rate_limited',
        `GitHub rate limit reached${remaining === '0' ? ' (unauthenticated quota)' : ''}. Configure GITHUB_TOKEN for higher limits.`,
      );
    }
    throw new AppError(502, 'github_error', `GitHub API returned ${response.status}`);
  }
  return response;
}

function doc({ kind, title, rawText, author, occurredAt, url, meta = {} }) {
  const text = truncate(String(rawText ?? '').replace(/\r\n?/g, '\n'), MAX_DOC_CHARS);
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
    meta,
  };
}

function labelLine(prefix, text) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim();
  return cleaned ? `${prefix}: ${cleaned}` : '';
}

async function collectIssues(fullName) {
  const response = await ghFetch(
    `/repos/${fullName}/issues?state=all&per_page=${MAX_ISSUES}&sort=updated&direction=desc`,
  );
  const issues = (await response.json()).filter((item) => !item.pull_request).slice(0, MAX_ISSUES);
  const docs = [];
  let threadsFetched = 0;

  for (const issue of issues) {
    const labels = (issue.labels || []).map((label) => label.name).join(', ');
    const lines = [
      `# Issue #${issue.number}: ${issue.title}`,
      `State: ${issue.state}`,
      `Author: ${issue.user?.login || 'unknown'}`,
      `Created: ${(issue.created_at || '').slice(0, 10)}`,
      `Labels: ${labels || 'none'}`,
      `URL: ${issue.html_url}`,
      '',
      labelLine('Task', issue.title) +
        ` (status: ${issue.state === 'closed' ? 'done' : 'open'})` +
        (issue.assignee ? ` owner: ${issue.assignee.login}` : ''),
      /blocker|risk|incident/i.test(labels)
        ? labelLine('Risk', issue.title) + ` (status: ${issue.state === 'closed' ? 'resolved' : 'open'})`
        : '',
      '',
      'Body:',
      truncate(issue.body || '(no description provided)', 8_000),
    ].filter((line) => line !== '');

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

    docs.push(
      doc({
        kind: 'github_issue',
        title: `Issue #${issue.number}: ${issue.title}`,
        rawText: lines.join('\n'),
        author: issue.user?.login,
        occurredAt: issue.created_at,
        url: issue.html_url,
        meta: { number: issue.number, state: issue.state },
      }),
    );
  }

  return docs;
}

async function collectPullRequests(fullName) {
  const response = await ghFetch(
    `/repos/${fullName}/pulls?state=all&per_page=${MAX_PULLS}&sort=updated&direction=desc`,
  );
  const pulls = (await response.json()).slice(0, MAX_PULLS);
  return pulls.map((pull) => {
    const status = pull.merged_at ? 'done' : pull.state === 'closed' ? 'resolved' : 'open';
    const lines = [
      `# Pull request #${pull.number}: ${pull.title}`,
      `State: ${pull.state}${pull.merged_at ? ' (merged)' : ''}`,
      `Author: ${pull.user?.login || 'unknown'}`,
      `Created: ${(pull.created_at || '').slice(0, 10)}`,
      `URL: ${pull.html_url}`,
      '',
      labelLine('Task', `Review and merge PR #${pull.number}`) +
        ` (status: ${status}, owner: ${pull.user?.login || 'unassigned'})`,
      '',
      'Body:',
      truncate(pull.body || '(no description provided)', 6_000),
    ];
    return doc({
      kind: 'github_pr',
      title: `PR #${pull.number}: ${pull.title}`,
      rawText: lines.join('\n'),
      author: pull.user?.login,
      occurredAt: pull.created_at,
      url: pull.html_url,
      meta: { number: pull.number, merged: Boolean(pull.merged_at) },
    });
  });
}

async function collectCommits(fullName) {
  const response = await ghFetch(`/repos/${fullName}/commits?per_page=30`);
  const commits = await response.json();
  if (!Array.isArray(commits) || commits.length === 0) return null;

  const lines = ['# Recent commits', ''];
  for (const entry of commits) {
    const message = String(entry.commit?.message || '').split('\n')[0];
    lines.push(
      `- ${(entry.sha || '').slice(0, 7)} ${(entry.commit?.author?.date || '').slice(0, 10)} ${
        entry.author?.login || entry.commit?.author?.name || 'unknown'
      }: ${truncate(message, 200)}`,
    );
  }
  return doc({
    kind: 'github_commits',
    title: 'Recent commits',
    rawText: lines.join('\n'),
    occurredAt: commits[0]?.commit?.author?.date,
    url: `https://github.com/${fullName}/commits`,
  });
}

export async function collectGithubDocuments(ref) {
  const { fullName } = parseRepoRef(ref);
  const repoResponse = await ghFetch(`/repos/${fullName}`);
  const repo = await repoResponse.json();

  const documents = [];
  try {
    const readmeResponse = await ghFetch(`/repos/${fullName}/readme`, {
      accept: 'application/vnd.github.raw',
    });
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
  } catch (error) {
    if (error.status === 429) throw error;
  }

  documents.push(...(await collectIssues(fullName)));
  try {
    documents.push(...(await collectPullRequests(fullName)));
  } catch (error) {
    if (error.status === 429) throw error;
  }
  try {
    const commits = await collectCommits(fullName);
    if (commits) documents.push(commits);
  } catch (error) {
    if (error.status === 429) throw error;
  }

  return documents;
}
