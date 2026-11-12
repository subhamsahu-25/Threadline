import { env } from '../config/env.js';
import { connectDB, disconnectDB } from '../db/connect.js';
import { logger } from '../lib/logger.js';
import { seedDemo } from '../demo/seed.js';
import { processSourceJob } from '../services/ingest/index.js';
import { configureQueue, setJobHandler } from '../services/queue.js';

setJobHandler(processSourceJob);
configureQueue({ concurrency: 2 });

await connectDB();

if (!env.mongoUri) {
  logger.warn(
    'No MONGODB_URI configured: the demo is written to an in-memory database and will disappear when this script exits. Set MONGODB_URI to keep it.',
  );
}

const result = await seedDemo({ reset: true });
console.log(JSON.stringify(result, null, 2));

await disconnectDB();
