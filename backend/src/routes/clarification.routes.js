import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, forbidden } from '../lib/errors.js';
import { getProjectForUser } from '../middleware/project.js';
import { validate } from '../middleware/validate.js';
import { canContribute } from '../services/access/policy.js';
import {
  answerClarification,
  declineClarification,
  listMyClarifications,
  listProjectClarifications,
} from '../services/clarifications.js';
import {
  answerClarificationSchema,
  declineClarificationSchema,
  objectId,
} from '../validation/schemas.js';

const router = Router();

const listQuerySchema = z.object({
  projectId: objectId.optional(),
  status: z.enum(['open', 'answered', 'declined', 'closed']).optional(),
});

router.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const { projectId, status } = req.query;
    if (projectId) {
      const project = await getProjectForUser(projectId, req.user);
      if (!canContribute(project, req.user)) {
        throw forbidden('Only the outgoing team can see the project clarification list');
      }
      return res.json({ clarifications: await listProjectClarifications({ project }) });
    }
    const clarifications = await listMyClarifications({ user: req.user, status });
    return res.json({ clarifications });
  }),
);

router.post(
  '/:id/answer',
  validate({ body: answerClarificationSchema }),
  asyncHandler(async (req, res) => {
    const result = await answerClarification({
      clarificationId: req.params.id,
      actor: req.user,
      answer: req.body.answer,
      req,
    });
    res.json(result);
  }),
);

router.post(
  '/:id/decline',
  validate({ body: declineClarificationSchema }),
  asyncHandler(async (req, res) => {
    const result = await declineClarification({
      clarificationId: req.params.id,
      actor: req.user,
      note: req.body.note,
      req,
    });
    res.json(result);
  }),
);

export default router;
