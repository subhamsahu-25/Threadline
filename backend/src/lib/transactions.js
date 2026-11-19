import mongoose from 'mongoose';

/**
 * Runs one logical commit in a transaction when the server supports it
 * (replica set / Atlas). A standalone server applies the same work
 * sequentially, so local development and the demo remain usable. The work
 * must be safe to repeat: the fallback re-runs it after a rejected begin.
 */
export async function withOptionalTransaction(work) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => work(session));
    return true;
  } catch (error) {
    if (/Transaction numbers are only allowed|does not support transactions|replica set/i.test(error.message)) {
      await work(null);
      return false;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

/** Attaches a session to a query when one is present. */
export function useSession(query, session) {
  return session ? query.session(session) : query;
}
