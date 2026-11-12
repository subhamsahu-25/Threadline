import { env } from '../../config/env.js';

export function llmStatus() {
  return { enabled: Boolean(env.geminiApiKey), model: env.geminiModel };
}

export async function generateJson({ system, prompt, schema, temperature = 0.1, maxOutputTokens = 2048 }) {
  if (!env.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    env.geminiModel,
  )}:generateContent?key=${env.geminiApiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Gemini request failed (${response.status}): ${body.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join('');

  if (!text) throw new Error('Gemini returned no content');
  return JSON.parse(text);
}
