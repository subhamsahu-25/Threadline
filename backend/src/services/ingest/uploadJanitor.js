import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { Source } from '../../models/index.js';

/**
 * Removes files in the upload directory that no source record references.
 * The age threshold keeps in-flight uploads (written but not yet saved to a
 * source) and anything from a crashed request out of the deletion path until
 * a later run.
 */
export async function removeOrphanUploads({
  olderThanHours = env.uploadOrphanHours,
  now = Date.now(),
} = {}) {
  const referenced = new Set(await Source.distinct('files.storedName'));
  let entries;
  try {
    entries = await fs.readdir(env.uploadDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { candidates: 0, removed: 0 };
    throw error;
  }

  let candidates = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || referenced.has(entry.name)) continue;
    candidates += 1;

    const fullPath = path.join(env.uploadDir, entry.name);
    try {
      const stats = await fs.stat(fullPath);
      if (now - stats.mtimeMs < olderThanHours * 3_600_000) continue;
      await fs.unlink(fullPath);
      removed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn({ file: entry.name, error: error.message }, 'Could not remove an orphan upload');
      }
    }
  }

  return { candidates, removed };
}

export function startUploadJanitor({
  intervalMs = env.uploadJanitorIntervalHours * 3_600_000,
} = {}) {
  const run = () => {
    removeOrphanUploads()
      .then(({ removed }) => {
        if (removed > 0) logger.info({ removed }, 'Removed orphan upload files');
      })
      .catch((error) => logger.warn({ error: error.message }, 'Upload janitor scan failed'));
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
