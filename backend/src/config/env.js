import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int('PORT', 4000),
  mongoUri: process.env.MONGODB_URI || '',
  dbName: process.env.DB_NAME || '',
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigins: list('CORS_ORIGINS'),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite',
  githubToken: process.env.GITHUB_TOKEN || '',
  googleDriveToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN || '',
  uploadDir: process.env.UPLOAD_DIR || path.join(rootDir, 'storage', 'uploads'),
  maxUploadMb: int('MAX_UPLOAD_MB', 15),
  maxFilesPerUpload: int('MAX_FILES_PER_UPLOAD', 20),
  staleDays: int('STALE_DAYS', 30),
  shareTtlDays: int('SHARE_TTL_DAYS', 7),
  allowDemoSeed: bool('ALLOW_DEMO_SEED', process.env.NODE_ENV !== 'production'),
  rootDir,
};

export const isProd = env.nodeEnv === 'production';
export const isTest = env.nodeEnv === 'test';

if (isProd && env.jwtSecret === DEV_JWT_SECRET) {
  throw new Error('JWT_SECRET must be set to a strong value in production');
}

export const llmEnabled = Boolean(env.geminiApiKey);
