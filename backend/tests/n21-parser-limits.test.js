import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { MAX_DOCX_UNCOMPRESSED_BYTES } from '../src/services/ingest/limits.js';
import { parseFile } from '../src/services/ingest/parsers.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files, { deflate = {}, overrideUncompressed = {} } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file, index) => {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data ?? '', 'utf8');
    const compressed = deflate[index] ? zlib.deflateRawSync(raw) : raw;
    const method = deflate[index] ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(overrideUncompressed[index] ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += 30 + name.length + compressed.length;
  });

  const directory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, directory, eocd]);
}

const DOCX_PARTS = [
  {
    name: '[Content_Types].xml',
    data:
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  },
  {
    name: 'word/document.xml',
    data:
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Task: Update the rollback guide (owner: Priya, due: 2026-12-01)</w:t></w:r></w:p></w:body></w:document>',
  },
];

async function expectAppError(promise, { status, code }) {
  try {
    await promise;
  } catch (error) {
    expect(error.name).toBe('AppError');
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error('Expected the promise to reject');
}

describe('N21 parser limits', () => {
  const originalCap = env.maxDocumentChars;

  afterEach(() => {
    env.maxDocumentChars = originalCap;
  });

  it('reads a deflated DOCX whose declared sizes are honest', async () => {
    const parsed = await parseFile({
      buffer: buildZip(DOCX_PARTS, { deflate: { 0: true, 1: true } }),
      filename: 'deflated.docx',
    });
    expect(parsed.text).toContain('Update the rollback guide');
  }, 60_000);

  it('measures the real inflated size instead of trusting the archive', async () => {
    const oversized = 'A'.repeat(MAX_DOCX_UNCOMPRESSED_BYTES + 1_000_000);
    const buffer = buildZip(
      [DOCX_PARTS[0], { name: 'word/document.xml', data: oversized }],
      // The central directory claims a tiny part while the deflate stream
      // really expands past the limit.
      { deflate: { 1: true }, overrideUncompressed: { 1: 1_024 } },
    );

    await expectAppError(parseFile({ buffer, filename: 'forged.docx' }), {
      status: 422,
      code: 'document_too_large',
    });
  }, 120_000);

  it('applies one configured character cap to every parser', async () => {
    env.maxDocumentChars = 5_000;
    const parsed = await parseFile({
      buffer: Buffer.from('b'.repeat(7_500), 'utf8'),
      filename: 'notes.txt',
    });

    expect(parsed.text.length).toBe(5_000);
    expect(parsed.warnings.join(' ')).toMatch(/Truncated from 7,500 to 5,000 characters/);
  });
});
