import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createInflateRaw } from 'node:zlib';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { normalizeWhitespace, truncate } from '../../lib/text.js';
import {
  MAX_DOCX_ENTRIES,
  MAX_DOCX_RATIO,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  PARSE_MEMORY_MB,
  PARSE_RSS_LIMIT_MB,
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
  const parts = [];

  while (offset + 46 <= directoryOffset + directorySize && entries < declaredEntries) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
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

    parts.push({ name, flags, method, compressedSize, localOffset });
    entries += 1;
    uncompressedBytes += uncompressedSize;
    offset = nameEnd + extraLength + commentLength;
  }

  return { entries, uncompressedBytes, hasDocumentPart, parts };
}

function zipEntryDataOffset(buffer, part) {
  const local = part.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new AppError(422, 'invalid_document', 'This DOCX archive is truncated or malformed.');
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  if (start > buffer.length) {
    throw new AppError(422, 'invalid_document', 'This DOCX archive is truncated or malformed.');
  }
  return start;
}

/**
 * The central directory is attacker-controlled metadata. Inflate each entry
 * for real with a running byte counter, so a forged "small" declaration
 * cannot smuggle a decompression bomb past the limit.
 */
function inflateWithinBudget(buffer, start, end, budget) {
  return new Promise((resolve, reject) => {
    if (budget <= 0) {
      reject(
        new AppError(
          422,
          'document_too_large',
          'This DOCX expands to more content than the ingestion limit allows. Split it into smaller files and upload again.',
        ),
      );
      return;
    }

    const inflate = createInflateRaw();
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      inflate.destroy();
      reject(error);
    };

    inflate.on('data', (chunk) => {
      total += chunk.length;
      if (total > budget) {
        fail(
          new AppError(
            422,
            'document_too_large',
            'This DOCX expands to more content than the ingestion limit allows. Split it into smaller files and upload again.',
          ),
        );
      }
    });
    inflate.on('error', () =>
      fail(new AppError(422, 'invalid_document', 'This DOCX archive could not be read. Re-save it and try again.')),
    );
    inflate.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(total);
    });

    const step = 64 * 1024;
    try {
      for (let offset = start; offset < end && !settled; offset += step) {
        inflate.write(buffer.subarray(offset, Math.min(offset + step, end)));
      }
      inflate.end();
    } catch {
      fail(new AppError(422, 'invalid_document', 'This DOCX archive could not be read. Re-save it and try again.'));
    }
  });
}

async function assertDocxRealSize(buffer, parts) {
  let total = 0;
  for (const part of parts) {
    if (part.name.endsWith('/')) continue;
    if (part.flags & 0x1) {
      throw new AppError(422, 'invalid_document', 'This DOCX is encrypted. Remove the password and upload it again.');
    }

    if (part.method === 0) {
      total += part.compressedSize;
    } else if (part.method === 8) {
      const start = zipEntryDataOffset(buffer, part);
      const end = part.compressedSize > 0 ? Math.min(buffer.length, start + part.compressedSize) : buffer.length;
      total += await inflateWithinBudget(buffer, start, end, MAX_DOCX_UNCOMPRESSED_BYTES - total);
    } else {
      throw new AppError(
        422,
        'invalid_document',
        'This DOCX uses a compression method the reader does not support. Re-save it and try again.',
      );
    }

    if (total > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new AppError(
        422,
        'document_too_large',
        'This DOCX expands to more content than the ingestion limit allows. Split it into smaller files and upload again.',
      );
    }
  }
}

async function assertDocxWithinLimits(buffer) {
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

  await assertDocxRealSize(buffer, stats.parts);
}

function parseInWorker(kind, buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parseWorker.js', import.meta.url), {
      workerData: { kind, buffer },
      resourceLimits: { maxOldGenerationSizeMb: PARSE_MEMORY_MB },
    });

    let settled = false;
    let rssWatch = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(rssWatch);
      worker.terminate();
      callback();
    };

    // Buffer memory is allocated outside the worker's JavaScript heap, so the
    // heap limit alone cannot stop a decompression bomb. A process-wide RSS
    // sample ends the run when memory keeps climbing anyway.
    rssWatch = setInterval(() => {
      if (process.memoryUsage().rss <= PARSE_RSS_LIMIT_MB * 1024 * 1024) return;
      finish(() =>
        reject(
          new AppError(
            422,
            'document_too_complex',
            'This document needs more memory than the parser allows. Split it and upload again.',
          ),
        ),
      );
    }, 250);
    rssWatch.unref?.();

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
    await assertDocxWithinLimits(buffer);
    parsed = await parseInWorker('docx', buffer);
  } else {
    parsed = await parsePlain(buffer, extension);
  }

  let text = normalizeWhitespace(parsed.text);
  const warnings = [...(parsed.warnings || [])];
  const maxChars = env.maxDocumentChars;
  if (text.length > maxChars) {
    warnings.push(
      `Truncated from ${text.length.toLocaleString('en-US')} to ${maxChars.toLocaleString('en-US')} characters`,
    );
    text = truncate(text, maxChars);
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
