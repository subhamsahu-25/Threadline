import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError, asyncHandler, unauthorized } from '../lib/errors.js';
import { Session, User } from '../models/index.js';

async function userFromRequest(req) {
  const header = req.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;

  const token = header.slice(7).trim();
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Your session token is invalid or has expired');
  }

  if (!payload.jti) {
    throw unauthorized('Your session has ended. Sign in again.');
  }

  const user = await User.findById(payload.sub);
  if (!user) throw unauthorized('This account no longer exists');
  if ((payload.tv || 0) !== (user.tokenVersion || 0)) {
    throw unauthorized('Your session has been revoked. Sign in again.');
  }

  const session = await Session.findOne({
    jti: payload.jti,
    user: user._id,
    revokedAt: null,
  }).lean();
  if (!session) throw unauthorized('Your session has ended. Sign in again.');

  return { user, payload };
}

export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw unauthorized('Provide an Authorization: Bearer <token> header');
  }

  const result = await userFromRequest(req);
  req.user = result.user;
  req.auth = result.payload;
  next();
});

export const authenticateOptional = asyncHandler(async (req, _res, next) => {
  const result = await userFromRequest(req);
  req.user = result?.user || null;
  req.auth = result?.payload || null;
  next();
});

// Share links must keep working for a visitor whose stored session has gone
// stale, so a broken token is treated as "not signed in" instead of a 401.
export const authenticateIfPresent = asyncHandler(async (req, _res, next) => {
  try {
    const result = await userFromRequest(req);
    req.user = result?.user || null;
    req.auth = result?.payload || null;
  } catch {
    req.user = null;
    req.auth = null;
  }
  next();
});

export function requirePlatformAdmin(req, _res, next) {
  if (req.user?.platformRole !== 'admin') {
    return next(new AppError(403, 'forbidden', 'Platform administrator access required'));
  }
  next();
}
