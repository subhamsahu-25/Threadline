import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Job } from '../src/models/index.js';
import {
  enqueue,
  resetQueueForTests,
  setJobHandler,
  whenIdle,
} from '../src/services/queue.js';
import { startDb, stopDb } from './helpers.js';

/**
 * A very short job is the dangerous case: the handler can finish before the
 * queued row has been inserted. If the delete runs first, the insert lands
 * afterwards and a restart reruns a job that already completed.
 */
describe('P4 a completed job never leaves a queued row', () => {
  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetQueueForTests();
  });

  it('deletes the row even when the insert is slow and the handler is instant', async () => {
    const real = Job.updateOne.bind(Job);
    vi.spyOn(Job, 'updateOne').mockImplementation((filter, update, options) => {
      if (update?.$setOnInsert) {
        // The insert arrives a quarter second late, long after the handler.
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            real(filter, update, options).then(resolve, reject);
          }, 250);
        });
      }
      return real(filter, update, options);
    });

    setJobHandler(async () => {
      // Nothing to do: a freshness check that finds no change.
    });

    enqueue('sync_check', {}, { key: 'p4:sync-check' });
    await whenIdle({ timeoutMs: 5_000 });
    // Give a badly ordered insert time to land after the delete.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await Job.countDocuments({})).toBe(0);
  });

  it('keeps ordering when several instant jobs are enqueued together', async () => {
    setJobHandler(async () => {});
    for (let index = 0; index < 5; index += 1) {
      enqueue('sync_check', {}, { key: `p4:batch:${index}` });
    }
    await whenIdle({ timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await Job.countDocuments({})).toBe(0);
  });
});
