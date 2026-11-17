import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env.js';
import { asyncHandler, conflict, unauthorized } from '../lib/errors.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { User } from '../models/index.js';
import { recordAudit } from '../services/audit.js';
import { hashPassword, publicUser, signToken, verifyPassword } from '../services/auth.js';
import { loginSchema, registerSchema } from '../validation/schemas.js';

const router = Router();

/**
 * Credential endpoints are throttled per IP and submitted email so a single
 * noisy client cannot brute-force an account and one address cannot spread
 * attempts across many addresses.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: (req) =>
    `${req.ip}:${String(req.body?.email || '').toLowerCase().trim()}`,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: 'too_many_attempts',
        message: 'Too many sign-in attempts. Try again in a few minutes.',
      },
    });
  },
});

router.post(
  '/register',
  credentialLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { email, name, password } = req.body;
    const existing = await User.findOne({ email });
    if (existing) throw conflict('An account with this email already exists');

    const user = await User.create({
      email,
      name,
      passwordHash: await hashPassword(password),
    });

    await recordAudit({
      actor: user,
      action: 'auth.registered',
      targetType: 'user',
      targetId: user._id,
      targetLabel: user.email,
      req,
    });

    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  }),
);

router.post(
  '/login',
  credentialLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) throw unauthorized('Email or password is incorrect');

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) throw unauthorized('Email or password is incorrect');

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    res.json({ token: signToken(user), user: publicUser(user) });
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
    // Bumping tokenVersion invalidates every token issued before this call,
    // including ones on devices the user no longer holds.
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
    res.json({ loggedOut: true });
  }),
);

export default router;
