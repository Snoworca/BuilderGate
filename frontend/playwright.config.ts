import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222';
const webServerPort = Number(new URL(baseURL).port || 443);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 1,
  fullyParallel: false,
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
    actionTimeout: 10000,
  },
  projects: [
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'Tablet',
      use: { viewport: { width: 1024, height: 768 } },
    },
  ],
  webServer: {
    command: 'cd .. && start.bat --port 2222',
    port: webServerPort,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
