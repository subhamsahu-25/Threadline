import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { Source } from '../../models/index.js';

// multer stores uploads as `${Date.now()}-${randomUUID()}${ext}`. Only names
// that follow that shape were written by this application; everything else in
// the directory belongs to someone else and must be left alone.
const GENERATED_UPLOAD =
  /^\d{10,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/;
const MAX_UNRECOGNIZED_ENTRIES = 25;

export function isGeneratedUploadName(name) {
  return GENERATED_UPLOAD.test(String(name || ''));
}

/**
 * Removes files in the upload directory that no source record references.
 * The age threshold keeps in-flight uploads (written but not yet saved to a
 * source) and anything from a crashed request out of the deletion path until
 * a later run.
 *
 * A misconfigured directory cannot turn this into a general-purpose cleaner:
 * files outside the generated naming pattern are never touched, and a folder
 * that looks like someone else's data stops the run instead of being swept.
 */
export async function removeOrphanUploads({
  olderThanHours = env.uploadOrphanHours,
  now = Date.now(),
  dir = env.uploadDir,
  dryRun = env.uploadJanitorDryRun,
} = {}) {
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) {
    logger.warn({ dir: resolved }, 'Refusing to run the upload janitor at a filesystem root');
    return { scanned: 0, candidates: 0, removed: 0, refused: 'filesystem_root', dryRun };
  }

  let entries;
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { scanned: 0, candidates: 0, removed: 0, refused: null, dryRun };
    }
    throw error;
  }

  const unrecognized = entries.filter(
    (entry) => !entry.isFile() || !isGeneratedUploadName(entry.name),
  );
  if (unrecognized.length > MAX_UNRECOGNIZED_ENTRIES) {
    logger.warn(
      { dir: resolved, unrecognized: unrecognized.length },
      'Refusing to run the upload janitor: the directory holds files it did not write',
    );
    return {
      scanned: entries.length,
      candidates: 0,
      removed: 0,
      refused: 'unrecognized_entries',
      dryRun,
    };
  }

  const referenced = new Set(await Source.distinct('files.storedName'));
  let candidates = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isGeneratedUploadName(entry.name) || referenced.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(resolved, entry.name);
    try {
      const stats = await fs.stat(fullPath);
      if (now - stats.mtimeMs < olderThanHours * 3_600_000) continue;
      candidates += 1;
      if (dryRun) {
        logger.info(
          { file: entry.name, dir: resolved },
          'Upload janitor would remove an orphan upload',
        );
        continue;
      }
      await fs.unlink(fullPath);
      removed += 1;
      logger.info({ file: entry.name, dir: resolved }, 'Removed an orphan upload');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn({ file: entry.name, error: error.message }, 'Could not remove an orphan upload');
      }
    }
  }

  return { scanned: entries.length, candidates, removed, refused: null, dryRun };
}

export function startUploadJanitor({
  intervalMs = env.uploadJanitorIntervalHours * 3_600_000,
} = {}) {
  const run = () => {
    removeOrphanUploads()
      .then(({ removed, refused }) => {
        if (refused) logger.warn({ refused }, 'Upload janitor skipped this run');
        else if (removed > 0) logger.info({ removed }, 'Removed orphan upload files');
      })
      .catch((error) => logger.warn({ error: error.message }, 'Upload janitor scan failed'));
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
