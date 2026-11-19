import { describe, expect, it } from 'vitest';
import {
  archiveEntryNames,
  disallowedTrackedPaths,
  trackedPaths,
} from '../../scripts/build-archive.mjs';

describe('release archive hygiene', () => {
  it('flags environment files, dependencies, storage and build output', () => {
    const flagged = disallowedTrackedPaths([
      'backend/.env',
      'backend/.env.production',
      'backend/.env.example',
      'frontend/node_modules/react/index.js',
      'backend/storage/upload.pdf',
      'frontend/dist/index.html',
      '.qoder-office-docx-locks/state.json',
      'backend/src/app.js',
    ]);
    expect(flagged).toEqual([
      'backend/.env',
      'backend/.env.production',
      'frontend/node_modules/react/index.js',
      'backend/storage/upload.pdf',
      'frontend/dist/index.html',
      '.qoder-office-docx-locks/state.json',
    ]);
  });

  it('never tracks a real environment file', () => {
    expect(disallowedTrackedPaths()).toEqual([]);
  });

  it('builds the archive from tracked files only', () => {
    const archive = archiveEntryNames();
    const tracked = new Set(trackedPaths());
    expect(archive.length).toBeGreaterThan(100);
    expect(disallowedTrackedPaths(archive)).toEqual([]);
    for (const entry of archive) {
      expect(tracked.has(entry)).toBe(true);
    }
  });
});
