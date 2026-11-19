import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session, User } from '../src/models/index.js';
import { app, auth, request, seed, startDb, stopDb, tokenOf } from './helpers.js';

const LEAD = 'subham@threadline.demo';

describe('N22 session bookkeeping', () => {
  let seeded;
  let leadToken;

  beforeEach(async () => {
    await startDb();
    seeded = await seed();
    leadToken = tokenOf(seeded, LEAD);
  });

  afterAll(async () => {
    await stopDb();
  });

  it('validates a session from cache after the first request', async () => {
    await request(app).get('/api/auth/me').set(auth(leadToken)).expect(200);

    const userFind = vi.spyOn(User, 'findById');
    const sessionFind = vi.spyOn(Session, 'findOne');
    try {
      await request(app).get('/api/auth/me').set(auth(leadToken)).expect(200);
      expect(userFind).not.toHaveBeenCalled();
      expect(sessionFind).not.toHaveBeenCalled();
    } finally {
      userFind.mockRestore();
      sessionFind.mockRestore();
    }
  });

  it('writes lastSeenAt at most once per minute', async () => {
    await request(app).get('/api/auth/me').set(auth(leadToken)).expect(200);

    // Age the stored timestamp past the window and drop the in-process copy of
    // it; the next request must persist a new one.
    const stored = await Session.findOne({ user: seeded.users.find((u) => u.email === LEAD).id }).lean();
    await Session.collection.updateOne(
      { _id: stored._id },
      { $set: { lastSeenAt: new Date(Date.now() - 120_000) } },
    );
    const { clearSessionCache } = await import('../src/lib/sessionCache.js');
    clearSessionCache();

    const update = vi.spyOn(Session, 'updateOne');
    try {
      await request(app).get('/api/auth/me').set(auth(leadToken)).expect(200);
      expect(update).toHaveBeenCalledTimes(1);
      const fresh = await Session.findById(stored._id).lean();
      expect(new Date(fresh.lastSeenAt).getTime()).toBeGreaterThan(Date.now() - 5_000);

      await request(app).get('/api/auth/me').set(auth(leadToken)).expect(200);
      await request(app).get('/api/auth/me').set(auth(leadToken)).expect(200);
      const lastSeenWrites = update.mock.calls.filter(
        (call) => call[1]?.$set && 'lastSeenAt' in call[1].$set,
      );
      expect(lastSeenWrites).toHaveLength(1);
    } finally {
      update.mockRestore();
    }
  });

  it('lists devices, marks the current one and revokes another on request', async () => {
    const second = await request(app)
      .post('/api/demo/session')
      .send({ email: LEAD })
      .expect(200);

    const list = await request(app)
      .get('/api/auth/sessions')
      .set(auth(leadToken))
      .expect(200);
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(list.body.sessions.every((session) => session.jti === undefined)).toBe(true);
    expect(list.body.sessions.filter((session) => session.current)).toHaveLength(1);

    // Use the other device once so its session is in the middleware cache; the
    // revoke must still take effect immediately.
    await request(app).get('/api/auth/me').set(auth(second.body.token)).expect(200);
    const other = list.body.sessions.find((session) => !session.current);

    await request(app)
      .delete(`/api/auth/sessions/${other.id}`)
      .set(auth(leadToken))
      .expect(200);

    await request(app).get('/api/auth/me').set(auth(second.body.token)).expect(401);
    const after = await request(app)
      .get('/api/auth/sessions')
      .set(auth(leadToken))
      .expect(200);
    expect(after.body.sessions.some((session) => session.id === other.id)).toBe(false);
  });
});
