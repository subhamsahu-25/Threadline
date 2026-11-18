import mongoose from 'mongoose';
import { env, isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';

let memoryServer = null;
let errorHandlerAttached = false;

export function redactUri(uri) {
  return uri.replace(/\/\/[^@/]*@/, '//***@');
}

const CONNECT_ATTEMPTS = 5;
const CONNECT_BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectDB(uri = env.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  let target = uri;
  if (!target) {
    if (isProd) throw new Error('MONGODB_URI is required in production');
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    target = memoryServer.getUri();
    logger.warn(
      'MONGODB_URI is not set - started an ephemeral in-memory MongoDB (development only, data is lost on exit)',
    );
  }

  const options = {
    autoIndex: true,
    // Fail a single attempt quickly enough that the retry loop below can move
    // to the next one instead of hanging for the driver's 30-second default.
    serverSelectionTimeoutMS: 5_000,
  };
  if (env.dbName && target === env.mongoUri) options.dbName = env.dbName;

  // A transient Atlas hiccup at boot used to crash the process. Retry with
  // exponential back-off, and keep a handler attached so a connection that
  // drops later is logged instead of becoming an unhandled event.
  if (!errorHandlerAttached) {
    errorHandlerAttached = true;
    mongoose.connection.on('error', (error) => {
      logger.error({ err: error }, 'MongoDB connection error');
    });
  }

  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      await mongoose.connect(target, options);
      logger.info({ uri: redactUri(target), attempt }, 'MongoDB connected');
      return mongoose.connection;
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error;
      const delay = CONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn(
        { attempt, delay, error: error.message },
        'MongoDB connection failed; retrying',
      );
      await sleep(delay);
    }
  }
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
