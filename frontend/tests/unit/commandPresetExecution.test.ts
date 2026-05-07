import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTerminalInput } from '../../src/components/CommandPresetManager/commandPresetExecution.ts';

test('command presets append Enter', () => {
  assert.equal(buildTerminalInput('command', 'npm test', 'powershell'), 'npm test\r');
});

test('prompt presets paste text without Enter', () => {
  const prompt = 'line 1\nline 2';
  assert.equal(buildTerminalInput('prompt', prompt, 'bash'), prompt);
});

test('directory presets format PowerShell literal paths', () => {
  assert.equal(
    buildTerminalInput('directory', "C:\\Work\\O'Reilly", 'powershell'),
    "Set-Location -LiteralPath 'C:\\Work\\O''Reilly'\r",
  );
});

test('directory presets format cmd drive-aware cd commands', () => {
  assert.equal(
    buildTerminalInput('directory', 'D:\\Project Space', 'cmd'),
    'cd /d "D:\\Project Space"\r',
  );
});

test('directory presets format POSIX shell paths', () => {
  assert.equal(
    buildTerminalInput('directory', "/work/it's here", 'bash'),
    "cd -- '/work/it'\\''s here'\r",
  );
});

test('directory presets return empty input for blank paths', () => {
  assert.equal(buildTerminalInput('directory', '   ', 'auto'), '');
});
