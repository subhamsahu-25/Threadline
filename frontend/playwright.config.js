import { defineConfig, devices } from '@playwright/test';

const backendPort = process.env.E2E_BACKEND_PORT || '4000';
const frontendPort = process.env.E2E_FRONTEND_PORT || '5173';
const backendUrl = `http://localhost:${backendPort}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: `http://localhost:${frontendPort}`,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The backend falls back to an in-memory MongoDB when MONGODB_URI is
      // empty, so this run never touches a real database.
      command: 'npm start',
      cwd: '../backend',
      url: `${backendUrl}/api/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MONGODB_URI: '',
        DB_NAME: '',
        PORT: backendPort,
        JWT_SECRET: 'e2e-only-secret-not-for-production',
        ALLOW_DEMO_SEED: 'true',
        // Keep the run deterministic and offline: with a key from a developer
        // .env the seed and compose steps call Gemini and can outlast the test.
        GEMINI_API_KEY: '',
        OUTBOUND_WEBHOOK_URL: '',
        HANDOVER_REMINDER_ENABLED: 'false',
      },
    },
    {
      command: `npm run dev -- --port ${frontendPort} --strictPort`,
      cwd: '.',
      url: `http://localhost:${frontendPort}`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VITE_API_PROXY: backendUrl,
      },
    },
  ],
});
