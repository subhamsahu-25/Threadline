import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import {
  assertRepoAllowed,
  collectGithubDocuments,
  parseRepoRef,
} from '../src/services/ingest/github.js';
import { assertFolderAllowed, parseDriveRef } from '../src/services/ingest/googleDrive.js';

const ALLOWED = ['acme/threadline-demo'];
const ALLOWED_FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

function withAllowlist(run) {
  const previous = env.githubAllowedRepos;
  env.githubAllowedRepos = [...ALLOWED];
  try {
    return run();
  } finally {
    env.githubAllowedRepos = previous;
  }
}

describe('GitHub reference parsing', () => {
  it('accepts owner/repo and common pasted GitHub URLs', () => {
    withAllowlist(() => {
      expect(parseRepoRef('acme/threadline-demo').fullName).toBe('acme/threadline-demo');
      expect(parseRepoRef('acme/threadline-demo.git').fullName).toBe('acme/threadline-demo');
      expect(
        parseRepoRef('https://github.com/acme/threadline-demo/tree/main').fullName,
      ).toBe('acme/threadline-demo');
      expect(
        parseRepoRef('https://github.com/acme/threadline-demo/issues?q=open').fullName,
      ).toBe('acme/threadline-demo');
    });
  });

  it.each([
    ['../user'],
    ['..%2Fuser'],
    ['acme/..'],
    ['acme/threadline-demo.'],
    ['.acme/threadline-demo'],
    ['acme./threadline-demo'],
    ['https://gitlab.com/acme/threadline-demo'],
    ['acme\\threadline-demo'],
  ])('rejects traversal and malformed reference %s', (input) => {
    withAllowlist(() => {
      expect(() => parseRepoRef(input)).toThrow();
    });
  });

  it('accepts a dot-prefixed repository name but never a dot path segment', () => {
    const previous = env.githubAllowedRepos;
    env.githubAllowedRepos = ['acme/.github', 'acme/.devcontainer'];
    try {
      expect(parseRepoRef('acme/.github').fullName).toBe('acme/.github');
      expect(parseRepoRef('https://github.com/acme/.devcontainer/tree/main').fullName).toBe(
        'acme/.devcontainer',
      );
      expect(() => parseRepoRef('acme/.')).toThrow(/cannot be "\." or "\.\."/);
      expect(() => parseRepoRef('acme/..')).toThrow();
      expect(() => parseRepoRef('.acme/.github')).toThrow();
    } finally {
      env.githubAllowedRepos = previous;
    }
  });

  it('enforces GitHub length and character limits', () => {
    withAllowlist(() => {
      expect(() => parseRepoRef(`${'a'.repeat(40)}/repo`)).toThrow();
      expect(() => parseRepoRef(`acme/${'a'.repeat(101)}`)).toThrow();
      expect(() => parseRepoRef('-acme/repo')).toThrow();
      expect(() => parseRepoRef('acme/rep o')).toThrow();
    });
  });

  it('never reaches the network for a traversal reference', async () => {
    const previous = env.githubAllowedRepos;
    env.githubAllowedRepos = [...ALLOWED];
    const fetchSpy = vi.spyOn(global, 'fetch');
    try {
      await expect(collectGithubDocuments('../user')).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      env.githubAllowedRepos = previous;
    }
  });

  it('fails closed when no allowlist is configured', () => {
    const previous = env.githubAllowedRepos;
    env.githubAllowedRepos = [];
    try {
      expect(() => assertRepoAllowed('acme/threadline-demo')).toThrowError(
        /GITHUB_ALLOWED_REPOS/,
      );
      expect(() => parseRepoRef('acme/threadline-demo')).toThrowError(/GITHUB_ALLOWED_REPOS/);
    } finally {
      env.githubAllowedRepos = previous;
    }
  });
});

describe('Drive reference parsing', () => {
  const previous = env.driveAllowedFolders;

  afterEach(() => {
    env.driveAllowedFolders = previous;
  });

  it('accepts an allow-listed folder id or URL', () => {
    env.driveAllowedFolders = [ALLOWED_FOLDER];
    expect(parseDriveRef(ALLOWED_FOLDER)).toBe(ALLOWED_FOLDER);
    expect(
      parseDriveRef(`https://drive.google.com/drive/folders/${ALLOWED_FOLDER}?usp=sharing`),
    ).toBe(ALLOWED_FOLDER);
  });

  it('fails closed when no allowlist is configured', () => {
    env.driveAllowedFolders = [];
    expect(() => assertFolderAllowed(ALLOWED_FOLDER)).toThrowError(/DRIVE_ALLOWED_FOLDERS/);
  });
});
