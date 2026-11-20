import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env, isTest } from '../config/env.js';
import { DEMO_PROJECT_KEY, DEMO_USERS, seedDemo } from '../demo/seed.js';
import { asyncHandler, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { authenticateOptional } from '../middleware/auth.js';
import { Project, User } from '../models/index.js';
import { canManageProject } from '../services/access/policy.js';
import { issueSession, publicUser } from '../services/auth.js';

const router = Router();

// The sign-in page asks whether the demo personas are usable before anyone is
// signed in. That check is public, so it answers with two booleans only, and a
// short cache keeps a page reload from querying the database every time.
const STATUS_TTL_MS = isTest ? 0 : 5_000;
let statusCache = { at: 0, value: null };

async function demoAvailability() {
  if (statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value;
  }
  const ready = Boolean(await Project.exists({ key: DEMO_PROJECT_KEY, isDemo: true }));
  // A seeded workspace stays usable after seeding is switched off, so judges
  // can still enter the demo profiles. `ready` only decides whether the
  // workspace still has to be created.
  const value = {
    seedEnabled: env.allowDemoSeed,
    ready,
    available: env.allowDemoSeed || ready,
  };
  statusCache = { at: Date.now(), value };
  return value;
}

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

const sessionLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: 'too_many_attempts',
        message: 'Too many demo sign-in requests. Try again in a few minutes.',
      },
    });
  },
});

// One-click demo entry. It replaces the password that used to be compiled into
// the browser bundle: the accounts keep random, unpublished passwords, and this
// route can only name a seeded persona on a deployment with demo mode on.
router.post(
  '/session',
  sessionLimiter,
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const persona = DEMO_USERS.find((entry) => entry.email === email);
    if (!persona) throw notFound('That demo profile does not exist');
    const user = await User.findOne({ email: persona.email, isDemo: true });
    if (!user) throw notFound('The demo workspace has not been set up on this deployment');
    res.json({ token: await issueSession(user, req), user: publicUser(user) });
  }),
);

router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await demoAvailability());
  }),
);

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
    statusCache = { at: 0, value: null };
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
