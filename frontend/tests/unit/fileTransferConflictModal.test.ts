// FR-FOP-006 AC-1~AC-4 (#139): one conflict wording for upload, copy and move, a remaining-count
// checkbox in place of 더 이상 묻지 않기, and a phone layout that stacks the decision buttons.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildDecisionModal,
  buildRejectedItemsModal,
  shortenMiddle,
} from '../../src/components/fileExplorer/fileExplorerModalModel.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
const en = JSON.parse(read('../../public/locales/messages.en.json')) as Record<string, string>;

const labels = (model: { choices: readonly { label: string }[] }) => model.choices.map((c) => c.label);

test('FR-FOP-006 AC-1: the conflict modal reads 덮어쓰기 · 둘 다 유지 · 건너뛰기 and draws only the offered decisions', () => {
  assert.deepEqual(labels(buildDecisionModal({ kind: 'conflict', path: '/w/src/a.png', choices: ['overwrite', 'rename', 'skip'] })), ['덮어쓰기', '둘 다 유지', '건너뛰기']);
  // A file against a folder (FR-FOP-004 AC-7): no overwrite.
  assert.deepEqual(labels(buildDecisionModal({ kind: 'conflict', path: '/w/src/a', choices: ['rename', 'skip'] })), ['둘 다 유지', '건너뛰기']);
  // The same model serves upload questions, which carry the folder and the two sides.
  const upload = buildDecisionModal({
    kind: 'conflict', path: 'a.png', choices: ['overwrite', 'rename', 'skip'], folder: 'components', remaining: 1,
    existing: { size: 900, modified: '2026-10-15T17:31:00.000Z', isDirectory: false }, incoming: { size: 1200, isDirectory: false },
  });
  assert.deepEqual(labels(upload), ['덮어쓰기', '둘 다 유지', '건너뛰기']);
  assert.equal(upload.details?.length, 2, 'existing and incoming are compared');
});

test('FR-FOP-006 AC-2: the checkbox names the remaining count and is hidden when none remain', () => {
  const base = { kind: 'conflict' as const, path: '/w/src/a.png', choices: ['overwrite', 'rename', 'skip'] as const };
  const two = buildDecisionModal({ ...base, choices: [...base.choices], remaining: 2 });
  assert.equal(two.showApplyToAll, true);
  assert.equal(two.applyToAllLabel, '남은 2개에도 같은 선택 적용');
  const none = buildDecisionModal({ ...base, choices: [...base.choices], remaining: 0 });
  assert.equal(none.showApplyToAll, false);
  // The server's copy/move questions do not say how many follow: the checkbox stays, without a number.
  const unknown = buildDecisionModal({ ...base, choices: [...base.choices] });
  assert.equal(unknown.showApplyToAll, true);
  assert.equal(unknown.applyToAllLabel, '남은 항목에도 같은 선택 적용');
  assert.ok(!Object.values(ko).includes('더 이상 묻지 않기'), '더 이상 묻지 않기 is gone from the catalog');
});

test('FR-FOP-006 AC-3: the message puts no particle right after a placeholder; en and ko hold the same keys', () => {
  const model = buildDecisionModal({ kind: 'conflict', path: '/w/src/components/a.png', choices: ['overwrite', 'rename', 'skip'] });
  assert.equal(model.message, 'components 에 같은 이름이 있습니다: a.png');
  const keys = ['fileExplorer.modal.conflictMessage', 'fileExplorer.modal.keepBoth', 'fileExplorer.modal.skip', 'fileExplorer.modal.applyToRemaining.other', 'fileExplorer.modal.applyToRemainingUnknown'];
  for (const key of keys) {
    assert.equal(typeof ko[key], 'string', `ko ${key}`);
    assert.equal(typeof en[key], 'string', `en ${key}`);
  }
  assert.doesNotMatch(ko['fileExplorer.modal.conflictMessage'], /\}(?:을|를|이|가|은|는|와|과|으로|로)/);
});

test('FR-FOP-006 AC-4: a long name is shortened in the middle; on a phone the buttons stack full width at 44 px', () => {
  const long = 'screenshot-2026-10-18-final-version.png';
  const short = shortenMiddle(long, 20);
  assert.ok(short.length <= 20, short);
  assert.match(short, /^scre.*….*\.png$/);
  assert.equal(shortenMiddle('a.png', 20), 'a.png');
  const model = buildDecisionModal({ kind: 'conflict', path: `/w/${long}`, choices: ['overwrite', 'rename', 'skip'] });
  assert.ok(model.message.includes('…'), 'the name in the message is shortened');
  const css = read('../../src/components/fileExplorer/FileExplorer.css');
  // FR-UIDS-015: the phone rule is the shared layout query (tests/unit/mobileLayoutQuery.test.ts).
  const phone = /@media\s*\(max-width:\s*767px\)[^{]*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(phone, /\.fx-window-modal-actions\s*\{[^}]*flex-direction:\s*column/, 'stacked');
  assert.match(phone, /\.fx-window-modal-actions\s+\.fx-confirm-button\s*\{[^}]*min-height:\s*44px[^}]*width:\s*100%|\.fx-window-modal-actions\s+\.fx-confirm-button\s*\{[^}]*width:\s*100%[^}]*min-height:\s*44px/, 'full width, 44 px');
});

test('FR-FEX-024 AC-8: rejected files are listed together in 처리하지 못한 항목 with a reason each', () => {
  const model = buildRejectedItemsModal([{ path: 'setup.exe', code: 'PATH_BLOCKED' }, { path: 'big.iso', code: 'FILE_TOO_LARGE' }]);
  assert.equal(model.title, '처리하지 못한 항목');
  assert.deepEqual(model.items?.map((i) => i.name), ['setup.exe', 'big.iso']);
  assert.ok(model.items?.every((i) => i.reason.length > 0));
  assert.deepEqual(model.choices.map((c) => c.id), ['confirm']);
  assert.equal(model.showApplyToAll, false);
});
