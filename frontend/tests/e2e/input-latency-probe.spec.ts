import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { expect } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import type { RegistryOptions } from './workspaceLeakGuard';
import { login, sendVisibleTerminalCommand } from './helpers';

// Measurement, not a pass/fail test: keypress-to-glyph latency in one visible terminal while
// N other sessions run a Claude-Code-like redraw loop in hidden grid workspaces.
// LOAD_LEVELS (default "0,10,20,30"), LOAD_TICK (ms per frame, default 100), KEYS (default 40).

const ORIGIN = 'https://localhost:2222';
const ECHO = fileURLToPath(new URL('./fixtures/raw-echo.mjs', import.meta.url));
const LOAD = fileURLToPath(new URL('./fixtures/ink-like-redraw-tui.mjs', import.meta.url));
const LEVELS = (process.env.LOAD_LEVELS ?? '0,10,20,30').split(',').map(Number);
const TICK = Number(process.env.LOAD_TICK ?? 100);
const PRE = Number(process.env.LOAD_PRE ?? 0);
const KEYS = Number(process.env.KEYS ?? 40);
// Wait after starting a level's load so its scrollback prefill is over and steady state is measured.
const SETTLE_MS = Number(process.env.LOAD_SETTLE_MS ?? 60_000);
const PER_WORKSPACE = 6;

function hostPath(path: string): string {
  const wsl = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
}
function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}
function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] * 10) / 10;
}
function healthRtt(): Promise<number> {
  return new Promise((resolve) => {
    const started = performance.now();
    https.get(`${ORIGIN}/health`, { rejectUnauthorized: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(performance.now() - started));
    }).on('error', () => resolve(NaN));
  });
}

interface Ws { id: string; name: string; sessions: string[] }

test('measure: input latency vs. number of busy sessions', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
  test.setTimeout(1_800_000);
  const ownerId = `input-latency-probe/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const tabsOf = async (id: string) => ((await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json()) as { tabs: Array<{ workspaceId: string; sessionId: string }> })
    .tabs.filter((tab) => tab.workspaceId === id).map((tab) => tab.sessionId);
  const create = async (label: string, tabs: number, grid: boolean): Promise<Ws> => {
    const name = `e2e-latency-${label}-${randomUUID().slice(0, 6)}`;
    const ws = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name } });
    for (let i = (await tabsOf(ws.id)).length; i < tabs; i += 1) {
      expect((await request.post(`${ORIGIN}/api/workspaces/${ws.id}/tabs`, { headers, data: { name: `${label}${i + 1}` } })).status()).toBe(201);
    }
    if (grid) await request.patch(`${ORIGIN}/api/workspaces/${ws.id}`, { headers, data: { viewMode: 'grid' } });
    return { id: ws.id, name, sessions: await tabsOf(ws.id) };
  };

  const maxLoad = Math.max(...LEVELS);
  const measure = await create('measure', 1, false);
  const loads: Ws[] = [];
  for (let i = 0; i < Math.ceil(maxLoad / PER_WORKSPACE); i += 1) loads.push(await create(`load${i}`, PER_WORKSPACE, true));
  await page.reload();
  await page.waitForSelector('.workspace-screen');
  const open = async (ws: Ws) => {
    await page.locator('.workspace-item', { hasText: ws.name }).first().click();
    await page.waitForTimeout(800);
  };

  await open(measure);
  await page.waitForTimeout(1500);
  await sendVisibleTerminalCommand(page, `node "${hostPath(ECHO)}"`, { sessionId: measure.sessions[0] });
  await expect.poll(() => page.evaluate((id) => window.__buildergateTerminalDebug?.captureTerminalText(id) ?? '', measure.sessions[0]), { timeout: 15000 }).toContain('ECHO-READY');

  const loadSessions = loads.flatMap((ws) => ws.sessions.map((sessionId) => ({ ws, sessionId })));
  let running = 0;
  const results: string[] = [];
  for (const level of LEVELS) {
    // Start load sessions up to `level`, a grid workspace at a time.
    while (running < level) {
      const { ws } = loadSessions[running];
      await open(ws);
      await page.waitForTimeout(1200);
      for (const entry of loadSessions.filter((e) => e.ws === ws)) {
        if (running >= level) break;
        if (loadSessions.indexOf(entry) < running) continue;
        await sendVisibleTerminalCommand(page, `$env:PRE='${PRE}'; $env:TICK='${TICK}'; node "${hostPath(LOAD)}"`, { sessionId: entry.sessionId });
        running += 1;
      }
    }
    await open(measure);
    await page.waitForTimeout(level > 0 ? SETTLE_MS : 4000);
    await page.locator(`[data-session-id="${measure.sessions[0]}"] .xterm-screen`).click();

    // Browser main-thread pressure during the window.
    await page.evaluate(() => {
      const w = window as unknown as { __lt: { long: number[]; gaps: number[]; stop: boolean } };
      w.__lt = { long: [], gaps: [], stop: false };
      new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__lt.long.push(e.duration); }).observe({ type: 'longtask', buffered: false });
      let last = performance.now();
      const frame = (now: number) => { w.__lt.gaps.push(now - last); last = now; if (!w.__lt.stop) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    });
    let healthStop = false;
    const health: number[] = [];
    const healthLoop = (async () => { while (!healthStop) { health.push(await healthRtt()); await new Promise((r) => setTimeout(r, 200)); } })();

    const latencies: number[] = [];
    for (let k = 0; k < KEYS; k += 1) {
      const ch = String.fromCharCode(97 + (k % 26));
      const pending = page.evaluate(({ id, ch }) => new Promise<number>((resolve) => {
        const count = () => (window.__buildergateTerminalDebug?.captureTerminalText(id) ?? '').split(ch).length;
        const before = count();
        let pressedAt = 0;
        document.addEventListener('keydown', () => { pressedAt = performance.now(); }, { capture: true, once: true });
        const deadline = performance.now() + 5000;
        const poll = () => {
          if (pressedAt && count() > before) { resolve(performance.now() - pressedAt); return; }
          if (performance.now() > deadline) { resolve(-1); return; }
          setTimeout(poll, 2);
        };
        poll();
      }), { id: measure.sessions[0], ch });
      await page.waitForTimeout(30);
      await page.keyboard.press(ch);
      latencies.push(await pending);
      await page.waitForTimeout(120);
    }
    healthStop = true;
    await healthLoop;
    const browser = await page.evaluate(() => {
      const w = window as unknown as { __lt: { long: number[]; gaps: number[]; stop: boolean } };
      w.__lt.stop = true;
      return { long: w.__lt.long, gaps: w.__lt.gaps };
    });
    const telemetryStarted = performance.now();
    const telemetry = await request.get(`${ORIGIN}/api/sessions/telemetry`, { headers, timeout: 60_000 })
      .then((res) => res.json() as Promise<{ sessions: { totalSessions: number; processCpuPercentOfOneCore?: number } }>)
      .catch(() => ({ sessions: { totalSessions: NaN, processCpuPercentOfOneCore: NaN } }));
    const telemetryMs = Math.round(performance.now() - telemetryStarted);
    const ok = latencies.filter((v) => v >= 0);
    const line = [
      `busy=${level}`,
      `sessions=${telemetry.sessions.totalSessions}`,
      `keyLatency p50=${pct(ok, 0.5)} p95=${pct(ok, 0.95)} max=${pct(ok, 1)} lost=${latencies.length - ok.length}`,
      `serverHealthRtt p50=${pct(health, 0.5)} p95=${pct(health, 0.95)} max=${pct(health, 1)}`,
      `serverCpu=${Math.round(telemetry.sessions.processCpuPercentOfOneCore ?? NaN)}%`,
      `telemetryMs=${telemetryMs}`,
      `browserLongTasks n=${browser.long.length} sumMs=${Math.round(browser.long.reduce((a, b) => a + b, 0))} max=${pct(browser.long, 1)}`,
      `rafGap p95=${pct(browser.gaps, 0.95)} max=${pct(browser.gaps, 1)}`,
    ].join(' | ');
    console.log(`RESULT ${line}`);
    results.push(line);
  }
  console.log(results.join('\n'));
});
