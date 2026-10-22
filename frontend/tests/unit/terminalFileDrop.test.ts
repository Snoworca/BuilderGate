// FR-FEX-031: files dragged from the operating system onto a terminal session are
// uploaded into that session's current folder, on the desktop only. The overlay is
// the session's own yellow at 15% opacity with the upload prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  answerTerminalDropConflict,
  createTerminalDropDepth,
  decideTerminalFileDrag,
  isDesktopDropSurface,
  terminalDropDirLabel,
} from '../../src/components/Terminal/terminalFileDrop.ts';

test('FR-FEX-031 AC-1/AC-5: only a fine pointer at desktop width is a drop surface', () => {
  assert.equal(isDesktopDropSurface({ width: 1280, coarsePointer: false }), true);
  assert.equal(isDesktopDropSurface({ width: 767, coarsePointer: false }), false);
  assert.equal(isDesktopDropSurface({ width: 1280, coarsePointer: true }), false);
});

test('FR-FEX-031 AC-1/AC-5: operating-system files upload; explorer rows and plain text do not', () => {
  assert.equal(decideTerminalFileDrag({ types: ['Files'], desktop: true }), 'upload');
  assert.equal(decideTerminalFileDrag({ types: ['Files'], desktop: false }), 'ignore');
  assert.equal(decideTerminalFileDrag({ types: ['text/plain'], desktop: true }), 'ignore');
  assert.equal(decideTerminalFileDrag({ types: null, desktop: true }), 'ignore');
});

test('FR-FEX-031 AC-2: the overlay stays while the pointer crosses the session children and goes when it leaves', () => {
  const depth = createTerminalDropDepth();
  assert.equal(depth.enter(), true);
  assert.equal(depth.enter(), true);
  assert.equal(depth.leave(), true);
  assert.equal(depth.leave(), false);
  depth.enter();
  depth.reset();
  assert.equal(depth.active(), false);
  assert.equal(depth.leave(), false);
});

test('FR-FEX-031 AC-4: a clash keeps both and never overwrites', () => {
  assert.deepEqual(
    answerTerminalDropConflict({ kind: 'conflict', path: 'a.txt', choices: ['overwrite', 'rename', 'skip'] }),
    { kind: 'decide', choice: 'rename', applyToAll: true },
  );
  assert.deepEqual(
    answerTerminalDropConflict({ kind: 'conflict', path: 'a.txt', choices: ['overwrite', 'skip'] }),
    { kind: 'decide', choice: 'skip', applyToAll: true },
  );
});

test('FR-FEX-031 AC-3: the job is labelled with the session folder name', () => {
  assert.equal(terminalDropDirLabel('C:\\Work\\git\\project'), 'project');
  assert.equal(terminalDropDirLabel('/home/user/work/'), 'work');
  assert.equal(terminalDropDirLabel(''), '.');
});

test('FR-FEX-031 AC-1/AC-3: the session host shows the overlay and starts the upload into the session folder', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalRuntimeLayer.tsx', import.meta.url), 'utf8');
  assert.match(source, /onDragEnter=/);
  assert.match(source, /onDrop=/);
  assert.match(source, /decideTerminalFileDrag\(/);
  assert.match(source, /readDroppedSources\(/);
  assert.match(source, /startUpload\(\{/);
  assert.match(source, /dir: ''/);
  assert.match(source, /t\('terminal\.fileDrop\.overlay'\)/);
});

test('FR-FEX-031 AC-1: the overlay is yellow at 15% opacity and lets events through', () => {
  const css = readFileSync(new URL('../../src/components/Terminal/terminalFileDrop.css', import.meta.url), 'utf8');
  assert.match(css, /\.terminal-file-drop-overlay\s*\{[^}]*rgba\(255,\s*214,\s*0,\s*0\.15\)/);
  assert.match(css, /\.terminal-file-drop-overlay\s*\{[^}]*pointer-events:\s*none/);
});

test('FR-FEX-031 AC-1: the prompt exists in every catalog', () => {
  const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8'));
  const ko = JSON.parse(readFileSync(new URL('../../public/locales/messages.ko.json', import.meta.url), 'utf8'));
  assert.equal(typeof en['terminal.fileDrop.overlay'], 'string');
  assert.equal(ko['terminal.fileDrop.overlay'], '이곳으로 파일 업로드');
});
