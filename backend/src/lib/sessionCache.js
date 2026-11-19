import { env } from '../config/env.js';

/**
 * A short-lived, per-process cache of validated sessions. The middleware
 * otherwise reads the user and the session row on every authenticated request.
 * Revocation paths call forget* so a sign-out is effective immediately in the
 * process that served it; the TTL bounds how long another process could lag.
 */
const entries = new Map();
const MAX_ENTRIES = 1_000;

function nowMs() {
  return Date.now();
}

export function readSessionCache(jti) {
  if (!jti || env.sessionCacheSeconds <= 0) return null;
  const entry = entries.get(jti);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs()) {
    entries.delete(jti);
    return null;
  }
  return entry;
}

export function writeSessionCache(jti, { user, payload, lastSeenMs = nowMs() }) {
  if (!jti || env.sessionCacheSeconds <= 0) return;
  if (entries.size >= MAX_ENTRIES) {
    const cutoff = nowMs();
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= cutoff) entries.delete(key);
    }
    // Still full of live entries: drop the oldest to keep memory bounded.
    while (entries.size >= MAX_ENTRIES) {
      entries.delete(entries.keys().next().value);
    }
  }
  entries.set(jti, {
    user,
    payload,
    userId: String(user._id),
    lastSeenMs,
    expiresAtMs: nowMs() + env.sessionCacheSeconds * 1_000,
  });
}

export function touchSessionCache(jti, lastSeenMs = nowMs()) {
  const entry = entries.get(jti);
  if (entry) entry.lastSeenMs = lastSeenMs;
}

export function forgetSessionCache(jti) {
  if (jti) entries.delete(jti);
}

export function forgetUserSessionCache(userId) {
  const id = String(userId);
  for (const [key, entry] of entries) {
    if (entry.userId === id) entries.delete(key);
  }
}

export function clearSessionCache() {
  entries.clear();
}
