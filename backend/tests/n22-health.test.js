import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, request, startDb, stopDb } from './helpers.js';
import { healthSnapshot, resetHealthCache } from '../src/services/health.js';

describe('public status endpoints', () => {
  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  it('caches the health answer instead of probing on every call', async () => {
    resetHealthCache();
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return true;
    };

    const first = await healthSnapshot({ probe, now: 1_000 });
    const second = await healthSnapshot({ probe, now: 3_000 });
    expect(probes).toBe(1);
    expect(second).toBe(first);

    await healthSnapshot({ probe, now: 7_000 });
    expect(probes).toBe(2);
  });

  it('reports degraded when the probe fails', async () => {
    resetHealthCache();
    const snapshot = await healthSnapshot({ probe: async () => false, now: 10_000 });
    expect(snapshot).toEqual({ status: 'degraded' });
  });

  it('publishes liveness only', async () => {
    resetHealthCache();
    const response = await request(app).get('/api/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    for (const leaked of [
      'database',
      'extraction',
      'demoSeedEnabled',
      'demoProjectReady',
      'version',
      'time',
    ]) {
      expect(response.body).not.toHaveProperty(leaked);
    }
  });

  it('answers demo availability without exposing accounts or secrets', async () => {
    const response = await request(app).get('/api/demo/status').expect(200);

    expect(response.body).toEqual({ seedEnabled: true, ready: false, available: true });
    expect(response.body).not.toHaveProperty('users');
    expect(response.body).not.toHaveProperty('project');
  });

  it('reports the demo workspace as ready once seeded', async () => {
    await request(app).post('/api/demo/seed').expect(201);

    const response = await request(app).get('/api/demo/status').expect(200);
    expect(response.body).toEqual({ seedEnabled: true, ready: true, available: true });
  });
});
