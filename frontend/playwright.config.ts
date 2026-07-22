import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
const cmsPort = Number(process.env.PLAYWRIGHT_CMS_PORT || 4174);
const baseURL = `http://127.0.0.1:${port}`;
const cmsURL = `http://127.0.0.1:${cmsPort}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  expect: {
    timeout: 7_500,
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: 'node --import tsx e2e/mock-cms.ts',
      url: `${cmsURL}/healthz`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: { PLAYWRIGHT_CMS_PORT: String(cmsPort) },
    },
    {
      command: 'npm run build && npm start',
      url: `${baseURL}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'production',
        PORT: String(port),
        PUBLIC_ORIGIN: baseURL,
        CMS_INTERNAL_ORIGIN: cmsURL,
        CMS_FETCH_TIMEOUT_MS: '1000',
      },
    },
  ],
});
