import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'threadline-test-secret';
process.env.ALLOW_DEMO_SEED = 'true';
process.env.UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(os.tmpdir(), `threadline-test-uploads-${process.pid}`);
