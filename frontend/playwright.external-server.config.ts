import { defineConfig } from '@playwright/test';

import base from './playwright.config';

/**
 * Runs the same suite against an already running https://localhost:2222 that
 * somebody else owns. The base config would otherwise start one through
 * start.bat, which reaches for the daemon and can adopt or disturb an instance
 * this run does not own; `webServer: undefined` removes that path entirely.
 */
export default defineConfig({ ...base, webServer: undefined });
