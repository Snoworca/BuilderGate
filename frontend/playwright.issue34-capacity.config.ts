import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Issue #34 / FR-BGSTAB-026 AC-3, AC-4: the verified external runtime owns
// startup and shutdown, exactly as playwright.ownership-validation.config.ts
// requires. webServer is dropped so a run can never start or stop a server.
const origin = 'https://localhost:2222';
if (process.env.PLAYWRIGHT_BASE_URL !== undefined && process.env.PLAYWRIGHT_BASE_URL !== origin) {
  throw new Error('Issue #34 capacity ratification requires PLAYWRIGHT_BASE_URL=https://localhost:2222 or an unset value');
}

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: origin },
  webServer: undefined,
  testMatch: 'issue34-capacity-ratify.spec.ts',
  projects: base.projects?.filter(project => project.name === 'Desktop Chrome'),
  workers: 1,
  retries: 0,
  fullyParallel: false,
});
