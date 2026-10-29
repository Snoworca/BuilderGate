import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LoopService, SCHEDULE_TAB_CAP, type LoopRuntimePort } from './LoopService.js';
import type { LoopInput } from './loopDefinition.js';

// FR-LOOP-003 / FR-LOOP-004 / FR-LOOP-005: a loop run against an in-memory workspace.

interface FakeTab { id: string; workspaceId: string; sessionId: string; name: string; shell: string; cwd: string }

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
  };
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

async function withService<T>(runtime: ReturnType<typeof fakeRuntime>, body: (service: LoopService, now: { value: Date }) => Promise<T>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-loop-'));
  const now = { value: new Date(2026, 9, 29, 8, 0) };
  const service = new LoopService({ dataPath: path.join(dir, 'loops.json'), runtime: runtime.port, now: () => now.value, startTimer: false });
  try {
    await service.initialize();
    return await body(service, now);
  } finally {
    service.dispose();
    rmSync(dir, { recursive: true, force: true });
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
