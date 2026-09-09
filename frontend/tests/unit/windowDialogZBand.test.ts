import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createWindowDialogBehaviorModel } from '../../src/components/dialog/windowDialogModel.ts';

// Every expected number below is written out rather than recomputed from the
// formula under test. A table derived from that formula would agree with any
// implementation, including a wrong one.
const MODELESS_LAYERS: Array<{ layerIndex: number; layerZ: number; dialogZ: number }> = [
  { layerIndex: 0, layerZ: 3000, dialogZ: 3001 },
  { layerIndex: 1, layerZ: 3020, dialogZ: 3021 },
  { layerIndex: 2, layerZ: 3040, dialogZ: 3041 },
  { layerIndex: 10, layerZ: 3200, dialogZ: 3201 },
  { layerIndex: 48, layerZ: 3960, dialogZ: 3961 },
  { layerIndex: 49, layerZ: 3980, dialogZ: 3981 },
];

const MODELESS_LAYERS_AT_CAP: number[] = [50, 51, 200];
const MODELESS_LAYER_CAP = 3980;
const MODELESS_SURFACE_CAP = 3981;

test('CON-MDE-001 modeless layer is 3000 + n * 20 capped at 3980 and the surface is one greater', () => {
  MODELESS_LAYERS.forEach(({ layerIndex, layerZ, dialogZ }) => {
    const model = createWindowDialogBehaviorModel({ layerIndex, mode: 'modeless' });

    assert.equal(
      model.layerZ,
      layerZ,
      `modeless layer value at stack index ${layerIndex}`,
    );
    assert.equal(
      model.dialogZ,
      dialogZ,
      `modeless surface value at stack index ${layerIndex}`,
    );
    assert.equal(model.backdropZ, layerZ);
  });

  // The cap saturates rather than wrapping or continuing to climb.
  MODELESS_LAYERS_AT_CAP.forEach(layerIndex => {
    const model = createWindowDialogBehaviorModel({ layerIndex, mode: 'modeless' });

    assert.equal(model.layerZ, MODELESS_LAYER_CAP, `layer saturates at stack index ${layerIndex}`);
    assert.equal(
      model.dialogZ,
      MODELESS_SURFACE_CAP,
      `surface saturates at stack index ${layerIndex}`,
    );
  });

  // The layer cap and the surface cap are different numbers, and both operands
  // of that comparison come from the function rather than from this file: a
  // surface clamped to the layer cap would satisfy every equality above.
  const saturated = createWindowDialogBehaviorModel({ layerIndex: 60, mode: 'modeless' });
  assert.notEqual(saturated.dialogZ, saturated.layerZ);
  assert.equal(saturated.dialogZ - saturated.layerZ, 1);

  // Two windows at different stack indices below the cap must receive
  // different surface values. This is the assertion that a fixed layerIndex 0
  // for every window fails: without it the whole band could collapse onto one
  // value and every equality above would still be satisfiable window by window.
  const surfaces = MODELESS_LAYERS.map(
    ({ layerIndex }) => createWindowDialogBehaviorModel({ layerIndex, mode: 'modeless' }).dialogZ,
  );
  assert.equal(
    new Set(surfaces).size,
    surfaces.length,
    'every stack index below the cap must produce its own surface value',
  );
});

test('CON-MDE-001 omitting mode behaves as modal and the returned field set does not grow', () => {
  const implicit = createWindowDialogBehaviorModel({ layerIndex: 0 });
  const explicitModal = createWindowDialogBehaviorModel({ layerIndex: 0, mode: 'modal' });

  assert.deepEqual(implicit, explicitModal);
  assert.equal(implicit.layerZ, 5000);
  assert.equal(implicit.backdropZ, 5000);
  assert.equal(implicit.dialogZ, 5001);

  assert.equal(createWindowDialogBehaviorModel({ layerIndex: 2 }).layerZ, 5040);
  assert.equal(createWindowDialogBehaviorModel({ layerIndex: 2 }).dialogZ, 5041);

  // The modal band is not capped the way the modeless band is: a modal at a
  // stack index past the modeless cap keeps climbing.
  assert.equal(createWindowDialogBehaviorModel({ layerIndex: 60 }).layerZ, 6200);

  // The set of returned fields is the contract windowDialogContract.test.ts
  // pins with deepEqual. Taking a mode input must not add one.
  const expectedFields = [
    'backdropZ',
    'dialogZ',
    'layerZ',
    'persistGeometry',
    'resizable',
    'role',
    'showCloseButton',
  ];
  assert.deepEqual(Object.keys(implicit).sort(), expectedFields);
  assert.deepEqual(
    Object.keys(createWindowDialogBehaviorModel({ layerIndex: 0, mode: 'modeless' })).sort(),
    expectedFields,
  );
});

test('CON-MDE-001 editor window z-index is below every modal surface', () => {
  // The saturated window is the highest an editor window can ever reach, so it
  // is the only index that can disprove the ordering.
  const highest = createWindowDialogBehaviorModel({ layerIndex: 200, mode: 'modeless' });
  const highestApplied = Math.max(highest.layerZ, highest.backdropZ, highest.dialogZ);

  const modalSurfaces: Array<{ name: string; z: number }> = [
    { name: 'WindowDialog modal layer', z: 5000 },
    { name: '.command-preset-toast', z: 5100 },
    { name: '.modal-overlay', z: 9999 },
    { name: 'context menu', z: 10000 },
    { name: 'context menu submenu', z: 10001 },
  ];

  modalSurfaces.forEach(({ name, z }) => {
    assert.ok(
      highestApplied < z,
      `saturated editor window (${highestApplied}) must render below ${name} (${z})`,
    );
  });

  // A modal at stack index 0 is the lowest modal there can be, and the
  // saturated editor window must still sit under it.
  assert.ok(highestApplied < createWindowDialogBehaviorModel({ layerIndex: 0 }).layerZ);
});

test('CON-MDE-001 editor window z-index is above the terminal, tile, settings and mobile bands', () => {
  // The first window in the stack is the lowest an editor window can be.
  const lowest = createWindowDialogBehaviorModel({ layerIndex: 0, mode: 'modeless' });
  const lowestApplied = Math.min(lowest.layerZ, lowest.backdropZ, lowest.dialogZ);

  const underlyingSurfaces: Array<{ name: string; z: number }> = [
    { name: 'terminal layer', z: 2 },
    { name: 'tile parts', z: 12 },
    { name: 'settings page and font-size toast', z: 100 },
    { name: 'mobile surfaces', z: 1000 },
  ];

  underlyingSurfaces.forEach(({ name, z }) => {
    assert.ok(
      lowestApplied > z,
      `first editor window (${lowestApplied}) must render above ${name} (${z})`,
    );
  });
});

test('CON-MDE-001 WindowDialog hands its mode to the behavior model', () => {
  // The band branch is only reachable if the call site passes mode through.
  // Because mode is optional, dropping that argument still type-checks and
  // still satisfies every value assertion above -- each of which supplies mode
  // itself -- while putting every editor window back in the modal band. No
  // assertion over the model alone can observe that, and this suite has no DOM
  // to render the component in, so the call site is pinned as source text.
  const source = readFileSync(
    new URL('../../src/components/dialog/WindowDialog.tsx', import.meta.url),
    'utf8',
  ).replace(/\r\n/g, '\n');

  const callStart = source.indexOf('createWindowDialogBehaviorModel(');
  assert.notEqual(callStart, -1, 'WindowDialog no longer calls createWindowDialogBehaviorModel');

  const callEnd = source.indexOf('});', callStart);
  assert.notEqual(callEnd, -1, 'could not find the end of the createWindowDialogBehaviorModel call');

  const callArguments = source.slice(callStart, callEnd);
  assert.match(
    callArguments,
    /(^|[\s,{])mode\s*[,:]/,
    'WindowDialog does not pass mode into createWindowDialogBehaviorModel, so every window would fall back to the modal band',
  );
  assert.match(callArguments, /(^|[\s,{])layerIndex\s*:/);
});
