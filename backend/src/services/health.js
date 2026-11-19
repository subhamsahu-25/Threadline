import mongoose from 'mongoose';

// Health is polled by platform probes and by the app while it is cold-starting,
// so the answer is cached briefly instead of probing the database per request.
const CACHE_MS = 5_000;

let snapshot = { at: 0, value: null };

export function databaseUp() {
  return mongoose.connection.readyState === 1;
}

export async function healthSnapshot({ probe = databaseUp, now = Date.now() } = {}) {
  if (snapshot.value && now - snapshot.at < CACHE_MS) return snapshot.value;
  const up = await probe();
  // Only liveness is public. Version, clock, database state, demo switches and
  // extraction mode are configuration and stay off an anonymous endpoint.
  snapshot = { at: now, value: Object.freeze({ status: up ? 'ok' : 'degraded' }) };
  return snapshot.value;
}

export function resetHealthCache() {
  snapshot = { at: 0, value: null };
}
