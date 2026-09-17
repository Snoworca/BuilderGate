// Issue #5 probe: capture the real server's screen-snapshot frame and report
// whether it carries the authority proof fields the client's
// hasValidAuthorityProof() requires of a screen-repair:restore-needed frame.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: 'https://localhost:2222' });
const page = await ctx.newPage();
const frames = [];
await page.routeWebSocket(/\/ws(?:\?|$)/, (pageRoute) => {
  const server = pageRoute.connectToServer();
  pageRoute.onMessage((raw) => server.send(raw));
  server.onMessage((raw) => {
    if (typeof raw === 'string') {
      try { const m = JSON.parse(raw); if (m && typeof m === 'object') frames.push(m); } catch {}
    }
    pageRoute.send(raw);
  });
});
await page.goto('/');
await page.waitForSelector('input[type="password"]', { timeout: 15000 });
await page.fill('input[type="password"]', process.env.BUILDERGATE_PASSWORD || '1234');
await page.click('button[type="submit"]');
await page.waitForSelector('.xterm-screen:visible', { timeout: 20000 });
await page.waitForTimeout(4000);
const snaps = frames.filter(f => f.type === 'screen-snapshot');
console.log('screen-snapshot frames:', snaps.length);
for (const s of snaps.slice(0, 3)) {
  console.log(JSON.stringify({
    type: s.type, seq: s.seq, mode: s.mode, source: s.source,
    replayToken: typeof s.replayToken, authorityEpoch: s.authorityEpoch,
    authorityRevision: s.authorityRevision, coversThroughSeq: s.coversThroughSeq,
  }));
}
console.log('frame types:', [...new Set(frames.map(f => f.type))].join(','));
await browser.close();
