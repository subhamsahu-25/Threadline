import jwt from 'jsonwebtoken';
import { env, isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { User } from '../models/index.js';
import { mailConfigured, sendVerificationEmail } from './mailer.js';

const PURPOSE = 'email_verify';

/**
 * The link proves control of the mailbox, so the token is signed with the
 * deployment secret and carries the address it was issued for. Any token for
 * another address is refused even if the signature is valid.
 */
export function signEmailVerificationToken(user, { expiresIn } = {}) {
  return jwt.sign(
    { sub: String(user._id), email: user.email, purpose: PURPOSE },
    env.jwtSecret,
    { expiresIn: expiresIn || `${env.emailVerificationTtlHours}h`, algorithm: 'HS256' },
  );
}

export function verificationUrl(token) {
  return `${env.publicAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
}

export function readEmailVerificationToken(token) {
  let payload;
  try {
    payload = jwt.verify(String(token || ''), env.jwtSecret, { algorithms: ['HS256'] });
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'TokenExpiredError' ? 'expired' : 'invalid',
    };
  }
  if (payload?.purpose !== PURPOSE || !payload.sub || !payload.email) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, userId: String(payload.sub), email: String(payload.email).toLowerCase() };
}

/**
 * Marks the account verified only when the token belongs to that account and
 * names the address currently on it. Re-clicking a link is a success, not an
 * error, so a mail client prefetch cannot spoil the real click.
 */
export async function verifyEmailToken(token) {
  const parsed = readEmailVerificationToken(token);
  if (!parsed.ok) return parsed;

  const user = await User.findById(parsed.userId);
  if (!user || String(user.email).toLowerCase() !== parsed.email) {
    return { ok: false, reason: 'invalid' };
  }
  if (user.emailVerifiedAt) {
    return { ok: true, alreadyVerified: true, user };
  }

  user.emailVerifiedAt = new Date();
  await user.save();
  return { ok: true, alreadyVerified: false, user };
}

export function buildEmailVerification(user) {
  const token = signEmailVerificationToken(user);
  return { token, url: verificationUrl(token) };
}

/**
 * Outside production, a deployment without a mail transport returns the link
 * to the caller who just typed the address. Nobody else ever sees it.
 */
export function returnsVerificationLink() {
  return !isProd && !mailConfigured();
}

const inflight = new Set();

/**
 * Delivery runs after the response, so a slow provider does not make account
 * creation wait (or reveal, by timing, whether the address existed). Tests and
 * callers that need the record can wait for whenVerificationMailIdle().
 */
export function scheduleVerificationEmail(user) {
  const { token, url } = buildEmailVerification(user);
  const job = new Promise((resolve) => {
    setImmediate(async () => {
      try {
        await sendVerificationEmail(user, url);
      } catch (error) {
        logger.warn({ error: error?.name }, 'Verification mail could not be sent');
      }
      resolve();
    });
  });
  inflight.add(job);
  job.finally(() => inflight.delete(job));
  return { token, url };
}

export async function whenVerificationMailIdle() {
  await Promise.allSettled([...inflight]);
}

/**
 * Issues a fresh link and delivers it. Callers that cannot wait use
 * scheduleVerificationEmail instead.
 */
export async function issueEmailVerification(user) {
  const { token, url } = scheduleVerificationEmail(user);
  await whenVerificationMailIdle();
  return { token, url };
}
