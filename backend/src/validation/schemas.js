import { z } from 'zod';
import { passwordProblem } from '../services/passwordPolicy.js';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Expected a 24-character id');
export const emailField = z.string().trim().toLowerCase().email('Enter a valid email address');
export const projectRoleField = z.enum(['lead', 'contributor', 'observer']);
export const sensitivityField = z.enum(['public', 'internal', 'confidential']);

export const visibilitySchema = z
  .object({
    scope: z.enum(['project', 'roles', 'users']),
    roles: z.array(projectRoleField).max(3).default([]),
    users: z.array(objectId).max(200).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'roles' && value.roles.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles'],
        message: 'Choose at least one role for a role-scoped source',
      });
    }
    if (value.scope === 'users' && value.users.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['users'],
        message: 'Choose at least one user for a user-scoped source',
      });
    }
  });

export const registerSchema = z
  .object({
    email: emailField,
    name: z.string().trim().min(2).max(80),
    password: z.string().min(10, 'Use at least 10 characters').max(128),
    inviteCode: z.string().trim().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const problem = passwordProblem(value.password, {
      email: value.email,
      name: value.name,
    });
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: problem });
    }
  });

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1).max(128),
});

const transitionSchema = z
  .object({
    outgoingUserId: objectId.optional(),
    outgoingName: z.string().trim().max(120).optional(),
    plannedDepartureAt: z.coerce.date().optional(),
    context: z.string().trim().max(2000).optional(),
  })
  .partial();

export const createProjectSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(16)
    .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens only'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional().default(''),
  members: z
    .array(z.object({ email: emailField, role: projectRoleField }))
    .max(50)
    .optional()
    .default([]),
  transition: transitionSchema.optional(),
  startedAt: z.coerce.date().optional(),
  targetDate: z.coerce.date().optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(['active', 'paused', 'completed']).optional(),
  transition: transitionSchema.optional(),
  settings: z
    .object({
      requireSeparateApprover: z.boolean().optional(),
    })
    .optional(),
  startedAt: z.coerce.date().optional(),
  targetDate: z.coerce.date().optional(),
});

export const addMemberSchema = z
  .object({
    email: emailField.optional(),
    userId: objectId.optional(),
    role: projectRoleField.default('contributor'),
  })
  .refine((value) => value.email || value.userId, {
    message: 'Provide the email or userId of an existing user',
  });

export const updateMemberRoleSchema = z.object({
  role: projectRoleField,
});

export const createSourceSchema = z.object({
  kind: z.enum(['github', 'drive']),
  name: z.string().trim().min(1).max(120).optional(),
  externalRef: z.string().trim().min(1).max(500),
  visibility: visibilitySchema.optional(),
  sensitivity: sensitivityField.optional(),
  aiPolicy: z.object({ allowExternal: z.boolean() }).optional(),
});

export const updateSourceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  visibility: visibilitySchema.optional(),
  sensitivity: sensitivityField.optional(),
  hidden: z.boolean().optional(),
  aiPolicy: z.object({ allowExternal: z.boolean() }).optional(),
});

export const syncSourceSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .refine((value) => value.enabled !== undefined || value.intervalMinutes !== undefined, {
    message: 'Provide enabled and/or intervalMinutes',
  });

export const createHandoverSchema = z.object({
  projectId: objectId,
  recipientId: objectId,
  roleTemplate: z.enum(['onboarding', 'executive', 'audit']).default('onboarding'),
});

export const reviewItemSchema = z.object({
  decision: z.enum(['accepted', 'rejected', 'edited', 'pending']),
  editedStatement: z.string().trim().max(1200).optional(),
  note: z.string().trim().max(600).optional(),
  shareWithProject: z.boolean().optional(),
});

export const bulkReviewSchema = z.object({
  decisions: z
    .array(
      z.object({
        claimId: objectId,
        decision: z.enum(['accepted', 'rejected', 'edited', 'pending']),
        editedStatement: z.string().trim().max(1200).optional(),
        note: z.string().trim().max(600).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const resolveConflictSchema = z
  .object({
    claimIds: z.array(objectId).min(2).max(50),
    keepClaimId: objectId,
  })
  .refine(
    (value) => value.claimIds.some((id) => String(id) === String(value.keepClaimId)),
    { message: 'keepClaimId must be one of the claimIds in the conflict', path: ['keepClaimId'] },
  );

export const askClarificationsSchema = z
  .object({
    claimIds: z.array(objectId).min(1).max(50).optional(),
    askForAll: z.boolean().optional(),
    prompt: z.string().trim().min(3).max(500).optional(),
  })
  .refine((value) => value.askForAll === true || (value.claimIds || []).length > 0, {
    message: 'Pass askForAll or a list of claimIds to ask about',
  })
  .refine((value) => !(value.prompt && (value.claimIds || []).length > 1), {
    message: 'A custom prompt can only be used when asking about a single item',
  });

export const answerClarificationSchema = z.object({
  answer: z.string().trim().min(1).max(1200),
});

export const declineClarificationSchema = z.object({
  note: z.string().trim().max(600).optional(),
});

export const resolveClaimSchema = z
  .object({
    ownerName: z.string().trim().min(1).max(80).optional(),
    note: z.string().trim().max(600).optional(),
    status: z.enum(['done', 'resolved']).optional(),
  })
  .refine((value) => value.ownerName || value.status || value.note, {
    message: 'Provide an ownerName, a status, or a note',
  });

export const noteSchema = z.object({
  note: z.string().trim().min(1).max(600),
});

export const optionalNoteSchema = z.object({
  note: z.string().trim().max(600).optional(),
});

export const handoverFeedbackSchema = z.object({
  message: z.string().trim().min(5).max(1000),
  claimId: objectId.optional(),
});

export const resolveFeedbackSchema = z.object({
  note: z.string().trim().max(600).optional(),
});

export const listHandoversQuerySchema = z.object({
  projectId: objectId.optional(),
  scope: z.enum(['all', 'created', 'received']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: objectId.optional(),
});

export const listClaimsQuerySchema = z.object({
  type: z
    .enum([
      'decision',
      'task',
      'risk',
      'dependency',
      'question',
      'milestone',
      'responsibility',
      'next_action',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: z.string().trim().max(200).optional(),
});

export const listVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().min(1).optional(),
});

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const uploadSourceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sensitivity: sensitivityField.optional().default('internal'),
  visibility: visibilitySchema.optional(),
});
