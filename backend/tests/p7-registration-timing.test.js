import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { whenVerificationMailIdle } from '../src/services/verification.js';
import { app, request, startDb, stopDb } from './helpers.js';

const PASSWORD = 'Threadline#2026';

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function register(email) {
  return request(app)
    .post('/api/auth/register')
    .send({ name: 'Timing Person', email, password: PASSWORD });
}

describe('registration answers new and known addresses on one clock', () => {
  const original = {
    min: env.registrationMinMs,
    provider: env.mailProvider,
    apiBase: env.mailApiBase,
    key: env.resendApiKey,
  };

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  afterEach(() => {
    env.registrationMinMs = original.min;
    env.mailProvider = original.provider;
    env.mailApiBase = original.apiBase;
    env.resendApiKey = original.key;
  });

  it('spends the same time on a new and an already registered address', async () => {
    env.registrationMinMs = 400;

    const firstStarted = Date.now();
    const first = await register('timing-new@example.test');
    const firstMs = Date.now() - firstStarted;
    expect(first.status).toBe(201);

    const secondStarted = Date.now();
    const second = await register('timing-new@example.test');
    const secondMs = Date.now() - secondStarted;
    expect(second.status).toBe(201);
    expect(second.body.registered).toBe(true);

    // Both paths honour the floor, so the insert is not observable as speed.
    expect(firstMs).toBeGreaterThanOrEqual(380);
    expect(secondMs).toBeGreaterThanOrEqual(380);
    expect(Math.abs(firstMs - secondMs)).toBeLessThan(250);
  });

  it('returns without waiting for a slow mail provider', async () => {
    env.registrationMinMs = 100;
    const provider = await listen(async (_req, res) => {
      await readBody(_req);
      await new Promise((resolve) => setTimeout(resolve, 400));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg"}');
    });
    env.mailProvider = 'resend';
    env.mailApiBase = provider.base;
    env.resendApiKey = 'test-key';

    try {
      const started = Date.now();
      const response = await register('timing-mail@example.test');
      const elapsed = Date.now() - started;
      expect(response.status).toBe(201);
      expect(response.body.mailConfigured).toBe(true);
      // The provider is still sleeping 400 ms when this response lands.
      expect(elapsed).toBeLessThan(350);
      await whenVerificationMailIdle();
    } finally {
      await provider.close();
    }
  });
});
