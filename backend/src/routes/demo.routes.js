import { Router } from 'express';
import { env } from '../config/env.js';
import { asyncHandler, notFound } from '../lib/errors.js';
import { seedDemo } from '../demo/seed.js';

const router = Router();

router.post(
  '/seed',
  asyncHandler(async (req, res) => {
    if (!env.allowDemoSeed) throw notFound('Demo seeding is disabled on this deployment');
    const reset = req.query.reset !== 'false';
    const result = await seedDemo({ reset });
    res.status(result.alreadySeeded ? 200 : 201).json(result);
  }),
);

export default router;
