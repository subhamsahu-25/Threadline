import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env, isTest } from './config/env.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import clarificationRoutes from './routes/clarification.routes.js';
import demoRoutes from './routes/demo.routes.js';
import handoverRoutes, { sharedHandoverRouter } from './routes/handover.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import projectRoutes from './routes/project.routes.js';
import { healthSnapshot } from './services/health.js';
import { processSourceJob } from './services/ingest/index.js';
import { setJobHandler } from './services/queue.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// The API only returns JSON (and, for downloads, files with an attachment
// disposition), so every document directive can be denied outright.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  }),
);
app.use(
  cors({
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : true,
    credentials: false,
    exposedHeaders: ['Content-Disposition'],
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

if (!isTest) {
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );
}

setJobHandler(processSourceJob);

app.get('/', (_req, res) => {
  res.json({
    service: 'threadline-api',
    message: 'Threadline turns scattered project activity into permission-aware, evidence-linked handovers.',
    docs: '/api/health',
  });
});

app.get('/api/health', async (_req, res) => {
  // A process that cannot reach its database is not healthy. Reporting 503
  // lets the platform's probe restart or drain this instance instead of
  // routing traffic to an API that can only return errors. The body is cached
  // and deliberately carries liveness only; configuration lives on endpoints
  // that authenticated users can reach.
  const snapshot = await healthSnapshot();
  res.status(snapshot.status === 'ok' ? 200 : 503).json(snapshot);
});

app.use('/api/auth', authRoutes);
app.use('/api/projects', authenticate, projectRoutes);
app.use('/api/handovers/shared', sharedHandoverRouter);
app.use('/api/handovers', authenticate, handoverRoutes);
app.use('/api/clarifications', authenticate, clarificationRoutes);
app.use('/api/notifications', authenticate, notificationRoutes);
app.use('/api/demo', demoRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
