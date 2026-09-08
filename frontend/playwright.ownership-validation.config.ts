import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// REL-BGSTAB-001: the verified external runtime owns startup and shutdown.
const origin = 'https://localhost:2222';
if (process.env.PLAYWRIGHT_BASE_URL !== undefined && process.env.PLAYWRIGHT_BASE_URL !== origin) {
  throw new Error('Ownership validation requires PLAYWRIGHT_BASE_URL=https://localhost:2222 or an unset value');
}

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: origin },
  webServer: undefined,
  testMatch: 'workspace-ownership-validation.spec.ts',
  projects: base.projects?.filter(project => project.name === 'Desktop Chrome'),
  workers: 1,
  retries: 0,
  fullyParallel: false,
});
