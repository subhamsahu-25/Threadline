import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const FALLBACK_STATUSES = new Set([404, 429, 503]);

export function llmStatus() {
  return {
    enabled: Boolean(env.geminiApiKey),
    model: env.geminiModel,
    fallbackModel: env.geminiFallbackModel || null,
  };
}

async function requestModel(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${env.geminiApiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(
      `Gemini request failed (${response.status}) on ${model}: ${text.slice(0, 300)}`,
    );
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join('');

  if (!text) throw new Error(`Gemini returned no content from ${model}`);
  return JSON.parse(text);
}

export async function generateJson({ system, prompt, schema, temperature = 0.1, maxOutputTokens = 2048 }) {
  if (!env.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured');

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };

  try {
    return await requestModel(env.geminiModel, body);
  } catch (error) {
    const fallback = env.geminiFallbackModel;
    if (!fallback || fallback === env.geminiModel || !FALLBACK_STATUSES.has(error.status)) {
      throw error;
    }
    logger.warn(
      { model: env.geminiModel, fallbackModel: fallback, status: error.status },
      'Gemini model unavailable, retrying with the fallback model',
    );
    return requestModel(fallback, body);
  }
}
