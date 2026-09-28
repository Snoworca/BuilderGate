import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { AgentAliasService } from './AgentAliasService.js';
import { AppError } from '../utils/errors.js';

// FR-AITUI-011 — aliases such as claudep / codexp count as the agent itself.

async function fresh(): Promise<{ svc: AgentAliasService; file: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-alias-'));
  const file = path.join(dir, 'agent-aliases.json');
  const svc = new AgentAliasService({ dataPath: file });
  await svc.initialize();
  return { svc, file, dir };
}

test('FR-AITUI-011 AC-1 built-in names are always present and resolve', async () => {
  const { svc, dir } = await fresh();
  try {
    const all = svc.getAll();
    assert.deepEqual(all.claude.builtIn, ['claude', 'claude-code']);
    assert.deepEqual(all.codex.builtIn, ['codex']);
    assert.deepEqual(all.claude.aliases, []);
    assert.equal(svc.resolve('claude'), 'claude');
    assert.equal(svc.resolve('CODEX.exe'), 'codex');
    assert.equal(svc.resolve('claudep'), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('FR-AITUI-011 AC-2/AC-3 aliases persist and resolve to their agent, case- and extension-insensitively', async () => {
  const { svc, file, dir } = await fresh();
  try {
    await svc.update({ claude: ['claudep', 'claudex'], codex: ['codexp'] });
    assert.equal(svc.resolve('claudep'), 'claude');
    assert.equal(svc.resolve('ClaudeX.cmd'), 'claude');
    assert.equal(svc.resolve('codexp.ps1'), 'codex');
    const again = new AgentAliasService({ dataPath: file });
    await again.initialize();
    assert.deepEqual(again.getAll().claude.aliases, ['claudep', 'claudex']);
    assert.equal(again.resolve('codexp'), 'codex');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('FR-AITUI-011 AC-2 empty, spaced, path-like and already-used names are refused', async () => {
  const { svc, dir } = await fresh();
  try {
    for (const bad of [[''], ['a b'], ['bin/claudep'], ['c:\\x'], ['codex'], ['dup', 'dup']]) {
      await assert.rejects(() => svc.update({ claude: bad, codex: [] }), (e: unknown) => e instanceof AppError, JSON.stringify(bad));
    }
    await assert.rejects(() => svc.update({ claude: ['shared'], codex: ['shared'] }), (e: unknown) => e instanceof AppError);
    assert.deepEqual(svc.getAll().claude.aliases, [], 'a refused update changes nothing');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('FR-AITUI-011 a corrupt store starts empty instead of failing startup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-alias-'));
  try {
    const file = path.join(dir, 'agent-aliases.json');
    await fs.writeFile(file, '{not json');
    const svc = new AgentAliasService({ dataPath: file });
    await svc.initialize();
    assert.deepEqual(svc.getAll().codex.aliases, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
