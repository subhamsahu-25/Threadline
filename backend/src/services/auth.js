import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Session } from '../models/index.js';

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user, { jti } = {}) {
  const payload = {
    sub: String(user._id),
    email: user.email,
    tv: user.tokenVersion || 0,
  };
  if (jti) payload.jti = jti;
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

/**
 * Issues a token and records the session it belongs to. Revoking that one
 * row ends this sign-in only; other devices keep their own sessions.
 */
export async function issueSession(user, req) {
  const jti = randomUUID();
  const token = signToken(user, { jti });
  const decoded = jwt.decode(token);
  const expiresAt = decoded?.exp
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + 12 * 3_600_000);

  await Session.create({
    jti,
    user: user._id,
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 300),
    ip: String(req?.ip || '').slice(0, 100),
    lastSeenAt: new Date(),
    expiresAt,
  });

  return token;
}

export async function revokeSession(userId, jti) {
  if (!jti) return;
  await Session.updateOne(
    { user: userId, jti, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllSessions(userId) {
  await Session.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export function publicUser(user) {
  const data = user.toJSON ? user.toJSON() : { ...user };
  delete data.passwordHash;
  if (!data.id && data._id) data.id = String(data._id);
  delete data._id;
  return data;
}
