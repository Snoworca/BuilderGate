#!/usr/bin/env node
// Issue #91: kiwi/.status.json carries a fingerprint of the SRS bytes, and this
// epic's lanes report "the fingerprint matches the committed bytes" as evidence
// of record integrity. Nothing verified that claim -- before this script, no
// workflow, script or test in the repository referenced .status.json or
// specFingerprint at all.
//
// It matters because the fingerprint does not always get regenerated. Measured
// against speckiwi's CLI, two mutations write the SRS and leave .status.json
// untouched:
//
//   add-change-note      writes the SRS, does NOT regenerate
//   add-related-doc      writes the SRS, does NOT regenerate
//
// while these thirteen do regenerate: add-evidence, add-trace, add-requirement,
// append-note, check-ac, uncheck-ac, edit-ac, edit-requirement,
// replace-acceptance-criteria, add-completed-work, update-status,
// update-stability, set-target-goal, set-target-status, sync-index.
//
// So after one of the two, the fingerprint is stale by exactly one write, and any
// later mutation of the other kind silently repairs it. That makes an unverified
// "fingerprint matches" report a coincidence of mutation ordering rather than a
// statement about the record -- which is how issue #8 found it, having drifted
// back into agreement by accident.
//
// Exit 0 when every recorded file hashes to its recorded value, 1 otherwise.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statusPath = join(repositoryRoot, 'kiwi', '.status.json');

let status;
try {
  status = JSON.parse(await readFile(statusPath, 'utf8'));
} catch (error) {
  console.error(`kiwi status fingerprint: cannot read ${statusPath}: ${error.message}`);
  process.exit(1);
}

const files = status?.specFingerprint?.files;
if (!Array.isArray(files) || files.length === 0) {
  console.error('kiwi status fingerprint: specFingerprint.files is missing or empty; nothing was checked');
  process.exit(1);
}

const stale = [];
for (const entry of files) {
  let actual;
  try {
    actual = createHash('sha256').update(await readFile(join(repositoryRoot, entry.path))).digest('hex');
  } catch (error) {
    stale.push({ path: entry.path, recorded: entry.sha256, actual: `<unreadable: ${error.code ?? 'error'}>` });
    continue;
  }
  if (actual !== entry.sha256) stale.push({ path: entry.path, recorded: entry.sha256, actual });
}

if (stale.length > 0) {
  console.error(`kiwi status fingerprint is stale for ${stale.length} of ${files.length} spec file(s):`);
  for (const row of stale) {
    console.error(`  ${row.path}\n    recorded ${row.recorded}\n    actual   ${row.actual}`);
  }
  console.error('\nRegenerate it with any regenerating speckiwi mutation, or `speckiwi sync-index --root .`.');
  console.error('If the last mutation was add-change-note or add-related-doc, this is issue #91: those two');
  console.error('write the SRS without regenerating the fingerprint.');
  process.exit(1);
}

console.log(`kiwi status fingerprint matches all ${files.length} spec file(s).`);
