import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { env, isTest } from './config/env.js';
import { DEMO_PROJECT_KEY } from './demo/seed.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { Project } from './models/index.js';
import authRoutes from './routes/auth.routes.js';
import clarificationRoutes from './routes/clarification.routes.js';
import demoRoutes from './routes/demo.routes.js';
import handoverRoutes, { sharedHandoverRouter } from './routes/handover.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import projectRoutes from './routes/project.routes.js';
import { llmStatus } from './services/ai/llm.js';
import { processSourceJob } from './services/ingest/index.js';
import { setJobHandler } from './services/queue.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : true,
    credentials: false,
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
  let demoProjectReady = false;
  if (mongoose.connection.readyState === 1) {
    try {
      demoProjectReady = Boolean(await Project.exists({ key: DEMO_PROJECT_KEY }));
    } catch {
      demoProjectReady = false;
    }
  }
  res.json({
    status: 'ok',
    service: 'threadline-api',
    version: '0.1.0',
    time: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    extraction: llmStatus(),
    demoSeedEnabled: env.allowDemoSeed,
    demoProjectReady,
  });
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
