import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { FileSearchService } from './FileSearchService.js';
import { AppError, ErrorCode } from '../utils/errors.js';

// FR-FEX-013 — asynchronous, cancellable name search under the current directory.

async function tree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-search-'));
  const files = ['a/config.json5', 'a/b/Config.ts', 'a/b/c/other.txt', 'node_modules/pkg/config.js', '.git/config', 'readme.md', 'vite.config.ts'];
  for (const f of files) {
    await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await fs.writeFile(path.join(root, f), 'x');
  }
  await fs.mkdir(path.join(root, 'configs'));
  return root;
}

function service(root: string, opts: { maxResults?: number } = {}) {
  return new FileSearchService({ resolveRoot: async (_s, p) => (p === '..' ? Promise.reject(new AppError(ErrorCode.PATH_TRAVERSAL)) : { sessionRoot: root, dir: p ? path.resolve(root, p) : root }) }, opts);
}

async function drain(svc: FileSearchService, id: string) {
  const results: string[] = [];
  let after = 0;
  for (let i = 0; i < 400; i += 1) {
    const page = svc.poll(id, after);
    results.push(...page.results.map((r) => `${r.type}:${r.relativePath}`));
    after = page.next;
    if (page.done) return { results, page };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('search never finished');
}

test('FR-FEX-013 AC-5/AC-7 names match case-insensitively, .git and node_modules are skipped, paths are session-relative', async () => {
  const root = await tree();
  try {
    const svc = service(root);
    const { id } = await svc.start('s', { path: '', query: 'CONFIG' });
    const { results, page } = await drain(svc, id);
    assert.deepEqual(results.sort(), ['directory:configs', 'file:a/b/Config.ts', 'file:a/config.json5', 'file:vite.config.ts']);
    assert.equal(page.outcome, 'completed');
    assert.ok(page.examined >= 7);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('FR-FEX-013 AC-5 includeIgnored searches .git and node_modules too', async () => {
  const root = await tree();
  try {
    const svc = service(root);
    const { id } = await svc.start('s', { path: '', query: 'config', includeIgnored: true });
    const { results } = await drain(svc, id);
    assert.ok(results.includes('file:node_modules/pkg/config.js'));
    assert.ok(results.includes('file:.git/config'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('FR-FEX-013 AC-2/AC-3 results arrive incrementally with progress, and a sub-directory search stays under it', async () => {
  const root = await tree();
  try {
    const svc = service(root);
    const { id } = await svc.start('s', { path: 'a', query: 'config' });
    const { results } = await drain(svc, id);
    assert.deepEqual(results.sort(), ['file:a/b/Config.ts', 'file:a/config.json5']);
    assert.equal(svc.poll(id, 0).results.length, 2, 'polling from 0 again returns everything');
    assert.equal(svc.poll(id, 2).results.length, 0, 'polling after the end returns nothing new');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('FR-FEX-013 AC-4 cancel stops the walk and no results arrive after it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-search-'));
  try {
    for (let i = 0; i < 300; i += 1) {
      await fs.mkdir(path.join(root, `d${i}`), { recursive: true });
      await fs.writeFile(path.join(root, `d${i}`, `hit${i}.txt`), 'x');
    }
    const svc = service(root);
    const { id } = await svc.start('s', { path: '', query: 'hit' });
    svc.cancel(id);
    const after = svc.poll(id, 0);
    assert.equal(after.done, true);
    assert.equal(after.outcome, 'cancelled');
    const count = after.results.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(svc.poll(id, 0).results.length, count, 'nothing is added after cancel');
    assert.ok(count < 300, 'the walk stopped before finishing');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('FR-FEX-013 AC-6 the search stops at the result cap and says so', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-search-'));
  try {
    for (let i = 0; i < 12; i += 1) await fs.writeFile(path.join(root, `hit${i}.txt`), 'x');
    const svc = service(root, { maxResults: 5 });
    const { id } = await svc.start('s', { path: '', query: 'hit' });
    const { results, page } = await drain(svc, id);
    assert.equal(results.length, 5);
    assert.equal(page.outcome, 'truncated');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('FR-FEX-013 AC-8 a start path outside the session root is refused; a new search replaces the running one', async () => {
  const root = await tree();
  try {
    const svc = service(root);
    await assert.rejects(() => svc.start('s', { path: '..', query: 'x' }), (e: unknown) => e instanceof AppError && e.code === ErrorCode.PATH_TRAVERSAL);
    const first = await svc.start('s', { path: '', query: 'config' });
    const second = await svc.start('s', { path: '', query: 'readme' });
    assert.equal(svc.poll(first.id, 0).outcome, 'cancelled');
    const { results } = await drain(svc, second.id);
    assert.deepEqual(results, ['file:readme.md']);
    assert.throws(() => svc.poll('nope', 0), (e: unknown) => e instanceof AppError);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
