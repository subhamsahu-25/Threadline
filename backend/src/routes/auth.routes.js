import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env, isTest } from '../config/env.js';
import { AppError, asyncHandler, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { User } from '../models/index.js';
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
import { loginSchema, registerSchema } from '../validation/schemas.js';

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

function inviteMatches(candidate) {
  const provided = digest(candidate);
  let matched = false;
  for (const code of env.registrationInviteCodes) {
    // Every configured code is compared, so timing does not reveal which one
    // (or how many) matched.
    if (timingSafeEqual(provided, digest(code))) matched = true;
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
    if (!inviteMatches(inviteCode)) {
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
  ipLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { email, name, password, inviteCode } = req.body;
    enforceRegistrationPolicy(email, inviteCode);

    const existing = await User.findOne({ email });

    // The password is hashed on both paths so response time does not tell a
    // caller whether the address was already registered. Neither path reveals
    // the difference in the response.
    const passwordHash = await hashPassword(password);
    if (!existing) {
      const user = await User.create({ email, name, passwordHash });
      await recordAudit({
        actor: user,
        action: 'auth.registered',
        targetType: 'user',
        targetId: user._id,
        targetLabel: user.email,
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

    const locked =
      user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now();
    const valid = await verifyPassword(password, user.passwordHash);

    if (locked) {
      // Same shape as the rate limiter's response, so a locked account is not
      // distinguishable from a throttled address.
      throw new AppError(
        429,
        'too_many_attempts',
        'Too many sign-in attempts. Try again in a few minutes.',
      );
    }

    if (!valid) {
      const attempts = (user.failedLoginAttempts || 0) + 1;
      if (attempts >= env.loginMaxAttempts) {
        const lockedUntil = new Date(Date.now() + env.loginLockoutMinutes * 60_000);
        await User.updateOne(
          { _id: user._id },
          { $set: { failedLoginAttempts: 0, lockedUntil } },
        );
        await recordAudit({
          actor: user,
          action: 'auth.lockout',
          targetType: 'user',
          targetId: user._id,
          targetLabel: user.email,
          meta: {
            attempts,
            lockedUntil: lockedUntil.toISOString(),
            minutes: env.loginLockoutMinutes,
          },
          req,
        });
        await notifyAccountLockout({ user });
      } else {
        await User.updateOne(
          { _id: user._id },
          { $set: { failedLoginAttempts: attempts } },
        );
      }
      throw unauthorized('Email or password is incorrect');
    }

    await User.updateOne(
      { _id: user._id },
      {
        $set: { lastLoginAt: new Date(), failedLoginAttempts: 0 },
        $unset: { lockedUntil: 1 },
      },
    );

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
