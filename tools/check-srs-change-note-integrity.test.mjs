// A superseded requirement keeps its Change Notes, but `speckiwi supersede` rewrites its heading as
// `### ~~ID — title~~ [DISCARDED → see NEW]`. Reading only `### ID` headings lost the block: its
// rows went to the requirement above it, and the check reported the discarded one as `1 -> 0`.
//   node --test tools/check-srs-change-note-integrity.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeNoteCounts } from './check-srs-change-note-integrity.mjs';

const block = (heading, rows) => [
  heading,
  '',
  '#### Change Notes',
  '',
  '| Date | Change | Reason |',
  '| --- | --- | --- |',
  ...rows.map(date => `| ${date} | Created | add-requirement |`),
  '',
].join('\n');

test('a discarded requirement with a struck-through heading keeps its own Change Note rows', () => {
  const markdown = [
    block('### PERF-BGSTAB-024 — earlier requirement', ['2026-10-01', '2026-10-02']),
    block('### ~~REL-BGSTAB-050 — old title~~ [DISCARDED → see REL-BGSTAB-053]', ['2026-10-21', '2026-10-27']),
    block('### REL-BGSTAB-053 — new title', ['2026-10-27']),
  ].join('\n');
  const counts = changeNoteCounts(markdown);
  assert.equal(counts.get('REL-BGSTAB-050'), 2);
  assert.equal(counts.get('PERF-BGSTAB-024'), 2, 'the discarded block is not counted into the one above it');
  assert.equal(counts.get('REL-BGSTAB-053'), 1);
});

test('an ordinary heading is still read, and a heading that only looks like an ID is not', () => {
  const counts = changeNoteCounts([
    block('### REL-BGSTAB-001 — title', ['2026-10-01']),
    block('### ~~not a requirement~~', ['2026-10-02']),
  ].join('\n'));
  assert.equal(counts.get('REL-BGSTAB-001'), 1, 'rows after a non-requirement heading are not credited to it');
  assert.equal(counts.size, 1);
});

test('CRLF text counts the same as LF text', () => {
  const markdown = block('### ~~REL-BGSTAB-050 — old~~ [DISCARDED → see REL-BGSTAB-053]', ['2026-10-21']);
  assert.deepEqual(changeNoteCounts(markdown.replace(/\n/gu, '\r\n')), changeNoteCounts(markdown));
});
