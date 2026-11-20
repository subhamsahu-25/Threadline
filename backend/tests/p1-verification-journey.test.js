import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { Delivery, User } from '../src/models/index.js';
import { whenVerificationMailIdle } from '../src/services/verification.js';
import { app, auth, request, seed, startDb, stopDb } from './helpers.js';

const LEAD = 'subham@threadline.demo';
const PASSWORD = 'Threadline#2026';

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

describe('P1 email verification is a complete, private journey', () => {
  let originalMail;
  let seeded;
  let projectId;
  let leadToken;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    originalMail = {
      provider: env.mailProvider,
      apiBase: env.mailApiBase,
      key: env.resendApiKey,
      from: env.mailFrom,
      webhook: env.outboundWebhookUrl,
    };
    env.mailProvider = '';
    env.mailApiBase = 'http://127.0.0.1:1';
    env.resendApiKey = '';
    env.outboundWebhookUrl = '';
    seeded = await seed();
    projectId = seeded.project.id;
    leadToken = seeded.users.find((user) => user.email === LEAD).token;
  });

  afterEach(() => {
    env.mailProvider = originalMail.provider;
    env.mailApiBase = originalMail.apiBase;
    env.resendApiKey = originalMail.key;
    env.mailFrom = originalMail.from;
    env.outboundWebhookUrl = originalMail.webhook;
  });

  it('returns a working confirmation link to the registrant when mail is not configured', async () => {
    const register = await request(app).post('/api/auth/register').send({
      email: 'p1-local@example.com',
      name: 'Local Registrant',
      password: PASSWORD,
    });
    expect(register.status).toBe(201);
    expect(register.body.mailConfigured).toBe(false);
    expect(register.body.verificationUrl).toMatch(/\/verify-email\?token=/);

    await whenVerificationMailIdle();
    const record = await Delivery.findOne({
      user: (await User.findOne({ email: 'p1-local@example.com' }))._id,
      kind: 'auth.verify_email',
    }).lean();
    expect(record.channel).toBe('email');
    expect(record.status).toBe('skipped');
    expect(JSON.stringify(record)).not.toContain('token=');

    const token = new URL(register.body.verificationUrl).searchParams.get('token');
    expect(token).toBeTruthy();

    // The member cannot be added before the link is opened.
    const refused = await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email: 'p1-local@example.com', role: 'observer' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('email_unverified');

    // Opening the link is exactly the POST the confirmation page makes.
    await request(app).post('/api/auth/verify-email').send({ token }).expect(200);

    const added = await request(app)
      .post(`/api/projects/${projectId}/members`)
      .set(auth(leadToken))
      .send({ email: 'p1-local@example.com', role: 'observer' })
      .expect(201);
    expect(
      added.body.project.members.some((member) => member.email === 'p1-local@example.com'),
    ).toBe(true);
  });

  it('sends the link only to the address owner, never to the operator webhook', async () => {
    const providerRequests = [];
    const provider = await listen(async (req, res) => {
      providerRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(await readBody(req)),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"mail_1"}');
    });
    const webhookRequests = [];
    const webhook = await listen(async (req, res) => {
      webhookRequests.push(await readBody(req));
      res.writeHead(204);
      res.end();
    });

    env.mailProvider = 'resend';
    env.mailApiBase = provider.base;
    env.resendApiKey = 're_test_key';
    env.outboundWebhookUrl = `${webhook.base}/hook`;

    try {
      const register = await request(app).post('/api/auth/register').send({
        email: 'p1-mail@example.com',
        name: 'Mailed Registrant',
        password: PASSWORD,
      });
      expect(register.status).toBe(201);
      expect(register.body.mailConfigured).toBe(true);
      expect(JSON.stringify(register.body)).not.toContain('token=');
      expect(JSON.stringify(register.body)).not.toContain('verificationUrl');

      await whenVerificationMailIdle();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0].url).toBe('/emails');
      expect(providerRequests[0].authorization).toBe('Bearer re_test_key');
      expect(providerRequests[0].body.to).toEqual(['p1-mail@example.com']);
      expect(providerRequests[0].body.text).toMatch(/\/verify-email\?token=/);
      expect(providerRequests[0].body.text).toContain('p1-mail@example.com');
      expect(webhookRequests).toHaveLength(0);

      const user = await User.findOne({ email: 'p1-mail@example.com' });
      const record = await Delivery.findOne({ user: user._id, kind: 'auth.verify_email' }).lean();
      expect(record.channel).toBe('email');
      expect(record.status).toBe('sent');
    } finally {
      await provider.close();
      await webhook.close();
    }
  });

  it('answers a resend request uniformly for known and unknown addresses', async () => {
    await request(app).post('/api/auth/register').send({
      email: 'p1-resend@example.com',
      name: 'Resend Person',
      password: PASSWORD,
    });
    await whenVerificationMailIdle();

    const known = await request(app)
      .post('/api/auth/verification/resend')
      .send({ email: 'p1-resend@example.com' });
    const unknown = await request(app)
      .post('/api/auth/verification/resend')
      .send({ email: 'p1-nobody@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(JSON.stringify(known.body)).not.toContain('token=');
    await whenVerificationMailIdle();
  });

  it('refuses a missing or malformed token with the page\u2019s error code', async () => {
    const missing = await request(app).post('/api/auth/verify-email').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('verification_invalid');

    const garbage = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: 'not-a-token' });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('verification_invalid');
  });
});
