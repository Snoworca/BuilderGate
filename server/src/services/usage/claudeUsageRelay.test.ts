import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CLAUDE_RELAY_FILE,
  CLAUDE_USAGE_FILE,
  claudeRelaySource,
  installClaudeRelay,
  readClaudeUsage,
  relayStatus,
  uninstallClaudeRelay,
} from './claudeUsageRelay.js';

const NOW = Date.parse('2026-10-31T09:00:00.000Z');

function configDir(withAccount = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-claude-relay-'));
  if (withAccount) {
    writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      oauthAccount: { accountUuid: 'acc-uuid-1', organizationUuid: 'org-uuid-1', emailAddress: 'beom@hancomins.com', planDisplayName: 'Max', organizationType: 'claude_max' },
      unrelated: { keep: true },
    }));
  }
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const statusInput = JSON.stringify({
  session_id: 's1',
  transcript_path: '/secret/path/transcript.jsonl',
  rate_limits: {
    five_hour: { used_percentage: 38, resets_at: '2026-10-31T11:10:00.000Z' },
    seven_day: { used_percentage: 71, resets_at: 1793776651 },
  },
});

/** An "original statusline" that prints what it read, so pass-through can be checked. */
const echoCommand = `"${process.execPath}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('HUD:'+JSON.parse(s).session_id);process.exit(3)})"`;

function runRelay(dir: string, input: string) {
  writeFileSync(path.join(dir, CLAUDE_RELAY_FILE), claudeRelaySource());
  return spawnSync(process.execPath, [path.join(dir, CLAUDE_RELAY_FILE)], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    timeout: 20_000,
  });
}

test('FR-USAGE-002 AC-1/AC-2/AC-3: the relay records rate limits and the hashed account, nothing else', () => {
  const c = configDir();
  try {
    writeFileSync(path.join(c.dir, 'buildergate-statusline.json'), JSON.stringify({ original: { type: 'command', command: echoCommand } }));
    const run = runRelay(c.dir, statusInput);
    const usage = JSON.parse(readFileSync(path.join(c.dir, CLAUDE_USAGE_FILE), 'utf8'));
    const [key, entry] = Object.entries(usage.accounts)[0] as [string, any];
    assert.match(key, /^[0-9a-f]{16}$/u);
    assert.equal(entry.email, 'beom@hancomins.com', 'the whole address (user decision 2026-10-31)');
    assert.equal(entry.plan, 'Max');
    assert.equal(entry.five_hour.used_percentage, 38);
    assert.equal(entry.seven_day.used_percentage, 71);
    const raw = readFileSync(path.join(c.dir, CLAUDE_USAGE_FILE), 'utf8');
    for (const secret of ['acc-uuid-1', 'org-uuid-1', 'transcript', '/secret/path']) {
      assert.equal(raw.includes(secret), false, `${secret} is not recorded`);
    }
    assert.equal(run.status, 3, 'the original exit code passes through');
  } finally {
    c.done();
  }
});

test('FR-USAGE-002 AC-4: the original statusline gets the same input and its output is printed unchanged', () => {
  const c = configDir();
  try {
    writeFileSync(path.join(c.dir, 'buildergate-statusline.json'), JSON.stringify({ original: { type: 'command', command: echoCommand } }));
    assert.equal(runRelay(c.dir, statusInput).stdout, 'HUD:s1');
  } finally {
    c.done();
  }
});

test('FR-USAGE-002 AC-4: a recording failure still runs the original; no original prints nothing', () => {
  const c = configDir();
  try {
    writeFileSync(path.join(c.dir, 'buildergate-statusline.json'), JSON.stringify({ original: { type: 'command', command: echoCommand } }));
    mkdirSync(path.join(c.dir, CLAUDE_USAGE_FILE)); // a directory where the file goes: the write fails
    assert.equal(runRelay(c.dir, statusInput).stdout, 'HUD:s1');
    // Seen on Windows with several Claude sessions at once: a failed rename left its temp file behind.
    assert.deepEqual(readdirSync(c.dir).filter((name) => name.endsWith('.tmp')), [], 'no temp file is left');
    rmSync(path.join(c.dir, CLAUDE_USAGE_FILE), { recursive: true });
    writeFileSync(path.join(c.dir, 'buildergate-statusline.json'), JSON.stringify({ original: null }));
    const quiet = runRelay(c.dir, statusInput);
    assert.equal(quiet.stdout, '');
    assert.equal(quiet.status, 0);
    assert.ok(existsSync(path.join(c.dir, CLAUDE_USAGE_FILE)), 'recording still happens without an original');
  } finally {
    c.done();
  }
});

test('FR-USAGE-002: input without rate limits (API key mode) records nothing and still passes through', () => {
  const c = configDir();
  try {
    writeFileSync(path.join(c.dir, 'buildergate-statusline.json'), JSON.stringify({ original: { type: 'command', command: echoCommand } }));
    const run = runRelay(c.dir, JSON.stringify({ session_id: 's2' }));
    assert.equal(run.stdout, 'HUD:s2');
    assert.equal(existsSync(path.join(c.dir, CLAUDE_USAGE_FILE)), false);
  } finally {
    c.done();
  }
});

test('FR-USAGE-001/004: the server reads relay records as Claude readings', async () => {
  const c = configDir();
  try {
    writeFileSync(path.join(c.dir, CLAUDE_USAGE_FILE), JSON.stringify({
      version: 1,
      accounts: {
        abcdef0123456789: {
          email: 'b***@hancomins.com', plan: 'Max', observedAt: '2026-10-31T08:59:00.000Z',
          five_hour: { used_percentage: 38, resets_at: '2026-10-31T11:10:00.000Z' },
          seven_day: { used_percentage: 71, resets_at: 1793776651 },
        },
      },
    }));
    const readings = await readClaudeUsage([{ configDir: c.dir, source: 'wsl' }]);
    assert.equal(readings.length, 1);
    assert.deepEqual(readings[0].windows, {
      fiveHour: { usedPercent: 38, resetsAt: Date.parse('2026-10-31T11:10:00.000Z') },
      weekly: { usedPercent: 71, resetsAt: 1793776651000 },
    });
    assert.equal(readings[0].source, 'wsl');
    assert.equal(readings[0].accountKey, 'abcdef0123456789');
    assert.deepEqual(await readClaudeUsage([{ configDir: path.join(c.dir, 'missing'), source: 'windows' }]), []);
  } finally {
    c.done();
  }
});

test('FR-USAGE-003 AC-1/AC-3: turning on wraps statusLine once, keeps other keys and stores the original', async () => {
  const c = configDir(false);
  try {
    const settings = { theme: 'dark', statusLine: { type: 'command', command: 'node C:/hud/index.js', padding: 0 } };
    writeFileSync(path.join(c.dir, 'settings.json'), JSON.stringify(settings, null, 2));
    await installClaudeRelay({ configDir: c.dir, commandPath: 'C:/cfg', nodeCommand: 'node' });
    await installClaudeRelay({ configDir: c.dir, commandPath: 'C:/cfg', nodeCommand: 'node' });
    const after = JSON.parse(readFileSync(path.join(c.dir, 'settings.json'), 'utf8'));
    assert.equal(after.theme, 'dark');
    assert.equal(after.statusLine.command, `node "C:/cfg/${CLAUDE_RELAY_FILE}"`);
    assert.equal(after.statusLine.padding, 0);
    const stored = JSON.parse(readFileSync(path.join(c.dir, 'buildergate-statusline.json'), 'utf8'));
    assert.deepEqual(stored.original, settings.statusLine, 'the original is kept, not the relay itself');
    assert.ok(existsSync(path.join(c.dir, CLAUDE_RELAY_FILE)));
    assert.equal((await relayStatus(c.dir)).installed, true);
  } finally {
    c.done();
  }
});

test('FR-USAGE-003 AC-2: turning off restores the original exactly, or removes statusLine if there was none', async () => {
  const c = configDir(false);
  try {
    const settings = { statusLine: { type: 'command', command: 'node C:/hud/index.js' }, other: 1 };
    writeFileSync(path.join(c.dir, 'settings.json'), JSON.stringify(settings));
    await installClaudeRelay({ configDir: c.dir, commandPath: 'C:/cfg', nodeCommand: 'node' });
    await uninstallClaudeRelay(c.dir);
    assert.deepEqual(JSON.parse(readFileSync(path.join(c.dir, 'settings.json'), 'utf8')), settings);
    assert.equal(existsSync(path.join(c.dir, CLAUDE_RELAY_FILE)), false);

    writeFileSync(path.join(c.dir, 'settings.json'), JSON.stringify({ other: 1 }));
    await installClaudeRelay({ configDir: c.dir, commandPath: 'C:/cfg', nodeCommand: 'node' });
    await uninstallClaudeRelay(c.dir);
    assert.deepEqual(JSON.parse(readFileSync(path.join(c.dir, 'settings.json'), 'utf8')), { other: 1 });
  } finally {
    c.done();
  }
});

test('FR-USAGE-003 AC-4: a statusLine changed by the user after turning on is reported as drifted', async () => {
  const c = configDir(false);
  try {
    writeFileSync(path.join(c.dir, 'settings.json'), JSON.stringify({}));
    await installClaudeRelay({ configDir: c.dir, commandPath: 'C:/cfg', nodeCommand: 'node' });
    writeFileSync(path.join(c.dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'other-hud' } }));
    assert.deepEqual(await relayStatus(c.dir), { installed: false, drifted: true });
  } finally {
    c.done();
  }
});

const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
test('FR-USAGE-002 AC-4: on Windows the original statusline runs in Git Bash, as Claude Code runs it', { skip: process.platform !== 'win32' || !existsSync(gitBash) }, () => {
  const c = configDir();
  try {
    writeFileSync(path.join(c.dir, 'buildergate-statusline.json'), JSON.stringify({ original: { type: 'command', command: 'echo "HUD:$((1+1))"' } }));
    const run = runRelay(c.dir, statusInput);
    assert.equal(run.stdout.trim(), 'HUD:2', 'bash arithmetic, which cmd.exe would print literally');
  } finally {
    c.done();
  }
});

test('FR-USAGE-003 AC-2: turning off also removes the relay records, so no stale Claude bar is left', async () => {
  const c = configDir(false);
  try {
    writeFileSync(path.join(c.dir, 'settings.json'), JSON.stringify({}));
    await installClaudeRelay({ configDir: c.dir, commandPath: 'C:/cfg', nodeCommand: 'node' });
    writeFileSync(path.join(c.dir, CLAUDE_USAGE_FILE), JSON.stringify({ version: 1, accounts: {} }));
    await uninstallClaudeRelay(c.dir);
    assert.equal(existsSync(path.join(c.dir, CLAUDE_USAGE_FILE)), false);
  } finally {
    c.done();
  }
});

test('FR-USAGE-002 AC-4: without git on PATH the relay still finds Git Bash at its default place', { skip: process.platform !== 'win32' || !existsSync(gitBash) }, () => {
  const c = configDir();
  try {
    writeFileSync(path.join(c.dir, CLAUDE_RELAY_FILE), claudeRelaySource());
    writeFileSync(path.join(c.dir, 'buildergate-statusline.json'), JSON.stringify({ original: { type: 'command', command: 'echo "HUD:$((2+2))"' } }));
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: c.dir, PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' };
    const run = spawnSync(process.execPath, [path.join(c.dir, CLAUDE_RELAY_FILE)], { input: statusInput, encoding: 'utf8', env, timeout: 20_000 });
    assert.equal(run.stdout.trim(), 'HUD:4');
  } finally {
    c.done();
  }
});
