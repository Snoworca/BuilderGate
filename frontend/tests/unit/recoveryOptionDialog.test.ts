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
    `${relativePath} is missing: recovery option UI/API hook is not implemented`,
  );
  return readFileSync(absolutePath, 'utf8');
}

function expectSource(source: string, pattern: RegExp, message: string): void {
  assert.match(source, pattern, `${message}: recovery option UI/API hook is not implemented`);
}

function expectAnySource(source: string, patterns: RegExp[], message: string): void {
  assert.ok(
    patterns.some(pattern => pattern.test(source)),
    `${message}: recovery option UI/API hook is not implemented`,
  );
}

test('T-PH004-01 FR-AITUI-001 AC-1 desktop Tools menu opens 복구 옵션 dialog', () => {
  const headerSource = readSource('src/components/Header/Header.tsx');
  const appSource = readSource('src/App.tsx');
  const dialogSource = readSource('src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx');

  expectSource(headerSource, /onOpenRecoveryOptionManager/, 'Header must expose a recovery option manager opener');
  expectSource(headerSource, /복구 옵션/, 'Desktop Tools menu must include 복구 옵션');
  expectSource(appSource, /RecoveryOptionDialog/, 'App must render the recovery option manager dialog');
  expectSource(appSource, /showRecoveryOptionDialog|recoveryOptionDialogOpen/, 'App must own dialog open state');
  expectSource(dialogSource, /data-testid=["']recovery-option-dialog["']/, 'Dialog must expose a stable test id');
  expectSource(dialogSource, /title=["']복구 옵션["']|복구 옵션/, 'Dialog title must be 복구 옵션');
});

test('T-PH004-01 FR-AITUI-001 AC-2 추가 creates a blank command draft', () => {
  const dialogSource = readSource('src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx');

  expectSource(dialogSource, /추가/, 'Dialog must expose an add action');
  expectAnySource(
    dialogSource,
    [
      /command\s*:\s*['"`]\s*['"`]/,
      /setCommand\(\s*['"`]\s*['"`]\s*\)/,
      /value=\{[^}]*draft[^}]*\.command[^}]*\}/,
    ],
    'Add action must create a draft with no pre-filled command',
  );
  assert.doesNotMatch(
    dialogSource,
    /command\s*:\s*['"`](claude|codex)['"`]/i,
    'Blank drafts must not be pre-filled with a built-in command',
  );
});

test('T-PH004-01 FR-AITUI-001 AC-3 empty command is blocked in UI and API client surfaces rejection', () => {
  const dialogSource = readSource('src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx');
  const apiSource = readSource('src/services/api.ts');

  expectSource(dialogSource, /role=["']alert["']/, 'Dialog must display validation errors through an alert path');
  expectAnySource(
    dialogSource,
    [
      /command[^;\n]+trim\(\)[^;\n]*\)/,
      /!\s*[^;\n]*command[^;\n]*trim\(\)/,
      /명령|command/i,
    ],
    'Dialog must validate required command before save',
  );
  expectSource(apiSource, /recoveryOptionApi/, 'Frontend API service must expose recoveryOptionApi');
  expectSource(apiSource, /\/recovery-options/, 'Frontend API service must call the protected recovery option API');
  expectSource(apiSource, /parseError/, 'API client must surface server validation failures');
});

test('T-PH004-01 FR-AITUI-001 AC-4 saving without arguments persists an empty arguments array', () => {
  const dialogSource = readSource('src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx');
  const typeSource = readSource('src/types/recoveryOption.ts');

  expectSource(typeSource, /arguments\s*:\s*string\[\]/, 'RecoveryOption must model arguments as an array');
  expectAnySource(
    dialogSource,
    [
      /arguments\s*:\s*\[\]/,
      /args\s*:\s*\[\]/,
      /split\([^)]*\)[\s\S]{0,120}filter/,
    ],
    'Dialog must normalize empty arguments to an empty array when saving',
  );
});

test('T-PH005-01 review fix preserves arguments containing spaces through edit/save', () => {
  const dialogSource = readSource('src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx');

  expectSource(
    dialogSource,
    /(option\.arguments\.join\(\s*['"`]\\n['"`]\s*\)|formatDraftArguments\(option\.arguments\))/,
    'Dialog edit drafts must render one ordered argument per line',
  );
  expectSource(
    dialogSource,
    /split\(\s*\/\\r\?\\n\/\s*\)/,
    'Dialog must parse argument drafts by line, not by whitespace',
  );
  assert.doesNotMatch(
    dialogSource,
    /split\(\s*\/\\s\+\/\s*\)/,
    'Whitespace splitting changes a single argument such as "workspace path" into two arguments',
  );
  assert.doesNotMatch(
    dialogSource,
    /option\.arguments\.join\(\s*['"`] ['"`]\s*\)/,
    'Space-joined edit drafts cannot distinguish separators from spaces inside an argument',
  );
});

test('T-PH005-01 review fix keeps recovery-options E2E repeatable with valid default icons', () => {
  const helperSource = readSource('tests/e2e/helpers.ts');
  const specSource = readSource('tests/e2e/recovery-options.spec.ts');

  expectSource(
    helperSource,
    /ensureDefaultRecoveryOptionsForE2E/,
    'Recovery option E2E helpers must restore missing Claude/Codex defaults for repeatability',
  );
  expectSource(
    specSource,
    /ensureDefaultRecoveryOptionsForE2E/,
    'Recovery option E2E suite must restore defaults before and after deleting default rows',
  );
  expectSource(helperSource, /key\s*:\s*['"]bot['"]/, 'Claude E2E fallback must use an allowlisted built-in icon key');
  expectSource(helperSource, /key\s*:\s*['"]terminal['"]/, 'Codex E2E fallback must use an allowlisted built-in icon key');
  assert.doesNotMatch(
    `${helperSource}\n${specSource}`,
    /key\s*:\s*['"]claude['"]/,
    'The server allowlist does not accept a built-in icon key named claude',
  );
});

test('T-PH004-01 FR-AITUI-001 AC-5 matched icon data reaches tab metadata display paths', () => {
  const workspaceTypeSource = readSource('src/types/workspace.ts');
  const metadataRowSource = readSource('src/components/MetadataBar/MetadataRow.tsx');
  const tabBarSource = readSource('src/components/Workspace/WorkspaceTabBar.tsx');

  expectSource(workspaceTypeSource, /recoveryIcon/, 'Workspace tab types must carry recoveryIcon metadata');
  expectSource(workspaceTypeSource, /recoveryCommand/, 'Workspace tab types must carry recovery command metadata');
  expectSource(metadataRowSource, /recoveryIcon/, 'MetadataRow must render recovery icon metadata next to terminal names');
  expectSource(tabBarSource, /recoveryIcon/, 'WorkspaceTabBar must render recovery icon metadata next to tab names');
});

test('T-PH004-01 FR-AITUI-001 AC-6 built-in Claude and Codex defaults delete like normal rows', () => {
  const dialogSource = readSource('src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx');

  expectSource(dialogSource, /삭제/, 'Dialog must expose delete actions for recovery options');
  expectSource(dialogSource, /deleteOption|removeOption|recoveryOptionApi\.delete/, 'Dialog must call the normal delete path');
  assert.doesNotMatch(
    dialogSource,
    /isDefault[^;\n]*(disabled|readOnly|undeletable)|undeletable|protectedDefault/i,
    'Built-in defaults must not be treated as undeletable by the dialog',
  );
});
