import { createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { Source } from '../../models/index.js';
import { enqueue } from '../queue.js';

const SYNCABLE_KINDS = ['github', 'drive'];
// Connector checks spend the deployment's shared provider quota, so the
// default is deliberately rare; a project lead can opt into a shorter interval.
export const DEFAULT_INTERVAL_MINUTES = 15;

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
  if (source.sync.nextAttemptAt && new Date(source.sync.nextAttemptAt) > now) return false;
  const intervalMinutes = Math.max(1, source.sync.intervalMinutes || DEFAULT_INTERVAL_MINUTES);
  const last = source.sync.lastCheckedAt ? new Date(source.sync.lastCheckedAt).getTime() : 0;
  return now.getTime() - last >= intervalMinutes * 60_000;
}

/**
 * Enqueues a sync for every connected source whose interval has elapsed. The
 * attempt is reserved atomically so two scheduler ticks (or two processes)
 * cannot both enqueue the same source.
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
  const enqueued = [];
  for (const source of due) {
    const intervalMinutes = Math.max(1, source.sync.intervalMinutes || DEFAULT_INTERVAL_MINUTES);
    const reserved = await Source.findOneAndUpdate(
      {
        _id: source._id,
        deletedAt: null,
        $or: [
          { 'sync.nextAttemptAt': { $exists: false } },
          { 'sync.nextAttemptAt': { $lte: now } },
        ],
      },
      { $set: { 'sync.nextAttemptAt': new Date(now.getTime() + intervalMinutes * 60_000) } },
      { new: false },
    );
    if (!reserved) continue;
    if (enqueue('sync_source', { sourceId: String(source._id) })) {
      enqueued.push(String(source._id));
    }
  }
  return enqueued;
}

/** Pushes the next check out after a provider rate limit or outage. */
export async function deferSync(sourceId, { retryAt, error } = {}) {
  const nextAttemptAt =
    retryAt instanceof Date && retryAt.getTime() > Date.now()
      ? retryAt
      : new Date(Date.now() + DEFAULT_INTERVAL_MINUTES * 60_000);
  await Source.updateOne(
    { _id: sourceId },
    {
      $set: {
        'sync.nextAttemptAt': nextAttemptAt,
        ...(error ? { 'sync.lastError': String(error).slice(0, 300) } : {}),
      },
    },
  ).catch(() => {});
}

export function startSyncScheduler({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    runDueSyncs().catch((error) => {
      logger.warn({ err: error }, 'Source sync scan failed');
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
