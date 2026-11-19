import { describe, expect, it } from 'vitest';
import { locateMarkedQuoteSpans, MAX_REDACTION_MARKERS } from '../src/lib/text.js';
import { locateModelQuote } from '../src/services/ai/extract.js';

function repetitiveDocument(size) {
  const line = (index) =>
    `Part ${index}: contact person${index} at ops${index}@example.com about the migration.`;
  const lines = [];
  let index = 0;
  let length = 0;
  while (length < size) {
    const text = line(index);
    lines.push(text);
    length += text.length + 1;
    index += 1;
  }
  return lines.join('\n');
}

describe('marker quote resolution', () => {
  it('fails fast on 500 KB with four markers and a missing tail', () => {
    const document = repetitiveDocument(500 * 1024);
    expect(document.length).toBeGreaterThan(500_000);

    const quote = [
      'Part 0: contact person0 at [REDACTED: email] about the migration.',
      'Part 1: contact person1 at [REDACTED: email] about the migration.',
      'Part 2: contact person2 at [REDACTED: email] about the migration.',
      'Part 3: contact person3 at [REDACTED: email] about the migration.',
      'A closing sentence that is absent from the document.',
    ].join(' ');

    const stated = performance.now();
    const located = locateModelQuote(document, quote);
    const elapsed = performance.now() - stated;

    expect(located.ok).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  it('caps the number of markers a quote may contain', () => {
    const document = 'alpha one beta two gamma three delta four epsilon five';
    const quote = Array.from(
      { length: MAX_REDACTION_MARKERS + 1 },
      (_, index) => `token${index} [REDACTED: email]`,
    ).join(' ');
    expect(locateMarkedQuoteSpans(document, quote).ok).toBe(false);
  });

  it('refuses fragments that are further apart than the window', () => {
    const document = `start ${'x'.repeat(4000)} finish`;
    const located = locateMarkedQuoteSpans(document, 'start [REDACTED: email] finish');
    expect(located.ok).toBe(false);
    expect(located.reason).toBe('gap_too_large');
  });
});

describe('marker quote verification', () => {
  it('rejects a short marker quote that only matches a label', () => {
    const document = [
      'Contact: Rohan handles vendor questions.',
      'Deliverables were agreed on Monday.',
    ].join('\n');

    const located = locateModelQuote(document, 'Contact: [REDACTED: email]');
    expect(located.ok).toBe(false);
  });

  it('verifies a marker quote only where re-redaction reproduces it', () => {
    const document = [
      'The vendor contact is reachable at ops@example.com for escalations.',
      'The vendor contact is reachable at the Pune office every weekday.',
    ].join('\n');

    const located = locateModelQuote(
      document,
      'The vendor contact is reachable at [REDACTED: email] for escalations.',
    );
    expect(located.ok).toBe(true);
    expect(document.slice(located.start, located.end)).toContain('ops@example.com');
  });

  it('does not accept a match that jumped to a different line', () => {
    const document = [
      'The vendor contact is reachable at',
      'The vendor contact is reachable at ops@example.com for escalations.',
    ].join('\n');

    const located = locateModelQuote(
      document,
      'The vendor contact is reachable at [REDACTED: email] for escalations.',
    );
    expect(located.ok).toBe(false);
  });
});
