// FR-AITUI-023: the save button says how many terminals are selected, as the restore tab's
// 선택한 N개 복구 does. It read 모두 저장 (0) with nothing selected and 모두 저장 (1) with one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const catalog = (lang: string) => JSON.parse(readFileSync(new URL(`../../public/locales/messages.${lang}.json`, import.meta.url), 'utf8'));
const ko = catalog('ko');
const en = catalog('en');

test('FR-AITUI-023 AC-1: the save button names the selected count like the restore button', () => {
  assert.equal(ko['sessionSave.all.saveAll'], '선택한 {count}개 저장');
  assert.equal(en['sessionSave.all.saveAll'], 'Save {count} selected');
  assert.equal(ko['sessionSave.restore.run'], '선택한 {count}개 복구', 'the restore button it follows');
});

test('FR-AITUI-023 AC-1·AC-2: the button counts the picked rows and is disabled without them', () => {
  const dialog = readFileSync(new URL('../../src/components/SessionSave/SessionSaveDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /disabled=\{picked\.length === 0 \|\| invalidCount > 0\}/);
  assert.match(dialog, /t\('sessionSave\.all\.saveAll', \{ count: picked\.length \}\)/);
});
