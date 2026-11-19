import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/index.js';
import { deliverOutbound } from './delivery.js';

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

/**
 * Issues a fresh link and hands it to the configured outbound webhook. Without
 * a provider the delivery row says "skipped" — the product never claims a mail
 * was sent when nothing left the server.
 */
export async function issueEmailVerification(user) {
  const token = signEmailVerificationToken(user);
  const url = verificationUrl(token);
  await deliverOutbound({
    user: user._id,
    kind: 'auth.verify_email',
    text: `Confirm the email address for ${user.name} by opening this link: ${url}`,
    createdBy: user._id,
  });
  return { token, url };
}
