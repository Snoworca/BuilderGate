import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeCommandFrom, uncToLinuxPath } from './usageSources.js';

test('FR-USAGE-003: a WSL folder reached over \\\\wsl.localhost is written into the command as its Linux path', () => {
  assert.equal(uncToLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\beom\\.claude'), '/home/beom/.claude');
  assert.equal(uncToLinuxPath('\\\\wsl$\\Ubuntu-22.04\\home\\dev\\.claude'), '/home/dev/.claude');
  assert.equal(uncToLinuxPath('C:\\Users\\beom\\.claude'), null);
});

test('FR-USAGE-003: the relay runs with the node the original statusline used, else node', () => {
  assert.equal(nodeCommandFrom("'/home/beom/.nvm/versions/node/v24.21.0/bin/node' '/home/beom/.claude/plugins/claude-hud/statusline.mjs'"), "'/home/beom/.nvm/versions/node/v24.21.0/bin/node'");
  assert.equal(nodeCommandFrom('"C:\\Program Files\\nodejs\\node.exe" C:/x.js'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(nodeCommandFrom('node C:/Users/beom/.claude/plugins/x/index.js'), 'node');
  assert.equal(nodeCommandFrom('bun run hud.ts'), 'node');
  assert.equal(nodeCommandFrom(null), 'node');
});

test('FR-USAGE-003: a folder whose node cannot be found is refused, not wrapped', async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createUsageSources } = await import('./usageSources.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-usage-src-'));
  try {
    const claudeHome = path.join(dir, '.claude');
    (await import('node:fs')).mkdirSync(claudeHome);
    writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'hud' } }));
    const sources = createUsageSources({
      locations: async () => ({ codex: [], claude: [{ configDir: claudeHome, source: 'local' }] }),
      nodeExists: async () => false,
    });
    const [result] = await sources.setClaudeCollection(true);
    assert.match(result.error ?? '', /node/u);
    assert.equal(JSON.parse(readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).statusLine.command, 'hud');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// FR-USAGE-008 (#229): reading \\wsl.localhost of a stopped distribution starts it, and each start
// launches WSLg, whose window takes the focus from the app the user is typing in. Measured
// 2026-11-02: the server refresh and the browser poll did this twice a minute with no WSL tab open.
const wslHome = '\\\\wsl.localhost\\Ubuntu\\home\\dev';
const localRoots = { claudeHome: 'C:\\Users\\dev\\.claude', codexHome: 'C:\\Users\\dev\\.codex', opencodeData: 'x', hermesHome: 'y' };

async function locationsWith(running: string[], platform: NodeJS.Platform = 'win32') {
  const { createUsageLocations } = await import('./usageSources.js');
  const { wslAgentRoots } = await import('../agentSession/agentRoots.js');
  const calls: string[] = [];
  const locations = createUsageLocations({
    platform,
    local: localRoots,
    wsl: {
      runningDistros: async () => { calls.push('running'); return running; },
      homeRoots: async () => { calls.push('home'); return wslAgentRoots(wslHome, {}); },
    },
  });
  return { where: await locations(), calls };
}

test('FR-USAGE-008 AC-1: a stopped distribution is neither read nor asked for its home', async () => {
  const { where, calls } = await locationsWith([]);
  assert.deepEqual(calls, ['running'], 'only the list of running distributions, which starts none');
  assert.deepEqual(where.codex.map((ref) => ref.source), ['windows']);
  assert.deepEqual(where.claude.map((ref) => ref.source), ['windows']);
});

test('FR-USAGE-008 AC-2: a running distribution is read as before', async () => {
  const { where } = await locationsWith(['Ubuntu']);
  assert.deepEqual(where.codex, [{ codexHome: localRoots.codexHome, source: 'windows' }, { codexHome: `${wslHome}\\.codex`, source: 'wsl' }]);
  assert.deepEqual(where.claude, [{ configDir: localRoots.claudeHome, source: 'windows' }, { configDir: `${wslHome}\\.claude`, source: 'wsl' }]);
});

test('FR-USAGE-008 AC-1: another running distribution does not make the stopped home readable', async () => {
  const { where } = await locationsWith(['Debian']);
  assert.deepEqual(where.claude.map((ref) => ref.source), ['windows']);
});

test('FR-USAGE-008: off Windows there is no WSL to ask', async () => {
  const { where, calls } = await locationsWith(['Ubuntu'], 'linux');
  assert.deepEqual(calls, []);
  assert.deepEqual(where.claude.map((ref) => ref.source), ['local']);
});

test('FR-USAGE-008 AC-1: wsl.exe -l --running -q is read in UTF-16 or UTF-8', async () => {
  const { parseRunningDistros } = await import('./usageSources.js');
  assert.deepEqual(parseRunningDistros(Buffer.from('Ubuntu\r\nDebian\r\n', 'utf16le')), ['Ubuntu', 'Debian']);
  assert.deepEqual(parseRunningDistros(Buffer.from('\uFEFFUbuntu\r\n', 'utf16le')), ['Ubuntu']);
  assert.deepEqual(parseRunningDistros(Buffer.from('Ubuntu\n', 'utf8')), ['Ubuntu']);
  assert.deepEqual(parseRunningDistros(Buffer.alloc(0)), []);
});

test('FR-USAGE-008 AC-3: while WSL is skipped its last readings stay; once read, the new ones replace them', async () => {
  const { holdWslReadings } = await import('./usageSources.js');
  const reading = (source: 'windows' | 'wsl', observedAt: number) => ({ agent: 'claude' as const, accountKey: source, email: null, plan: null, source, observedAt, windows: {} });
  const held = [reading('wsl', 1)];
  assert.deepEqual(holdWslReadings(held, [reading('windows', 2)], false), [reading('windows', 2), reading('wsl', 1)]);
  assert.deepEqual(holdWslReadings(held, [reading('windows', 2), reading('wsl', 3)], true), [reading('windows', 2), reading('wsl', 3)]);
  assert.deepEqual(holdWslReadings(held, [reading('windows', 2)], true), [reading('windows', 2)], 'a read WSL with no records has none');
});
