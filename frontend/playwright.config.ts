import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:4545',
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
    command: 'cd .. && node dev.js',
    port: 4545,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
