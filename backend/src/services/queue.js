import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { Job } from '../models/index.js';

const state = {
  handler: null,
  pending: [],
  active: 0,
  delayed: 0,
  concurrency: 1,
  maxAttempts: 2,
  idleWaiters: [],
  keys: new Set(),
  timers: new Set(),
};

export function setJobHandler(handler) {
  state.handler = handler;
}

export function configureQueue({ concurrency = 1, maxAttempts = 2 } = {}) {
  state.concurrency = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1;
  state.maxAttempts = maxAttempts;
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

function persistStatus(job, fields) {
  if (!durableWritesEnabled()) return;
  Job.updateOne({ _id: job.id }, { $set: fields }).catch((error) => {
    logger.warn({ job: job.name, error: error.message }, 'Could not update a queued job');
  });
}

/**
 * Jobs are de-duplicated by name and source id: a scheduler tick, a manual
 * "sync now" and a retry can all ask for the same source without stacking
 * duplicate work or spending the provider quota several times over.
 */
export function enqueue(name, payload, { key } = {}) {
  const jobKeyValue = key || jobKey(name, payload);
  if (state.keys.has(jobKeyValue)) return null;
  state.keys.add(jobKeyValue);

  const job = {
    id: randomUUID(),
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

async function runJob(job) {
  if (!state.handler) {
    logger.error({ job: job.name }, 'No job handler configured');
    releaseKey(job);
    return;
  }
  state.active += 1;
  job.attempts += 1;
  persistStatus(job, { status: 'running', attempts: job.attempts, leaseUntil: new Date(Date.now() + 120_000) });
  try {
    await state.handler(job);
    logger.info({ job: job.name, id: job.id }, 'Job completed');
    if (durableWritesEnabled()) {
      Job.deleteOne({ _id: job.id }).catch(() => {});
    }
    releaseKey(job);
  } catch (error) {
    logger.warn(
      { job: job.name, id: job.id, attempt: job.attempts, error: error.message },
      'Job failed',
    );
    if (job.attempts < state.maxAttempts) {
      state.delayed += 1;
      persistStatus(job, {
        status: 'queued',
        lastError: error.message,
        availableAt: new Date(Date.now() + 400 * job.attempts),
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
      persistStatus(job, { status: 'failed', lastError: error.message, leaseUntil: null });
      releaseKey(job);
    }
  } finally {
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
 * Re-enqueues jobs that were queued or running when the previous process
 * exited. The in-memory list is still the executor; MongoDB keeps the record
 * so a restart does not silently drop the work.
 */
export async function recoverDurableJobs() {
  if (!durableWritesEnabled()) return 0;
  const stuck = await Job.find({ status: { $in: ['queued', 'running'] } })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();
  let recovered = 0;
  for (const row of stuck) {
    if (enqueue(row.name, row.payload, { key: row.key })) recovered += 1;
  }
  return recovered;
}

export function configureQueueFromEnv() {
  configureQueue({
    concurrency: env.ingestConcurrency,
    maxAttempts: 2,
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
