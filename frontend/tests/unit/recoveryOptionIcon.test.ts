import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(testDir, '../..');

function readSource(relativePath: string): string {
  const absolutePath = resolve(frontendRoot, relativePath);
  assert.ok(
    existsSync(absolutePath),
    `${relativePath} is missing: recovery option icon rendering is not implemented`,
  );
  return readFileSync(absolutePath, 'utf8');
}

function expectSource(source: string, pattern: RegExp, message: string): void {
  assert.match(source, pattern, `${message}: recovery option icon rendering is not implemented`);
}

function expectAnySource(source: string, patterns: RegExp[], message: string): void {
  assert.ok(
    patterns.some(pattern => pattern.test(source)),
    `${message}: recovery option icon rendering is not implemented`,
  );
}

function expectNoRawMarkupInterpretation(source: string, context: string): void {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `${context} must not use dangerouslySetInnerHTML`);
  assert.doesNotMatch(source, /\.innerHTML\s*=/, `${context} must not assign innerHTML`);
  assert.doesNotMatch(source, /<img[^>]+src=\{[^}]*recoveryIcon/i, `${context} must not render recoveryIcon as an image URL`);
  assert.doesNotMatch(source, /href=\{[^}]*recoveryIcon/i, `${context} must not render recoveryIcon as a link URL`);
}

test('T-PH004-01 SEC-AITUI-002 AC-1 built-in recovery icon keys render through an allowlisted representation', () => {
  const typeSource = readSource('src/types/recoveryOption.ts');
  const metadataRowSource = readSource('src/components/MetadataBar/MetadataRow.tsx');
  const tabBarSource = readSource('src/components/Workspace/WorkspaceTabBar.tsx');

  expectSource(typeSource, /type\s*:\s*['"]builtin['"]/, 'RecoveryOptionIcon must include built-in icon keys');
  expectSource(typeSource, /key\s*:\s*string/, 'Built-in recovery icons must store a key, not markup');
  expectSource(metadataRowSource, /builtin/, 'MetadataRow must handle built-in recovery icon keys');
  expectSource(tabBarSource, /builtin/, 'WorkspaceTabBar must handle built-in recovery icon keys');
});

test('T-PH004-01 SEC-AITUI-002 AC-5 unsupported persisted icons are omitted without raw markup rendering', () => {
  const metadataRowSource = readSource('src/components/MetadataBar/MetadataRow.tsx');
  const tabBarSource = readSource('src/components/Workspace/WorkspaceTabBar.tsx');

  expectSource(metadataRowSource, /recoveryIcon/, 'MetadataRow must inspect recovery icon metadata');
  expectSource(tabBarSource, /recoveryIcon/, 'WorkspaceTabBar must inspect recovery icon metadata');
  expectAnySource(metadataRowSource, [/null/, /undefined/, /unsupported|invalid|quarantine|omit/i], 'MetadataRow must omit unsupported icons');
  expectAnySource(tabBarSource, [/null/, /undefined/, /unsupported|invalid|quarantine|omit/i], 'WorkspaceTabBar must omit unsupported icons');
  expectNoRawMarkupInterpretation(metadataRowSource, 'MetadataRow');
  expectNoRawMarkupInterpretation(tabBarSource, 'WorkspaceTabBar');
});
