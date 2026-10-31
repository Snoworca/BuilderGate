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
