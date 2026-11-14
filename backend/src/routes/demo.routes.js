import { Router } from 'express';
import { env } from '../config/env.js';
import { DEMO_PROJECT_KEY, seedDemo } from '../demo/seed.js';
import { asyncHandler, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { authenticateOptional } from '../middleware/auth.js';
import { Project } from '../models/index.js';
import { canManageProject } from '../services/access/policy.js';

const router = Router();

router.post(
  '/seed',
  authenticateOptional,
  asyncHandler(async (req, res) => {
    if (!env.allowDemoSeed) throw notFound('Demo seeding is disabled on this deployment');

    const reset = req.query.reset === 'true';

    // A rebuild deletes every source, claim and handover in the workspace.
    // It is only destructive when the workspace already exists, so an empty
    // database may be seeded by anyone; rebuilding needs an Atlas lead.
    if (reset) {
      const existing = await Project.findOne({ key: DEMO_PROJECT_KEY });
      if (existing) {
        if (!req.user) {
          throw unauthorized('Sign in as the Atlas project lead to rebuild the demo workspace');
        }
        if (!canManageProject(existing, req.user)) {
          throw forbidden('Only an Atlas project lead can rebuild the demo workspace');
        }
      }
    }

    const result = await seedDemo({ reset });
    res.status(result.alreadySeeded ? 200 : 201).json(result);
  }),
);

export default router;
