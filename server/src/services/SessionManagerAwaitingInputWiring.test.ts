/**
 * FR-AITUI-024 AC-2 / AC-3: SessionManager feeds the awaiting-input tracker from
 * every PTY output chunk and every client input, reads only the bottom of the
 * headless screen once its write chain has settled, and drops a closed session.
 * Reads the source (src/ only, like the other source-contract tests here): the
 * class needs a live PTY to construct.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./SessionManager.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

function body(startPattern: RegExp, length = 4000): string {
  const match = startPattern.exec(source);
  assert.ok(match, `found ${startPattern}`);
  return source.slice(match.index, match.index + length);
}

test('FR-AITUI-024 AC-2: every PTY output chunk is noted, before any classification can return early', () => {
  const onData = body(/ptyProcess\.onData\(\(rawData: string\) => \{/, 900);
  assert.match(onData, /this\.awaitingInputTracker\.noteOutput\(id\)/);
  assert.ok(
    onData.indexOf('noteOutput(id)') < onData.indexOf('oscDetector.process'),
    'noted right after the stale-session check',
  );
});

test('FR-AITUI-024 AC-3: client input reaches the tracker once it was written to the PTY', () => {
  const write = body(/writeInputDetailed\(\s*id: string,/, 9000);
  const ptyWrite = write.indexOf('data.pty.write(inputToWrite)');
  const noted = write.indexOf('this.awaitingInputTracker.noteInput(id, input)');
  assert.ok(ptyWrite > 0 && noted > ptyWrite, 'noted after the write succeeded');
});

test('FR-AITUI-024 AC-2: the screen is read from the bottom rows after the headless writes settle', () => {
  const method = body(/private async readAwaitingInputScreen\(/, 900);
  const read = method.slice(0, method.indexOf('\n  }\n'));
  assert.match(read, /await data\.headlessWriteChain/);
  assert.match(read, /readHeadlessBottomRows\(data\.headless, CHOICE_PROMPT_SCAN_ROWS\)/);
  assert.doesNotMatch(read, /readHeadlessTerminalText/, 'not the whole scrollback');
});

test('FR-AITUI-024 AC-2: a session that goes away is dropped from the tracker', () => {
  assert.match(source, /this\.awaitingInputTracker\.forget\(/);
});

test('FR-AITUI-024 AC-4: the mark is published through onAwaitingInputChange', () => {
  assert.match(source, /onAwaitingInputChange\(cb: \(sessionId: string, awaiting: boolean\) => void\): void/);
  assert.match(source, /new AgentAwaitingInputTracker\(\{[\s\S]{0,600}onChange: \(sessionId, awaiting\) =>[\s\S]{0,200}this\.awaitingInputChangeCallback\?\.\(sessionId, awaiting\)/);
});
