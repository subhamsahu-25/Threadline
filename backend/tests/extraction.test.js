import { describe, expect, it } from 'vitest';
import { locateQuote } from '../src/lib/text.js';
import { heuristicExtract } from '../src/services/ai/heuristics.js';
import { parseFile } from '../src/services/ingest/parsers.js';

const NOTES = `# Database choice

Decision: Use PostgreSQL for the ledger. (date: 2026-09-02, status: active)
Task: Write the backfill script (owner: Rohan, due: 2026-11-20, status: open)
Risk: Dual writes will cause reconciliation drift. (date: 2026-10-18, status: open)
- [x] Update the runbook
Open question: Do we migrate invoices older than 24 months?
`;

describe('verbatim evidence location', () => {
  it('locates an exact quote and reports its offsets', () => {
    const haystack = 'Intro line.\nDecision: Use PostgreSQL.\nOutro.';
    const result = locateQuote(haystack, 'Decision: Use PostgreSQL.');
    expect(result.ok).toBe(true);
    expect(result.match).toBe('exact');
    expect(haystack.slice(result.start, result.end)).toBe('Decision: Use PostgreSQL.');
  });

  it('matches through markdown marks and collapsed whitespace', () => {
    const haystack = 'Intro\n\n**Decision:**  use   PostgreSQL.\nOutro';
    const result = locateQuote(haystack, 'Decision: use PostgreSQL.');
    expect(result.ok).toBe(true);
    expect(result.match).toBe('normalized');
    const slice = haystack
      .slice(result.start, result.end)
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(slice).toBe('Decision: use PostgreSQL.');
  });

  it('fails when the quote is not in the source', () => {
    const result = locateQuote('nothing relevant here', 'Use PostgreSQL for the ledger');
    expect(result.ok).toBe(false);
  });
});

describe('deterministic heuristic extractor', () => {
  const items = heuristicExtract({ text: NOTES, docTitle: 'fallback topic' });

  it('strips metadata and keeps the readable statement', () => {
    const decision = items.find((item) => item.type === 'decision');
    expect(decision.statement).toBe('Use PostgreSQL for the ledger.');
    expect(decision.topic).toBe('Database choice');
    expect(decision.occurredAt).toBe('2026-09-02');
    expect(decision.status).toBe('active');
    expect(decision.owner).toBeNull();
  });

  it('captures owner, due date and status on tasks', () => {
    const task = items.find((item) => item.statement === 'Write the backfill script');
    expect(task).toBeTruthy();
    expect(task.owner).toBe('Rohan');
    expect(task.dueDate).toBe('2026-11-20');
    expect(task.status).toBe('open');
    expect(task.quote).toContain('owner: Rohan');
  });

  it('maps checkboxes to completed tasks', () => {
    const done = items.find((item) => item.statement === 'Update the runbook');
    expect(done.type).toBe('task');
    expect(done.status).toBe('done');
  });

  it('produces a quote that exists verbatim in the document', () => {
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const item of items) {
      const located = locateQuote(NOTES, item.quote);
      expect(located.ok, `quote not found: ${item.quote}`).toBe(true);
    }
  });
});

describe('CSV normalization', () => {
  it('turns spreadsheet rows into labelled records', async () => {
    const csv =
      'type,title,owner,due,status\ntask,Write smoke tests,Ananya,2026-11-12,open\nquestion,Who owns alerting?,,,open\n';
    const parsed = await parseFile({
      buffer: Buffer.from(csv, 'utf8'),
      filename: 'board.csv',
    });
    expect(parsed.text).toContain(
      'Task: Write smoke tests (owner: Ananya, due: 2026-11-12, status: open)',
    );
    expect(parsed.text).toContain('Question: Who owns alerting? (status: open)');

    const extracted = heuristicExtract({ text: parsed.text });
    const task = extracted.find((item) => item.type === 'task');
    expect(task.statement).toBe('Write smoke tests');
    expect(task.owner).toBe('Ananya');
    expect(task.dueDate).toBe('2026-11-12');
  });
});
