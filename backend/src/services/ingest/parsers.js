import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { AppError } from '../../lib/errors.js';
import { normalizeWhitespace, truncate } from '../../lib/text.js';
import {
  MAX_DOC_CHARS,
  MAX_DOCX_ENTRIES,
  MAX_DOCX_RATIO,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  PARSE_MEMORY_MB,
  PARSE_TIMEOUT_MS,
} from './limits.js';

export const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.json',
  '.pdf',
  '.docx',
]);

export function extensionOf(filename) {
  return path.extname(filename || '').toLowerCase();
}

export function isAllowedUpload(filename) {
  return ALLOWED_EXTENSIONS.has(extensionOf(filename));
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const UTF16_LE_MAGIC = [0xff, 0xfe];
const UTF16_BE_MAGIC = [0xfe, 0xff];
const UTF8_BOM_MAGIC = [0xef, 0xbb, 0xbf];

/**
 * Real-world exports use more than UTF-8: Excel writes UTF-16 with a BOM and
 * Windows tools write cp1252. Decode from the bytes instead of assuming.
 */
export function decodeText(buffer) {
  if (startsWith(buffer, UTF16_LE_MAGIC)) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (startsWith(buffer, UTF16_BE_MAGIC)) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  const body = startsWith(buffer, UTF8_BOM_MAGIC) ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // Not valid UTF-8; cp1252 is the common fallback for older Windows files.
    return new TextDecoder('windows-1252').decode(body);
  }
}

/**
 * Trusts the bytes rather than the filename. A wrong magic number usually
 * means the extension is misleading (or the upload is not what it claims),
 * so it is rejected before any parser touches it.
 */
function assertContentMatchesExtension(extension, buffer) {
  const isPdf = startsWith(buffer, PDF_MAGIC);
  const isZip = startsWith(buffer, ZIP_MAGIC);

  if (extension === '.pdf' && !isPdf) {
    throw new AppError(
      415,
      'file_type_mismatch',
      'This file is named .pdf but its contents are not a PDF. Convert it to PDF and upload again.',
    );
  }
  if (extension === '.docx' && !isZip) {
    throw new AppError(
      415,
      'file_type_mismatch',
      'This file is named .docx but its contents are not a Word document. Save it as .docx and upload again.',
    );
  }
  if (extension !== '.pdf' && extension !== '.docx') {
    if (isPdf || isZip) {
      throw new AppError(
        415,
        'file_type_mismatch',
        `This file is named ${extension} but contains a binary document. Upload it with its real extension.`,
      );
    }
    // UTF-16 text legitimately contains NUL bytes; its BOM identifies it.
    const isUtf16 = startsWith(buffer, UTF16_LE_MAGIC) || startsWith(buffer, UTF16_BE_MAGIC);
    if (!isUtf16 && buffer.includes(0)) {
      throw new AppError(415, 'binary_file', `This file is named ${extension} but contains binary data.`);
    }
  }
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

/**
 * Reads the ZIP central directory without inflating anything, so a DOCX bomb
 * is rejected before mammoth allocates the declared uncompressed size.
 */
function readDocxArchiveStats(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw new AppError(422, 'invalid_document', 'This DOCX is not a readable ZIP archive. Re-save it and try again.');
  }

  const disk = buffer.readUInt16LE(eocd + 4);
  const directoryDisk = buffer.readUInt16LE(eocd + 6);
  const declaredEntries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    declaredEntries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new AppError(422, 'invalid_document', 'This DOCX uses an unsupported ZIP layout. Re-save it and try again.');
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new AppError(422, 'invalid_document', 'This DOCX archive is truncated or malformed.');
  }

  let offset = directoryOffset;
  let entries = 0;
  let uncompressedBytes = 0;
  let hasDocumentPart = false;

  while (offset + 46 <= directoryOffset + directorySize && entries < declaredEntries) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw new AppError(422, 'invalid_document', 'This DOCX uses an unsupported ZIP layout. Re-save it and try again.');
    }

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      throw new AppError(422, 'invalid_document', 'This DOCX archive is truncated or malformed.');
    }
    const name = buffer.toString('utf8', nameStart, nameEnd).replace(/\\/g, '/');
    if (name === 'word/document.xml') hasDocumentPart = true;

    entries += 1;
    uncompressedBytes += uncompressedSize;
    offset = nameEnd + extraLength + commentLength;
  }

  return { entries, uncompressedBytes, hasDocumentPart };
}

function assertDocxWithinLimits(buffer) {
  const stats = readDocxArchiveStats(buffer);
  if (!stats.hasDocumentPart) {
    throw new AppError(
      422,
      'invalid_document',
      'This file is a ZIP archive but not a Word document. Upload the original .docx or a PDF.',
    );
  }

  const ratio = buffer.length > 0 ? stats.uncompressedBytes / buffer.length : 0;
  const tooManyEntries = stats.entries > MAX_DOCX_ENTRIES;
  const tooLarge = stats.uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES;
  const suspiciousRatio = stats.uncompressedBytes > 4 * 1024 * 1024 && ratio > MAX_DOCX_RATIO;

  if (tooManyEntries || tooLarge || suspiciousRatio) {
    throw new AppError(
      422,
      'document_too_large',
      'This DOCX expands to more content than the ingestion limit allows. Split it into smaller files and upload again.',
    );
  }
}

function parseInWorker(kind, buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parseWorker.js', import.meta.url), {
      workerData: { kind, buffer },
      resourceLimits: { maxOldGenerationSizeMb: PARSE_MEMORY_MB },
    });

    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      callback();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new AppError(
            422,
            'document_too_complex',
            `Parsing took longer than ${Math.round(PARSE_TIMEOUT_MS / 1000)} seconds. Split the document and upload again.`,
          ),
        ),
      );
    }, PARSE_TIMEOUT_MS);
    timer.unref?.();

    worker.once('message', (message) => {
      finish(() => {
        if (message?.ok) {
          resolve({ text: message.text ?? '', warnings: message.warnings || [] });
          return;
        }
        reject(
          new AppError(
            422,
            message?.code || 'parse_failed',
            message?.message || 'The document could not be parsed',
          ),
        );
      });
    });

    worker.once('error', (error) => {
      finish(() => {
        const outOfMemory = error?.code === 'ERR_WORKER_OUT_OF_MEMORY';
        reject(
          new AppError(
            422,
            outOfMemory ? 'document_too_complex' : 'parse_failed',
            outOfMemory
              ? 'This document needs more memory than the parser allows. Split it and upload again.'
              : error?.message || 'The document could not be parsed',
          ),
        );
      });
    });

    worker.once('exit', (code) => {
      finish(() =>
        reject(
          new AppError(
            422,
            'parse_failed',
            `The parser stopped unexpectedly${code == null ? '' : ` (exit code ${code})`}.`,
          ),
        ),
      );
    });
  });
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || '';
  let quoted = false;
  const counts = new Map();
  for (const char of firstLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && [',', ';', '\t', '|'].includes(char)) {
      counts.set(char, (counts.get(char) || 0) + 1);
    }
  }
  let best = ',';
  let bestCount = 0;
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function parseCsvRows(input, delimiter = ',', maxRows = 501) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let truncated = false;

  const endRow = (index) => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    if (rows.length >= maxRows) {
      truncated = input.slice(index + 1).trim().length > 0;
      return true;
    }
    return false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      if (endRow(index)) break;
    } else if (char === '\r') {
      // Old-Mac exports end rows with a bare CR; CRLF is handled by the LF.
      if (input[index + 1] === '\n') continue;
      if (endRow(index)) break;
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows, truncated };
}

const KNOWN_ROW_TYPES = new Set([
  'decision',
  'task',
  'risk',
  'dependency',
  'question',
  'milestone',
  'responsibility',
]);

/**
 * Turns a task/decision spreadsheet into readable, labelled records so the
 * extractor sees the same explicit structure it gets from meeting notes.
 */
function normalizeCsv(text) {
  const { rows, truncated } = parseCsvRows(text, detectDelimiter(text));
  if (rows.length < 2) return { text, warnings: ['CSV has no data rows'] };

  const headers = rows[0].map((header) => header.trim());
  const pick = (row, pattern) => {
    const index = headers.findIndex((header) => pattern.test(header));
    return index >= 0 ? String(row[index] ?? '').trim() : '';
  };

  const lines = ['# Spreadsheet export', ''];
  for (const row of rows.slice(1)) {
    const rowType = pick(row, /^(type|kind|label|category)$/i).toLowerCase();
    const statement = pick(row, /^(task|title|summary|description|item|statement)$/i);
    const owner = pick(row, /(owner|assignee)/i);
    const due = pick(row, /(due|deadline)/i);
    const status = pick(row, /^(status|state)$/i);

    if (KNOWN_ROW_TYPES.has(rowType) && statement) {
      const meta = [
        owner && `owner: ${owner}`,
        due && `due: ${due}`,
        status && `status: ${status}`,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`${rowType[0].toUpperCase()}${rowType.slice(1)}: ${statement}${meta ? ` (${meta})` : ''}`);
    } else {
      const cells = headers
        .map((header, index) => `${header}: ${String(row[index] ?? '').trim()}`)
        .filter((cell) => !cell.endsWith(': '))
        .join('; ');
      if (cells) lines.push(`- ${cells}`);
    }
  }

  const warnings = truncated
    ? [`Only the first ${rows.length - 1} data rows were ingested`]
    : [];
  if (lines.length <= 2) return { text, warnings: [...warnings, 'CSV had no usable rows'] };
  return { text: lines.join('\n'), warnings };
}

async function parsePlain(buffer, extension) {
  const text = stripBom(decodeText(buffer));
  if (extension === '.json') {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), warnings: [] };
    } catch {
      return { text, warnings: ['JSON could not be parsed; ingested as raw text'] };
    }
  }
  if (extension === '.csv') return normalizeCsv(text);
  return { text, warnings: [] };
}

export async function parseFile({ buffer, filename }) {
  const extension = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new AppError(
      415,
      'unsupported_file',
      `Unsupported file type "${extension || filename}"`,
      { allowed: [...ALLOWED_EXTENSIONS] },
    );
  }

  assertContentMatchesExtension(extension, buffer);

  let parsed;
  if (extension === '.pdf') {
    parsed = await parseInWorker('pdf', buffer);
  } else if (extension === '.docx') {
    assertDocxWithinLimits(buffer);
    parsed = await parseInWorker('docx', buffer);
  } else {
    parsed = await parsePlain(buffer, extension);
  }

  let text = normalizeWhitespace(parsed.text);
  const warnings = [...(parsed.warnings || [])];
  if (text.length > MAX_DOC_CHARS) {
    warnings.push(
      `Truncated from ${text.length.toLocaleString('en-US')} to ${MAX_DOC_CHARS.toLocaleString('en-US')} characters`,
    );
    text = truncate(text, MAX_DOC_CHARS);
  }
  if (text.length < 20) {
    const message =
      extension === '.pdf'
        ? `No usable text could be extracted from ${filename}. Scanned PDFs need OCR first.`
        : `No usable text could be extracted from ${filename}: it contains only ${text.length} characters. Add the project context and upload it again.`;
    throw new AppError(422, 'empty_document', message);
  }

  return { text, warnings, extension };
}
