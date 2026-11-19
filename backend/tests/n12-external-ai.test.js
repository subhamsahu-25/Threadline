import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Source } from '../src/models/index.js';
import { app, auth, registerAndLogin, request, startDb, stopDb } from './helpers.js';

const LEAD = 'lead@n12.test';
const SECOND_LEAD = 'second-lead@n12.test';

describe('external AI consent on sources', () => {
  let lead;
  let secondLead;
  let projectId;
  let readableSource;
  let hiddenSource;

  beforeAll(async () => {
    await startDb();
    lead = await registerAndLogin(LEAD, 'Lead N12');
    secondLead = await registerAndLogin(SECOND_LEAD, 'Second Lead N12');

    const created = await request(app)
      .post('/api/projects')
      .set(auth(lead.token))
      .send({
        key: 'N12',
        name: 'External AI consent',
        members: [{ email: SECOND_LEAD, role: 'lead' }],
      });
    expect(created.status).toBe(201);
    projectId = created.body.project.id;

    readableSource = await Source.create({
      project: projectId,
      kind: 'upload',
      name: 'Contract notes',
      status: 'ready',
      createdBy: lead.user.id,
      visibility: { scope: 'roles', roles: ['lead'], users: [] },
      sensitivity: 'confidential',
    });
    // This lead is deliberately not named in the sharing rule.
    hiddenSource = await Source.create({
      project: projectId,
      kind: 'upload',
      name: 'Board minutes',
      status: 'ready',
      createdBy: secondLead.user.id,
      visibility: { scope: 'users', roles: [], users: [secondLead.user.id] },
      sensitivity: 'confidential',
    });
  });

  afterAll(async () => {
    await stopDb();
  });

  it('refuses an AI policy change on a source the lead cannot read', async () => {
    const response = await request(app)
      .patch(`/api/projects/${projectId}/sources/${hiddenSource._id}`)
      .set(auth(lead.token))
      .send({ aiPolicy: { allowExternal: true }, reason: 'Need a summary' })
      .expect(403);
    expect(response.body.error.code).toBe('forbidden');

    const stored = await Source.findById(hiddenSource._id);
    expect(stored.aiPolicy?.allowExternal).not.toBe(true);
  });

  it('requires a written reason to allow a confidential source out of the server', async () => {
    const refused = await request(app)
      .patch(`/api/projects/${projectId}/sources/${readableSource._id}`)
      .set(auth(lead.token))
      .send({ aiPolicy: { allowExternal: true } })
      .expect(400);
    expect(refused.body.error.code).toBe('bad_request');

    const accepted = await request(app)
      .patch(`/api/projects/${projectId}/sources/${readableSource._id}`)
      .set(auth(lead.token))
      .send({
        aiPolicy: { allowExternal: true },
        reason: 'Legal review needs a summary of the vendor contract.',
      })
      .expect(200);
    expect(accepted.body.source.aiPolicy.allowExternal).toBe(true);

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(lead.token))
      .expect(200);
    const event = audit.body.events.find((entry) => entry.action === 'source.ai_policy_changed');
    expect(event).toBeTruthy();
    expect(event.meta.after.reason).toContain('Legal review needs a summary');
  });

  it('notifies the other readers named by the restricted sharing rule', async () => {
    const notices = await request(app)
      .get('/api/notifications')
      .set(auth(secondLead.token))
      .expect(200);
    const notice = notices.body.notifications.find(
      (entry) => entry.type === 'source.external_ai_enabled',
    );
    expect(notice).toBeTruthy();
    expect(notice.title).toContain('confidential source');
    expect(notice.detail).toContain('Contract notes');

    // The actor made the decision and does not need to be told about it.
    const own = await request(app)
      .get('/api/notifications')
      .set(auth(lead.token))
      .expect(200);
    expect(
      own.body.notifications.some((entry) => entry.type === 'source.external_ai_enabled'),
    ).toBe(false);
  });

  it('does not demand a new reason when saving a source that already allows it', async () => {
    await request(app)
      .patch(`/api/projects/${projectId}/sources/${readableSource._id}`)
      .set(auth(lead.token))
      .send({ name: 'Contract notes (reviewed)', aiPolicy: { allowExternal: true } })
      .expect(200);
  });
});
