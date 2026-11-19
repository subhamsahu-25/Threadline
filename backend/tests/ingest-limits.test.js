import { describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { collectDriveDocuments } from '../src/services/ingest/googleDrive.js';
import {
  MAX_DOCX_ENTRIES,
} from '../src/services/ingest/limits.js';
import { parseFile } from '../src/services/ingest/parsers.js';

const PDF_MAGIC = Buffer.from('%PDF-1.4\n');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

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

function buildZip(files, { overrideUncompressed = {} } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file, index) => {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data ?? '', 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(overrideUncompressed[index] ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += 30 + name.length + data.length;
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

function buildPdf(pageCount) {
  const fontId = 3 + pageCount * 2;
  const chunks = ['%PDF-1.4\n'];
  const offsets = [];
  let length = Buffer.byteLength(chunks[0], 'latin1');
  const add = (id, body) => {
    offsets[id] = length;
    const chunk = `${id} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    length += Buffer.byteLength(chunk, 'latin1');
  };

  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ');
  add(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);

  for (let index = 0; index < pageCount; index += 1) {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const stream = `BT /F1 12 Tf 72 720 Td (Page ${index + 1}: Task - update the rollback guide by Friday.) Tj ET`;
    add(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    add(
      contentId,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
  }
  add(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const xrefOffset = length;
  let xref = `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(xref);
  return Buffer.from(chunks.join(''), 'latin1');
}

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

describe('document parsing limits', () => {
  it('parses a real DOCX in the parser worker', async () => {
    const parsed = await parseFile({ buffer: buildZip(DOCX_PARTS), filename: 'handover.docx' });
    expect(parsed.text).toContain('Update the rollback guide');
    expect(parsed.extension).toBe('.docx');
  });

  it('parses a real PDF in the parser worker', async () => {
    const parsed = await parseFile({ buffer: buildPdf(1), filename: 'notes.pdf' });
    expect(parsed.text).toContain('rollback guide');
  }, 30_000);

  it('rejects a PDF with more pages than the cap', async () => {
    await expectAppError(parseFile({ buffer: buildPdf(301), filename: 'huge.pdf' }), {
      status: 422,
      code: 'too_many_pages',
    });
  }, 60_000);

  it('rejects a .pdf whose bytes are not a PDF', async () => {
    await expectAppError(
      parseFile({ buffer: Buffer.from('Just some plain text that is long enough'), filename: 'fake.pdf' }),
      { status: 415, code: 'file_type_mismatch' },
    );
  });

  it('rejects a .docx whose bytes are not a ZIP', async () => {
    await expectAppError(
      parseFile({ buffer: Buffer.from('Just some plain text that is long enough'), filename: 'fake.docx' }),
      { status: 415, code: 'file_type_mismatch' },
    );
  });

  it('rejects a binary file hiding behind a text extension', async () => {
    await expectAppError(parseFile({ buffer: PDF_MAGIC, filename: 'notes.txt' }), {
      status: 415,
      code: 'file_type_mismatch',
    });
    await expectAppError(
      parseFile({ buffer: Buffer.concat([Buffer.from('hello\0world'), Buffer.alloc(30)]), filename: 'notes.md' }),
      { status: 415, code: 'binary_file' },
    );
    await expectAppError(parseFile({ buffer: ZIP_MAGIC, filename: 'notes.json' }), {
      status: 415,
      code: 'file_type_mismatch',
    });
  });

  it('rejects a DOCX that claims a huge uncompressed size', async () => {
    const buffer = buildZip(DOCX_PARTS, {
      overrideUncompressed: { 1: 200 * 1024 * 1024 },
    });
    await expectAppError(parseFile({ buffer, filename: 'bomb.docx' }), {
      status: 422,
      code: 'document_too_large',
    });
  });

  it('rejects a DOCX with too many archive entries', async () => {
    const parts = [...DOCX_PARTS];
    for (let index = 0; index < MAX_DOCX_ENTRIES; index += 1) {
      parts.push({ name: `word/media/part-${index}.xml`, data: '<x/>' });
    }
    await expectAppError(parseFile({ buffer: buildZip(parts), filename: 'many.docx' }), {
      status: 422,
      code: 'document_too_large',
    });
  });

  it('rejects a ZIP that is not a Word document', async () => {
    const buffer = buildZip([{ name: 'readme.xml', data: '<note>not a docx</note>' }]);
    await expectAppError(parseFile({ buffer, filename: 'archive.docx' }), {
      status: 422,
      code: 'invalid_document',
    });
  });

  it('caps extracted characters and reports the truncation', async () => {
    const parsed = await parseFile({
      buffer: Buffer.from('a'.repeat(env.maxDocumentChars + 50_000), 'utf8'),
      filename: 'long.txt',
    });
    expect(parsed.text.length).toBeLessThanOrEqual(env.maxDocumentChars);
    expect(parsed.warnings.join(' ')).toMatch(/Truncated from/);
  });

  it('rejects a document with no usable text', async () => {
    await expectAppError(parseFile({ buffer: Buffer.from('too short'), filename: 'short.txt' }), {
      status: 422,
      code: 'empty_document',
    });
  });
});

describe('Drive download size guard', () => {
  it('skips an oversized file without downloading its bytes', async () => {
    const previousToken = env.googleDriveToken;
    const previousFolders = env.driveAllowedFolders;
    env.googleDriveToken = 'test-token';
    env.driveAllowedFolders = ['folder-1234567890'];

    const calls = [];
    const fetchMock = vi.fn(async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes('/files?')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'big-file',
                name: 'video-recording.pdf',
                mimeType: 'application/pdf',
                size: String((env.maxUploadMb + 50) * 1024 * 1024),
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ name: 'Allowed folder' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const documents = await collectDriveDocuments('folder-1234567890');
      expect(documents).toEqual([]);
      expect(calls.some((url) => url.includes('alt=media'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      env.googleDriveToken = previousToken;
      env.driveAllowedFolders = previousFolders;
    }
  });
});
