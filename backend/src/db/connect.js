import mongoose from 'mongoose';
import { env, isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';

let memoryServer = null;

export function redactUri(uri) {
  return uri.replace(/\/\/[^@/]*@/, '//***@');
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

  const options = { autoIndex: true };
  if (env.dbName && target === env.mongoUri) options.dbName = env.dbName;
  await mongoose.connect(target, options);
  logger.info({ uri: redactUri(target) }, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
