import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, auth, idOf, request, seed, startDb, stopDb, tokenOf } from './helpers.js';
import { Handover } from '../src/models/index.js';
import { HANDOVER_LIST_SCAN_BATCHES } from '../src/routes/handover.routes.js';

const LEAD = 'subham@threadline.demo';
const RECIPIENT = 'ananya@threadline.demo';

describe('N20 bounded handover list scan', () => {
  let seeded;
  let projectId;
  let leadToken;
  let recipientToken;
  let recipientId;
  let leadId;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    seeded = await seed();
    projectId = seeded.project.id;
    leadToken = tokenOf(seeded, LEAD);
    recipientToken = tokenOf(seeded, RECIPIENT);
    recipientId = idOf(seeded, RECIPIENT);
    leadId = idOf(seeded, LEAD);
  });

  function fixture(overrides = {}) {
    return {
      project: projectId,
      recipient: recipientId,
      createdBy: leadId,
      roleTemplate: 'onboarding',
      ...overrides,
    };
  }

  it('filters recipient visibility in the database query, not after the fetch', async () => {
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 6 * 86_400_000);
    const draft = await Handover.create(fixture({ status: 'draft' }));
    await Handover.create(
      fixture({ status: 'shared', shareTokenHash: 'hash', shareExpiresAt: past }),
    );
    const acknowledged = await Handover.create(
      fixture({ status: 'acknowledged', shareTokenHash: 'hash', shareExpiresAt: past }),
    );

    const spy = vi.spyOn(Handover, 'find');
    const list = await request(app)
      .get('/api/handovers?scope=received&limit=100')
      .set(auth(recipientToken))
      .expect(200);
    const filters = spy.mock.calls.map(([filter]) => filter);
    spy.mockRestore();

    const filter = filters[0];
    expect(filter).toBeTruthy();
    expect(String(filter.recipient)).toBe(recipientId);
    // The status and live-link rule is part of the query itself.
    expect(filter.status).toEqual({ $in: ['shared', 'acknowledged'] });
    expect(JSON.stringify(filter)).toContain('shareExpiresAt');
    expect(JSON.stringify(filter)).toContain('shareTokenHash');

    const ids = list.body.handovers.map((entry) => String(entry.id));
    expect(ids).toContain(String(acknowledged._id));
    expect(ids).not.toContain(String(draft._id));
    expect(ids).toHaveLength(1);
  });

  it('stops after a fixed number of batches instead of scanning the collection', async () => {
    // Another workspace where the recipient is not a member: rows match the
    // query but fail the read-time membership check, which is exactly the
    // case that used to scan without a bound.
    const otherProject = await request(app)
      .post('/api/projects')
      .set(auth(leadToken))
      .send({ key: 'OTH', name: 'Other workspace', description: 'No recipient here' })
      .expect(201);
    const otherProjectId = otherProject.body.project.id;

    const rows = HANDOVER_LIST_SCAN_BATCHES + 3;
    await Handover.insertMany(
      Array.from({ length: rows }, (_, index) =>
        fixture({
          project: otherProjectId,
          status: 'shared',
          shareTokenHash: `hidden-${index}`,
          shareExpiresAt: new Date(Date.now() + 86_400_000),
        }),
      ),
    );

    const spy = vi.spyOn(Handover, 'find');
    const list = await request(app)
      .get('/api/handovers?scope=received&limit=1')
      .set(auth(recipientToken))
      .expect(200);
    const findCalls = spy.mock.calls.length;
    spy.mockRestore();

    expect(list.body.handovers).toEqual([]);
    expect(findCalls).toBeLessThanOrEqual(HANDOVER_LIST_SCAN_BATCHES);
    expect(list.body.nextCursor).toBeTruthy();
    expect(list.body.hasMore).toBe(true);
  });
});
