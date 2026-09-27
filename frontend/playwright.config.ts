import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222';
const webServerPort = Number(new URL(baseURL).port || 443);

export default defineConfig({
  testDir: './tests/e2e',
  // Brackets the run so workspaces it creates cannot accumulate past the
  // instance quota; see tests/e2e/workspaceLeakGuard.ts.
  globalSetup: './tests/e2e/workspaceLeakGuard.ts',
  globalTeardown: './tests/e2e/workspaceTeardown.ts',
  timeout: 60000,
  retries: 1,
  fullyParallel: false,
  // One worker, not one-per-file. These specs assert on state the server holds
  // globally — the workspace list, live session counts, the terminal authority
  // singleton — so two files running at once read each other's writes.
  // `fullyParallel: false` only serialises tests inside a file; without this
  // Playwright still ran three files on three workers. Measured 2026-09-01:
  // the same three specs went from 7 failures to 2 when serialised, and the
  // five that recovered pass individually.
  workers: 1,
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
    actionTimeout: 10000,
    // CON-I18N-001: the UI language follows navigator.language and the specs
    // select by Korean copy; Playwright's default locale is en-US. The six
    // derived configs spread this `use`, so this one line pins all seven.
    locale: 'ko-KR',
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
