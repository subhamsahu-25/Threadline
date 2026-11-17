import app from './app.js';
import { env } from './config/env.js';
import { connectDB, disconnectDB, redactUri } from './db/connect.js';
import { logger } from './lib/logger.js';
import { processSourceJob, recoverInterruptedSources } from './services/ingest/index.js';
import { startSyncScheduler } from './services/ingest/sync.js';
import { configureQueue, setJobHandler } from './services/queue.js';
import { reconcileDemoWorkspace } from './demo/seed.js';

setJobHandler(processSourceJob);
configureQueue({ concurrency: Number(process.env.INGEST_CONCURRENCY || 2), maxAttempts: 2 });

await connectDB();

const recovered = await recoverInterruptedSources();
if (recovered > 0) logger.info({ recovered }, 'Re-queued interrupted ingestion jobs');

try {
  const repaired = await reconcileDemoWorkspace();
  if (repaired) {
    logger.info(
      { project: repaired.project.id },
      'Reconciled the demo workspace with the current demo personas',
    );
  }
} catch (error) {
  logger.warn({ err: error }, 'Could not reconcile the demo workspace');
}

const stopSync = startSyncScheduler();

const server = app.listen(env.port, () => {
  logger.info(
    {
      port: env.port,
      env: env.nodeEnv,
      database: redactUri(env.mongoUri || 'in-memory'),
      extraction: env.geminiApiKey ? env.geminiModel : 'deterministic-heuristic',
    },
    'Threadline API listening',
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  stopSync();
  server.close(async () => {
    await disconnectDB();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
