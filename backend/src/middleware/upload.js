import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { extensionOf, isAllowedUpload } from '../services/ingest/parsers.js';

fs.mkdirSync(env.uploadDir, { recursive: true });

/**
 * Multipart headers are decoded as latin1 by busboy, so a Hindi or accented
 * filename arrives as mojibake. Re-decode the bytes as UTF-8; a name that is
 * already valid UTF-8 produces replacement characters and is left untouched.
 */
export function decodeOriginalName(name) {
  const decoded = Buffer.from(String(name || ''), 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? String(name || '') : decoded;
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, env.uploadDir),
  filename: (_req, file, callback) =>
    callback(null, `${Date.now()}-${randomUUID()}${extensionOf(file.originalname)}`),
});

const parser = multer({
  storage,
  limits: {
    fileSize: env.maxUploadMb * 1024 * 1024,
    files: env.maxFilesPerUpload,
  },
  fileFilter: (_req, file, callback) => {
    file.originalname = decodeOriginalName(file.originalname);
    if (!isAllowedUpload(file.originalname)) {
      callback(
        new AppError(415, 'unsupported_file', `Unsupported file type: ${path.basename(file.originalname)}`),
      );
      return;
    }
    callback(null, true);
  },
}).array('files', env.maxFilesPerUpload);

/**
 * Deletes files multer already wrote for a request that failed. Only the
 * generated stored name is used, so a crafted client filename cannot point
 * the deletion outside the upload directory.
 */
export async function discardUploads(files) {
  await Promise.all(
    (files || []).map(async (file) => {
      const storedName = path.basename(file?.filename || '');
      if (!storedName) return;
      await fsp.unlink(path.join(env.uploadDir, storedName)).catch(() => {});
    }),
  );
}

export function uploadFiles(req, res, next) {
  parser(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    discardUploads(req.files).finally(() => next(error));
  });
}
