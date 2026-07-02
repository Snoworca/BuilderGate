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

test('T-PH004-01 SEC-AITUI-002 AC-2 emoji or plain text icons render as text data', () => {
  const typeSource = readSource('src/types/recoveryOption.ts');
  const metadataRowSource = readSource('src/components/MetadataBar/MetadataRow.tsx');
  const tabBarSource = readSource('src/components/Workspace/WorkspaceTabBar.tsx');

  expectSource(typeSource, /type\s*:\s*['"]text['"]/, 'RecoveryOptionIcon must include a safe text icon representation');
  expectSource(typeSource, /value\s*:\s*string/, 'Text recovery icons must store a string value');
  expectAnySource(metadataRowSource, [/recoveryIcon[^;\n]*\.value/, /\.value[^;\n]*recoveryIcon/], 'MetadataRow must render text icons as text data');
  expectAnySource(tabBarSource, [/recoveryIcon[^;\n]*\.value/, /\.value[^;\n]*recoveryIcon/], 'WorkspaceTabBar must render text icons as text data');
});

test('T-PH004-01 SEC-AITUI-002 AC-3 markup rejection errors are displayed without replacing the prior icon', () => {
  const dialogSource = readSource('src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx');

  expectSource(dialogSource, /role=["']alert["']/, 'Recovery icon validation errors must use the normal alert path');
  expectAnySource(
    dialogSource,
    [/icon[^;\n]*(error|Error)/, /(error|Error)[^;\n]*icon/, /아이콘/],
    'Dialog must display icon validation failures',
  );
  expectAnySource(
    dialogSource,
    [/catch\s*\([^)]*\)[\s\S]{0,240}(set[A-Za-z]*Error|showToast)/, /throw\s+await\s+parseError/],
    'Dialog must keep the prior option visible when markup icon saves are rejected',
  );
});

test('T-PH004-01 SEC-AITUI-002 AC-4 script style and URL rejection use the normal API error path', () => {
  const apiSource = readSource('src/services/api.ts');
  const dialogSource = readSource('src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx');

  expectSource(apiSource, /recoveryOptionApi/, 'Recovery option API client must exist');
  expectSource(apiSource, /throw\s+await\s+parseError\(res\)/, 'Recovery option API client must surface server validation errors');
  expectAnySource(
    dialogSource,
    [/script|onerror|onclick|style|https?:\/\//i, /validation|검증|거부|아이콘/],
    'Dialog must have a visible rejection display path for unsafe icon payloads',
  );
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
