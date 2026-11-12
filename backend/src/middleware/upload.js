import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { extensionOf, isAllowedUpload } from '../services/ingest/parsers.js';

fs.mkdirSync(env.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, env.uploadDir),
  filename: (_req, file, callback) =>
    callback(null, `${Date.now()}-${randomUUID()}${extensionOf(file.originalname)}`),
});

export const uploadFiles = multer({
  storage,
  limits: {
    fileSize: env.maxUploadMb * 1024 * 1024,
    files: env.maxFilesPerUpload,
  },
  fileFilter: (_req, file, callback) => {
    if (!isAllowedUpload(file.originalname)) {
      callback(
        new AppError(415, 'unsupported_file', `Unsupported file type: ${path.basename(file.originalname)}`),
      );
      return;
    }
    callback(null, true);
  },
}).array('files', env.maxFilesPerUpload);
