import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { Job, Source } from '../models/index.js';

const state = {
  handler: null,
  pending: [],
  active: 0,
  delayed: 0,
  concurrency: 1,
  maxAttempts: 2,
  jobTimeoutMs: 0,
  idleWaiters: [],
  keys: new Set(),
  timers: new Set(),
};

export function setJobHandler(handler) {
  state.handler = handler;
}

export function configureQueue({
  concurrency = 1,
  maxAttempts = 2,
  jobTimeoutMs = 0,
} = {}) {
  state.concurrency = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1;
  state.maxAttempts = maxAttempts;
  state.jobTimeoutMs =
    Number.isFinite(jobTimeoutMs) && jobTimeoutMs > 0 ? jobTimeoutMs : 0;
}

class JobTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobTimeoutError';
    this.code = 'job_timeout';
  }
}

function jobKey(name, payload) {
  return payload?.sourceId ? `${name}:${payload.sourceId}` : `${name}:${randomUUID()}`;
}

function durableWritesEnabled() {
  return mongoose.connection.readyState === 1;
}

function persistJob(job) {
  if (!durableWritesEnabled()) return;
  Job.updateOne(
    { _id: job.id },
    {
      $setOnInsert: {
        name: job.name,
        key: job.key,
        payload: job.payload,
        status: 'queued',
        attempts: 0,
        maxAttempts: state.maxAttempts,
        availableAt: new Date(job.enqueuedAt),
      },
    },
    { upsert: true },
  ).catch((error) => {
    logger.warn({ job: job.name, error: error.message }, 'Could not persist a queued job');
  });
}

// Status writes are awaited by the worker: whenIdle() must mean the durable
// row has settled too, otherwise a job that just finished still looks
// "running" to the next reader.
function persistStatus(job, fields) {
  if (!durableWritesEnabled()) return Promise.resolve();
  return Job.updateOne({ _id: job.id }, { $set: fields }).catch((error) => {
    logger.warn({ job: job.name, error: error.message }, 'Could not update a queued job');
  });
}

/**
 * Jobs are de-duplicated by name and source id: a scheduler tick, a manual
 * "sync now" and a retry can all ask for the same source without stacking
 * duplicate work or spending the provider quota several times over.
 */
export function enqueue(name, payload, { key, id } = {}) {
  const jobKeyValue = key || jobKey(name, payload);
  if (state.keys.has(jobKeyValue)) return null;
  state.keys.add(jobKeyValue);

  const job = {
    // Recovery passes the durable row id so the original record is reused and
    // deleted on completion instead of leaving a permanent queued ghost.
    id: id || randomUUID(),
    name,
    key: jobKeyValue,
    payload,
    attempts: 0,
    enqueuedAt: Date.now(),
  };
  state.pending.push(job);
  persistJob(job);
  setImmediate(() => pump());
  return job.id;
}

function releaseKey(job) {
  if (job.key) state.keys.delete(job.key);
}

function notifyIdle() {
  if (state.pending.length === 0 && state.active === 0 && state.delayed === 0) {
    const waiters = state.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

const LEASE_MS = 120_000;

function startLeaseRenewal(job) {
  if (!durableWritesEnabled()) return null;
  const timer = setInterval(() => {
    persistStatus(job, { leaseUntil: new Date(Date.now() + LEASE_MS) });
  }, 30_000);
  timer.unref?.();
  state.timers.add(timer);
  return timer;
}

function withDeadline(promise, job) {
  if (!state.jobTimeoutMs) return promise;
  let timer;
  const limit =
    state.jobTimeoutMs >= 1000
      ? `${Math.round(state.jobTimeoutMs / 1000)}s`
      : `${Math.round(state.jobTimeoutMs)}ms`;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new JobTimeoutError(`Job ${job.name} exceeded its ${limit} deadline`));
    }, state.jobTimeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function failSourceAfterTimeout(job, message) {
  const sourceId = job.payload?.sourceId;
  if (!sourceId || !durableWritesEnabled()) return;
  try {
    await Source.updateOne(
      { _id: sourceId, deletedAt: null },
      {
        $set: {
          status: 'failed',
          statusMessage: `Background work timed out (${message}). Retry from this source.`,
        },
      },
    );
  } catch (error) {
    logger.warn(
      { job: job.name, sourceId: String(sourceId), error: error.message },
      'Could not mark a timed-out source as failed',
    );
  }
}

async function runJob(job) {
  if (!state.handler) {
    logger.error({ job: job.name }, 'No job handler configured');
    releaseKey(job);
    return;
  }
  state.active += 1;
  job.attempts += 1;
  await persistStatus(job, { status: 'running', attempts: job.attempts, leaseUntil: new Date(Date.now() + LEASE_MS) });
  const leaseTimer = startLeaseRenewal(job);
  try {
    // A handler that never settles must not hold a worker forever. The process
    // cannot cancel the abandoned promise, but the slot, key and source state
    // are released so the queue keeps moving.
    await withDeadline(Promise.resolve(state.handler(job)), job);
    logger.info({ job: job.name, id: job.id }, 'Job completed');
    if (durableWritesEnabled()) {
      await Job.deleteOne({ _id: job.id }).catch((error) => {
        logger.warn({ job: job.name, error: error.message }, 'Could not clear a finished job');
      });
    }
    releaseKey(job);
  } catch (error) {
    logger.warn(
      { job: job.name, id: job.id, attempt: job.attempts, error: error.message },
      'Job failed',
    );
    if (error?.code === 'job_timeout') {
      // A retry would hang for the same reason; fail it and free the source.
      await persistStatus(job, { status: 'failed', lastError: error.message, leaseUntil: null });
      releaseKey(job);
      await failSourceAfterTimeout(job, error.message);
    } else if (job.attempts < state.maxAttempts) {
      state.delayed += 1;
      persistStatus(job, {
        status: 'queued',
        lastError: error.message,
        availableAt: new Date(Date.now() + 400 * job.attempts),
        leaseUntil: null,
      });
      const timer = setTimeout(() => {
        state.timers.delete(timer);
        state.delayed -= 1;
        state.pending.push(job);
        pump();
      }, 400 * job.attempts);
      timer.unref?.();
      state.timers.add(timer);
    } else {
      await persistStatus(job, { status: 'failed', lastError: error.message, leaseUntil: null });
      releaseKey(job);
    }
  } finally {
    if (leaseTimer) {
      clearInterval(leaseTimer);
      state.timers.delete(leaseTimer);
    }
    state.active -= 1;
    notifyIdle();
    pump();
  }
}

export function pump() {
  if (!state.handler) return;
  while (state.active < state.concurrency && state.pending.length > 0) {
    const job = state.pending.shift();
    runJob(job);
  }
  notifyIdle();
}

export function pendingJobs() {
  // A job waiting for its retry timer is still pending work; reporting zero
  // made whenIdle() resolve between attempts and let tests inspect a
  // half-finished source.
  return state.pending.length + state.active + state.delayed;
}

export function whenIdle({ timeoutMs = 30_000 } = {}) {
  if (pendingJobs() === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for background jobs to finish'));
    }, timeoutMs);
    state.idleWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Re-enqueues jobs that were abandoned by the previous process. Only rows
 * whose lease has expired are recovered: a fresh queued row or a job another
 * worker is still running is left alone. The durable row id is reused, so a
 * completed recovery deletes the record it came from instead of leaving a
 * ghost that every later restart runs again.
 */
export async function recoverDurableJobs() {
  if (!durableWritesEnabled()) return 0;
  const now = new Date();
  const stuck = await Job.find({
    $or: [
      { status: 'queued', $or: [{ availableAt: { $lte: now } }, { availableAt: null }] },
      { status: 'running', $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: null }] },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();
  if (stuck.length === 0) return 0;

  // Work for a deleted source would run against nothing; drop those rows.
  const sourceIds = [...new Set(stuck.map((row) => row.payload?.sourceId).filter(Boolean))];
  const live = sourceIds.length
    ? await Source.find({ _id: { $in: sourceIds } }).select('_id').lean()
    : [];
  const alive = new Set(live.map((source) => String(source._id)));
  const orphaned = stuck.filter(
    (row) => row.payload?.sourceId && !alive.has(String(row.payload.sourceId)),
  );
  if (orphaned.length > 0) {
    await Job.deleteMany({ _id: { $in: orphaned.map((row) => row._id) } });
  }

  let recovered = 0;
  for (const row of stuck) {
    if (orphaned.some((entry) => entry._id === row._id)) continue;
    await Job.updateOne(
      { _id: row._id },
      { $set: { status: 'queued', leaseUntil: null, availableAt: new Date() } },
    );
    if (enqueue(row.name, row.payload, { key: row.key, id: row._id })) recovered += 1;
  }
  return recovered;
}

export function configureQueueFromEnv() {
  configureQueue({
    concurrency: env.ingestConcurrency,
    maxAttempts: 2,
    jobTimeoutMs: env.ingestJobTimeoutMs,
  });
}

/** Waits for in-flight work so SIGTERM does not abandon a half-written run. */
export async function drainQueue({ timeoutMs = 8_000 } = {}) {
  await whenIdle({ timeoutMs }).catch(() => {});
}

export function resetQueueForTests() {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  state.pending.length = 0;
  state.active = 0;
  state.delayed = 0;
  state.idleWaiters.length = 0;
  state.keys.clear();
}
