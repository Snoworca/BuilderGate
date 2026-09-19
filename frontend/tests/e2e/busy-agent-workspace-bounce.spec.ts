import { test, expect, type Page } from './workspaceOwnershipFixture';
import { getActiveSessionId, login, sendVisibleTerminalCommand, waitForTerminal } from './helpers';

/**
 * A workspace switch while a long-running agent holds the terminal must not
 * leave the terminal reading "세션이 종료되었습니다".
 *
 * The overlay is gated on `tab.status === 'disconnected'`, and reaching it
 * unmounts the terminal host: the only way back is the restart button, which
 * kills whatever the agent was doing. So the status is not cosmetic, and it must
 * mean the session is actually gone.
 *
 * The path that produced it did not mean that. A re-subscribe asks for an atomic
 * restore snapshot, that snapshot was refused for any session with writes on its
 * headless chain — which a redrawing TUI holds continuously — and the refusal
 * arrived at the client as a `session:error` it could not tell apart from an
 * exited shell.
 *
 * Discrimination measured 2026-08-31: with the server-side fixes reverted this
 * spec reports `session:error` in roughly one run in three, and with them in
 * place ten consecutive runs produced none. It is still a sampling test — a
 * green run is weaker evidence than the unit coverage in
 * `server/src/services/SessionManagerBusySnapshot.test.ts`,
 * `server/src/services/SessionManagerBusyResize.test.ts` and
 * `server/src/ws/WsRouterRestoreAuthorityBudget.test.ts` — so read a single
 * failure here as a signal to repeat, not as proof either way.
 */

const SESSION_ENDED = '세션이 종료되었습니다';

async function fetchWorkspaceState(page: Page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    return res.json();
  });
}

async function createWorkspace(page: Page, name: string) {
  return page.evaluate(async ({ name }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`workspace create failed: ${res.status}`);
    return res.json();
  }, { name });
}

async function createTab(page: Page, workspaceId: string, shell?: string) {
  return page.evaluate(async ({ workspaceId, shell }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ shell }),
    });
    if (!res.ok) throw new Error(`tab create failed: ${res.status}`);
    return res.json();
  }, { workspaceId, shell });
}

async function findWorkspaceOption(page: Page, workspaceName: string) {
  return page.getByRole('option', { name: workspaceName }).first();
}

async function readVisibleTerminalText(page: Page) {
  // #39: `.xterm-rows` is the DOM renderer's output, and since #15 attached the WebGL addon
  // the visible terminal draws to a canvas -- measured on this host: `.xterm-screen` 1,
  // `.xterm-rows` 0, canvases 3. The old selector therefore matches nothing at all rather
  // than matching late, which is why the failure read `element(s) not found` while a
  // 1060x598 terminal was plainly on screen. `webgl-dom-fallback.spec.ts` records the same
  // fact from the other side: "while WebGL is attached the terminal text is not in the DOM".
  //
  // Reading the rows when they exist keeps this working under the DOM renderer (and after a
  // WebGL context loss falls back to it); when they do not, the text is genuinely
  // unreadable from the DOM and an empty string is the honest answer rather than a hang.
  const rows = page.locator('.terminal-view:visible .xterm-rows').first();
  if (await rows.count() > 0) return (await rows.textContent()) ?? '';
  // WebGL is attached: read the buffer through the test-host-gated debug hook instead.
  const sessionId = await getActiveSessionId(page);
  if (!sessionId) return '';
  return await page.evaluate(
    (id) => window.__buildergateTerminalDebug?.captureTerminalText?.(id) ?? '',
    sessionId,
  );
}


interface CapturedFrame { type?: string; reason?: string; message?: string }

declare global {
  interface Window {
    __busyAgentFrames?: CapturedFrame[];
  }
}

/** Records the control frames the server sends, so a refusal is visible even
 * when the client recovers from it without showing anything. */
async function captureServerFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__busyAgentFrames = [];
    const Original = window.WebSocket;
    class Recording extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const parsed = JSON.parse(event.data) as CapturedFrame;
            if (typeof parsed?.type === 'string') window.__busyAgentFrames!.push(parsed);
          } catch {
            // Binary data-plane frames are not control frames.
          }
        });
      }
    }
    window.WebSocket = Recording as unknown as typeof WebSocket;
  });
}

async function readCapturedFrames(page: Page): Promise<CapturedFrame[]> {
  return page.evaluate(() => window.__busyAgentFrames ?? []);
}

/** Tab statuses as the client currently holds them, straight from the store. */
async function readTabStatuses(page: Page, workspaceId: string): Promise<string[]> {
  const state = await fetchWorkspaceState(page);
  return state.tabs
    .filter((tab: { workspaceId: string }) => tab.workspaceId === workspaceId)
    .map((tab: { status: string }) => tab.status);
}



/**
 * codex shows a chain of one-time onboarding prompts before it draws anything, and which ones
 * appear depends on the machine's codex state, not on this test. Measured 2026-09-19 against a
 * live session on https://localhost:2222, a fresh run walked three in a row: an update notice
 * ("1. Update now / 2. Skip / 3. Skip until next version"), then "Do you trust the contents of
 * this directory?", then a new-model choice. None of them contains the string 'Update
 * available', which is what this spec used to look for, and it pressed '2' exactly once -- so
 * codex sat on the first prompt until the banner poll timed out, and the failure read
 * "codex never drew its interface" as though the product were at fault.
 *
 * Every one of these prompts is a selection list with a highlighted default and the footer
 * "press enter to continue" or "press enter to confirm", so Enter is both what a user presses
 * and the one key that does not depend on the option order of a particular codex version.
 */
function codexHasDecided(text: string): boolean {
  return text.includes('OpenAI Codex') || /press enter to (continue|confirm)/i.test(text);
}

async function dismissCodexStartupPrompts(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let text = await readVisibleTerminalText(page);
    if (!codexHasDecided(text)) {
      // #110 follow-up. This used to sample once and return the moment the screen showed
      // neither the banner nor a prompt -- which is exactly codex's state for the first second
      // after launch, and between one prompt and the next. Measured 2026-09-19: the helper
      // returned having pressed nothing, and the outer poll then failed 60s later with the
      // update notice still on screen. Not a focus problem: an Enter that landed without focus
      // would have failed the "did not respond to Enter" poll below, and that never fired.
      const decided = await expect.poll(
        async () => {
          text = await readVisibleTerminalText(page);
          return codexHasDecided(text);
        },
        { timeout: 15000, message: 'codex printed neither its banner nor a startup prompt' },
      ).toBe(true).then(() => true, () => false);
      if (!decided) return;
    }
    if (text.includes('OpenAI Codex')) return;
    if (!/press enter to (continue|confirm)/i.test(text)) return;
    await page.keyboard.press('Enter');
    // The screen has to actually change, or the next iteration would answer the same prompt
    // twice and walk past whatever came after it.
    await expect.poll(
      async () => await readVisibleTerminalText(page) !== text,
      { timeout: 15000, message: 'codex startup prompt did not respond to Enter' },
    ).toBe(true);
  }
}


/**
 * What the screen shows cannot distinguish "the agent never started" from "the keystrokes never
 * left the browser". The input gate can: `barrierReason` names what is holding input and
 * `serverReady` says whether the client believes the session is up. Measured 2026-09-19, a
 * terminal stuck behind `visible-output-recovery` held keystrokes for 49.6s against a 1.5s TTL
 * while rendering a live prompt, which on screen is indistinguishable from an idle shell.
 */
async function describeInputGate(page: Page): Promise<string> {
  const sessionId = await getActiveSessionId(page);
  if (!sessionId) return 'input gate: no active session id';
  const gate = await page.evaluate(
    (id) => window.__buildergateTerminalDebug?.readInputGateSnapshot?.(id) ?? null,
    sessionId,
  );
  const text = (await readVisibleTerminalText(page)).replace(/\n+/gu, '\n').trim();
  // The barrier name alone says input is held, not what set it. The recorded events say which
  // transition left it that way, and they are the only thing that survives the run.
  const events = await page.evaluate((id) => {
    const recorded = window.__buildergateTerminalDebug?.getEvents?.(id) ?? [];
    const counts: Record<string, number> = {};
    for (const event of recorded) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    const interesting = recorded.filter(event => event.kind !== 'terminal_input_held_for_barrier');
    return { total: recorded.length, counts, tail: interesting.slice(-60) };
  }, sessionId);
  return `session ${sessionId}\ninput gate: ${JSON.stringify(gate)}`
    + `\nscreen tail: ${JSON.stringify(text.slice(-400))}`
    + `\nevent counts: ${JSON.stringify(events.counts)}`
    + `\nlast events: ${JSON.stringify(events.tail)}`;
}

test.describe('Busy agent survives workspace bounce', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await captureServerFrames(page);
    await login(page);
    await waitForTerminal(page);
  });

  test('a codex session is not reported as ended after bouncing workspaces', async ({ page }) => {
    // codex boots its MCP servers before drawing; the default 60s covers neither
    // that nor the bounces that follow.
    test.setTimeout(240_000);
    const stamp = Date.now();
    const agentWorkspace = await createWorkspace(page, `BusyAgent-${stamp}`);
    const otherWorkspace = await createWorkspace(page, `BounceTarget-${stamp}`);
    await createTab(page, agentWorkspace.id, 'auto');

    await page.evaluate((id) => localStorage.setItem('active_workspace_id', id), agentWorkspace.id);
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);
    // After the reload, not before: the flag lives in the page and the reload throws it away.
    // Enabling it in beforeEach printed empty diagnostics on a real failure.
    await page.evaluate(() => { window.__buildergateTerminalDebug?.enable?.(); });

    const agentOption = await findWorkspaceOption(page, agentWorkspace.name);
    await agentOption.click();
    await expect(agentOption).toHaveAttribute('aria-selected', 'true');

    // #39: this spec creates its tab through the API and then typed into
    // `.terminal-view:visible` straight after selecting the workspace. Measured outside the
    // spec, that sequence leaves every `.terminal-view` at 0x0 for at least twelve seconds --
    // the tab button renders and the tab has a session, but no terminal host is mounted for
    // it. Selecting the tab, the way a user reaching that workspace does, mounts it at once
    // (1060x598 on the next sample). The `waitForTerminal` in beforeEach cannot stand in for
    // this: it ran before the switch and answered for whichever terminal was on screen then.
    const agentTab = page.locator('.workspace-tabbar [role="tab"]').first();
    await agentTab.waitFor({ state: 'visible', timeout: 30000 });
    await agentTab.click();
    await expect(page.locator('.terminal-view:visible .xterm-screen').first())
      .toBeVisible({ timeout: 30000 });

    // codex draws a full-screen TUI and keeps redrawing it, which is what holds
    // the headless write chain non-empty for as long as it runs.
    await sendVisibleTerminalCommand(page, 'codex');
    // codex may open on an update notice; nothing else draws until it is dismissed, so clear
    // it before waiting for the banner. #39: wait for codex to have drawn SOMETHING rather
    // than for a fixed 4s -- on a slow boot the old sleep read an empty screen and skipped the
    // dismissal, and then the banner poll below waited out its whole minute for a notice
    // nobody had answered.
    await expect.poll(
      async () => (await readVisibleTerminalText(page)).trim().length,
      { timeout: 30000, message: 'codex printed nothing at all after launch' },
    ).toBeGreaterThan(0);
    await dismissCodexStartupPrompts(page);
    // The banner proves codex is actually drawing, which is the precondition of
    // this test: a prompt alone would make every assertion below vacuous.
    try {
      await expect.poll(
        async () => readVisibleTerminalText(page),
        { timeout: 60000, message: 'codex never drew its interface' },
      ).toContain('OpenAI Codex');
    } catch (error) {
      // This failure has twice been read as a product defect and twice been something else --
      // once codex's own onboarding prompts, once a held input gate. The screen text alone
      // cannot tell those apart, so say which one it was.
      throw new Error(`${(error as Error).message}\n\n${await describeInputGate(page)}`);
    }

    const otherOption = await findWorkspaceOption(page, otherWorkspace.name);
    await page.evaluate(() => { window.__busyAgentFrames = []; });

    // One switch is enough to ask for a restore; several make the race reliable.
    for (let bounce = 0; bounce < 4; bounce += 1) {
      await otherOption.click();
      await expect(otherOption).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(150);
      await agentOption.click();
      await expect(agentOption).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(150);

      await expect(
        page.getByText(SESSION_ENDED),
        `the terminal reported the session as ended on bounce ${bounce + 1}`,
      ).toHaveCount(0);
    }

    const statuses = await readTabStatuses(page, agentWorkspace.id);
    expect(statuses, 'a tab was left disconnected after the bounces').not.toContain('disconnected');

    // The overlay is the symptom; these are the refusals that lead to it. A busy
    // session is not a fault, so neither should appear.
    const frames = await readCapturedFrames(page);
    const rejections = frames.filter(frame => frame.type === 'screen-repair:rejected');
    console.log('screen-repair rejection reasons:', JSON.stringify(rejections.map(f => f.reason)));
    expect(
      rejections.filter(frame => frame.reason === 'headless-busy'),
      'the server refused a screen repair for a session that was merely busy',
    ).toEqual([]);
    // Asserted again. It was demoted to an observation while the server side was
    // open: measured 2026-08-30 it appeared in roughly one run in three. After
    // the restore-authority sampling ramp replaced the 32ms budget, ten
    // consecutive runs produced none. A running session is not an error.
    expect(
      frames.filter(frame => frame.type === 'session:error').map(frame => frame.message),
      'the server reported a session error for a running session',
    ).toEqual([]);
  });
});
