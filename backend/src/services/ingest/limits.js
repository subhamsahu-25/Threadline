/**
 * Hard limits for untrusted documents. They bound both the parsing work and
 * the amount of text that ever reaches chunking and extraction.
 *
 * The character cap lives in config as MAX_DOCUMENT_CHARS so every parser and
 * connector enforces the same number. These limits cover everything else.
 */
export const MAX_PDF_PAGES = 300;
export const MAX_DOCX_ENTRIES = 2_000;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_DOCX_RATIO = 100;

export const PARSE_TIMEOUT_MS = 20_000;
export const PARSE_MEMORY_MB = 256;
// Buffer memory sits outside the worker heap limit, so a parsing run is also
// stopped when the process RSS climbs past this ceiling.
export const PARSE_RSS_LIMIT_MB = 1024;
