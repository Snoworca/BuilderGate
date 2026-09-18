import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager, stripHostAgentIdentity } from './SessionManager.js';

/**
 * SEC-MCP-003 — a terminal session does not inherit the host's agent identity.
 *
 * `buildShellEnv` copies the server process's whole environment into the PTY.
 * When the server is started from a shell that is itself a Claude Code session
 * — which is how it is started during development and during agent-driven work
 * — every terminal it creates carries that session's markers, and the agent run
 * in the terminal believes it is a child of the host session and keeps no
 * transcript of its own.
 *
 * The environment is read from the object handed to `spawnPty` rather than from
 * `buildShellEnv` alone, because the filter and the `envPatch` merge happen in
 * different places and only the spawn sees the result of both.
 */

/**
 * The variables a Claude Code session exports into its children.
 *
 * Read off a real host environment on 2026-09-11 rather than guessed, which is
 * the only reason the last five are here: they do not share the
 * `CLAUDE_CODE_` namespace. `CLAUDECODE` has no underscore at all, `CLAUDE_PID`
 * names the host process, and `AI_AGENT` names its build. A rule written
 * against `CLAUDE_CODE_` alone leaves every one of them behind.
 */
const HOST_MARKERS = {
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session-id',
  CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-host',
  CLAUDE_CODE_MESSAGING_TOKEN: 'host-token',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDECODE: '1',
  CLAUDE_PID: '58416',
  CLAUDE_EFFORT: 'medium',
  CLAUDE_PLUGIN_DATA: '{}',
  AI_AGENT: 'claude-code_2-1-267_agent',
  // Not a name anyone ships. The rule has to cover the namespace rather than a
  // list, or a variable the tool adds next year walks straight through.
  CLAUDE_CODE_SOMETHING_NOBODY_HAS_HEARD_OF: 'future',
};

/**
 * Variables that must survive untouched.
 *
 * Deliberately synthetic. `PATH`, `HOME` and `USERPROFILE` are the ones that
 * matter, but overwriting them here breaks the shell resolution a session runs
 * through long before it reaches the spawn, so those are compared against the
 * values this process actually holds -- see `REAL_KEEPERS`.
 */
const KEEPERS = {
  SEC_MCP_003_ORDINARY: 'keep me',
  // Contains the prefix without starting with it: the rule is a prefix rule,
  // and a substring match would take a variable belonging to something else.
  MY_CLAUDE_CODE_SETTING: 'keep me too',
};

/** Real variables of the running process, compared by value rather than set. */
const REAL_KEEPERS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP'];

/**
 * The rule, written out here rather than imported from the module under test.
 *
 * Imported, it would agree with any implementation, including one that removed
 * nothing. Written out, it is a second statement of the contract that has to be
 * changed deliberately when the contract changes.
 */
function isHostAgentName(key: string): boolean {
  return key.startsWith('CLAUDE') || key === 'AI_AGENT';
}

interface SpawnCall {
  env: Record<string, string>;
}

/**
 * Runs `body` with the given variables added to `process.env`, and puts the
 * environment back afterwards whatever happens.
 */
function withEnv(extra: Record<string, string>, body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(extra)) {
    saved.set(key, process.env[key]);
    process.env[key] = extra[key];
  }
  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Shuts a manager down so the test process can exit.
 *
 * A session holds cwd watchers and idle timers. Left running they keep the
 * event loop alive, and `node --test` then reports the whole file as failed
 * even though every subtest passed -- a failure that says nothing about the
 * code under test and everything about the harness.
 *
 * Every caller runs this from a `finally`. A teardown that only ran on the way
 * out of a passing test would turn the first real failure into a hung process
 * instead of a red one, which is the worse of the two by a distance: a red test
 * names what broke, a hung one stops the run.
 */
function teardown(manager: SessionManager, ids: string[]): void {
  for (const id of ids) {
    manager.deleteSession(id, 'direct-session-delete');
  }
  manager.stopAllCwdWatching();
}

function setup(): { manager: SessionManager; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      // true rather than false: with false the manager runs a winpty
      // availability probe that really forks node and really spawns
      // powershell, with an unfiltered environment and no bearing on what
      // this file asserts. It also leaves those children behind.
      useConpty: true,
      scrollbackLines: 100,
      maxSnapshotBytes: 1024,
      shell: 'bash',
    },
    session: { idleDelayMs: 200 },
  }, {
    platform: 'win32',
    // Issue #89. This harness pins win32 on a Linux host, which sends
    // isCommandAvailable through `where` instead of `which`. `where` does not
    // exist here, so every probe answered false regardless of what is installed:
    // `which wsl.exe` finds /mnt/c/WINDOWS/system32/wsl.exe while `where wsl.exe`
    // cannot run at all. resolveShell('bash') then fell through resolveAutoShell
    // to powershell, and buildShellEnv sets no BASH_ENV for powershell -- so the
    // OSC 133 case failed on the platform pin rather than on the injection it
    // names. It was carried for days as a pre-existing failure needing a product
    // decision; the measured cause is this line's absence.
    isCommandAvailableFn: () => true,
    spawnPty: ((_file: string, _args: string[], options: { env: Record<string, string> }) => {
      calls.push({ env: options.env });
      return {
        pid: 4242,
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
      };
    }) as never,
  });

  return { manager, calls };
}

/** The environment the PTY was spawned with, asserted to be a real object. */
function spawnedEnv(calls: SpawnCall[]): Record<string, string> {
  assert.equal(calls.length, 1, 'the pty was not spawned exactly once');
  const env = calls[0].env;
  // The cast into the harness is unchecked, so the shape is asserted here. A
  // spawn that stopped passing `env` would otherwise make every assertion
  // below read as a pass over `undefined`.
  assert.equal(typeof env, 'object', 'spawnPty received no env object');
  assert.notEqual(env, null, 'spawnPty received a null env');
  assert.ok(Object.keys(env).length > 0, 'spawnPty received an empty env');
  return env;
}

test('SEC-MCP-003 the host session marker does not reach a spawned terminal', () => {
  withEnv(HOST_MARKERS, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-marker', 'bash').id;

    try {

      const env = spawnedEnv(calls);
      assert.equal(
        env.CLAUDE_CODE_CHILD_SESSION,
        undefined,
        'the spawned terminal inherited CLAUDE_CODE_CHILD_SESSION, so an agent there keeps no transcript',
      );
      // The marker really was set on the server process, so the absence above is
      // not vacuous.
      assert.equal(process.env.CLAUDE_CODE_CHILD_SESSION, '1');
    } finally {
      teardown(manager, [id]);
    }
  });
});

test('SEC-MCP-003 every variable in the vendor namespace is dropped, by prefix and not by name', () => {
  withEnv(HOST_MARKERS, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-prefix', 'bash').id;

    try {

      const env = spawnedEnv(calls);
      for (const key of Object.keys(HOST_MARKERS)) {
        assert.equal(env[key], undefined, `${key} reached the spawned terminal`);
        assert.equal(process.env[key], HOST_MARKERS[key as keyof typeof HOST_MARKERS]);
      }
      assert.deepEqual(
        Object.keys(env).filter(key => key.startsWith('CLAUDE_CODE_')),
        [],
        'a variable in the filtered namespace survived',
      );
    } finally {
      teardown(manager, [id]);
    }
  });
});

test('SEC-MCP-003 nothing outside the namespace is removed', () => {
  withEnv({ ...HOST_MARKERS, ...KEEPERS }, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-keepers', 'bash').id;

    try {

      const env = spawnedEnv(calls);
      for (const [key, value] of Object.entries(KEEPERS)) {
        assert.equal(env[key], value, `${key} was lost or altered on the way to the terminal`);
      }

      // The variables a shell actually needs, compared against what this process
      // holds rather than against values written here -- setting them would break
      // the shell resolution long before the spawn.
      //
      // Looked up without regard to case. `process.env` is case-insensitive on
      // Windows while the plain object handed to the spawn is not, so `SystemRoot`
      // can be stored as `SYSTEMROOT` and a direct lookup would report it missing.
      // That is true of any copy of `process.env`, including the spread this
      // filter replaced, so it is a property of the platform rather than of the
      // change under test.
      const byLowerKey = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
      let compared = 0;
      for (const key of REAL_KEEPERS) {
        const value = process.env[key];
        if (value === undefined) continue;
        compared += 1;
        assert.equal(
          byLowerKey.get(key.toLowerCase()),
          value,
          `${key} was lost or altered on the way to the terminal`,
        );
      }
      assert.ok(compared > 0, 'none of the real variables were set, so this half cannot judge');

      // The count is compared as well as the named keys. A filter that removed
      // everything would satisfy the absences above and fail here, and so would
      // one that removed a variable nobody thought to name.
      const carried = Object.keys(process.env).filter(key => isHostAgentName(key));
      const removed = Object.keys(process.env).filter(key => env[key] === undefined);
      assert.ok(carried.length > 0, 'the server process carried no host variable, so this cannot judge');
      assert.deepEqual(
        removed.filter(key => !isHostAgentName(key)),
        [],
        'the filter removed variables outside the host agent namespace',
      );
      // The counts match, which is the half the criterion names and the half a
      // subset check leaves open: a filter that dropped one of the two rules
      // would still satisfy the subset above.
      assert.equal(
        removed.length,
        carried.length,
        'the number of removed variables does not match the number the process carried',
      );
    } finally {
      teardown(manager, [id]);
    }
  });
});

test('SEC-MCP-003 the OSC 133 BASH_ENV injection survives the filter', () => {
  withEnv(HOST_MARKERS, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-bashenv', 'bash').id;

    try {

      const env = spawnedEnv(calls);
      // The injection happens in the same function as the filter, so a filter
      // applied after it would take the injected value away again.
      assert.equal(typeof env.BASH_ENV, 'string', 'the OSC 133 script path is gone');
      assert.ok(env.BASH_ENV.length > 0, 'BASH_ENV is empty');
    } finally {
      teardown(manager, [id]);
    }
  });
});

test('SEC-MCP-003 a variable the caller named in envPatch survives the filter', () => {
  withEnv(HOST_MARKERS, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-patch', 'bash', undefined, {
      envPatch: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' },
    }).id;

    try {

      const env = spawnedEnv(calls);
      assert.equal(
        env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE,
        '1',
        'a value the caller asked for was filtered out',
      );
      // And the inherited ones still went, so the patch did not turn the filter
      // off wholesale.
      assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
    } finally {
      teardown(manager, [id]);
    }
  });
});

test('SEC-MCP-003 the rule covers the host names that sit outside the CLAUDE_CODE_ namespace', () => {
  // Judged on the function directly. Five of the host's variables do not carry
  // that prefix -- `CLAUDECODE` has no underscore, `CLAUDE_PID` names the host
  // process, `AI_AGENT` names its build -- and a rule written against the
  // prefix alone leaves every one of them in the terminal. Going through the
  // function rather than through a session keeps this readable as what it is: a
  // statement about which names belong to the host.
  const filtered = stripHostAgentIdentity({
    ...HOST_MARKERS,
    ...KEEPERS,
    PATH: '/usr/bin',
  });

  for (const key of Object.keys(HOST_MARKERS)) {
    assert.equal(filtered[key], undefined, `${key} survived the rule`);
  }
  for (const [key, value] of Object.entries(KEEPERS)) {
    assert.equal(filtered[key], value, `${key} was taken by the rule`);
  }
  assert.equal(filtered.PATH, '/usr/bin');

  // A value the caller could not have produced by accident: the input really
  // carried every name asserted absent above.
  assert.equal(Object.keys(HOST_MARKERS).length, 11);
});

test('SEC-MCP-003 the rule takes the namespace and not everything that mentions it', () => {
  const filtered = stripHostAgentIdentity({
    // Taken: the host's own names.
    CLAUDECODE: '1',
    CLAUDE_ANYTHING_ADDED_LATER: 'x',
    AI_AGENT: 'claude-code',
    // Kept: names that merely mention it, and the one vendor variable a user
    // sets for their own work rather than inheriting from a host session.
    MY_CLAUDE_SETTING: 'keep',
    NOT_AI_AGENT: 'keep',
    ANTHROPIC_API_KEY: 'keep',
  });

  assert.deepEqual(Object.keys(filtered).sort(), [
    'ANTHROPIC_API_KEY',
    'MY_CLAUDE_SETTING',
    'NOT_AI_AGENT',
  ]);
});

test('SEC-MCP-003 an undefined value is dropped rather than carried as the string undefined', () => {
  // `process.env` never holds one, but the parameter type admits it, and a
  // spread would have put the literal `undefined` into the environment handed
  // to the spawn.
  const filtered = stripHostAgentIdentity({ KEPT: 'yes', GONE: undefined });

  assert.deepEqual(filtered, { KEPT: 'yes' });
});
