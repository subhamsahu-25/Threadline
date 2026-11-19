import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { env, isTest } from '../config/env.js';
import { AppError, asyncHandler, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { LoginThrottle, Session, User } from '../models/index.js';
import { recordAudit } from '../services/audit.js';
import {
  hashPassword,
  issueSession,
  publicUser,
  revokeAllSessions,
  revokeSession,
  verifyPassword,
} from '../services/auth.js';
import { notifyAccountLockout } from '../services/notifications.js';
import { isBreachedOnline } from '../services/passwordPolicy.js';
import {
  issueEmailVerification,
  verifyEmailToken,
} from '../services/verification.js';
import {
  loginSchema,
  registerSchema,
  resendVerificationSchema,
} from '../validation/schemas.js';

const router = Router();

// Compared against when the email is unknown so both paths pay one bcrypt
// check. The value is a hash of a random phrase, never a usable password.
const DUMMY_HASH = '$2b$12$dcZVVi8hyDKbvCwIF0GgJ.4AA9R1KE/wOJb9DwzPeKdSKR8//iVnm';

/**
 * Credential endpoints are throttled twice: once per source IP so one client
 * cannot spray many accounts, and once per email so an account cannot be
 * attacked from many addresses. Successful requests are not counted, so the
 * demo's persona switcher and shared-NAT evaluators are not locked out.
 */
function limitHandler(_req, res) {
  // Identical for both limiters and for unknown/wrong credentials.
  res.status(429).json({
    error: {
      code: 'too_many_attempts',
      message: 'Too many sign-in attempts. Try again in a few minutes.',
    },
  });
}

const ipLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.ip,
  handler: limitHandler,
});

const emailLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    return email || `no-email:${req.ip}`;
  },
  handler: limitHandler,
});

function digest(value) {
  return createHash('sha256').update(String(value ?? '')).digest();
}

// Confirmation mail is a side effect a caller can trigger repeatedly, so this
// one counts every request rather than skipping successes.
const verificationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: (req) => req.ip,
  handler: limitHandler,
});

/**
 * Registration is CPU-expensive (bcrypt cost 12) and creates database rows, so
 * every request counts, successful or not. The sign-in limiters deliberately
 * skip successes; sharing that setting here let a script mint accounts freely.
 * New accounts still stay unverified until the mailbox owner follows the link.
 */
export function createRegistrationLimiter({ skip = () => isTest } = {}) {
  return rateLimit({
    windowMs: 60 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip,
    keyGenerator: (req) => req.ip,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'too_many_attempts',
          message: 'Too many account registrations from this address. Try again later.',
        },
      });
    },
  });
}

const registrationLimiter = createRegistrationLimiter();/**
 * Lockout is scoped to the account and the client that kept guessing. The
 * account alone is not enough: a stranger could otherwise lock the real owner
 * out from another network, and every demo persona could be taken offline.
 */
function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 100);
}

function failureDelayMs(attempts) {
  if (attempts < 2) return 0;
  return Math.min(1500, 250 * 2 ** (attempts - 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A caller who already holds a live session for this account proves they are
 * the owner, so the throttle on this device is cleared instead of locking a
 * person out of their own account.
 */
async function holdsKnownSession(req, user) {
  const header = req.get?.('authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  try {
    const payload = jwt.verify(header.slice(7), env.jwtSecret, { algorithms: ['HS256'] });
    if (String(payload.sub) !== String(user._id)) return false;
    if (Number(payload.tv || 0) !== Number(user.tokenVersion || 0)) return false;
    if (!payload.jti) return false;
    const session = await Session.findOne({
      jti: payload.jti,
      user: user._id,
      revokedAt: null,
    });
    return Boolean(session && session.expiresAt.getTime() > Date.now());
  } catch {
    return false;
  }
}

async function recordFailure(user, client) {
  let row;
  try {
    row = await LoginThrottle.findOneAndUpdate(
      { user: user._id, client },
      { $inc: { attempts: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    // Two first failures at once can race on the unique index; the loser
    // still has to count its attempt.
    if (error.code !== 11000) throw error;
    row = await LoginThrottle.findOneAndUpdate(
      { user: user._id, client },
      { $inc: { attempts: 1 } },
      { new: true },
    );
  }
  if (!row || row.attempts < env.loginMaxAttempts) {
    return { attempts: row?.attempts ?? 1, lockedUntil: null };
  }
  const lockedUntil = new Date(Date.now() + env.loginLockoutMinutes * 60_000);
  await LoginThrottle.updateOne(
    { _id: row._id },
    { $set: { attempts: 0, lockUntil: lockedUntil } },
  );
  return { attempts: row.attempts, lockedUntil };
}

/**
 * An invite entry may be a bare code or `CODE:address`. A bound entry only
 * admits that address, so forwarding the code cannot give somebody else a
 * membership under the invited person's name. Every entry is compared so
 * timing does not reveal which (or how many) matched.
 */
function inviteEntries() {
  return env.registrationInviteCodes.map((entry) => {
    const separator = entry.lastIndexOf(':');
    const bound = separator > 0 ? entry.slice(separator + 1).trim() : '';
    if (bound.includes('@')) {
      return { code: entry.slice(0, separator), email: bound.toLowerCase() };
    }
    return { code: entry, email: null };
  });
}

function inviteMatches(candidate, email) {
  const provided = digest(candidate);
  const address = String(email || '').toLowerCase().trim();
  let matched = false;
  for (const entry of inviteEntries()) {
    const codeMatch = timingSafeEqual(provided, digest(entry.code));
    const emailMatch = entry.email === null || entry.email === address;
    if (codeMatch && emailMatch) matched = true;
  }
  return matched;
}

/**
 * Non-demo production deployments default to invite-only. The checks run
 * before the account lookup, so an invalid invite looks the same whether or
 * not the email is already registered.
 */
function enforceRegistrationPolicy(email, inviteCode) {
  if (env.registrationMode === 'closed') {
    throw new AppError(403, 'registration_closed', 'Registration is closed on this deployment.');
  }
  if (env.registrationMode === 'invite') {
    if (env.registrationInviteCodes.length === 0) {
      throw new AppError(
        403,
        'registration_invite_only',
        'Registration is invite-only on this deployment. Ask an administrator for an invite code.',
      );
    }
    if (!inviteMatches(inviteCode, email)) {
      throw new AppError(
        403,
        'registration_invite_only',
        'Registration is invite-only on this deployment. Ask an administrator for an invite code.',
      );
    }
  }
  if (env.registrationEmailDomains.length > 0) {
    const domain = String(email).split('@')[1]?.toLowerCase();
    if (!env.registrationEmailDomains.includes(domain)) {
      throw new AppError(
        403,
        'registration_domain_restricted',
        'Registration is limited to approved email domains.',
      );
    }
  }
}

router.post(
  '/register',
  registrationLimiter,
  ipLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { email, name, password, inviteCode } = req.body;
    enforceRegistrationPolicy(email, inviteCode);

    // Checked before the account lookup so a breached password is refused the
    // same way for a new and an existing address, which keeps the response
    // from disclosing whether the address is registered.
    if (await isBreachedOnline(password)) {
      throw new AppError(
        400,
        'password_breached',
        'This password appears in a known data breach. Choose a different one.',
      );
    }

    const existing = await User.findOne({ email });

    // The password is hashed on both paths so response time does not tell a
    // caller whether the address was already registered. Neither path reveals
    // the difference in the response.
    const passwordHash = await hashPassword(password);
    if (!existing) {
      // New accounts start unverified. They can sign in, but a lead cannot add
      // them to a project until the owner of the mailbox follows the link,
      // which is what stops a stranger claiming access sent to an address they
      // merely typed in.
      const user = await User.create({ email, name, passwordHash });
      await issueEmailVerification(user);
      await recordAudit({
        actor: user,
        action: 'auth.registered',
        targetType: 'user',
        targetId: user._id,
        targetLabel: user.email,
        meta: { verificationSent: true },
        req,
      });
    } else {
      logger.info('Registration attempted for an existing address');
      await recordAudit({
        actor: existing,
        action: 'auth.registration_duplicate',
        targetType: 'user',
        targetId: existing._id,
        targetLabel: existing.email,
        meta: { inviteRequired: env.registrationMode === 'invite' },
        req,
      });
    }

    res.status(201).json({
      registered: true,
      message: 'Account created. Sign in with your email and password.',
    });
  }),
);

router.post(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const result = await verifyEmailToken(req.body?.token);
    if (!result.ok) {
      throw new AppError(
        400,
        'verification_invalid',
        'This verification link is invalid or has expired. Request a new one from the sign-in page.',
      );
    }
    if (!result.alreadyVerified) {
      await recordAudit({
        actor: result.user,
        action: 'auth.email_verified',
        targetType: 'user',
        targetId: result.user._id,
        targetLabel: result.user.email,
        meta: { channel: 'verification_link' },
        req,
      });
    }
    res.json({ verified: true, alreadyVerified: result.alreadyVerified });
  }),
);

router.post(
  '/verification/resend',
  verificationLimiter,
  emailLimiter,
  validate({ body: resendVerificationSchema }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    // The response is the same for unknown, already-verified and demo
    // accounts, so the endpoint cannot be used to probe the address book.
    if (user && !user.isDemo && !user.emailVerifiedAt) {
      await issueEmailVerification(user);
      await recordAudit({
        actor: user,
        action: 'auth.verification_resent',
        targetType: 'user',
        targetId: user._id,
        targetLabel: user.email,
        req,
      });
    }
    res.status(202).json({
      requested: true,
      message: 'If that address needs confirmation, a new link has been sent.',
    });
  }),
);

router.post(
  '/login',
  ipLimiter,
  emailLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) {
      await verifyPassword(password, DUMMY_HASH);
      throw unauthorized('Email or password is incorrect');
    }

    const client = clientKey(req);
    const knownSession = await holdsKnownSession(req, user);
    const throttle = user.isDemo
      ? null
      : await LoginThrottle.findOne({ user: user._id, client });
    const locked =
      !knownSession &&
      throttle?.lockUntil &&
      new Date(throttle.lockUntil).getTime() > Date.now();

    if (locked) {
      // Same shape as the rate limiter's response, so a locked client is not
      // distinguishable from a throttled address.
      throw new AppError(
        429,
        'too_many_attempts',
        'Too many sign-in attempts. Try again in a few minutes.',
      );
    }

    const valid = await verifyPassword(password, user.passwordHash);

    if (!valid) {
      if (!user.isDemo) {
        const { attempts, lockedUntil } = await recordFailure(user, client);
        if (lockedUntil) {
          await recordAudit({
            actor: user,
            action: 'auth.lockout',
            targetType: 'user',
            targetId: user._id,
            targetLabel: user.email,
            meta: {
              attempts,
              client,
              lockedUntil: lockedUntil.toISOString(),
              minutes: env.loginLockoutMinutes,
            },
            req,
          });
          await notifyAccountLockout({ user });
        }
        const delayMs = failureDelayMs(attempts);
        if (delayMs > 0 && !isTest) await sleep(delayMs);
      }
      throw unauthorized('Email or password is incorrect');
    }

    if (!user.isDemo) {
      await LoginThrottle.deleteOne({ user: user._id, client });
    }
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    res.json({ token: await issueSession(user, req), user: publicUser(user) });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }),
);

// "Your devices": every live sign-in for this account. Shows when each was
// last seen so an unexpected session can be spotted, and lets a user end one
// without signing out everywhere.
router.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    const sessions = await Session.find({
      user: req.user._id,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .select('jti userAgent ip createdAt lastSeenAt expiresAt')
      .lean();

    res.json({
      sessions: sessions.map((session) => ({
        id: String(session._id),
        current: session.jti === req.auth?.jti,
        userAgent: session.userAgent || 'Unknown device',
        ip: session.ip || '',
        signedInAt: session.createdAt,
        lastSeenAt: session.lastSeenAt || session.createdAt,
        expiresAt: session.expiresAt,
      })),
    });
  }),
);

router.delete(
  '/sessions/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const session = /^[0-9a-f]{24}$/i.test(req.params.id)
      ? await Session.findOne({
          _id: req.params.id,
          user: req.user._id,
          revokedAt: null,
        })
      : null;
    if (!session) {
      throw new AppError(404, 'session_not_found', 'That device is already signed out.');
    }
    if (session.jti === req.auth?.jti) {
      throw new AppError(
        400,
        'current_session',
        'Use Sign out to end the session you are using.',
      );
    }
    await revokeSession(req.user._id, session.jti);
    await recordAudit({
      actor: req.user,
      action: 'auth.session_revoked',
      targetType: 'user',
      targetId: req.user._id,
      targetLabel: req.user.email,
      meta: { sessionId: String(session._id), current: false },
      req,
    });
    res.json({ revoked: true });
  }),
);

router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    // Only this sign-in ends. Other devices keep working until they sign out
    // or the account uses "sign out everywhere".
    await revokeSession(req.user._id, req.auth?.jti);
    await recordAudit({
      actor: req.user,
      action: 'auth.logged_out',
      targetType: 'user',
      targetId: req.user._id,
      targetLabel: req.user.email,
      meta: { allSessionsRevoked: false },
      req,
    });
    res.json({ loggedOut: true });
  }),
);

router.post(
  '/logout-all',
  authenticate,
  asyncHandler(async (req, res) => {
    await revokeAllSessions(req.user._id);
    // The version bump also rejects any token that predates per-session rows.
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    await recordAudit({
      actor: req.user,
      action: 'auth.logged_out',
      targetType: 'user',
      targetId: req.user._id,
      targetLabel: req.user.email,
      meta: { allSessionsRevoked: true },
      req,
    });
    res.json({ loggedOut: true, allSessions: true });
  }),
);

export default router;
