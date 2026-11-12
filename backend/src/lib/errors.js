export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed', details) =>
  new AppError(403, 'forbidden', message, details);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message, details) => new AppError(409, 'conflict', message, details);
export const unprocessable = (message, details) =>
  new AppError(422, 'unprocessable', message, details);

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
