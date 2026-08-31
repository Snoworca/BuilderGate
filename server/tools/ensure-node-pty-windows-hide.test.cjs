const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensurePatch, patches } = require('./ensure-node-pty-windows-hide.cjs');

test('node-pty runtime patches are idempotent and fail closed on target drift', () => {
  const sourcePatch = patches.find(patch => (
    patch.label === 'node-pty ConPTY natural-exit input pipe cleanup'
  ));
  assert.ok(sourcePatch, 'cleanup patch must remain registered in the persistent prebuild patcher');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-node-pty-patch-'));
  const file = path.join(directory, 'windowsPtyAgent.js');
  const patch = { ...sourcePatch, file };
  try {
    fs.writeFileSync(file, `prefix\n${patch.before}\nsuffix\n`, 'utf8');
    assert.equal(ensurePatch({ patches: [patch], log() {} }), true);
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(
      patch.after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));
    assert.equal(ensurePatch({ patches: [patch], log() {} }), false);

    fs.writeFileSync(file, 'upstream target drifted', 'utf8');
    assert.throws(
      () => ensurePatch({ patches: [patch], log() {} }),
      /patch target did not match expected node-pty source/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
