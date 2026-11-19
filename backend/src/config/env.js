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
const nodeEnv = process.env.NODE_ENV || 'development';
const productionEnv = nodeEnv === 'production';

// Public demo seeding is opt-in. A production deployment needs DEMO_MODE=true
// explicitly; ALLOW_DEMO_SEED alone can never switch it on there.
const demoMode = bool('DEMO_MODE', false);

export const env = {
  nodeEnv,
  port: int('PORT', 4000),
  mongoUri: process.env.MONGODB_URI || '',
  dbName: process.env.DB_NAME || '',
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigins: list('CORS_ORIGINS'),
  // The browser address used in emailed links. Falls back to the first
  // allowed origin so a single-origin deployment needs no extra setting.
  publicAppUrl: (process.env.PUBLIC_APP_URL || list('CORS_ORIGINS')[0] || 'http://localhost:5173').replace(/\/+$/, ''),
  emailVerificationTtlHours: Math.max(1, int('EMAIL_VERIFICATION_TTL_HOURS', 48)),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite',
  githubToken: process.env.GITHUB_TOKEN || '',
  githubAllowedRepos: list('GITHUB_ALLOWED_REPOS').map((ref) => ref.toLowerCase()),
  googleDriveToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN || '',
  // A static access token expires after an hour. When the OAuth client and a
  // refresh token are configured, the connector renews itself instead of
  // failing every hour.
  googleDriveClientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
  googleDriveClientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
  googleDriveRefreshToken: process.env.GOOGLE_DRIVE_REFRESH_TOKEN || '',
  driveAllowedFolders: list('DRIVE_ALLOWED_FOLDERS'),
  uploadDir: process.env.UPLOAD_DIR || path.join(rootDir, 'storage', 'uploads'),
  maxUploadMb: int('MAX_UPLOAD_MB', 15),
  maxFilesPerUpload: int('MAX_FILES_PER_UPLOAD', 20),
  // Stored text is capped well below MongoDB's 16 MB document limit. Only the
  // first 250 chunks (about 500k characters) are ever analysed, so keeping
  // more raw text would cost storage without adding usable evidence.
  maxDocumentChars: Math.max(100_000, int('MAX_DOCUMENT_CHARS', 1_000_000)),
  uploadJanitorEnabled: bool('UPLOAD_JANITOR_ENABLED', true),
  uploadJanitorIntervalHours: Math.max(1, int('UPLOAD_JANITOR_INTERVAL_HOURS', 6)),
  uploadOrphanHours: Math.max(1, int('UPLOAD_ORPHAN_HOURS', 24)),
  // Report which files would be deleted without unlinking them. Useful for a
  // first run against an unfamiliar directory.
  uploadJanitorDryRun: bool('UPLOAD_JANITOR_DRY_RUN', false),
  staleDays: int('STALE_DAYS', 30),
  // An open question older than this is counted as an old question in the
  // readiness score. Separate from the staleness window because an unanswered
  // question costs more than a stale task.
  oldQuestionDays: Math.max(1, int('OLD_QUESTION_DAYS', 14)),
  // Readiness starts at 100 and subtracts a bounded penalty per finding. The
  // penalty is what one item costs; the cap stops a single category from
  // taking the whole score, so the number still ranks projects against each
  // other. Both are operator-tunable; the defaults are documented here.
  readinessWeights: {
    unverified: Math.max(0, int('READINESS_PENALTY_UNVERIFIED', 3)),
    ownershipGap: Math.max(0, int('READINESS_PENALTY_OWNERSHIP_GAP', 8)),
    conflict: Math.max(0, int('READINESS_PENALTY_CONFLICT', 10)),
    oldQuestion: Math.max(0, int('READINESS_PENALTY_OLD_QUESTION', 4)),
  },
  shareTtlDays: int('SHARE_TTL_DAYS', 7),
  // Outbound delivery is optional. Without a webhook the product still records
  // a "skipped" delivery row; it never pretends a message was sent.
  outboundWebhookUrl: process.env.OUTBOUND_WEBHOOK_URL || '',
  outboundWebhookTimeoutMs: Math.max(1_000, int('OUTBOUND_WEBHOOK_TIMEOUT_MS', 5_000)),
  handoverReminderEnabled: bool('HANDOVER_REMINDER_ENABLED', true),
  handoverReminderDays: Math.max(1, int('HANDOVER_REMINDER_DAYS', 3)),
  extractConcurrency: Math.max(1, int('EXTRACT_CONCURRENCY', 3)),
  // Parsed here so a malformed value falls back to a sane number instead of
  // NaN, which used to stop the queue pump entirely.
  ingestConcurrency: Math.max(1, int('INGEST_CONCURRENCY', 2)),
  // A handler that never settles would otherwise hold its worker forever.
  ingestJobTimeoutMs: Math.max(10_000, int('INGEST_JOB_TIMEOUT_MS', 300_000)),
  extractTimeBudgetMs: Math.max(5_000, int('EXTRACT_TIME_BUDGET_MS', 120_000)),
  // The demo workspace is opt-in. In production only DEMO_MODE=true enables
  // it; elsewhere ALLOW_DEMO_SEED must also be set explicitly.
  allowDemoSeed: demoMode || (!productionEnv && bool('ALLOW_DEMO_SEED', false)),
  // Connector sources are capped so one project cannot exhaust the shared
  // provider token's quota or fill the database with external copies.
  maxConnectorSources: Math.max(1, int('MAX_CONNECTOR_SOURCES', 10)),
  // Open registration is a demo affordance. A non-demo production deployment
  // defaults to invite-only unless the operator opts in explicitly.
  registrationMode: ['open', 'invite', 'closed'].includes(process.env.REGISTRATION_MODE)
    ? process.env.REGISTRATION_MODE
    : productionEnv && !demoMode
      ? 'invite'
      : 'open',
  registrationInviteCodes: list('REGISTRATION_INVITE_CODES'),
  registrationEmailDomains: list('REGISTRATION_EMAIL_DOMAINS').map((domain) =>
    domain.toLowerCase().replace(/^@/, ''),
  ),
  loginMaxAttempts: Math.max(3, int('LOGIN_MAX_ATTEMPTS', 5)),
  loginLockoutMinutes: Math.max(1, int('LOGIN_LOCKOUT_MINUTES', 15)),
  // New passwords are checked against the Have I Been Pwned range API. The
  // check sends only the first five SHA-1 characters, so the password itself
  // never leaves the server. Tests run offline unless explicitly enabled.
  breachCheckEnabled: bool('BREACH_CHECK_ENABLED', nodeEnv !== 'test'),
  breachCheckTimeoutMs: Math.max(250, int('BREACH_CHECK_TIMEOUT_MS', 1_500)),
  // Authenticated requests reuse a validated session for this many seconds
  // instead of reading the user and session rows each time. Revocation clears
  // the entry in the process that handled it; the TTL bounds other processes.
  sessionCacheSeconds: Math.max(0, int('SESSION_CACHE_SECONDS', 10)),
  // lastSeenAt is written at most once per this window, however busy the
  // session is.
  sessionLastSeenSeconds: Math.max(10, int('SESSION_LAST_SEEN_SECONDS', 60)),
  rootDir,
};

export const isProd = productionEnv;
export const isTest = env.nodeEnv === 'test';

if (isProd && env.jwtSecret === DEV_JWT_SECRET) {
  throw new Error('JWT_SECRET must be set to a strong value in production');
}

if (isProd && env.corsOrigins.length === 0) {
  throw new Error(
    'CORS_ORIGINS must list the allowed frontend origin(s) in production; refusing to start with an open policy',
  );
}

export const llmEnabled = Boolean(env.geminiApiKey);
