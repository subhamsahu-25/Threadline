import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notifications.js';
import { objectId } from '../validation/schemas.js';

const router = Router();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

router.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await listNotifications({
      user: req.user,
      limit: req.query.limit || 50,
    });
    res.json(result);
  }),
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    res.json(await markAllNotificationsRead({ user: req.user }));
  }),
);

router.post(
  '/:id/read',
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    res.json(await markNotificationRead({ id: req.params.id, user: req.user }));
  }),
);

export default router;
