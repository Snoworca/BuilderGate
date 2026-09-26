import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeRuntimeProvenance,
  type RuntimeProvenanceInput,
} from './runtimeProvenance.js';

/**
 * FR-BGSTAB-030 AC-1, AC-2.
 *
 * Measured 2026-09-20: this checkout's `dist/index.js` was started from cmd.exe
 * and inherited fifteen BUILDERGATE_* variables that the Windows environment
 * had set, every one of them pointing at the INSTALLED deployment. The server
 * started, `/health` answered 200, and the assets it served and the config it
 * read were the installed deployment's. WSL has none of those variables, so a
 * procedure written against WSL did not transfer.
 *
 * The anchor that makes this decidable is already present and cannot be
 * overridden: the running module's own directory. Whatever else an environment
 * says, `dist/index.js` sits in exactly one checkout. So "is a resolved path
 * outside the code that is running" is a mechanical question, and this is the
 * function that answers it.
 */

const ANCHOR = '/home/u/checkout-a/server/dist';

function input(overrides: Partial<RuntimeProvenanceInput> = {}): RuntimeProvenanceInput {
  return {
    moduleDir: ANCHOR,
    serverRoot: '/home/u/checkout-a/server',
    configPath: '/home/u/checkout-a/server/config.json5',
    webRoot: '/home/u/checkout-a/server/dist/public',
    ...overrides,
  };
}

test('FR-BGSTAB-030 AC-1 a runtime whose paths all sit under its own code reports no foreign root', () => {
  const provenance = describeRuntimeProvenance(input());

  assert.deepEqual(provenance.foreign, []);
  assert.equal(provenance.hasForeignRoot, false);
});

test('FR-BGSTAB-030 AC-1 a web root in another tree is named, with what it resolved to', () => {
  const provenance = describeRuntimeProvenance(input({
    webRoot: '/opt/installed/builder-gate/web',
  }));

  assert.equal(provenance.hasForeignRoot, true);
  assert.deepEqual(
    provenance.foreign.map(entry => entry.name),
    ['webRoot'],
  );
  // The warning has to carry the path, or it says "something is wrong" without
  // saying what to look at. This is a local log, not an HTTP response.
  assert.equal(provenance.foreign[0].resolved, '/opt/installed/builder-gate/web');
});

test('FR-BGSTAB-030 AC-1 every foreign path is reported, not just the first', () => {
  const provenance = describeRuntimeProvenance(input({
    configPath: '/opt/installed/builder-gate/config.json5',
    serverRoot: '/opt/installed/builder-gate/server',
    webRoot: '/opt/installed/builder-gate/web',
  }));

  assert.deepEqual(
    provenance.foreign.map(entry => entry.name).sort(),
    ['configPath', 'serverRoot', 'webRoot'],
  );
});

test('FR-BGSTAB-030 AC-1 a sibling checkout with a shared prefix is foreign, not local', () => {
  // The bug this rules out is a prefix compare: '/home/u/checkout-a2' starts
  // with '/home/u/checkout-a' as a string and is a different tree.
  const provenance = describeRuntimeProvenance(input({
    webRoot: '/home/u/checkout-a2/server/dist/public',
  }));

  assert.equal(provenance.hasForeignRoot, true);
  assert.deepEqual(provenance.foreign.map(entry => entry.name), ['webRoot']);
});

test('FR-BGSTAB-030 AC-1 the anchor is the checkout, not the dist directory', () => {
  // config.json5 lives beside `server/`, one level above `dist/`. Anchoring on
  // the module directory itself would call the ordinary layout foreign, and a
  // warning that fires on every correct start is a warning nobody reads.
  const provenance = describeRuntimeProvenance(input());
  assert.equal(provenance.hasForeignRoot, false);
  assert.ok(
    provenance.anchor.length > 0 && ANCHOR.startsWith(provenance.anchor),
    `the anchor must contain the module dir; anchor=${provenance.anchor}`,
  );
});

test('FR-BGSTAB-030 AC-2 the health view carries the verdict and the build id, never a path', () => {
  const provenance = describeRuntimeProvenance(input({
    webRoot: '/opt/installed/builder-gate/web',
  }));
  const view = provenance.toHealthView('abc123def456');

  assert.equal(view.rootsForeign, true);
  assert.equal(view.buildId, 'abc123def456');

  // /health is unauthenticated. The verdict is what a scripted preflight needs;
  // absolute filesystem paths are not, and handing them to an anonymous caller
  // is a disclosure with no corresponding gain.
  const serialized = JSON.stringify(view);
  assert.ok(
    !serialized.includes('/opt/installed'),
    `the health view leaked a path: ${serialized}`,
  );
  assert.ok(
    !serialized.includes('/home/u/checkout-a'),
    `the health view leaked a path: ${serialized}`,
  );
});

test('FR-BGSTAB-030 AC-2 a missing build id is null rather than an invented value', () => {
  const view = describeRuntimeProvenance(input()).toHealthView(null);

  assert.equal(view.rootsForeign, false);
  assert.equal(view.buildId, null);
});

/**
 * OPS-BGSTAB-017 AC-5.
 *
 * Measured 2026-09-21: the packaged single executable printed the foreign-root
 * warning on a correct start, and `/health` answered `rootsForeign: true`. Under
 * pkg the running module is loaded from `/snapshot/<project>`, a path that does
 * not exist on disk, while config and web resolve beside the executable — so all
 * three roots looked foreign.
 *
 * FR-BGSTAB-030 argues that a warning firing on every correct start is a warning
 * nobody reads. The fix is not to suppress the check when packaged: an inherited
 * BUILDERGATE_CONFIG_PATH pointing at the installed deployment is exactly as
 * wrong inside an executable as outside one. It is to anchor on the thing that
 * plays the same role there — the directory the executable sits in, which is
 * already what `tools/daemon/runtime-paths.js` resolves the packaged root to.
 */

const EXE_DIR = '/opt/BuilderGate-0.5.4';

function packagedInput(overrides: Partial<RuntimeProvenanceInput> = {}): RuntimeProvenanceInput {
  return {
    // pkg loads the bundle from a virtual filesystem; this path has no on-disk
    // existence and no relationship to where the executable was placed.
    moduleDir: '/snapshot/ProjectMaster/server/dist-pkg',
    packagedExecutableDir: EXE_DIR,
    serverRoot: EXE_DIR,
    configPath: `${EXE_DIR}/config.json5`,
    webRoot: `${EXE_DIR}/web`,
    ...overrides,
  };
}

test('OPS-BGSTAB-017 AC-5 a packaged runtime serving files beside its executable reports no foreign root', () => {
  const provenance = describeRuntimeProvenance(packagedInput());

  assert.deepEqual(provenance.foreign, []);
  assert.equal(provenance.hasForeignRoot, false);
  assert.equal(provenance.toHealthView(null).rootsForeign, false);
});

test('OPS-BGSTAB-017 AC-5 the packaged anchor is the executable directory, not the snapshot path', () => {
  const provenance = describeRuntimeProvenance(packagedInput());

  assert.equal(provenance.anchor, EXE_DIR);
});

test('OPS-BGSTAB-017 AC-5 a packaged runtime pointed at another deployment is still caught', () => {
  // The cheapest way to make the two tests above pass is to stop checking when
  // packaged. This is the case that refuses that: the inherited variable this
  // whole requirement exists to catch is still inherited inside an executable.
  const provenance = describeRuntimeProvenance(packagedInput({
    configPath: '/opt/installed/builder-gate/config.json5',
    webRoot: '/opt/installed/builder-gate/web',
  }));

  assert.equal(provenance.hasForeignRoot, true);
  assert.deepEqual(provenance.foreign.map(entry => entry.name), ['configPath', 'webRoot']);
  assert.equal(provenance.toHealthView('abc').rootsForeign, true);
});

test('OPS-BGSTAB-017 AC-5 an unpackaged runtime still anchors on its checkout', () => {
  // Boundary: adding the packaged branch must not move the anchor for the
  // ordinary case, which is the one FR-BGSTAB-030 was measured against.
  const provenance = describeRuntimeProvenance(input());

  assert.equal(provenance.anchor, '/home/u/checkout-a');
  assert.equal(provenance.hasForeignRoot, false);
});
