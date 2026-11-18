/**
 * Hard limits for untrusted documents. They bound both the parsing work and
 * the amount of text that ever reaches chunking and extraction.
 */
export const MAX_PDF_PAGES = 300;
export const MAX_DOC_CHARS = 200_000;
export const MAX_DOCX_ENTRIES = 2_000;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_DOCX_RATIO = 100;

export const PARSE_TIMEOUT_MS = 20_000;
export const PARSE_MEMORY_MB = 256;
