import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { docxText, pdfText, scanText } from '../../scripts/check-secrets.mjs';

// Values are assembled at runtime so this test file is not itself a fixture
// that the scanner has to exempt.
const googleKey = ['AIza', 'Z'.repeat(35)].join('');
const ownerPassword = ['RealOwner', 'Password#9'].join('');

function storedZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuffer = Buffer.from(name);
    const body = Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);

    parts.push(local, nameBuffer, body);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function pdfWithStream(text) {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 0 >>\nstream\n', 'latin1'),
    deflateSync(Buffer.from(text, 'latin1')),
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
}

describe('P9 secret scanner', () => {
  it('finds a credential assigned in a test fixture unless the value is named', () => {
    const fixture = `password: '${ownerPassword}',`;
    expect(scanText('backend/tests/example.test.js', fixture)).toEqual([
      { file: 'backend/tests/example.test.js', line: 1, kind: 'credential assignment' },
    ]);

    const named = "password: 'Threadline#2026',";
    expect(scanText('backend/tests/example.test.js', named)).toEqual([]);
  });

  it('finds JWT signing keys and skips visible placeholders', () => {
    const assignment = ['JWT_SECRET=', 'deadbeefcafebabe'].join('');
    expect(scanText('backend/.env.example', assignment)).toEqual([
      { file: 'backend/.env.example', line: 1, kind: 'credential environment variable' },
    ]);

    const placeholder = 'JWT_SECRET=replace-with-a-long-random-string';
    expect(scanText('backend/.env.example', placeholder)).toEqual([]);
  });

  it('extracts text from a DOCX before scanning it', () => {
    const docx = storedZip([
      ['word/document.xml', `<w:document><w:body><w:p><w:t>Key ${googleKey}</w:t></w:p></w:body></w:document>`],
    ]);
    expect(scanText('docs/report.docx', docxText(docx))).toEqual([
      { file: 'docs/report.docx', line: 1, kind: 'Google API key' },
    ]);
  });

  it('extracts text from a compressed PDF stream before scanning it', () => {
    const pdf = pdfWithStream(`token ${googleKey} used`);
    const findings = scanText('docs/report.pdf', pdfText(pdf));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'docs/report.pdf', kind: 'Google API key' });
  });
});
