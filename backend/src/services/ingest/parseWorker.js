import { parentPort, workerData } from 'node:worker_threads';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { truncate } from '../../lib/text.js';
import { MAX_DOC_CHARS, MAX_PDF_PAGES } from './limits.js';

const { kind, buffer } = workerData;
const data = Buffer.from(buffer);

function withCharCap(text, warnings) {
  const full = String(text ?? '');
  if (full.length > MAX_DOC_CHARS) {
    warnings.push(
      `Truncated from ${full.length.toLocaleString('en-US')} to ${MAX_DOC_CHARS.toLocaleString('en-US')} characters`,
    );
  }
  return truncate(full, MAX_DOC_CHARS);
}

async function parsePdf() {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  if (pdf.numPages > MAX_PDF_PAGES) {
    parentPort.postMessage({
      ok: false,
      code: 'too_many_pages',
      message: `This PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}. Split it before uploading.`,
    });
    return;
  }
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join('\n\n') : text;
  const warnings = [];
  parentPort.postMessage({ ok: true, text: withCharCap(merged, warnings), warnings });
}

async function parseDocx() {
  const { value, messages } = await mammoth.extractRawText({ buffer: data });
  const warnings = (messages || [])
    .filter((message) => message.type === 'warning')
    .map((message) => message.message)
    .slice(0, 5);
  parentPort.postMessage({ ok: true, text: withCharCap(value, warnings), warnings });
}

try {
  if (kind === 'pdf') await parsePdf();
  else await parseDocx();
} catch (error) {
  parentPort.postMessage({
    ok: false,
    code: 'parse_failed',
    message: error?.message || 'The document could not be parsed',
  });
}
