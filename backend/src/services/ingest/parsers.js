import path from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { AppError } from '../../lib/errors.js';
import { normalizeWhitespace } from '../../lib/text.js';

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

async function parsePdf(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return { text: Array.isArray(text) ? text.join('\n\n') : text, warnings: [] };
}

async function parseDocx(buffer) {
  const { value, messages } = await mammoth.extractRawText({ buffer });
  const warnings = (messages || [])
    .filter((message) => message.type === 'warning')
    .map((message) => message.message)
    .slice(0, 5);
  return { text: value, warnings };
}

function parseCsvRows(input, maxRows = 501) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let truncated = false;

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
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= maxRows) {
        truncated = input.slice(index + 1).trim().length > 0;
        break;
      }
    } else if (char !== '\r') {
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
  const { rows, truncated } = parseCsvRows(text);
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
  const text = stripBom(buffer.toString('utf8'));
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

  let parsed;
  if (extension === '.pdf') parsed = await parsePdf(buffer);
  else if (extension === '.docx') parsed = await parseDocx(buffer);
  else parsed = await parsePlain(buffer, extension);

  const text = normalizeWhitespace(parsed.text);
  if (text.length < 20) {
    throw new AppError(
      422,
      'empty_document',
      `No usable text could be extracted from ${filename}. Scanned PDFs need OCR first.`,
    );
  }

  return { text, warnings: parsed.warnings, extension };
}
