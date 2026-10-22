// FR-ARCH-014: a session whose program is waiting on a GUI editor on the
// server's desktop (Claude Code's Ctrl+G runs `start /wait notepad`) looks
// frozen from a phone. Measured 2026-10-21: claude.exe waited 2.5 hours on a
// notepad nobody could see, and no reload brought the session back.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessInfo } from '../agentSession/agentSessionResolver.js';
import {
  closeEditorWait,
  EDITOR_WAIT_SCAN_INTERVAL_MS,
  EditorWaitMonitor,
  findEditorWait,
  type EditorWait,
} from './editorWait.js';

const SHELL = 100;

// powershell(100) -> claude.exe(200) -> cmd /c start /wait notepad(300) -> Notepad.exe(400)
function claudeCtrlGTree(): ProcessInfo[] {
  return [
    { pid: SHELL, ppid: 1, name: 'powershell.exe', createdAtMs: 1_000 },
    { pid: 200, ppid: SHELL, name: 'claude.exe', createdAtMs: 2_000 },
    { pid: 210, ppid: 200, name: 'node.exe', createdAtMs: 2_100 },
    { pid: 300, ppid: 200, name: 'cmd.exe', createdAtMs: 3_000 },
    { pid: 400, ppid: 300, name: 'Notepad.exe', createdAtMs: 3_100 },
  ];
}

test('FR-ARCH-014 AC-1: a GUI editor anywhere under the session shell is an editor wait, any letter case', () => {
  assert.deepEqual(findEditorWait(claudeCtrlGTree(), SHELL), { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 });
});

test('FR-ARCH-014 AC-1: every listed editor name counts, and nothing else does', () => {
  for (const name of ['notepad.exe', 'notepad++.exe', 'Code.exe', 'sublime_text.exe', 'wordpad.exe', 'write.exe', 'gvim.exe', 'gedit', 'kate', 'mousepad', 'xed', 'pluma']) {
    const processes: ProcessInfo[] = [
      { pid: SHELL, ppid: 1, name: 'bash' },
      { pid: 500, ppid: SHELL, name },
    ];
    assert.equal(findEditorWait(processes, SHELL)?.pid, 500, name);
  }
  for (const name of ['vim', 'nano', 'node.exe', 'notepad.exe.bak', 'mynotepad.exe']) {
    const processes: ProcessInfo[] = [
      { pid: SHELL, ppid: 1, name: 'bash' },
      { pid: 500, ppid: SHELL, name },
    ];
    assert.equal(findEditorWait(processes, SHELL), null, name);
  }
});

test('FR-ARCH-014 AC-1: an editor that is not under this session shell is not this session\'s wait', () => {
  const processes = [
    ...claudeCtrlGTree().filter(p => p.pid !== 400),
    // The user's own notepad, opened from the desktop.
    { pid: 900, ppid: 16_060, name: 'Notepad.exe', createdAtMs: 500 },
  ];
  assert.equal(findEditorWait(processes, SHELL), null);
});

test('FR-ARCH-014 AC-1: the earliest editor wins and a parent loop from a reused pid does not hang', () => {
  const processes: ProcessInfo[] = [
    { pid: SHELL, ppid: 700, name: 'bash' },
    { pid: 700, ppid: SHELL, name: 'sh' },
    { pid: 701, ppid: 700, name: 'gedit', createdAtMs: 9_000 },
    { pid: 702, ppid: 700, name: 'kate', createdAtMs: 8_000 },
  ];
  assert.equal(findEditorWait(processes, SHELL)?.pid, 702);
});

class Clock {
  intervals: Array<{ fn: () => void; ms: number }> = [];
  setInterval = (fn: () => void, ms: number) => {
    this.intervals.push({ fn, ms });
    return this.intervals.length as unknown as ReturnType<typeof setInterval>;
  };
  clearInterval = () => {
    this.intervals = [];
  };
}

function monitorWith(options: {
  sessions?: () => Array<{ sessionId: string; shellPid: number | null }>;
  list?: () => Promise<ProcessInfo[]>;
}) {
  const changes: Array<[string, EditorWait | null]> = [];
  let listed = 0;
  const clock = new Clock();
  const monitor = new EditorWaitMonitor({
    listSessions: options.sessions ?? (() => [{ sessionId: 's1', shellPid: SHELL }]),
    listProcesses: async () => {
      listed += 1;
      return (options.list ?? (async () => claudeCtrlGTree()))();
    },
    onChange: (sessionId, wait) => changes.push([sessionId, wait]),
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  return { monitor, changes, clock, listed: () => listed };
}

test('FR-ARCH-014 AC-2: a wait that starts, changes or ends is reported once each', async () => {
  let tree = claudeCtrlGTree();
  const { monitor, changes } = monitorWith({ list: async () => tree });

  await monitor.scanOnce();
  await monitor.scanOnce();
  assert.deepEqual(changes, [['s1', { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 }]]);
  assert.deepEqual(monitor.get('s1'), { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 });

  tree = [...claudeCtrlGTree().filter(p => p.pid !== 400), { pid: 401, ppid: 300, name: 'Notepad.exe', createdAtMs: 5_000 }];
  await monitor.scanOnce();
  tree = claudeCtrlGTree().filter(p => p.pid !== 400);
  await monitor.scanOnce();

  assert.deepEqual(changes.slice(1), [
    ['s1', { pid: 401, name: 'Notepad.exe', startedAtMs: 5_000 }],
    ['s1', null],
  ]);
  assert.equal(monitor.get('s1'), null);
});

test('FR-ARCH-014 AC-5: scans run every 20 seconds, only with a live session, never two at once', async () => {
  assert.equal(EDITOR_WAIT_SCAN_INTERVAL_MS, 20_000);
  let sessions: Array<{ sessionId: string; shellPid: number | null }> = [];
  let release: (value: ProcessInfo[]) => void = () => undefined;
  const { monitor, clock, listed } = monitorWith({
    sessions: () => sessions,
    list: () => new Promise<ProcessInfo[]>((resolve) => { release = resolve; }),
  });
  monitor.start();
  assert.deepEqual(clock.intervals.map(entry => entry.ms), [20_000]);

  clock.intervals[0].fn();
  assert.equal(listed(), 0, 'no session, no process query');

  sessions = [{ sessionId: 's1', shellPid: SHELL }];
  clock.intervals[0].fn();
  clock.intervals[0].fn();
  assert.equal(listed(), 1, 'a scan still running is not started again');
  release(claudeCtrlGTree());
  await new Promise(resolve => setImmediate(resolve));
  clock.intervals[0].fn();
  assert.equal(listed(), 2);

  monitor.stop();
  assert.deepEqual(clock.intervals, []);
});

test('FR-ARCH-014 AC-6: a failed query keeps what was known and the next scan tries again', async () => {
  let fail = false;
  const { monitor, changes, listed } = monitorWith({
    list: async () => {
      if (fail) throw new Error('powershell timed out');
      return claudeCtrlGTree();
    },
  });
  await monitor.scanOnce();
  fail = true;
  await monitor.scanOnce();
  assert.equal(changes.length, 1);
  assert.equal(monitor.get('s1')?.pid, 400);
  fail = false;
  await monitor.scanOnce();
  assert.equal(listed(), 3);
  assert.equal(changes.length, 1);
});

test('FR-ARCH-014 AC-2: a session that is gone is forgotten without a report', async () => {
  let sessions = [{ sessionId: 's1', shellPid: SHELL }];
  const { monitor, changes } = monitorWith({ sessions: () => sessions });
  await monitor.scanOnce();
  sessions = [{ sessionId: 's2', shellPid: 999 }];
  await monitor.scanOnce();
  assert.equal(monitor.get('s1'), null);
  assert.deepEqual(changes.map(([id]) => id), ['s1']);
});

test('FR-ARCH-014 AC-4: closing ends that one editor process after checking pid and start time', async () => {
  const killed: number[] = [];
  const result = await closeEditorWait({
    current: { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 },
    requestedPid: 400,
    shellPid: SHELL,
    listProcesses: async () => claudeCtrlGTree(),
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(killed, [400], 'only the editor, not cmd or claude above it');
});

test('FR-ARCH-014 AC-4: nothing is ended when the request does not match the current wait', async () => {
  const cases: Array<{ label: string; current: EditorWait | null; requestedPid: number; tree: ProcessInfo[]; code: string }> = [
    { label: 'no wait', current: null, requestedPid: 400, tree: claudeCtrlGTree(), code: 'EDITOR_WAIT_NOT_FOUND' },
    { label: 'another pid', current: { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 }, requestedPid: 401, tree: claudeCtrlGTree(), code: 'EDITOR_WAIT_MISMATCH' },
    { label: 'already gone', current: { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 }, requestedPid: 400, tree: claudeCtrlGTree().filter(p => p.pid !== 400), code: 'EDITOR_WAIT_GONE' },
    {
      label: 'pid reused by another process',
      current: { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 },
      requestedPid: 400,
      tree: [...claudeCtrlGTree().filter(p => p.pid !== 400), { pid: 400, ppid: 300, name: 'Notepad.exe', createdAtMs: 7_777 }],
      code: 'EDITOR_WAIT_GONE',
    },
    {
      label: 'moved out of the session',
      current: { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 },
      requestedPid: 400,
      tree: [...claudeCtrlGTree().filter(p => p.pid !== 400), { pid: 400, ppid: 16_060, name: 'Notepad.exe', createdAtMs: 3_100 }],
      code: 'EDITOR_WAIT_GONE',
    },
  ];
  for (const entry of cases) {
    const killed: number[] = [];
    const result = await closeEditorWait({
      current: entry.current,
      requestedPid: entry.requestedPid,
      shellPid: SHELL,
      listProcesses: async () => entry.tree,
      kill: (pid) => killed.push(pid),
    });
    assert.deepEqual(result, { ok: false, code: entry.code }, entry.label);
    assert.deepEqual(killed, [], entry.label);
  }
});

test('FR-ARCH-014 AC-4: an editor that ends between the check and the kill is reported as gone', async () => {
  const result = await closeEditorWait({
    current: { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 },
    requestedPid: 400,
    shellPid: SHELL,
    listProcesses: async () => claudeCtrlGTree(),
    kill: () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    },
  });
  assert.deepEqual(result, { ok: false, code: 'EDITOR_WAIT_GONE' });
});

test('FR-ARCH-014 AC-4: a closed wait is reported as ended right away', async () => {
  const { monitor, changes } = monitorWith({});
  await monitor.scanOnce();
  monitor.markClosed('s1', 400);
  assert.equal(monitor.get('s1'), null);
  assert.deepEqual(changes.at(-1), ['s1', null]);
  monitor.markClosed('s1', 400);
  assert.equal(changes.length, 2, 'a second close reports nothing');
});
