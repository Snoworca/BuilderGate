// Read-only measurement script (not a committed test). Measures readInputGateSnapshot()
// over time during and after a large output flood, per team-lead's request. Creates one
// owned workspace, deletes it itself on exit (success or failure).
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE_URL = 'https://localhost:2222';
const PASSWORD = process.env.BUILDERGATE_PASSWORD;
if (!PASSWORD) throw new Error('BUILDERGATE_PASSWORD not set');
const FLOOD_COUNT = Number(process.argv[2] ?? 15000);
const OUT_FILE = process.argv[3] ?? '/tmp/flood-gate-measurement.json';

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

const samples = [];
let workspaceId = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function createWorkspace() {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const name = `msr-${crypto.randomUUID().slice(0, 8)}`;
    const wsRes = await fetch('/api/workspaces', { method: 'POST', headers, body: JSON.stringify({ name }) });
    if (!wsRes.ok) throw new Error(`workspace create failed: ${wsRes.status}`);
    const workspace = await wsRes.json();
    const tabRes = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'measure' }),
    });
    if (!tabRes.ok) throw new Error(`tab create failed: ${tabRes.status}`);
    const tab = await tabRes.json();
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspaceId: workspace.id, tabId: tab.id, sessionId: tab.sessionId };
  });
}

async function deleteWorkspace(id) {
  await page.evaluate(async (wid) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = { Authorization: `Bearer ${token}` };
    const res = await fetch(`/api/workspaces/${wid}`, { method: 'DELETE', headers });
    if (!res.ok) throw new Error(`workspace delete failed: ${res.status}`);
  }, id);
}

async function getSelectedUiSessionId() {
  return page.evaluate(() => {
    const el = document.querySelector('.workspace-tabbar [role="tab"][aria-selected="true"]');
    const controls = el?.getAttribute('aria-controls') ?? null;
    return controls?.startsWith('terminal-') ? controls.slice('terminal-'.length) : null;
  });
}

async function readGate(sessionId) {
  return page.evaluate((id) => window.__buildergateTerminalDebug?.readInputGateSnapshot?.(id) ?? null, sessionId);
}

async function readEvents(sessionId) {
  return page.evaluate((id) => window.__buildergateTerminalDebug?.getEvents?.(id) ?? [], sessionId);
}

async function captureLines(sessionId) {
  const text = await page.evaluate((id) => window.__buildergateTerminalDebug?.captureTerminalText?.(id) ?? null, sessionId);
  return text === null ? null : text.split('\n');
}

async function waitInputReady(sessionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gate = await readGate(sessionId);
    if (gate?.inputReady) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

async function sendCommand(sessionId, command) {
  const screen = page.locator(`[data-session-id="${sessionId}"] .xterm-screen`);
  await screen.click();
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea');
  }, undefined, { timeout: 10000 });
  // #109: characters typed while the gate is still restore-pending are silently discarded.
  // Wait for inputReady before typing anything, exactly like sendVisibleTerminalCommand does.
  const ready = await waitInputReady(sessionId);
  if (!ready) log('WARNING: input gate never reported ready before sending', JSON.stringify(command).slice(0, 60));
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

try {
  await page.goto(BASE_URL);
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.workspace-screen', { timeout: 10000 });

  const created = await createWorkspace();
  workspaceId = created.workspaceId;
  const sessionId = created.sessionId;
  log('created workspace', workspaceId, 'session', sessionId);

  await page.reload();
  await page.waitForSelector('.xterm-screen:visible', { timeout: 15000 });
  let tries = 0;
  while ((await getSelectedUiSessionId()) !== sessionId && tries < 60) {
    await new Promise(r => setTimeout(r, 250));
    tries += 1;
  }
  const actualSelected = await getSelectedUiSessionId();
  if (actualSelected !== sessionId) throw new Error(`UI never switched to session ${sessionId}, saw ${actualSelected}`);
  log('UI confirmed on session', sessionId);

  await page.evaluate((id) => {
    window.__buildergateTerminalDebug?.clear?.(id);
    window.__buildergateTerminalDebug?.enable?.(id);
  }, sessionId);

  const t0 = Date.now();
  const sample = async (label) => {
    const gate = await readGate(sessionId);
    samples.push({ tSec: +((Date.now() - t0) / 1000).toFixed(2), label, gate });
  };

  await sample('baseline-before-flood');

  log(`sending flood of ${FLOOD_COUNT} lines`);
  await sendCommand(sessionId, `node -e "for(let i=1;i<=${FLOOD_COUNT};i++)console.log('FLOOD-'+i)"`);

  // Sample every 300ms for up to 60s, stop early once flood output confirmed AND a post-flood
  // probe command succeeds twice in a row (stable recovery), or at the 60s cap either way.
  const deadline = Date.now() + 60000;
  let floodConfirmedAtSec = null;
  let probeSentAtSec = null;
  let probeConfirmed = false;
  const probeMarker = `PROBE-${Date.now()}`;
  let probeSent = false;

  while (Date.now() < deadline) {
    await sample('poll');
    if (floodConfirmedAtSec === null) {
      const lines = await captureLines(sessionId);
      if (lines?.some(l => l.trim() === `FLOOD-${FLOOD_COUNT}`)) {
        floodConfirmedAtSec = samples.at(-1).tSec;
        log('flood output confirmed in viewport at t=', floodConfirmedAtSec);
      }
    } else if (!probeSent) {
      // Send a probe command 2s after flood output is confirmed present, to see whether new
      // input is accepted once output has visibly finished arriving.
      if (samples.at(-1).tSec - floodConfirmedAtSec >= 2) {
        probeSentAtSec = samples.at(-1).tSec;
        log('sending probe command at t=', probeSentAtSec);
        await sendCommand(sessionId, `echo ${probeMarker}`);
        probeSent = true;
      }
    } else if (!probeConfirmed) {
      const lines = await captureLines(sessionId);
      if (lines?.some(l => l.trim() === probeMarker)) {
        probeConfirmed = true;
        log('probe command echoed back successfully at t=', samples.at(-1).tSec);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (!probeConfirmed) {
    log('probe command NEVER echoed back within the 60s window -- treating as reproduced lockup');
  }

  const events = await readEvents(sessionId);
  const allEvents = events.map(e => ({
    tSec: +((Date.parse(e.recordedAt) - t0) / 1000).toFixed(2),
    kind: e.kind,
    details: e.details,
  }));
  const relevantEvents = allEvents.filter(e => (
    e.kind === 'ws_input_sent' || e.kind === 'terminal_input_rejected'
  ));
  const kindCounts = {};
  for (const e of allEvents) kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;

  const result = {
    floodCount: FLOOD_COUNT,
    sessionId,
    floodConfirmedAtSec,
    probeSentAtSec,
    probeConfirmed,
    gateSamples: samples,
    relevantEvents,
    kindCounts,
    allEvents,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  log('wrote', OUT_FILE);
} finally {
  if (workspaceId) {
    try {
      await deleteWorkspace(workspaceId);
      log('deleted workspace', workspaceId);
    } catch (e) {
      log('WARNING: failed to delete workspace', workspaceId, e.message);
    }
  }
  await browser.close();
}
