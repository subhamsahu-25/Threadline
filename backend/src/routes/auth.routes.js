import { Router } from 'express';
import { asyncHandler, conflict, unauthorized } from '../lib/errors.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { User } from '../models/index.js';
import { recordAudit } from '../services/audit.js';
import { hashPassword, publicUser, signToken, verifyPassword } from '../services/auth.js';
import { loginSchema, registerSchema } from '../validation/schemas.js';

const router = Router();

router.post(
  '/register',
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

export default router;
