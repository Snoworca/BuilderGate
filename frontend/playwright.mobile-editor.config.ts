import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// MCP editor tools, the Git viewer (#188), image viewer navigation, file download (#130), file transfer (#139), file extract (#140), HTML viewer (#141) and the mobile touch regressions (#127, #128, #129),
// run only against the verified external runtime on 2222. No webServer: the default config's
// reuseExistingServer could attach to or start another instance, which the E2E rules forbid.
//
// BUILDERGATE_E2E_BROWSER_CHANNEL=msedge runs both projects in the installed Edge, for a host
// whose Playwright-bundled browsers are not installed; the mobile project is then Chromium with
// a phone's viewport, touch and user agent rather than WebKit.
const origin = 'https://localhost:2222';
if (process.env.PLAYWRIGHT_BASE_URL !== undefined && process.env.PLAYWRIGHT_BASE_URL !== origin) {
  throw new Error('These E2E specs require PLAYWRIGHT_BASE_URL=https://localhost:2222 or an unset value');
}
const channel = process.env.BUILDERGATE_E2E_BROWSER_CHANNEL;

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: origin },
  webServer: undefined,
  testMatch: ['mcp-editor-open.spec.ts', 'mobile-touch-regressions.spec.ts', 'file-download.spec.ts', 'file-transfer.spec.ts', 'file-extract.spec.ts', 'html-viewer.spec.ts', 'grid-redraw-nudge.spec.ts', 'mobile-terminal-keyboard.spec.ts', 'mobile-header-fit.spec.ts', 'file-explorer-create-move.spec.ts', 'mobile-tab-switch.spec.ts', 'mobile-double-tap.spec.ts', 'editor-single-line-selection.spec.ts', 'mobile-tab-reveal-paint.spec.ts', 'git-viewer.spec.ts'],
  projects: channel
    ? [
      { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'], channel } },
      { name: 'Mobile Chromium', use: { ...devices['Pixel 7'], channel } },
    ]
    : base.projects?.filter(project => project.name === 'Desktop Chrome' || project.name === 'Mobile Safari'),
  workers: 1,
  retries: 0,
  fullyParallel: false,
});
