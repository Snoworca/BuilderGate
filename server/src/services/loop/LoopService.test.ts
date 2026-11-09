import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LoopService, SCHEDULE_TAB_CAP, type LoopRuntimePort } from './LoopService.js';
import type { LoopInput } from './loopDefinition.js';

// FR-LOOP-003 / FR-LOOP-004 / FR-LOOP-005: a loop run against an in-memory workspace.

interface FakeTab {
  id: string; workspaceId: string; sessionId: string; name: string; shell: string; cwd: string;
  /** FR-LOOP-008: the shell has ended (no live session). */
  stopped?: boolean;
  agent?: { kind: string; status: string } | null;
}

function fakeRuntime(options: { maxTabs?: number; missingDirs?: string[]; failShell?: boolean; refuseClose?: Set<string> } = {}) {
  const workspaces: Array<{ id: string; name: string }> = [{ id: 'user', name: 'ProjectMaster' }];
  const tabs: FakeTab[] = [];
  const log: string[] = [];
  const events: string[] = [];
  let seq = 0;
  const gates: Array<() => void> = [];
  let holdSleeps = false;
  const port: LoopRuntimePort = {
    workspaceExists: (id) => workspaces.some((ws) => ws.id === id),
    countTabs: (id) => tabs.filter((tab) => tab.workspaceId === id).length,
    maxTabsPerWorkspace: () => options.maxTabs ?? 8,
    createWorkspace: async (name) => {
      const ws = { id: `ws${++seq}`, name };
      workspaces.push(ws);
      events.push(`workspace:${name}`);
      return ws.id;
    },
    openTab: async (workspaceId, request) => {
      if (options.failShell) throw new Error('shell not found');
      const tab = { id: `tab${++seq}`, workspaceId, sessionId: `s${seq}`, ...request };
      tabs.push(tab);
      events.push(`open:${request.name}`);
      return { tabId: tab.id, sessionId: tab.sessionId };
    },
    closeTab: async (tabId) => {
      if (options.refuseClose?.has(tabId)) throw new Error('TAB_NOT_FOUND');
      const at = tabs.findIndex((tab) => tab.id === tabId);
      if (at < 0) throw new Error('TAB_NOT_FOUND');
      tabs.splice(at, 1);
      events.push(`close:${tabId}`);
    },
    tabExists: (tabId) => tabs.some((tab) => tab.id === tabId),
    submit: async (sessionId, text) => {
      log.push(`${sessionId} ${text}`);
      return true;
    },
    sleep: (ms) => {
      log.push(`sleep ${ms}`);
      return holdSleeps ? new Promise<void>((resolve) => gates.push(resolve)) : Promise.resolve();
    },
    directoryExists: async (cwd) => !(options.missingDirs ?? []).includes(cwd),
    inspectTab: (tabId) => {
      const tab = tabs.find((current) => current.id === tabId);
      return tab ? tabInfo(tab) : null;
    },
    listTabs: () => tabs.map(tabInfo),
  };
  function tabInfo(tab: FakeTab) {
    return {
      tabId: tab.id,
      workspaceId: tab.workspaceId,
      workspaceName: workspaces.find((ws) => ws.id === tab.workspaceId)?.name ?? '',
      tabName: tab.name,
      cwd: tab.cwd,
      shell: tab.shell,
      sessionId: tab.stopped ? null : tab.sessionId,
      agent: tab.agent ?? null,
    };
  }
  return {
    port, workspaces, tabs, log, events,
    hold: () => { holdSleeps = true; },
    release: () => { holdSleeps = false; gates.splice(0).forEach((open) => open()); },
  };
}

/** Waits until the run has reached the given point, not a fixed number of turns. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(condition(), 'the run reached the expected step');
}

const loop = (overrides: Partial<LoopInput> = {}): LoopInput => ({
  name: '시황',
  enabled: true,
  schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['08:30'] },
  shell: 'powershell',
  cwd: 'C:\\work\\market',
  keepTabs: 1,
  steps: [
    { kind: 'command', text: 'codex' },
    { kind: 'delay', ms: 2000 },
    { kind: 'prompt', text: '금일 주식 시황 분석하시오' },
  ],
  ...overrides,
});

async function withService<T>(runtime: ReturnType<typeof fakeRuntime>, body: (service: LoopService, now: { value: Date }) => Promise<T>, options: { busyConfirmMs?: number } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-loop-'));
  const now = { value: new Date(2026, 9, 29, 8, 0) };
  const service = new LoopService({
    dataPath: path.join(dir, 'loops.json'), runtime: runtime.port, now: () => now.value, startTimer: false,
    busyConfirmMs: options.busyConfirmMs ?? 0,
  });
  try {
    await service.initialize();
    return await body(service, now);
  } finally {
    service.dispose();
    // A run's last persist can still be writing its temp file when the body returns (startNow does not wait).
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

test('FR-LOOP-003 AC-1/AC-2: steps go out top to bottom — command, the exact wait, then the prompt', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop());
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'success');
    assert.equal(run.stepsSent, 3);
    assert.deepEqual(rt.log, ['s2 codex', 'sleep 2000', 's2 금일 주식 시황 분석하시오']);
    assert.equal(rt.tabs[0].shell, 'powershell');
    assert.equal(rt.tabs[0].cwd, 'C:\\work\\market');
  });
});

test('FR-LOOP-003 AC-3: a session-end step closes the tab instead of typing into it', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop({ steps: [{ kind: 'command', text: 'codex' }, { kind: 'end' }] }));
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'success');
    assert.deepEqual(rt.log, ['s2 codex']);
    assert.equal(rt.tabs.length, 0);
  });
});

test('FR-LOOP-003 AC-4: turning a loop off mid-run sends no more steps and leaves the tab', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop());
    rt.hold();
    const running = service.runNow(created.id);
    await until(() => rt.log.includes('sleep 2000'));
    await service.update(created.id, { ...loop(), enabled: false });
    rt.release();
    const run = await running;
    assert.equal(run.result, 'aborted');
    assert.deepEqual(rt.log, ['s2 codex', 'sleep 2000']);
    assert.equal(rt.tabs.length, 1);
  });
});

test('FR-LOOP-003 AC-5: a missing directory or a shell that will not open is a failed run with no tab', async () => {
  const rt = fakeRuntime({ missingDirs: ['C:\\nowhere'] });
  await withService(rt, async (service) => {
    const created = await service.create(loop({ cwd: 'C:\\nowhere' }));
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'failed');
    assert.equal(run.reason, 'directoryMissing');
    assert.equal(run.detail, 'C:\\nowhere');
    assert.equal(rt.tabs.length, 0);
  });
  const broken = fakeRuntime({ failShell: true });
  await withService(broken, async (service) => {
    const run = await service.runNow((await service.create(loop())).id);
    assert.equal(run.result, 'failed');
    assert.equal(run.reason, 'error');
    assert.match(run.detail ?? '', /shell not found/u);
  });
});

test('FR-LOOP-004 AC-1/AC-2/AC-3: tabs fill @schedule-0, then @schedule-1 is made', async () => {
  const rt = fakeRuntime({ maxTabs: 2 });
  await withService(rt, async (service) => {
    const created = await service.create(loop({ keepTabs: 16 }));
    for (let i = 0; i < 3; i += 1) await service.runNow(created.id);
    assert.deepEqual(rt.workspaces.map((ws) => ws.name), ['ProjectMaster', '@schedule-0', '@schedule-1']);
    assert.deepEqual(rt.tabs.map((tab) => `${rt.workspaces.find((ws) => ws.id === tab.workspaceId)?.name} ${tab.name}`),
      ['@schedule-0 시황 #1', '@schedule-0 시황 #2', '@schedule-1 시황 #3']);
  });
});

test('FR-LOOP-004 AC-1: a free slot in a lower-numbered workspace is used first', async () => {
  const rt = fakeRuntime({ maxTabs: 1 });
  await withService(rt, async (service) => {
    const keep = await service.create(loop({ keepTabs: 16 }));
    await service.runNow(keep.id);
    await service.runNow(keep.id);
    rt.tabs.splice(0, 1); // the user closed the tab in @schedule-0
    await service.runNow(keep.id);
    assert.equal(rt.workspaces.length, 3);
    assert.equal(rt.workspaces.find((ws) => ws.id === rt.tabs.at(-1)!.workspaceId)?.name, '@schedule-0');
  });
});

test('FR-LOOP-004 AC-2: a deleted @schedule workspace is forgotten and the next number goes on', async () => {
  const rt = fakeRuntime({ maxTabs: 1 });
  await withService(rt, async (service) => {
    const created = await service.create(loop({ keepTabs: 16 }));
    await service.runNow(created.id);
    await service.runNow(created.id);
    // The user deletes @schedule-0 with its tab.
    const zero = rt.workspaces.findIndex((ws) => ws.name === '@schedule-0');
    rt.tabs.splice(rt.tabs.findIndex((tab) => tab.workspaceId === rt.workspaces[zero].id), 1);
    rt.workspaces.splice(zero, 1);
    await service.runNow(created.id);
    assert.deepEqual(rt.workspaces.map((ws) => ws.name), ['ProjectMaster', '@schedule-1', '@schedule-2']);
    assert.equal(service.isScheduleWorkspace(rt.workspaces[1].id), true);
    assert.equal(service.isScheduleWorkspace('user'), false);
  });
});

test('FR-LOOP-004 AC-4: tabs of runs without a session end beyond keepTabs close, oldest first', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop({ keepTabs: 2 }));
    for (let i = 0; i < 3; i += 1) await service.runNow(created.id);
    assert.deepEqual(rt.tabs.map((tab) => tab.name), ['시황 #2', '시황 #3']);
  });
});

test('FR-LOOP-004 AC-5: at the tab cap across @schedule workspaces the run is skipped', async () => {
  const rt = fakeRuntime({ maxTabs: 16 });
  await withService(rt, async (service) => {
    const created = await service.create(loop({ keepTabs: 16 }));
    for (let i = 0; i < SCHEDULE_TAB_CAP / 16; i += 1) {
      const other = await service.create(loop({ name: `l${i}`, keepTabs: 16 }));
      for (let j = 0; j < 16; j += 1) await service.runNow(other.id);
    }
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'skipped');
    assert.equal(run.reason, 'tabCap');
    assert.equal(rt.tabs.length, SCHEDULE_TAB_CAP);
  });
});

test('FR-LOOP-004 AC-6: an emptied @schedule workspace is kept', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop({ steps: [{ kind: 'command', text: 'x' }, { kind: 'end' }] }));
    await service.runNow(created.id);
    assert.equal(rt.tabs.length, 0);
    assert.equal(rt.workspaces.some((ws) => ws.name === '@schedule-0'), true);
    assert.equal(rt.events.some((event) => event.startsWith('deleteWorkspace')), false);
  });
});

test('FR-LOOP-005 AC-1: a run due while the last one is still sending is skipped and recorded', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop());
    rt.hold();
    const first = service.runNow(created.id);
    await until(() => rt.log.includes('sleep 2000'));
    const second = await service.runNow(created.id);
    assert.equal(second.result, 'skipped');
    assert.equal(second.reason, 'previousRunning');
    rt.release();
    assert.equal((await first).result, 'success');
    // Once the last step is sent the tab left open does not count as running.
    assert.equal((await service.runNow(created.id)).result, 'success');
  });
});

test('FR-LOOP-005 AC-2: the history keeps the newest 50 runs with their outcome', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop({ steps: [{ kind: 'command', text: 'x' }, { kind: 'end' }] }));
    for (let i = 0; i < 52; i += 1) await service.runNow(created.id);
    const runs = service.history(created.id);
    assert.equal(runs.length, 50);
    assert.equal(runs[0].tabName, '시황 #52');
    assert.equal(runs[0].stepsSent, 2);
    assert.equal(runs[0].totalSteps, 2);
  });
});

test('FR-LOOP-002 AC-3/AC-6: a due loop runs on the tick; a one-time loop turns itself off after its last time', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service, now) => {
    const weekly = await service.create(loop());
    const once = await service.create(loop({ name: 'once', schedule: { kind: 'once', date: '2026-10-29', times: ['08:30'] } }));
    now.value = new Date(2026, 9, 29, 8, 30);
    await service.tick();
    assert.equal(service.history(weekly.id)[0]?.result, 'success');
    // The one-time loop's last time still sends its steps; only then is it off.
    assert.equal(service.history(once.id)[0]?.result, 'success');
    assert.equal(service.history(once.id)[0]?.stepsSent, 3);
    assert.equal(service.get(once.id)?.enabled, false);
    // Back after a gap: the 08:30 runs of the days in between are not made up.
    now.value = new Date(2026, 10, 2, 9, 0);
    await service.tick();
    assert.equal(service.history(weekly.id).length, 1);
    assert.deepEqual(service.get(weekly.id)?.nextRunAt, new Date(2026, 10, 3, 8, 30).toISOString());
  });
});

test('FR-LOOP-001 AC-1: loops survive a restart', async () => {
  const rt = fakeRuntime();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-loop-'));
  try {
    const options = { dataPath: path.join(dir, 'loops.json'), runtime: rt.port, now: () => new Date(2026, 9, 29, 8, 0), startTimer: false };
    const first = new LoopService(options);
    await first.initialize();
    const created = await first.create(loop());
    await first.runNow(created.id);
    first.dispose();
    const second = new LoopService(options);
    await second.initialize();
    assert.equal(second.get(created.id)?.name, '시황');
    assert.equal(second.history(created.id).length, 1);
    second.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-LOOP-001 AC-2: an invalid definition is refused with its reason', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    await assert.rejects(service.create(loop({ steps: [] })), /noSteps/u);
  });
});

test('FR-LOOP-001 AC-5: run now works on a loop that is off', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop({ enabled: false }));
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'success');
    assert.equal(run.stepsSent, 3);
  });
});

test('FR-LOOP-001 AC-5: starting a run answers at once with the running record', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop());
    rt.hold();
    const started = service.startNow(created.id);
    assert.equal(started.result, 'running');
    assert.equal(service.startNow(created.id).result, 'skipped');
    await until(() => rt.log.includes('sleep 2000'));
    rt.release();
    await until(() => service.history(created.id).some((run) => run.id === started.id && run.result === 'success'));
  });
});

test('FR-LOOP-004 AC-4: a kept tab that cannot be closed (moved or gone) does not fail the run', async () => {
  const refuse = new Set<string>();
  const rt = fakeRuntime({ refuseClose: refuse });
  await withService(rt, async (service) => {
    const created = await service.create(loop({ keepTabs: 1 }));
    await service.runNow(created.id);
    refuse.add(rt.tabs[0].id); // the user moved it somewhere the loop can no longer close it
    const second = await service.runNow(created.id);
    assert.equal(second.result, 'success');
    const third = await service.runNow(created.id);
    assert.equal(third.result, 'success');
    // The refused tab is dropped from the loop's list; the second run's tab is closed as usual.
    assert.deepEqual(rt.tabs.map((tab) => tab.name), ['시황 #1', '시황 #3']);
  });
});

test('FR-LOOP-004 AC-4: the tab of a stopped run counts toward the tabs kept', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop({ keepTabs: 1 }));
    rt.hold();
    const running = service.runNow(created.id);
    await until(() => rt.log.includes('sleep 2000'));
    await service.update(created.id, { ...loop(), enabled: false });
    rt.release();
    assert.equal((await running).result, 'aborted');
    await service.update(created.id, { ...loop(), enabled: true });
    await service.runNow(created.id);
    assert.deepEqual(rt.tabs.map((tab) => tab.name), ['시황 #2']);
  });
});

test('FR-LOOP-005 AC-2: a run left running by a restart is recorded as stopped', async () => {
  const rt = fakeRuntime();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-loop-'));
  try {
    const options = { dataPath: path.join(dir, 'loops.json'), runtime: rt.port, now: () => new Date(2026, 9, 29, 8, 0), startTimer: false };
    const first = new LoopService(options);
    await first.initialize();
    const created = await first.create(loop());
    rt.hold();
    void first.runNow(created.id);
    await until(() => rt.log.includes('sleep 2000'));
    first.dispose();
    const second = new LoopService(options);
    await second.initialize();
    assert.equal(second.history(created.id)[0].result, 'aborted');
    assert.equal(second.history(created.id)[0].reason, 'restart');
    second.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-LOOP-003 AC-4: editing a loop that is already off does not stop its running run', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    const created = await service.create(loop({ enabled: false }));
    rt.hold();
    const running = service.runNow(created.id);
    await until(() => rt.log.includes('sleep 2000'));
    await service.update(created.id, { ...loop(), name: '시황 이름만 바꿈', enabled: false });
    rt.release();
    assert.equal((await running).result, 'success');
  });
});

test('FR-LOOP-006 AC-5: a step the session refuses is recorded with its own reason', async () => {
  const rt = fakeRuntime();
  rt.port.submit = async () => false;
  await withService(rt, async (service) => {
    const run = await service.runNow((await service.create(loop())).id);
    assert.equal(run.result, 'failed');
    assert.equal(run.reason, 'inputRejected');
    assert.equal(run.stepsSent, 0);
  });
});

// FR-LOOP-008: loops that send into a tab the user opened.

const userTab = (overrides: Partial<FakeTab> = {}): FakeTab => ({
  id: 'mine', workspaceId: 'user', sessionId: 'u1', name: 'api-server', shell: 'powershell', cwd: 'C:\\work\\api', ...overrides,
});

const sessionLoop = (overrides: Record<string, unknown> = {}, target: Record<string, unknown> = {}) => {
  const { shell: _s, cwd: _c, keepTabs: _k, ...rest } = loop({ steps: [{ kind: 'prompt', text: '진행 상황' }, { kind: 'delay', ms: 500 }, { kind: 'command', text: 'status' }] });
  return { ...rest, target: { kind: 'session', tabId: 'mine', label: { workspaceName: 'old', tabName: 'old' }, skipWhenBusy: true, ...target }, ...overrides };
};

test('FR-LOOP-008 AC-3: steps go into the saved tab\'s session; no tab, workspace or rename', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab());
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'success');
    assert.equal(run.stepsSent, 3);
    assert.deepEqual(rt.log, ['u1 진행 상황', 'sleep 500', 'u1 status']);
    assert.deepEqual(rt.events, [], 'no workspace or tab was created or closed');
    assert.equal(rt.tabs.length, 1);
    assert.equal(rt.tabs[0].name, 'api-server');
    assert.equal(run.tabId, 'mine');
    assert.equal(run.tabName, 'api-server');
    assert.equal(run.workspaceName, 'ProjectMaster');
  });
});

test('FR-LOOP-008 AC-2: saving takes the tab\'s current names as the label', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab());
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    assert.deepEqual(created.target, { kind: 'session', tabId: 'mine', label: { workspaceName: 'ProjectMaster', tabName: 'api-server' }, skipWhenBusy: true });
  });
});

test('FR-LOOP-008 AC-2: an enabled loop on a missing tab or a @schedule tab is refused; an off one keeps its label', async () => {
  const rt = fakeRuntime();
  await withService(rt, async (service) => {
    await assert.rejects(service.create(sessionLoop()), (error: Error & { reason?: string }) => error.reason === 'sessionMissing');
    const off = await service.create(sessionLoop({ enabled: false }));
    assert.deepEqual(off.target.kind === 'session' && off.target.label, { workspaceName: 'old', tabName: 'old' });
    // A tab a new-session loop opened lives in a @schedule workspace.
    const maker = await service.create(loop());
    await service.runNow(maker.id);
    const scheduleTab = rt.tabs[0].id;
    await assert.rejects(service.create(sessionLoop({}, { tabId: scheduleTab })), (error: Error & { reason?: string }) => error.reason === 'session');
  });
});

test('FR-LOOP-008 AC-4: a deleted tab skips the run and turns the loop off', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab());
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    rt.tabs.splice(0, 1);
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'skipped');
    assert.equal(run.reason, 'sessionMissing');
    assert.equal(run.stepsSent, 0);
    assert.deepEqual(rt.log, []);
    assert.equal(service.get(created.id)?.enabled, false);
    assert.equal(service.get(created.id)?.nextRunAt, null);
    assert.equal(run.tabName, 'api-server', 'the record still names what it was');
  });
});

test('FR-LOOP-008 AC-4: a tab whose shell has ended skips the run and the loop stays on', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab({ stopped: true }));
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'skipped');
    assert.equal(run.reason, 'sessionStopped');
    assert.deepEqual(rt.log, []);
    assert.equal(service.get(created.id)?.enabled, true);
  });
});

test('FR-LOOP-008 AC-5: a working agent skips the run when skipWhenBusy is on, and gets the steps when it is off', async () => {
  for (const status of ['busy', 'starting', 'running']) {
    const rt = fakeRuntime();
    rt.tabs.push(userTab({ agent: { kind: 'claude', status } }));
    await withService(rt, async (service) => {
      const skipping = await service.create(sessionLoop());
      const run = await service.runNow(skipping.id);
      assert.equal(run.result, 'skipped', status);
      assert.equal(run.reason, 'agentBusy');
      assert.deepEqual(rt.log, []);
      const sending = await service.create(sessionLoop({ name: 'send anyway' }, { skipWhenBusy: false }));
      assert.equal((await service.runNow(sending.id)).result, 'success');
    });
  }
  const rt = fakeRuntime();
  rt.tabs.push(userTab({ agent: { kind: 'codex', status: 'waiting_input' } }));
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    assert.equal((await service.runNow(created.id)).result, 'success', 'an agent waiting for input is not busy');
  });
});

test('FR-LOOP-008 AC-3: each step finds the tab\'s current session, so a restarted tab is followed', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab());
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    rt.hold();
    const running = service.runNow(created.id);
    await until(() => rt.log.includes('sleep 500'));
    rt.tabs[0].sessionId = 'u2';
    rt.release();
    assert.equal((await running).result, 'success');
    assert.deepEqual(rt.log, ['u1 진행 상황', 'sleep 500', 'u2 status']);
  });
});

test('FR-LOOP-008 AC-4: the tab closing mid-run stops the remaining steps', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab());
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    rt.hold();
    const running = service.runNow(created.id);
    await until(() => rt.log.includes('sleep 500'));
    rt.tabs.splice(0, 1);
    rt.release();
    const run = await running;
    assert.equal(run.result, 'aborted');
    assert.equal(run.reason, 'tabClosed');
    assert.equal(run.stepsSent, 2);
  });
});

test('FR-LOOP-008 AC-6: two loops on the same tab send one run after the other', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab());
  await withService(rt, async (service) => {
    const a = await service.create(sessionLoop({ name: 'a', steps: [{ kind: 'prompt', text: 'a1' }, { kind: 'delay', ms: 1 }, { kind: 'prompt', text: 'a2' }] }));
    const b = await service.create(sessionLoop({ name: 'b', steps: [{ kind: 'prompt', text: 'b1' }] }));
    rt.hold();
    const first = service.runNow(a.id);
    await until(() => rt.log.includes('sleep 1'));
    const second = service.runNow(b.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rt.log, ['u1 a1', 'sleep 1'], 'b waits while a is sending');
    rt.release();
    await Promise.all([first, second]);
    assert.deepEqual(rt.log, ['u1 a1', 'sleep 1', 'u1 a2', 'u1 b1']);
  });
});

test('FR-LOOP-008 AC-7: sessions lists the tabs a loop can send to, without @schedule tabs; targetMissing follows the tab', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab({ agent: { kind: 'claude', status: 'busy' } }), userTab({ id: 'old', name: '오래된 셸', stopped: true }));
  await withService(rt, async (service) => {
    const maker = await service.create(loop());
    await service.runNow(maker.id);
    assert.equal(rt.tabs.length, 3);
    assert.deepEqual(service.sessions(), [
      { tabId: 'mine', workspaceId: 'user', workspaceName: 'ProjectMaster', tabName: 'api-server', cwd: 'C:\\work\\api', shell: 'powershell', alive: true, agent: { kind: 'claude', status: 'busy' } },
      { tabId: 'old', workspaceId: 'user', workspaceName: 'ProjectMaster', tabName: '오래된 셸', cwd: 'C:\\work\\api', shell: 'powershell', alive: false, agent: null },
    ]);
    const created = await service.create(sessionLoop());
    assert.equal(service.targetMissing(service.get(created.id)!), false);
    rt.tabs.splice(0, 1);
    assert.equal(service.targetMissing(service.get(created.id)!), true);
    assert.equal(service.targetMissing(service.get(maker.id)!), false, 'a new-session loop is never missing its target');
  });
});

test('FR-LOOP-008 AC-1: a stored loop from before targets loads as a new session', async () => {
  const rt = fakeRuntime();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-loop-'));
  try {
    const { writeFileSync } = await import('node:fs');
    const stored = { id: 'L1', ...loop(), nextRunAt: null, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z' };
    writeFileSync(path.join(dir, 'loops.json'), JSON.stringify({ version: 1, loops: [stored], runs: {}, counters: {}, scheduleWorkspaces: [], keptTabs: {} }));
    const service = new LoopService({ dataPath: path.join(dir, 'loops.json'), runtime: rt.port, now: () => new Date(2026, 9, 29, 8, 0), startTimer: false });
    await service.initialize();
    const read = service.get('L1')!;
    assert.deepEqual(read.target, { kind: 'new', shell: 'powershell', cwd: 'C:\\work\\market', keepTabs: 1 });
    assert.equal('shell' in read, false);
    assert.equal((await service.runNow('L1')).result, 'success');
    service.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-LOOP-008 AC-3 / FR-LOOP-004 AC-4: a run into the user\'s tab never counts toward kept tabs, even if the target changes mid-run', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab());
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    rt.hold();
    const running = service.runNow(created.id);
    await until(() => rt.log.includes('sleep 500'));
    const { target: _target, ...rest } = sessionLoop();
    await service.update(created.id, { ...rest, target: { kind: 'new', shell: 'bash', cwd: '/w', keepTabs: 1 } });
    rt.release();
    await running;
    await service.runNow(created.id);
    await service.runNow(created.id);
    assert.ok(rt.tabs.some((tab) => tab.id === 'mine'), 'the user tab is still open');
  });
});

// E2E 2026-11-09: 1 of 11 runs typed into a working Claude. The detector's status drops to idle for a
// moment between steps (Claude Code shows ✳ for a few ms; idleDelayMs is 200 ms, SessionManager
// FR-AITUI-010), so one look at the start can land in that gap. The run looks again before sending.
test('FR-LOOP-008 AC-5: an agent that reads idle for a moment but working on a second look skips the run', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab({ agent: { kind: 'claude', status: 'idle' } }));
  const sleep = rt.port.sleep;
  rt.port.sleep = (ms) => {
    rt.tabs[0].agent = { kind: 'claude', status: 'running' };
    return sleep(ms);
  };
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    const run = await service.runNow(created.id);
    assert.equal(run.result, 'skipped');
    assert.equal(run.reason, 'agentBusy');
    assert.equal(rt.log.filter((line) => line.startsWith('u1')).length, 0, 'nothing was typed');
  }, { busyConfirmMs: 1500 });
});

test('FR-LOOP-008 AC-5: an agent idle on every look gets the steps; with skipWhenBusy off nobody waits', async () => {
  const rt = fakeRuntime();
  rt.tabs.push(userTab({ agent: { kind: 'claude', status: 'idle' } }));
  await withService(rt, async (service) => {
    const created = await service.create(sessionLoop());
    assert.equal((await service.runNow(created.id)).result, 'success');
    assert.deepEqual(rt.log.slice(0, 2), ['sleep 750', 'sleep 750'], 'two more looks over the confirm window');
    rt.log.length = 0;
    const eager = await service.create(sessionLoop({ name: 'eager' }, { skipWhenBusy: false }));
    assert.equal((await service.runNow(eager.id)).result, 'success');
    assert.equal(rt.log[0], 'u1 진행 상황', 'no confirm wait when busy runs are not skipped');
  }, { busyConfirmMs: 1500 });
});
