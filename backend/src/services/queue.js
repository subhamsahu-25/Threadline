import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

const state = {
  handler: null,
  pending: [],
  active: 0,
  concurrency: 1,
  maxAttempts: 2,
  idleWaiters: [],
};

export function setJobHandler(handler) {
  state.handler = handler;
}

export function configureQueue({ concurrency = 1, maxAttempts = 2 } = {}) {
  state.concurrency = concurrency;
  state.maxAttempts = maxAttempts;
}

export function enqueue(name, payload) {
  const job = { id: randomUUID(), name, payload, attempts: 0, enqueuedAt: Date.now() };
  state.pending.push(job);
  setImmediate(() => pump());
  return job.id;
}

function notifyIdle() {
  if (state.pending.length === 0 && state.active === 0) {
    const waiters = state.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

async function runJob(job) {
  if (!state.handler) {
    logger.error({ job: job.name }, 'No job handler configured');
    return;
  }
  state.active += 1;
  job.attempts += 1;
  try {
    await state.handler(job);
    logger.info({ job: job.name, id: job.id }, 'Job completed');
  } catch (error) {
    logger.warn(
      { job: job.name, id: job.id, attempt: job.attempts, error: error.message },
      'Job failed',
    );
    if (job.attempts < state.maxAttempts) {
      setTimeout(() => {
        state.pending.push(job);
        pump();
      }, 400 * job.attempts);
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
  return state.pending.length + state.active;
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

export function resetQueueForTests() {
  state.pending.length = 0;
  state.active = 0;
  state.idleWaiters.length = 0;
}
