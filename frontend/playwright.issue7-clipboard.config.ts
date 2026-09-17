import base from './playwright.config';
import { defineConfig } from '@playwright/test';

// webServer is deliberately undefined: the standing directive forbids Playwright
// from starting or reusing any server it did not verify. The 2222 listener is
// started and owned out of band.
export default defineConfig({
  ...base,
  webServer: undefined,
  testMatch: /terminal-clipboard\.spec\.ts/,
});
