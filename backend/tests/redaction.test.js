import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed, startDb, stopDb } from './helpers.js';
import { redactText } from '../src/lib/redaction.js';
import { Claim, Document, Evidence, Project, Source, User } from '../src/models/index.js';
import { composeHandover } from '../src/services/handover/compose.js';

const LEAD = 'subham@threadline.demo';
const RECIPIENT = 'partho@threadline.demo';

describe('handover redaction', () => {
  let project;
  let lead;
  let recipient;

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    await seed();
    project = await Project.findOne({ key: 'ATLAS' });
    lead = await User.findOne({ email: LEAD });
    recipient = await User.findOne({ email: RECIPIENT });
  });

  it('replaces emails, phones, credentials and national ids', () => {
    const result = redactText(
      'Email priya@example.com, call +91 98765 43210, set API_KEY=abc123def456, Aadhaar 1234 5678 9012.',
    );

    expect(result.count).toBe(4);
    expect(result.kinds).toEqual(
      expect.arrayContaining(['email', 'phone', 'credential', 'national id']),
    );
    expect(result.text).not.toContain('priya@example.com');
    expect(result.text).not.toContain('98765 43210');
    expect(result.text).not.toContain('abc123def456');
    expect(result.text).not.toContain('1234 5678 9012');
  });

  it('marks an assigned api key once, not twice', () => {
    const result = redactText('Rotate API_KEY=sk-live-abc123def456ghi789jkl012 before handing over.');
    expect(result.text).toBe('Rotate API_KEY=[REDACTED: api key] before handing over.');
    expect(result.count).toBe(1);
    expect(result.kinds).toEqual(['api key']);
  });

  it('leaves ordinary project text untouched', () => {
    const result = redactText('Decision: Stay on MySQL until Q1 2027 and revisit the ledger.');
    expect(result.count).toBe(0);
    expect(result.text).toBe('Decision: Stay on MySQL until Q1 2027 and revisit the ledger.');
  });

  it('redacts claim text and verbatim quotes at compose time', async () => {
    const quote =
      'Decision: Store the backup credentials in the vault owned by ops@example.com using API_KEY=abc123def456.';
    const source = await Source.create({
      project: project._id,
      kind: 'upload',
      name: 'credential-notes.md',
      createdBy: lead._id,
    });
    const document = await Document.create({
      project: project._id,
      source: source._id,
      kind: 'upload',
      title: 'credential-notes.md',
      rawText: quote,
    });
    const claim = await Claim.create({
      project: project._id,
      source: source._id,
      document: document._id,
      type: 'decision',
      statement: quote.replace('Decision: ', ''),
      statementKey: 'credential-notes-backup',
      topic: 'backup credentials',
      topicKey: 'backup credentials',
      status: 'open',
      occurredAt: new Date(),
    });
    await Evidence.create({
      project: project._id,
      claim: claim._id,
      source: source._id,
      document: document._id,
      quote,
      charStart: 0,
      charEnd: quote.length,
      validation: 'exact',
    });

    const handover = await composeHandover({ project, recipient, actor: lead });
    const item = handover.items.find((entry) => String(entry.claimId) === String(claim._id));

    expect(item).toBeTruthy();
    expect(item.statement).not.toContain('ops@example.com');
    expect(item.statement).toContain('[REDACTED: email]');
    expect(item.statement).toContain('[REDACTED: credential]');
    expect(item.citations[0].quote).not.toContain('ops@example.com');
    expect(item.redactionCount).toBeGreaterThanOrEqual(4);
    expect(handover.redactions.count).toBeGreaterThanOrEqual(4);
    expect(handover.redactions.kinds).toEqual(
      expect.arrayContaining(['email', 'credential']),
    );
  });
});
