import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  auth,
  idOf,
  request,
  seed,
  startDb,
  stopDb,
  tokenOf,
  whenIdle,
} from './helpers.js';
import { loadOwnerDirectory, resolveOwnerName } from '../src/services/owners.js';
import { Claim, Project } from '../src/models/index.js';

const LEAD = 'subham@threadline.demo';
const CONTRIBUTOR = 'rohan@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';

describe('N18 owner assignment confidence', () => {
  let seeded;
  let projectId;
  let leadToken;
  let rohanId;

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
    rohanId = idOf(seeded, CONTRIBUTOR);
  });

  async function directory() {
    const project = await Project.findById(projectId).lean();
    return loadOwnerDirectory(project);
  }

  it('assigns only an exact email or full name and never a first name', async () => {
    const owners = await directory();

    expect(String(resolveOwnerName(owners, 'Rohan Mehta').userId)).toBe(rohanId);
    expect(String(resolveOwnerName(owners, 'rohan@threadline.demo').userId)).toBe(rohanId);

    // "Rohan will follow up" may name an outside person even though exactly
    // one member is called Rohan.
    expect(resolveOwnerName(owners, 'Rohan')).toEqual({
      userId: null,
      ambiguous: false,
      unconfirmed: true,
    });
    expect(resolveOwnerName(owners, 'Someone Else')).toEqual({
      userId: null,
      ambiguous: false,
      unconfirmed: false,
    });
  });

  it('leaves observers out of the directory because they cannot own work', async () => {
    const owners = await directory();
    expect(owners.byEmail.has(OBSERVER)).toBe(false);
    expect(owners.byName.has('vikram nair')).toBe(false);

    expect(resolveOwnerName(owners, 'Vikram Nair').userId).toBeNull();
    expect(resolveOwnerName(owners, OBSERVER).userId).toBeNull();
    expect(resolveOwnerName(owners, 'Vikram').userId).toBeNull();
  });

  it('flags ingested first-name owners as unconfirmed instead of linking them', async () => {
    const content = [
      '# Owner runbook',
      '',
      'Task: Check the alerting runbook (owner: Rohan, due: 2026-12-01, status: open)',
      '',
      'Task: Update the billing table (owner: Rohan Mehta, due: 2026-12-02, status: open)',
      '',
      'Task: Review the audit notes (owner: Vikram Nair, due: 2026-12-03, status: open)',
    ].join('\n');

    const uploaded = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(leadToken))
      .field('name', 'Owner runbook')
      .attach('files', Buffer.from(content, 'utf8'), 'owner-runbook.md')
      .expect(202);
    await whenIdle({ timeoutMs: 120_000 });

    const claims = await Claim.find({
      source: uploaded.body.source.id,
      retiredAt: null,
    }).lean();
    const byOwner = new Map(claims.map((claim) => [claim.ownerName, claim]));

    const firstName = byOwner.get('Rohan');
    expect(firstName).toBeTruthy();
    expect(firstName.ownerUser).toBeFalsy();
    expect(firstName.flags).toContain('owner_unconfirmed');
    expect(firstName.state).toBe('needs_review');

    const fullName = byOwner.get('Rohan Mehta');
    expect(fullName).toBeTruthy();
    expect(String(fullName.ownerUser)).toBe(rohanId);
    expect(fullName.flags || []).not.toContain('owner_unconfirmed');

    const observer = byOwner.get('Vikram Nair');
    expect(observer).toBeTruthy();
    expect(observer.ownerUser).toBeFalsy();
  });

  it('does not silently link a manually typed first name', async () => {
    const state = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(leadToken))
      .expect(200);
    const gap = state.body.ownershipGaps[0];
    expect(gap).toBeTruthy();

    await request(app)
      .post(`/api/projects/${projectId}/claims/${gap.id}/resolve`)
      .set(auth(leadToken))
      .send({ ownerName: 'Rohan' })
      .expect(200);

    const unconfirmed = await Claim.findById(gap.id).lean();
    expect(unconfirmed.ownerName).toBe('Rohan');
    expect(unconfirmed.ownerUser).toBeFalsy();
    expect(unconfirmed.flags).toContain('owner_unconfirmed');
    expect(unconfirmed.state).toBe('needs_review');

    await request(app)
      .post(`/api/projects/${projectId}/claims/${gap.id}/resolve`)
      .set(auth(leadToken))
      .send({ ownerName: 'Rohan Mehta' })
      .expect(200);

    const confirmed = await Claim.findById(gap.id).lean();
    expect(String(confirmed.ownerUser)).toBe(rohanId);
    expect(confirmed.flags || []).not.toContain('owner_unconfirmed');
  });
});
