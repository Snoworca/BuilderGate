const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensurePatch,
  patches,
} = require('../../server/tools/ensure-node-pty-windows-hide.cjs');

function makePatchFixture(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-node-pty-hide-'));
  const file = path.join(root, 'node-pty', 'lib', 'windowsPtyAgent.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return { root, file };
}

test('node-pty ConPTY helper fork is patched with windowsHide', () => {
  const basePatch = patches[0];
  const fixture = makePatchFixture(`function test() { return ${basePatch.before}; }\n`);
  const testPatch = {
    ...basePatch,
    file: fixture.file,
  };
  const logs = [];

  const changed = ensurePatch({
    patches: [testPatch],
    log: (message) => logs.push(message),
  });

  assert.equal(changed, true);
  assert.match(fs.readFileSync(fixture.file, 'utf8'), /windowsHide: true/);
  assert.deepEqual(logs, ['[prebuild] node-pty Windows hidden-console patch applied.']);
});

test('node-pty hidden-console patch is idempotent', () => {
  const basePatch = patches[0];
  const fixture = makePatchFixture(`function test() { return ${basePatch.after}; }\n`);
  const logs = [];

  const changed = ensurePatch({
    patches: [{ ...basePatch, file: fixture.file }],
    log: (message) => logs.push(message),
  });

  assert.equal(changed, false);
  assert.deepEqual(logs, ['[prebuild] node-pty Windows hidden-console patch already applied.']);
});
