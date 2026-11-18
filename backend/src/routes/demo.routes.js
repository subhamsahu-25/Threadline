import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env, isTest } from '../config/env.js';
import { DEMO_PROJECT_KEY, seedDemo } from '../demo/seed.js';
import { asyncHandler, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { authenticateOptional } from '../middleware/auth.js';
import { Project } from '../models/index.js';
import { canManageProject } from '../services/access/policy.js';

const router = Router();

// Seeding is cheap once the workspace exists, but a fresh seed runs bcrypt and
// ingests six sources. Throttle it separately from the general API limiter.
const seedLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: 'too_many_attempts',
        message: 'Too many demo setup requests. Try again in a few minutes.',
      },
    });
  },
});

router.post(
  '/seed',
  seedLimiter,
  authenticateOptional,
  asyncHandler(async (req, res) => {
    if (!env.allowDemoSeed) throw notFound('Demo seeding is disabled on this deployment');

    const reset = req.query.reset === 'true';
    const existing = await Project.findOne({ key: DEMO_PROJECT_KEY });

    // A real project that happens to use the ATLAS key is not the demo and is
    // never reset, adopted or otherwise touched.
    if (existing && !existing.isDemo) {
      throw notFound('The ATLAS project on this deployment is not the demo workspace');
    }

    // A rebuild deletes every seeded source, claim and handover in the
    // workspace. Creating a missing workspace is safe for anyone; rebuilding
    // an existing one needs its lead.
    if (reset && existing) {
      if (!req.user) {
        throw unauthorized('Sign in as the Atlas project lead to rebuild the demo workspace');
      }
      if (!canManageProject(existing, req.user)) {
        throw forbidden('Only an Atlas project lead can rebuild the demo workspace');
      }
    }

    const result = await seedDemo({ reset });
    const { users, ...rest } = result;
    // Tokens are for internal scripts and tests. A public HTTP caller must
    // sign in through /api/auth/login like every other user.
    res.status(result.alreadySeeded ? 200 : 201).json({
      ...rest,
      users: users?.map(({ token, ...user }) => user),
    });
  }),
);

export default router;
