import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDocumentProxy, extractText } from 'unpdf';
import { env } from '../src/config/env.js';
import { Delivery, Handover, Notification, Source } from '../src/models/index.js';
import { sendDueReminders } from '../src/services/handover/reminders.js';
import {
  auth,
  idOf,
  request,
  app,
  seed,
  startDb,
  stopDb,
  tokenOf,
  whenIdle,
} from './helpers.js';

const LEAD = 'subham@threadline.demo';
const INCOMING = 'ananya@threadline.demo';
const OUTGOING = 'rohan@threadline.demo';
const OBSERVER = 'vikram@threadline.demo';
const DAY = 86_400_000;

describe('handover downloads, feedback, delivery and reminders', () => {
  let seeded;
  let projectId;
  let leadToken;
  let incomingToken;
  let incomingId;

  const originalFetch = global.fetch;
  const originalWebhook = env.outboundWebhookUrl;
  const originalReminderEnabled = env.handoverReminderEnabled;
  const originalReminderDays = env.handoverReminderDays;

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
    incomingToken = tokenOf(seeded, INCOMING);
    incomingId = idOf(seeded, INCOMING);
    env.outboundWebhookUrl = '';
    env.handoverReminderEnabled = true;
    env.handoverReminderDays = 3;
    global.fetch = originalFetch;
  });

  afterEach(() => {
    env.outboundWebhookUrl = originalWebhook;
    env.handoverReminderEnabled = originalReminderEnabled;
    env.handoverReminderDays = originalReminderDays;
    global.fetch = originalFetch;
  });

  async function createDraft() {
    const created = await request(app)
      .post('/api/handovers')
      .set(auth(leadToken))
      .send({ projectId, recipientId: incomingId, roleTemplate: 'onboarding' });
    expect(created.status).toBe(201);
    return created.body.handover;
  }

  async function createShared() {
    const handover = await createDraft();
    await request(app)
      .post(`/api/handovers/${handover.id}/submit`)
      .set(auth(leadToken))
      .expect(200);
    await request(app)
      .post(`/api/handovers/${handover.id}/approve`)
      .set(auth(leadToken))
      .send({})
      .expect(200);
    const shared = await request(app)
      .post(`/api/handovers/${handover.id}/share`)
      .set(auth(leadToken))
      .expect(200);
    return { handover, shareToken: shared.body.sharePath.split('/').pop() };
  }

  async function pdfText(response) {
    const buffer = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.body);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(doc, { mergePages: true });
    return { buffer, text, flat: text.replace(/\s+/g, ' ') };
  }

  it('exports the recipient copy without restricted evidence', async () => {
    const { shareToken } = await createShared();

    const exported = await request(app)
      .get(`/api/handovers/shared/${shareToken}/export`)
      .expect(200);

    expect(exported.headers['content-type']).toContain('application/pdf');
    expect(exported.headers['content-disposition']).toContain('attachment;');
    expect(exported.headers['content-disposition']).toContain('ananya-rao');
    expect(exported.headers['content-disposition']).toContain('.pdf');

    const { buffer, flat } = await pdfText(exported);
    expect(Number(exported.headers['content-length'])).toBe(buffer.length);
    expect(flat).toContain('Handover for Ananya Rao');
    expect(flat.toLowerCase()).toContain('recipient copy');
    expect(flat).not.toContain('vendor-contract-summary.md');
    expect(flat).not.toContain('22 percent');
    expect(flat).not.toContain('Withheld from this view');
  });

  it('exports the reviewer copy with a withheld summary', async () => {
    const { handover } = await createShared();

    const exported = await request(app)
      .get(`/api/handovers/${handover.id}/export`)
      .set(auth(leadToken))
      .expect(200);

    expect(exported.headers['content-type']).toContain('application/pdf');

    const { flat } = await pdfText(exported);
    expect(flat.toLowerCase()).toContain('reviewer copy');
    expect(flat).toContain('Withheld from this view');
    expect(flat).toContain('Details are intentionally omitted');
  });

  it('renders non-Latin statements and page footers', async () => {
    const { renderHandoverPdf } = await import('../src/services/handover/export.js');
    const pdf = await renderHandoverPdf({
      handover: {
        status: 'in_review',
        version: 1,
        recipientSnapshot: { name: 'Ananya Rao' },
        snapshot: { projectName: 'Atlas' },
        items: [
          {
            type: 'decision',
            status: 'active',
            statement: 'टीम ने नए खाते को मंजूरी दी',
            citations: [],
          },
        ],
      },
      projectName: 'Atlas',
      viewer: 'recipient',
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const { text } = await extractText(doc, { mergePages: true });
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('टीम ने नए खाते को मंजूरी दी');
    expect(flat).toContain('In review · version 1');
    expect(flat).toContain('Page 1 of');
  });

  it('only exports to viewers with access to the handover', async () => {
    const { handover } = await createShared();

    await request(app).get(`/api/handovers/${handover.id}/export`).expect(401);

    const outsider = await request(app)
      .get(`/api/handovers/${handover.id}/export`)
      .set(auth(tokenOf(seeded, OBSERVER)));
    expect(outsider.status).toBe(403);
  });

  it('counts share-link opens for the sender and resets them on rotation', async () => {
    const { handover, shareToken } = await createShared();

    await request(app).get(`/api/handovers/shared/${shareToken}`).expect(200);
    await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(incomingToken))
      .expect(200);

    let detail = await request(app)
      .get(`/api/handovers/${handover.id}`)
      .set(auth(leadToken))
      .expect(200);
    expect(detail.body.handover.shareOpenCount).toBe(2);
    expect(detail.body.handover.shareOpenedAt).toBeTruthy();
    expect(detail.body.handover.shareLastOpenedAt).toBeTruthy();
    expect(
      new Date(detail.body.handover.shareLastOpenedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(detail.body.handover.shareOpenedAt).getTime());
    expect(detail.body.handover.reminderSentAt).toBeNull();

    await request(app)
      .post(`/api/handovers/${handover.id}/share`)
      .set(auth(leadToken))
      .send({ confirmRotation: true })
      .expect(200);

    detail = await request(app)
      .get(`/api/handovers/${handover.id}`)
      .set(auth(leadToken))
      .expect(200);
    expect(detail.body.handover.shareOpenCount).toBe(0);
    expect(detail.body.handover.shareOpenedAt).toBeNull();
  });

  it('accepts recipient feedback, notifies the lead and resolves it', async () => {
    const { handover, shareToken } = await createShared();

    const recipientView = await request(app)
      .get(`/api/handovers/shared/${shareToken}`)
      .set(auth(incomingToken))
      .expect(200);
    const item = recipientView.body.handover.items.find(
      (entry) => (entry.citations || []).length > 0,
    );
    expect(item).toBeTruthy();

    const created = await request(app)
      .post(`/api/handovers/shared/${shareToken}/feedback`)
      .set(auth(incomingToken))
      .send({ claimId: item.claimId, message: 'This due date moved to December 2026.' })
      .expect(201);
    expect(created.body.feedback.authorName).toBe('Ananya Rao');
    expect(created.body.feedback.status).toBe('open');
    expect(created.body.feedback.claimId).toBe(item.claimId);

    await request(app)
      .post(`/api/handovers/shared/${shareToken}/feedback`)
      .send({ message: 'General note: the runbook link is missing.' })
      .expect(201);

    const list = await request(app)
      .get(`/api/handovers/${handover.id}/feedback`)
      .set(auth(leadToken))
      .expect(200);
    expect(list.body.feedback).toHaveLength(2);
    expect(list.body.feedback[0].message).toContain('runbook link');

    const reviewDetail = await request(app)
      .get(`/api/handovers/${handover.id}`)
      .set(auth(leadToken))
      .expect(200);
    expect(reviewDetail.body.handover.feedback).toHaveLength(2);

    const resolved = await request(app)
      .patch(`/api/handovers/${handover.id}/feedback/${created.body.feedback.id}`)
      .set(auth(leadToken))
      .send({ note: 'Confirmed with finance; the date is correct.' })
      .expect(200);
    expect(resolved.body.feedback.status).toBe('resolved');
    expect(resolved.body.feedback.resolutionNote).toContain('Confirmed with finance');

    const notification = await Notification.findOne({
      recipient: idOf(seeded, LEAD),
      type: 'handover.feedback',
      entityId: handover.id,
    });
    expect(notification).toBeTruthy();

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(leadToken))
      .expect(200);
    const actions = audit.body.events.map((event) => event.action);
    expect(actions).toContain('handover.feedback_received');
    expect(actions).toContain('handover.feedback_resolved');
  });

  it('rejects feedback from people other than the recipient and before sharing', async () => {
    const handover = await createDraft();

    const beforeShare = await request(app)
      .post(`/api/handovers/${handover.id}/feedback`)
      .set(auth(incomingToken))
      .send({ message: 'Trying to comment too early.' });
    expect(beforeShare.status).toBe(403);

    const { handover: sharedHandover, shareToken } = await createShared();

    const leadFails = await request(app)
      .post(`/api/handovers/${sharedHandover.id}/feedback`)
      .set(auth(leadToken))
      .send({ message: 'Leads cannot speak as the recipient.' });
    expect(leadFails.status).toBe(403);

    const contributorList = await request(app)
      .get(`/api/handovers/${sharedHandover.id}/feedback`)
      .set(auth(tokenOf(seeded, OUTGOING)));
    expect(contributorList.status).toBe(403);

    const short = await request(app)
      .post(`/api/handovers/shared/${shareToken}/feedback`)
      .send({ message: 'no' });
    expect(short.status).toBe(400);

    // Permissions are re-checked when the note is written, not only when the
    // handover was composed. Restricting a source after sharing makes its
    // items unreadable, so a note about them must be refused.
    const restrictedSourceId = seeded.sources.find(
      (source) => source.name === 'handover-notes.txt',
    ).id;
    await Source.updateOne(
      { _id: restrictedSourceId },
      { $set: { visibility: { scope: 'roles', roles: ['lead'], users: [] } } },
    );
    const reviewDetail = await request(app)
      .get(`/api/handovers/${sharedHandover.id}`)
      .set(auth(leadToken))
      .expect(200);
    const nowHidden = reviewDetail.body.handover.items.find((entry) =>
      (entry.citations || []).some(
        (citation) => String(citation.sourceId) === String(restrictedSourceId),
      ),
    );
    expect(nowHidden).toBeTruthy();

    const denied = await request(app)
      .post(`/api/handovers/shared/${shareToken}/feedback`)
      .set(auth(incomingToken))
      .send({ claimId: nowHidden.claimId, message: 'Commenting on a hidden item.' });
    expect(denied.status).toBe(403);
  });

  it('records a skipped delivery when no webhook is configured', async () => {
    const { handover } = await createShared();

    const deliveries = await request(app)
      .get(`/api/handovers/${handover.id}/deliveries`)
      .set(auth(leadToken))
      .expect(200);

    expect(deliveries.body.deliveries).toHaveLength(1);
    const record = deliveries.body.deliveries[0];
    expect(record.kind).toBe('handover.shared');
    expect(record.channel).toBe('webhook');
    expect(record.status).toBe('skipped');
    expect(record.detail).toContain('No outbound webhook is configured');
    expect(record.detail).not.toMatch(/https?:\/\//);

    const outsider = await request(app)
      .get(`/api/handovers/${handover.id}/deliveries`)
      .set(auth(tokenOf(seeded, OUTGOING)));
    expect(outsider.status).toBe(403);
  });

  it('records sent and failed deliveries when a webhook is configured', async () => {
    const { handover } = await createShared();
    env.outboundWebhookUrl = 'https://hooks.example.test/threadline-secret';

    let captured;
    global.fetch = async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 204 };
    };
    await request(app)
      .post(`/api/handovers/${handover.id}/share`)
      .set(auth(leadToken))
      .send({ confirmRotation: true })
      .expect(200);
    expect(captured.url).toBe(env.outboundWebhookUrl);
    expect(captured.body.text).toContain('Ananya Rao');
    expect(captured.body.text).not.toContain('vendor');

    global.fetch = async () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    await request(app)
      .post(`/api/handovers/${handover.id}/share`)
      .set(auth(leadToken))
      .send({ confirmRotation: true })
      .expect(200);

    const deliveries = await request(app)
      .get(`/api/handovers/${handover.id}/deliveries`)
      .set(auth(leadToken))
      .expect(200);
    const statuses = deliveries.body.deliveries.map((entry) => entry.status);
    expect(statuses).toEqual(['failed', 'sent', 'skipped']);
    const failed = deliveries.body.deliveries[0];
    expect(failed.detail).toBe('The webhook could not be reached.');
    expect(JSON.stringify(deliveries.body)).not.toContain('threadline-secret');
  });

  it('records the outbound attempt when a question is asked', async () => {
    await whenIdle();

    await request(app)
      .post(`/api/projects/${projectId}/clarifications`)
      .set(auth(leadToken))
      .send({ askForAll: true })
      .expect(201);

    const deliveries = await Delivery.find({ project: projectId, kind: 'clarification.asked' });
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((entry) => entry.status === 'skipped')).toBe(true);
  });

  it('sends one reminder after the delay and never twice', async () => {
    const { handover } = await createShared();

    await Handover.updateOne(
      { _id: handover.id },
      { $set: { sharedAt: new Date(Date.now() - 4 * DAY) } },
    );

    const first = await sendDueReminders({ now: new Date() });
    expect(first.sent).toBe(1);
    expect(first.scanned).toBe(1);

    const notification = await Notification.findOne({
      recipient: incomingId,
      type: 'handover.reminder',
    });
    expect(notification).toBeTruthy();

    const reminderDelivery = await Delivery.findOne({
      handover: handover.id,
      kind: 'handover.reminder',
    });
    expect(reminderDelivery).toBeTruthy();
    expect(reminderDelivery.status).toBe('skipped');

    const saved = await Handover.findById(handover.id);
    expect(saved.reminderSentAt).toBeTruthy();

    const second = await sendDueReminders({ now: new Date() });
    expect(second.sent).toBe(0);
    expect(second.scanned).toBe(0);
  });

  it('does not remind before the delay or after acknowledgement', async () => {
    const { handover } = await createShared();

    await Handover.updateOne(
      { _id: handover.id },
      { $set: { sharedAt: new Date(Date.now() - 1 * DAY) } },
    );
    expect((await sendDueReminders({ now: new Date() })).sent).toBe(0);

    await Handover.updateOne(
      { _id: handover.id },
      {
        $set: {
          sharedAt: new Date(Date.now() - 5 * DAY),
          status: 'acknowledged',
          acknowledgedAt: new Date(),
        },
      },
    );
    expect((await sendDueReminders({ now: new Date() })).sent).toBe(0);

    await Handover.updateOne(
      { _id: handover.id },
      { $set: { status: 'shared', acknowledgedAt: null } },
    );
    env.handoverReminderEnabled = false;
    expect((await sendDueReminders({ now: new Date() })).sent).toBe(0);
  });
});
