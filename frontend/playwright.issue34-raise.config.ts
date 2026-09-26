import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Issue #34 raise direction: the verified external runtime owns startup and
// shutdown, so webServer is dropped and a run can never start or stop a server.
const origin = 'https://localhost:2222';
if (process.env.PLAYWRIGHT_BASE_URL !== undefined && process.env.PLAYWRIGHT_BASE_URL !== origin) {
  throw new Error('Issue #34 raise ratification requires PLAYWRIGHT_BASE_URL=https://localhost:2222 or an unset value');
}

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: origin },
  webServer: undefined,
  testMatch: 'issue34-capacity-raise.spec.ts',
  projects: base.projects?.filter(project => project.name === 'Desktop Chrome'),
  workers: 1,
  retries: 0,
  fullyParallel: false,
});
