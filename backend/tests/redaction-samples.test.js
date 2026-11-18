import { describe, expect, it } from 'vitest';
import { redactText } from '../src/lib/redaction.js';

const googleKey = `AIza${'b'.repeat(35)}`;
const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const positives = [
  {
    name: 'prefixed Google API key',
    input: `GEMINI_API_KEY=${googleKey} for extraction`,
    kinds: ['api key'],
    count: 1,
    text: 'GEMINI_API_KEY=[REDACTED: api key] for extraction',
    gone: [googleKey],
  },
  {
    name: 'prefixed password',
    input: 'DB_PASSWORD=hunter2hunter2',
    kinds: ['credential'],
    count: 1,
    text: 'DB_PASSWORD=[REDACTED: credential]',
    gone: ['hunter2hunter2'],
  },
  {
    name: 'password phrase runs to the end of the line',
    input: 'password: correct horse battery staple',
    kinds: ['credential'],
    count: 1,
    text: 'password: [REDACTED: credential]',
    gone: ['correct', 'horse', 'staple'],
  },
  {
    name: 'prefixed secret',
    input: 'JWT_SECRET=super-secret-value-123',
    kinds: ['credential'],
    count: 1,
    text: 'JWT_SECRET=[REDACTED: credential]',
    gone: ['super-secret-value-123'],
  },
  {
    name: 'AWS secret access key',
    input: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    kinds: ['credential'],
    count: 1,
    text: 'AWS_SECRET_ACCESS_KEY=[REDACTED: credential]',
    gone: ['wJalrXUtnFEMI'],
  },
  {
    name: 'camelCase token name',
    input: 'accessToken: 9f8e7d6c5b4a',
    kinds: ['credential'],
    count: 1,
    text: 'accessToken: [REDACTED: credential]',
    gone: ['9f8e7d6c5b4a'],
  },
  {
    name: 'quoted secret keeps the quote boundary',
    input: 'MY_API_KEY="value with spaces"',
    kinds: ['credential'],
    count: 1,
    text: 'MY_API_KEY=[REDACTED: credential]',
    gone: ['value with spaces'],
  },
  {
    name: 'raw JWT',
    input: `Token ${jwt} leaked`,
    kinds: ['jwt'],
    count: 1,
    text: 'Token [REDACTED: jwt] leaked',
    gone: ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
  },
  {
    name: 'bearer token',
    input: 'Authorization: Bearer abcdefghijklmnop123456',
    kinds: ['bearer token'],
    count: 1,
    text: 'Authorization: [REDACTED: bearer token]',
    gone: ['abcdefghijklmnop123456'],
  },
  {
    name: 'connection string keeps scheme and host',
    input: 'mongodb+srv://user:pass@host/db',
    kinds: ['connection string'],
    count: 1,
    text: 'mongodb+srv://[REDACTED: connection string]@host/db',
    gone: ['user:pass', 'pass@'],
  },
  {
    name: 'slack webhook',
    input: ['https://hooks.slack.com', 'services', 'T00000000', 'B00000000', 'XXXXXXXXXXXXXXXXXXXXXXXX'].join('/'),
    kinds: ['webhook'],
    count: 1,
    text: '[REDACTED: webhook]',
    gone: ['T00000000'],
  },
  {
    name: 'stripe webhook',
    input: 'https://hooks.stripe.com/wh_1a2b3c4d5e6f',
    kinds: ['webhook'],
    count: 1,
    text: '[REDACTED: webhook]',
    gone: ['wh_1a2b3c4d5e6f'],
  },
  {
    name: 'discord webhook',
    input: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
    kinds: ['webhook'],
    count: 1,
    text: '[REDACTED: webhook]',
    gone: ['123456789012345678'],
  },
  {
    name: 'github token',
    input: `token ghp_${'a'.repeat(36)} used`,
    kinds: ['api key'],
    count: 1,
    text: 'token [REDACTED: api key] used',
    gone: ['ghp_'],
  },
  {
    name: 'stripe secret key',
    input: `stripe sk_live_${'a'.repeat(24)}`,
    kinds: ['api key'],
    count: 1,
    text: 'stripe [REDACTED: api key]',
    gone: ['sk_live_'],
  },
  {
    name: 'AWS access key id',
    input: 'AKIAIOSFODNN7EXAMPLE',
    kinds: ['api key'],
    count: 1,
    text: '[REDACTED: api key]',
    gone: ['AKIAIOSFODNN7EXAMPLE'],
  },
  {
    name: 'private key block',
    input: [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA7example',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n'),
    kinds: ['private key'],
    count: 1,
    text: '[REDACTED: private key]',
    gone: ['MIIEowIBAAKCAQEA7example'],
  },
  {
    name: 'email address',
    input: 'asked priya@example.com to rotate it',
    kinds: ['email'],
    count: 1,
    text: 'asked [REDACTED: email] to rotate it',
    gone: ['priya@example.com'],
  },
  {
    name: 'labelled Aadhaar number',
    input: 'Aadhaar 1234 5678 9012 on file',
    kinds: ['national id'],
    count: 1,
    text: 'Aadhaar [REDACTED: national id] on file',
    gone: ['1234 5678 9012'],
  },
  {
    name: 'unlabelled Aadhaar is still caught by its checksum',
    input: 'reference 987654321096',
    kinds: ['national id'],
    count: 1,
    text: 'reference [REDACTED: national id]',
    gone: ['987654321096'],
  },
  {
    name: 'labelled phone number',
    input: 'mobile: 98765 43210',
    kinds: ['phone'],
    count: 1,
    text: 'mobile: [REDACTED: phone]',
    gone: ['98765 43210'],
  },
  {
    name: 'phone with country code and no label',
    input: 'reach me on +91 98765 43210',
    kinds: ['phone'],
    count: 1,
    text: 'reach me on [REDACTED: phone]',
    gone: ['98765 43210'],
  },
  {
    name: 'twelve digit phone with country code is a phone, not a national id',
    input: 'call 919876543210 tomorrow',
    kinds: ['phone'],
    count: 1,
    text: 'call [REDACTED: phone] tomorrow',
    gone: ['919876543210'],
  },
  {
    name: 'labelled PAN',
    input: 'PAN ABCDE1234F for the vendor',
    kinds: ['national id'],
    count: 1,
    text: 'PAN [REDACTED: national id] for the vendor',
    gone: ['ABCDE1234F'],
  },
  {
    name: 'card number passes Luhn without a label',
    input: 'stored 4111 1111 1111 1111',
    kinds: ['card'],
    count: 1,
    text: 'stored [REDACTED: card]',
    gone: ['4111 1111 1111 1111'],
  },
];

const negatives = [
  'Decision: Stay on MySQL until Q1 2027 and revisit the ledger.',
  'Invoice INV-2026-004512 dated 2026-11-18T09:00:00Z for 1,25,000.',
  'Order 202611180001 shipped on schedule.',
  'Backlog review: 9876543210 tickets were closed last quarter.',
  'Intel shared 9876543210 benchmark rows.',
  'Excellent rating for 9876500000 sessions.',
  'Japan office reference 202611180001.',
  'The token budget: 42000 stays unchanged.',
  'sort key: ledger-priority',
];

describe('redaction samples', () => {
  it.each(positives)('$name', ({ input, kinds, count, text, gone }) => {
    const result = redactText(input);

    expect(result.text).toBe(text);
    expect(result.count).toBe(count);
    expect(result.kinds).toEqual(kinds);
    for (const value of gone) expect(result.text).not.toContain(value);
  });

  it.each(negatives)('leaves ordinary text alone: %s', (input) => {
    const result = redactText(input);
    expect(result.text).toBe(input);
    expect(result.count).toBe(0);
    expect(result.kinds).toEqual([]);
  });

  it('does not re-redact an existing marker', () => {
    const result = redactText('API_KEY=[REDACTED: credential] already handled');
    expect(result.text).toBe('API_KEY=[REDACTED: credential] already handled');
    expect(result.count).toBe(0);
  });

  it('counts two assignments as two redactions', () => {
    const result = redactText('API_KEY=abc123 SECRET=def456');
    expect(result.text).toBe('API_KEY=[REDACTED: credential] SECRET=[REDACTED: credential]');
    expect(result.count).toBe(2);
    expect(result.kinds).toEqual(['credential']);
  });
});
