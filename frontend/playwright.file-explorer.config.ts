import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// The file-explorer spec runs only against the verified external runtime on 2222.
// No webServer: the default config's reuseExistingServer could attach to or start
// another instance, which the E2E rules forbid.
const origin = 'https://localhost:2222';
if (process.env.PLAYWRIGHT_BASE_URL !== undefined && process.env.PLAYWRIGHT_BASE_URL !== origin) {
  throw new Error('File explorer E2E requires PLAYWRIGHT_BASE_URL=https://localhost:2222 or an unset value');
}

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: origin },
  webServer: undefined,
  testMatch: 'file-explorer.spec.ts',
  projects: base.projects?.filter(project => project.name === 'Desktop Chrome'),
  workers: 1,
  retries: 0,
  fullyParallel: false,
});
