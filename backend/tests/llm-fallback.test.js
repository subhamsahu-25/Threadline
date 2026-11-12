import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { generateJson } from '../src/services/ai/llm.js';

const args = { system: 'system', prompt: 'prompt', schema: { type: 'OBJECT' } };

function reply(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  env.geminiApiKey = '';
  env.geminiModel = 'gemini-3.8-flash';
  env.geminiFallbackModel = 'gemini-3.5-flash-lite';
});

describe('Gemini model fallback', () => {
  it('retries the fallback model when the primary is unavailable', async () => {
    env.geminiApiKey = 'test-key';
    env.geminiModel = 'primary-model';
    env.geminiFallbackModel = 'fallback-model';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(503, { error: { message: 'high demand' } }))
      .mockResolvedValueOnce(
        reply(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateJson(args)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('primary-model');
    expect(fetchMock.mock.calls[1][0]).toContain('fallback-model');
  });

  it('retries on a retired model (404)', async () => {
    env.geminiApiKey = 'test-key';
    env.geminiModel = 'retired-model';
    env.geminiFallbackModel = 'fallback-model';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(404, { error: { message: 'no longer available' } }))
      .mockResolvedValueOnce(
        reply(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateJson(args)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on client errors', async () => {
    env.geminiApiKey = 'test-key';
    env.geminiModel = 'primary-model';
    env.geminiFallbackModel = 'fallback-model';

    const fetchMock = vi.fn().mockResolvedValue(reply(400, { error: { message: 'bad request' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateJson(args)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
