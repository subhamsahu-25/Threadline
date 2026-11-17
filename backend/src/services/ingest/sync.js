import { createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { Source } from '../../models/index.js';
import { enqueue } from '../queue.js';

const SYNCABLE_KINDS = ['github', 'drive'];
const DEFAULT_INTERVAL_MINUTES = 5;

/**
 * Fingerprints the collected document set, not the ingestion time. Two syncs
 * that see identical titles, dates and text produce the same checksum and no
 * re-extraction happens.
 */
export function documentsChecksum(documents) {
  const hash = createHash('sha256');
  const entries = [...documents].sort((a, b) =>
    `${a.kind}\u0000${a.title}`.localeCompare(`${b.kind}\u0000${b.title}`),
  );
  for (const document of entries) {
    hash.update(document.kind || '');
    hash.update('\u0000');
    hash.update(document.title || '');
    hash.update('\u0000');
    hash.update(document.occurredAt ? new Date(document.occurredAt).toISOString() : '');
    hash.update('\u0000');
    hash.update(String(document.rawText || ''));
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

export function isSyncable(source) {
  return Boolean(source) && SYNCABLE_KINDS.includes(source.kind) && !source.deletedAt;
}

export function syncDue(source, now = new Date()) {
  if (!isSyncable(source)) return false;
  if (!source.sync?.enabled) return false;
  if (['queued', 'processing'].includes(source.status)) return false;
  const intervalMinutes = Math.max(1, source.sync.intervalMinutes || DEFAULT_INTERVAL_MINUTES);
  const last = source.sync.lastCheckedAt ? new Date(source.sync.lastCheckedAt).getTime() : 0;
  return now.getTime() - last >= intervalMinutes * 60_000;
}

/**
 * Enqueues a sync for every connected source whose interval has elapsed. The
 * scheduler runs this every minute; each source's own interval decides whether
 * it is actually checked, so the default five-minute promise holds.
 */
export async function runDueSyncs({ now = new Date(), limit = 25 } = {}) {
  const sources = await Source.find({
    kind: { $in: SYNCABLE_KINDS },
    deletedAt: null,
    'sync.enabled': true,
  })
    .sort({ 'sync.lastCheckedAt': 1 })
    .limit(200);

  const due = sources.filter((source) => syncDue(source, now)).slice(0, limit);
  for (const source of due) {
    enqueue('sync_source', { sourceId: String(source._id) });
  }
  return due.map((source) => String(source._id));
}

export function startSyncScheduler({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    runDueSyncs().catch((error) => {
      logger.warn({ error: error.message }, 'Source sync scan failed');
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
