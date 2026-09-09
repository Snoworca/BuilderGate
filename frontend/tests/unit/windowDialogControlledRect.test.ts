import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  clampDialogRect,
  getDialogGeometryKey,
  readDialogGeometry,
  writeDialogGeometry,
} from '../../src/components/dialog/dialogGeometry.ts';
import { createWindowDialogBehaviorModel } from '../../src/components/dialog/windowDialogModel.ts';

const DIALOG_ID = 'editor-window-c-work-notes-readme-md';
const GEOMETRY_KEY = 'buildergate.dialog.editor-window-c-work-notes-readme-md.geometry';
const MIN_SIZE = { width: 320, height: 240 };
const VIEWPORT = { width: 1280, height: 800 };

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

function installStorage(storage: MemoryStorage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

// The component cannot be mounted here: this suite has no DOM, and
// WindowDialog.tsx pulls in react-rnd and a stylesheet at module load. The
// storage half is therefore exercised through the real geometry module, and
// the wiring that only a render would show is pinned as source text -- the
// same split windowDialogZBand.test.ts already uses for the band branch.
function readWindowDialogSource(): string {
  return readFileSync(
    new URL('../../src/components/dialog/WindowDialog.tsx', import.meta.url),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `the source no longer contains ${startMarker}`);

  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `could not find ${endMarker} after ${startMarker}`);

  return source.slice(start, end);
}

test('FR-MDE-001 persistGeometry=false writes no geometry and a controlled rect skips clamping', () => {
  const storage = new MemoryStorage();
  installStorage(storage);

  // The key this criterion names, written out rather than read back from the
  // function that builds it.
  assert.equal(getDialogGeometryKey(DIALOG_ID), GEOMETRY_KEY);

  // The stub really is the storage the geometry module writes through. Without
  // this the absence assertions below would hold against a storage nobody
  // touches, and would pass no matter what the close path did.
  writeDialogGeometry(DIALOG_ID, { x: 10, y: 20, width: 640, height: 480 });
  assert.notEqual(storage.getItem(GEOMETRY_KEY), null);
  storage.clear();
  assert.equal(storage.getItem(GEOMETRY_KEY), null);

  // persistGeometry defaults to true, so an editor window that does not pass
  // it explicitly gets the second source of truth this criterion forbids.
  assert.equal(
    createWindowDialogBehaviorModel({ layerIndex: 0, mode: 'modeless' }).persistGeometry,
    true,
  );
  assert.equal(
    createWindowDialogBehaviorModel({
      layerIndex: 0,
      mode: 'modeless',
      persistGeometry: false,
    }).persistGeometry,
    false,
  );

  const source = readWindowDialogSource();

  // The close path writes only under the flag, so persistGeometry={false}
  // leaves the key untouched. This is the write half of the criterion.
  const closeBody = sliceBetween(source, 'const handleClose = useCallback(', '}, [');
  assert.match(closeBody, /if\s*\(\s*behavior\.persistGeometry\s*\)/);
  const guardIndex = closeBody.indexOf('behavior.persistGeometry');
  const writeIndex = closeBody.indexOf('writeDialogGeometry(');
  assert.notEqual(writeIndex, -1, 'handleClose no longer calls writeDialogGeometry');
  assert.ok(guardIndex < writeIndex, 'the geometry write must sit behind the persistGeometry guard');

  // The read path is deliberately not blocked: readDialogGeometry still hands
  // back a stored rect on every mount regardless of persistGeometry, which is
  // why the owner has to supply a controlled rect from the first render. This
  // criterion covers the write half only.
  storage.setItem(
    GEOMETRY_KEY,
    JSON.stringify({ schemaVersion: 1, x: 40, y: 50, width: 700, height: 500 }),
  );
  assert.deepEqual(
    readDialogGeometry(DIALOG_ID, { x: 0, y: 0, width: 640, height: 480 }, VIEWPORT, MIN_SIZE),
    { x: 40, y: 50, width: 700, height: 500 },
  );
  storage.clear();

  // Skipping the clamp is only observable where the clamp would have moved the
  // rect, so establish that first with the real function.
  const stageRelativeRect = { x: -120, y: -80, width: 900, height: 700 };
  assert.notDeepEqual(
    clampDialogRect(stageRelativeRect, VIEWPORT, MIN_SIZE),
    stageRelativeRect,
  );

  // The five optional props. Every one of them must be destructured, or the
  // component cannot see it at all.
  const props = sliceBetween(source, 'export function WindowDialog({', '}: ');
  ['rect', 'onRectChange', 'boundsElement', 'titlebarActions', 'dirty'].forEach(prop => {
    assert.match(
      props,
      new RegExp(`(^|[\\s,{])${prop}\\s*[,:}]`),
      `WindowDialog does not accept the ${prop} prop`,
    );
  });

  // A controlled rect is handed to Rnd untouched while an uncontrolled one is
  // still clamped, and that decision is made in one place rather than at each
  // interaction handler.
  assert.match(source, /const\s+isControlled\s*=/);
  assert.match(source, /isControlled\s*\?\s*[A-Za-z_$][\w$]*\s*:\s*clampDialogRect\(/);

  // Rnd's bounds is no longer the bare literal that this requirement replaces.
  assert.match(source, /bounds=\{[^}]*boundsElement/);
  assert.doesNotMatch(source, /bounds="window"/);

  // boundsElement needs something to name. The stage container carried inline
  // styles only, so without an identifier on it bounds falls back to "window"
  // -- the very boundary the prop exists to replace -- and nothing above would
  // notice, because every assertion so far is satisfied by a prop pointing at
  // a selector that matches no element.
  const appSource = readFileSync(
    new URL('../../src/App.tsx', import.meta.url),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const stage = sliceBetween(appSource, 'function TerminalWorkspaceStage(', '<TerminalRuntimeLayer');
  assert.match(
    stage,
    /className="terminal-workspace-stage"/,
    'the stage container has no identifier for Rnd bounds to point at',
  );

  // The injected controls sit to the left of the close button the component
  // renders itself.
  const titlebar = sliceBetween(source, '<div className="window-dialog-titlebar">', '</div>');
  const actionsIndex = titlebar.indexOf('titlebarActions');
  const closeIndex = titlebar.indexOf('window-dialog-close');
  assert.notEqual(actionsIndex, -1, 'the titlebar does not render titlebarActions');
  assert.notEqual(closeIndex, -1, 'the titlebar no longer renders the close button');
  assert.ok(actionsIndex < closeIndex, 'titlebarActions must precede the close button');
});
