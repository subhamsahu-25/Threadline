import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { Claim, Project, Source, User } from '../src/models/index.js';
import { linkSupersessions } from '../src/services/reconstruction/link.js';
import {
  BCRYPT_MAX_BYTES,
  isBreachedOnline,
  passwordProblem,
} from '../src/services/passwordPolicy.js';
import { app, request, startDb, stopDb } from './helpers.js';

const PASSWORD = 'Threadline#2026';

function register(body) {
  return request(app)
    .post('/api/auth/register')
    .send({ name: 'Grace Hopper', password: PASSWORD, ...body });
}

function sha1(value) {
  return createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();
}

function stubPwned(digest) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => ({
      ok: true,
      text: async () =>
        String(url).endsWith(digest.slice(0, 5)) ? `${digest.slice(5)}:9` : '',
    })),
  );
}

describe('N22 password policy', () => {
  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    env.breachCheckEnabled = false;
  });

  it('caps new passwords at the 72 bytes bcrypt actually reads', () => {
    const atLimit = `Aa1!${'xY7#'.repeat(17)}`;
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(72);
    expect(passwordProblem(atLimit)).toBeNull();

    const over = `${atLimit}x`;
    expect(Buffer.byteLength(over, 'utf8')).toBe(73);
    expect(passwordProblem(over)).toMatch(/72 bytes/);

    // Characters, not bytes: 76 UTF-8 bytes but only 22 code units.
    const wide = `Aa1!${'🙂'.repeat(18)}`;
    expect(wide.length).toBeLessThan(72);
    expect(Buffer.byteLength(wide, 'utf8')).toBeGreaterThan(72);
    expect(passwordProblem(wide)).toMatch(/72 bytes/);
  });

  it('sends only the five-character hash prefix and detects a hit', async () => {
    env.breachCheckEnabled = true;
    const digest = sha1(PASSWORD);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => `${digest.slice(5)}:42\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1`,
    }));

    await expect(isBreachedOnline(PASSWORD, { fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
    expect(url).not.toContain(digest.slice(5));
  });

  it('returns false for a miss and fails open when the API errors', async () => {
    env.breachCheckEnabled = true;
    await expect(
      isBreachedOnline(PASSWORD, {
        fetchImpl: async () => ({ ok: true, text: async () => 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1' }),
      }),
    ).resolves.toBe(false);

    await expect(
      isBreachedOnline(PASSWORD, {
        fetchImpl: async () => {
          throw new Error('network down');
        },
      }),
    ).resolves.toBe(false);

    await expect(
      isBreachedOnline(PASSWORD, {
        fetchImpl: async () => ({ ok: false, text: async () => '' }),
      }),
    ).resolves.toBe(false);
  });

  it('refuses registration with a breached password, new or existing address', async () => {
    env.breachCheckEnabled = true;
    const digest = sha1(PASSWORD);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const created = await register({ email: 'pwned@example.test' });
    expect(created.status).toBe(201);

    stubPwned(digest);
    const existing = await register({ email: 'pwned@example.test' });
    expect(existing.status).toBe(400);
    expect(existing.body.error.code).toBe('password_breached');

    const fresh = await register({ email: 'fresh-hit@example.test' });
    expect(fresh.status).toBe(400);
    expect(fresh.body.error.message).toMatch(/breach/i);
  });

  it('rejects an over-long password at registration with a 72-byte reason', async () => {
    const wide = `Aa1!${'🙂'.repeat(18)}`;
    const rejected = await register({ email: 'wide@example.test', password: wide });
    expect(rejected.status).toBe(400);
    const issue = rejected.body.error.details.find((entry) => entry.path === 'password');
    expect(issue.message).toMatch(/72 bytes/);
  });

  it('applies supersession in one bulk write and does nothing on a stable rerun', async () => {
    const user = await User.create({
      email: `n22-${randomUUID()}@example.test`,
      name: 'N22 Owner',
      passwordHash: 'not-used',
    });
    const project = await Project.create({
      key: `N22-${randomUUID().slice(0, 8)}`,
      name: 'N22 supersession',
      owner: user._id,
      members: [{ user: user._id, role: 'lead' }],
    });
    const source = await Source.create({
      project: project._id,
      kind: 'upload',
      name: `n22-${randomUUID()}.md`,
      status: 'ready',
      createdBy: user._id,
    });

    const older = await Claim.create({
      project: project._id,
      source: source._id,
      type: 'decision',
      statement: 'Cache sessions in Redis',
      statementKey: 'cache sessions in redis',
      topic: 'Session store',
      topicKey: 'session store',
      status: 'planned',
      occurredAt: new Date('2026-01-05'),
    });
    const newer = await Claim.create({
      project: project._id,
      source: source._id,
      type: 'decision',
      statement: 'Cache sessions in Memcached',
      statementKey: 'cache sessions in memcached',
      topic: 'Session store',
      topicKey: 'session store',
      status: 'active',
      occurredAt: new Date('2026-02-05'),
      flags: ['explicit_supersession'],
    });

    const bulk = vi.spyOn(Claim, 'bulkWrite');
    const save = vi.spyOn(Claim.prototype, 'save');
    try {
      const applied = await linkSupersessions(project._id);
      expect(applied).toBe(1);
      expect(bulk).toHaveBeenCalledTimes(1);
      expect(bulk.mock.calls[0][0]).toHaveLength(1);
      expect(save).not.toHaveBeenCalled();

      const marked = await Claim.findById(older._id).lean();
      expect(marked.status).toBe('superseded');
      expect(marked.supersededPriorStatus).toBe('planned');
      expect(String(marked.supersededBy)).toBe(String(newer._id));

      bulk.mockClear();
      expect(await linkSupersessions(project._id)).toBe(1);
      expect(bulk).not.toHaveBeenCalled();
    } finally {
      bulk.mockRestore();
      save.mockRestore();
    }
  });
});
