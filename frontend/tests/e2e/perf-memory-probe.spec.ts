import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type CDPSession } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { deleteOwnedWorkspace, type RegistryOptions } from './workspaceLeakGuard';
import { login, sendVisibleTerminalCommand } from './helpers';

// Measurement, not a pass/fail test: CPU and memory of the browser and the server while many
// sessions with long scrollback keep redrawing. Writes profiles to PERF_OUT (a directory on the
// server host) for offline analysis. PERF_SERVER_PROBE is a node script that attaches to the
// server's inspector (cpu | heap | gc | mem).

const ORIGIN = 'https://localhost:2222';
const ECHO = fileURLToPath(new URL('./fixtures/raw-echo.mjs', import.meta.url));
const LOAD = fileURLToPath(new URL('./fixtures/ink-like-redraw-tui.mjs', import.meta.url));
const OUT = process.env.PERF_OUT ?? '';
const SERVER_PROBE = process.env.PERF_SERVER_PROBE ?? '';
const GRIDS = Number(process.env.PERF_GRIDS ?? 4);
const PER_GRID = 6;
const PRE = Number(process.env.LOAD_PRE ?? 10000);
const TICK = Number(process.env.LOAD_TICK ?? 100);

function hostPath(path: string): string {
  const wsl = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
}
function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}
function serverProbe(pid: number, mode: string, seconds: number, name: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('node', [SERVER_PROBE, String(pid), mode, String(seconds), `${OUT}\\server-${name}.json`], { timeout: (seconds + 120) * 1000 }, (error, _stdout, stderr) => {
      if (error) console.log(`server probe ${mode} ${name} failed: ${stderr || error.message}`);
      resolve();
    });
  });
}

interface Ws { id: string; name: string; sessions: string[] }

test('measure: browser and server CPU and memory with many busy sessions', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
  test.skip(!OUT || !SERVER_PROBE, 'PERF_OUT and PERF_SERVER_PROBE are required');
  test.setTimeout(3_600_000);
  const ownerId = `perf-memory-probe/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
  const serverPid = Number(((await (await request.get(`${ORIGIN}/health`)).json()) as { pid: number }).pid);
  const marks: Array<Record<string, unknown>> = [];

  await login(page);
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const tabsOf = async (id: string) => ((await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json()) as { tabs: Array<{ workspaceId: string; sessionId: string }> })
    .tabs.filter((tab) => tab.workspaceId === id).map((tab) => tab.sessionId);
  const create = async (label: string, tabs: number, grid: boolean): Promise<Ws> => {
    const name = `e2e-perf-${label}-${randomUUID().slice(0, 6)}`;
    const ws = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name }, timeout: 60_000 });
    for (let i = (await tabsOf(ws.id)).length; i < tabs; i += 1) {
      expect((await request.post(`${ORIGIN}/api/workspaces/${ws.id}/tabs`, { headers, data: { name: `${label}${i + 1}` }, timeout: 60_000 })).status()).toBe(201);
    }
    if (grid) await request.patch(`${ORIGIN}/api/workspaces/${ws.id}`, { headers, data: { viewMode: 'grid' } });
    return { id: ws.id, name, sessions: await tabsOf(ws.id) };
  };
  const open = async (ws: Ws) => {
    await page.locator('.workspace-item', { hasText: ws.name }).first().click();
    await page.waitForTimeout(800);
  };
  const browserMem = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage') as { usedSize: number; totalSize: number };
    const dom = await page.evaluate(() => ({
      domNodes: document.getElementsByTagName('*').length,
      xterms: document.querySelectorAll('.xterm').length,
      canvases: document.querySelectorAll('canvas').length,
    }));
    return { jsHeapUsedMB: Math.round(heap.usedSize / 1e5) / 10, jsHeapTotalMB: Math.round(heap.totalSize / 1e5) / 10, ...dom };
  };
  const mark = async (label: string) => {
    const name = label.replace(/[^a-z0-9]+/gi, '-');
    await serverProbe(serverPid, 'gc', 0, `gc-${name}`);
    const browser = await browserMem();
    const entry = { label, at: new Date().toISOString(), browser };
    marks.push(entry);
    console.log(`MARK ${label} ${JSON.stringify(browser)}`);
  };
  const profileWindow = async (label: string, seconds: number, during: () => Promise<void>) => {
    await page.evaluate(() => {
      const w = window as unknown as { __pp: { long: number[] } };
      w.__pp = { long: [] };
      new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__pp.long.push(e.duration); }).observe({ type: 'longtask' });
    });
    await cdp.send('Profiler.start');
    const server = serverProbe(serverPid, 'cpu', seconds, `cpu-${label}`);
    const started = Date.now();
    await during();
    const remaining = seconds * 1000 - (Date.now() - started);
    if (remaining > 0) await page.waitForTimeout(remaining);
    const { profile } = await cdp.send('Profiler.stop') as { profile: unknown };
    writeFileSync(`${OUT}\\browser-cpu-${label}.json`, JSON.stringify(profile));
    await server;
    const long = await page.evaluate(() => (window as unknown as { __pp: { long: number[] } }).__pp.long);
    console.log(`WINDOW ${label} longTasks n=${long.length} sumMs=${Math.round(long.reduce((a, b) => a + b, 0))} max=${Math.round(Math.max(0, ...long))}`);
  };

  const measure = await create('measure', 1, false);
  const grids: Ws[] = [];
  for (let i = 0; i < GRIDS; i += 1) grids.push(await create(`grid${i}`, PER_GRID, true));

  // Allocation sampling from before the load starts to the end of the load phases, both sides.
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 });
  const serverHeap = serverProbe(serverPid, 'heap', Number(process.env.PERF_HEAP_SECONDS ?? 1800), 'heap-sampling');
  await page.reload();
  await page.waitForSelector('.workspace-screen');
  await open(measure);
  await page.waitForTimeout(1500);
  await sendVisibleTerminalCommand(page, `node "${hostPath(ECHO)}"`, { sessionId: measure.sessions[0] });
  await mark('baseline: sessions idle');

  for (const grid of grids) {
    await open(grid);
    await page.waitForTimeout(1200);
    for (const sessionId of grid.sessions) {
      await sendVisibleTerminalCommand(page, `$env:PRE='${PRE}'; $env:TICK='${TICK}'; node "${hostPath(LOAD)}"`, { sessionId });
    }
  }
  await open(measure);
  await page.waitForTimeout(Number(process.env.PERF_SETTLE_MS ?? 90_000));
  await mark(`${GRIDS * PER_GRID} busy hidden sessions`);

  if (process.env.PERF_MODE === 'hold') {
    // Let per-session buffers reach their caps, then capture what the server heap holds.
    await page.waitForTimeout(Number(process.env.PERF_HOLD_MS ?? 600_000));
    await mark('after holding the load');
    await serverProbe(serverPid, 'snapshot', 0, 'heap.heapsnapshot');
    writeFileSync(`${OUT}\\server-heap-sampling.json.stop`, '');
    await serverHeap;
    for (const grid of grids) await deleteOwnedWorkspace({ ...registryOptions(), ownerId, workspaceId: grid.id });
    writeFileSync(`${OUT}\\marks.json`, JSON.stringify(marks, null, 2));
    return;
  }

  if (process.env.PERF_MODE === 'reloads') {
    // Per-connection accumulation: each reload is a new WebSocket and a fresh set of views.
    const rounds = Number(process.env.PERF_RELOADS ?? 40);
    for (let round = 1; round <= rounds; round += 1) {
      await page.reload();
      await page.waitForSelector('.workspace-screen');
      await open(grids[round % grids.length]);
      await page.waitForTimeout(3000);
      if (round % 10 === 0) await mark(`after ${round} reloads`);
    }
    writeFileSync(`${OUT}\\server-heap-sampling.json.stop`, '');
    await serverHeap;
    for (const grid of grids) await deleteOwnedWorkspace({ ...registryOptions(), ownerId, workspaceId: grid.id });
    writeFileSync(`${OUT}\\marks.json`, JSON.stringify(marks, null, 2));
    return;
  }

  await page.locator(`[data-session-id="${measure.sessions[0]}"] .xterm-screen`).click();
  await profileWindow('typing-hidden-busy', 15, async () => {
    for (let k = 0; k < 30; k += 1) { await page.keyboard.press(String.fromCharCode(97 + (k % 26))); await page.waitForTimeout(150); }
  });

  await open(grids[0]);
  await page.waitForTimeout(10_000);
  await profileWindow('visible-grid-busy', 15, async () => {});
  await mark('visible busy grid');

  await profileWindow('switching-grids', 15, async () => {
    for (let k = 0; k < 10; k += 1) { await open(grids[k % 2]); await page.waitForTimeout(500); }
  });
  await mark('after 10 grid switches');

  for (let k = 0; k < 30; k += 1) { await open(grids[k % grids.length]); await page.waitForTimeout(300); }
  await open(measure);
  await page.waitForTimeout(20_000);
  await mark('after 40 switches, back on one terminal');

  writeFileSync(`${OUT}\\server-heap-sampling.json.stop`, '');
  await serverHeap;
  const sampled = await cdp.send('HeapProfiler.getSamplingProfile') as { profile: unknown };
  writeFileSync(`${OUT}\\browser-heap-sampling.json`, JSON.stringify(sampled.profile));
  await cdp.send('HeapProfiler.stopSampling');

  // Delete the load sessions and see whether memory comes back.
  for (const grid of grids) await deleteOwnedWorkspace({ ...registryOptions(), ownerId, workspaceId: grid.id });
  await page.waitForTimeout(20_000);
  await mark('after deleting the busy sessions');
  writeFileSync(`${OUT}\\marks.json`, JSON.stringify(marks, null, 2));
});
