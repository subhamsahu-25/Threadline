import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError, asyncHandler, unauthorized } from '../lib/errors.js';
import { User } from '../models/index.js';

async function userFromRequest(req) {
  const header = req.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;

  const token = header.slice(7).trim();
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw unauthorized('Your session token is invalid or has expired');
  }

  const user = await User.findById(payload.sub);
  if (!user) throw unauthorized('This account no longer exists');
  return user;
}

export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw unauthorized('Provide an Authorization: Bearer <token> header');
  }

  req.user = await userFromRequest(req);
  next();
});

export const authenticateOptional = asyncHandler(async (req, _res, next) => {
  req.user = await userFromRequest(req);
  next();
});

export function requirePlatformAdmin(req, _res, next) {
  if (req.user?.platformRole !== 'admin') {
    return next(new AppError(403, 'forbidden', 'Platform administrator access required'));
  }
  next();
}
