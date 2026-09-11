import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager } from './SessionManager.js';

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

/** The variables a Claude Code session exports into its children. */
const HOST_MARKERS = {
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session-id',
  CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-host',
  CLAUDE_CODE_MESSAGING_TOKEN: 'host-token',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  // Not a name anyone ships. The filter has to be a prefix rule rather than a
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
      useConpty: false,
      scrollbackLines: 100,
      maxSnapshotBytes: 1024,
      shell: 'bash',
    },
    session: { idleDelayMs: 200 },
  }, {
    platform: 'win32',
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

    const env = spawnedEnv(calls);
    assert.equal(
      env.CLAUDE_CODE_CHILD_SESSION,
      undefined,
      'the spawned terminal inherited CLAUDE_CODE_CHILD_SESSION, so an agent there keeps no transcript',
    );
    // The marker really was set on the server process, so the absence above is
    // not vacuous.
    assert.equal(process.env.CLAUDE_CODE_CHILD_SESSION, '1');
    teardown(manager, [id]);
  });
});

test('SEC-MCP-003 every variable in the vendor namespace is dropped, by prefix and not by name', () => {
  withEnv(HOST_MARKERS, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-prefix', 'bash').id;

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
    teardown(manager, [id]);
  });
});

test('SEC-MCP-003 nothing outside the namespace is removed', () => {
  withEnv({ ...HOST_MARKERS, ...KEEPERS }, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-keepers', 'bash').id;

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
    const before = Object.keys(process.env).filter(key => key.startsWith('CLAUDE_CODE_')).length;
    const removed = Object.keys(process.env).filter(key => env[key] === undefined);
    assert.ok(before > 0, 'the server process carried no prefixed variable, so this cannot judge');
    assert.deepEqual(
      removed.filter(key => !key.startsWith('CLAUDE_CODE_')),
      [],
      'the filter removed variables outside its namespace',
    );
    teardown(manager, [id]);
  });
});

test('SEC-MCP-003 the OSC 133 BASH_ENV injection survives the filter', () => {
  withEnv(HOST_MARKERS, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-bashenv', 'bash').id;

    const env = spawnedEnv(calls);
    // The injection happens in the same function as the filter, so a filter
    // applied after it would take the injected value away again.
    assert.equal(typeof env.BASH_ENV, 'string', 'the OSC 133 script path is gone');
    assert.ok(env.BASH_ENV.length > 0, 'BASH_ENV is empty');
    teardown(manager, [id]);
  });
});

test('SEC-MCP-003 a variable the caller named in envPatch survives the filter', () => {
  withEnv(HOST_MARKERS, () => {
    const { manager, calls } = setup();
    const id = manager.createSession('env-isolation-patch', 'bash', undefined, {
      envPatch: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' },
    }).id;

    const env = spawnedEnv(calls);
    assert.equal(
      env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE,
      '1',
      'a value the caller asked for was filtered out',
    );
    // And the inherited ones still went, so the patch did not turn the filter
    // off wholesale.
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
    teardown(manager, [id]);
  });
});
