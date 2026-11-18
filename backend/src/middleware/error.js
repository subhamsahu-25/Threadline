import { logger } from '../lib/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'route_not_found', message: `No route matches ${req.method} ${req.originalUrl}` },
  });
}

function multerToHttp(error) {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return { status: 413, code: 'file_too_large', message: 'One of the uploaded files is too large' };
  }
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return { status: 400, code: 'too_many_files', message: 'Too many files in this upload' };
  }
  return { status: 400, code: 'upload_failed', message: error.message };
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error?.name === 'MulterError') {
    const mapped = multerToHttp(error);
    return res.status(mapped.status).json({ error: mapped });
  }

  if (error?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
  }

  if (error?.name === 'CastError') {
    return res
      .status(400)
      .json({ error: { code: 'invalid_id', message: `Invalid value for ${error.path}` } });
  }

  if (error?.name === 'ValidationError' && error.errors) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'The request contains invalid fields',
        details: Object.values(error.errors).map((entry) => ({
          path: entry.path,
          message: entry.message,
        })),
      },
    });
  }

  if (error?.code === 11000) {
    return res.status(409).json({
      error: { code: 'duplicate', message: 'A record with those values already exists' },
    });
  }

  if (error?.name === 'VersionError' || error?.name === 'ParallelSaveError') {
    return res.status(409).json({
      error: {
        code: 'version_conflict',
        message: 'This handover changed in another session. Reload it and try again.',
      },
    });
  }

  const status = error?.status && error.status >= 400 ? error.status : 500;
  if (status >= 500) {
    logger.error(
      { method: req.method, path: req.originalUrl, code: error?.code, error: error?.message, stack: error?.stack },
      'Unhandled request error',
    );
  }

  return res.status(status).json({
    error: {
      code: error?.code || (status >= 500 ? 'internal_error' : 'request_error'),
      message: status >= 500 ? 'Something went wrong while processing the request' : error.message,
      ...(error?.details ? { details: error.details } : {}),
    },
  });
}
