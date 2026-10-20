// FR-FEX-026 AC-1~AC-6 (#139): the phone's four fixed slots, the selection band with its
// multi-select mode, the 더보기 sheet and its closing rules, the progress band and hiding the bar
// under the mobile terminal keyboard.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildMobileBarSlots,
  buildMobileMoreSheet,
  mobileSheetTitle,
} from '../../src/components/fileExplorer/fileExplorerContextMenu.ts';
import { decideRowPointer } from '../../src/components/fileExplorer/fileRowInteraction.ts';
import { selectionBandText, shouldShowMobileFileBar } from '../../src/components/fileExplorer/fileTransferModel.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const BAR = '../../src/components/fileExplorer/FileExplorerMobileBar.tsx';
const SHEET = '../../src/components/fileExplorer/FileExplorerMoreSheet.tsx';
const BANDS = '../../src/components/fileExplorer/FileExplorerMobileBands.tsx';
const CSS = '../../src/components/fileExplorer/FileExplorer.css';
const noop = () => {};

test('FR-FEX-026 AC-1: 업로드 · 다운로드 · 붙여넣기 · 더보기 in fixed slots, enabled by the menu predicates', () => {
  for (const count of [0, 1, 3]) {
    for (const clipboardEmpty of [true, false]) {
      const calls: string[] = [];
      const slots = buildMobileBarSlots({ count, clipboardEmpty }, {
        upload: () => calls.push('upload'), download: () => calls.push('download'), paste: () => calls.push('paste'), more: () => calls.push('more'),
      });
      assert.deepEqual(slots.map((s) => s.id), ['upload', 'download', 'paste', 'more']);
      assert.deepEqual(slots.map((s) => s.label), ['업로드', '다운로드', '붙여넣기', '더보기']);
      assert.ok(slots.every((s) => s.icon.length > 0));
      const by = new Map(slots.map((s) => [s.id, s]));
      assert.equal(by.get('upload')?.disabled, false);
      assert.equal(by.get('download')?.disabled, count === 0);
      assert.equal(by.get('paste')?.disabled, clipboardEmpty);
      assert.equal(by.get('more')?.disabled, false);
      slots.forEach((s) => s.onClick());
      assert.deepEqual(calls, ['upload', 'download', 'paste', 'more']);
    }
  }
  const bar = read(BAR);
  assert.match(bar, /aria-label=\{t\('fileExplorer\.mobileBar\.label'\)\}/);
  assert.doesNotMatch(bar, /common\.fileJobs/, 'the toolbar is not named after the job list');
  assert.match(bar, /aria-disabled=\{/);
  assert.match(bar, /buildMobileBarSlots\(/);
  const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
  assert.equal(ko['fileExplorer.mobileBar.label'], '파일 동작');
  // 12 px through the token (--fs-xs: 12px); raw sizes are not allowed in migrated CSS (CON-UIDS-001 AC-8).
  assert.match(read(CSS), /\.fx-mobile-slot-label\s*\{[^}]*font-size:\s*var\(--fs-xs\)/);
  assert.match(read('../../src/styles/tokens.css'), /--fs-xs:\s*12px/);
});

test('FR-FEX-026 AC-2: the band counts the selection; in 여러 개 선택 mode a tap toggles instead of replacing', () => {
  assert.equal(selectionBandText(2), '2개 선택됨');
  assert.deepEqual(decideRowPointer({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, isSelected: false, toggleMode: true }), { type: 'select', mods: { ctrl: true, shift: false } });
  assert.deepEqual(decideRowPointer({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, isSelected: false }), { type: 'select', mods: { ctrl: false, shift: false } });
  const bar = read(BANDS);
  for (const key of ['fileTransfer.selection.multi', 'fileTransfer.selection.all', 'fileTransfer.selection.clear']) assert.ok(bar.includes(key), key);
  assert.match(bar, /aria-pressed=\{/);
});

test('FR-FEX-026 AC-3: the sheet holds the menu actions in menu order with 삭제 alone at the bottom, disabled not hidden', () => {
  const sheet = buildMobileMoreSheet({ count: 0, isDir: false, clipboardEmpty: true, folderUploadSupported: false }, {
    download: noop, upload: noop, uploadFolder: noop, extract: noop, extractHere: noop, copy: noop, cut: noop, paste: noop, rename: noop, newfile: noop, newdir: noop, info: noop, delete: noop,
  });
  assert.deepEqual(sheet.map((e) => (e === 'sep' ? '|' : e.id)), ['download', 'upload', 'uploadFolder', 'extract', 'extractHere', '|', 'copy', 'cut', 'paste', '|', 'rename', 'newfile', 'newdir', 'info', '|', 'delete']);
  const items = sheet.filter((e): e is Exclude<typeof e, 'sep'> => e !== 'sep');
  const by = new Map(items.map((e) => [e.id, e]));
  assert.equal(by.get('delete')?.destructive, true);
  assert.equal(by.get('delete')?.disabled, true);
  assert.equal(by.get('uploadFolder')?.disabled, true);
  assert.equal(by.get('uploadFolder')?.reason, '이 브라우저는 폴더 업로드를 지원하지 않습니다');
  assert.equal(by.get('newdir')?.disabled, false);
  assert.equal(mobileSheetTitle({ count: 1, name: 'App.tsx', folder: 'components' }), 'App.tsx');
  assert.equal(mobileSheetTitle({ count: 3, name: null, folder: 'components' }), '3개 항목');
  assert.equal(mobileSheetTitle({ count: 0, name: null, folder: 'components' }), 'components');
  const css = read(CSS);
  assert.match(css, /\.fx-sheet-item\.fx-danger\s*\{[^}]*var\(--danger/);
});

test('FR-FEX-026 AC-4: the sheet closes on the scrim, the back gesture and a downward drag, and traps focus', () => {
  const sheet = read(SHEET);
  assert.match(sheet, /popstate/, 'back');
  assert.match(sheet, /history\.pushState/);
  assert.match(sheet, /onTouchEnd|onPointerUp/, 'drag down');
  assert.match(sheet, /'Tab'/, 'focus trap');
  assert.match(sheet, /'Escape'/);
  assert.match(sheet, /fx-sheet-scrim/);
  const bar = read(BAR);
  // A dialog, not a menu: the explorer draws no second menu beside ContextMenu (FR-FEX-006 AC-9).
  assert.match(bar, /aria-haspopup=\{[^}]*'dialog'/);
  assert.match(bar, /aria-expanded=\{/);
});

test('FR-FEX-026 AC-5: the bar uploads without a sheet; the progress band has a 44 px cancel and opens the popover', () => {
  const bar = read(BANDS);
  assert.match(bar, /openFileJobPopover\(/);
  assert.match(bar, /role="progressbar"/);
  assert.match(read(CSS), /\.fx-mobile-band-cancel\s*\{[^}]*(?:width|min-width):\s*44px/);
});

test('FR-FEX-026 AC-6: hidden while the mobile terminal keyboard is open; the bar keeps the bottom safe area', () => {
  assert.equal(shouldShowMobileFileBar({ isMobile: true, terminalKeyboardOpen: false }), true);
  assert.equal(shouldShowMobileFileBar({ isMobile: true, terminalKeyboardOpen: true }), false);
  assert.equal(shouldShowMobileFileBar({ isMobile: false, terminalKeyboardOpen: false }), false);
  assert.match(read(CSS), /\.fx-mobile-bar\s*\{[^}]*env\(safe-area-inset-bottom/);
  const app = read('../../src/App.tsx');
  assert.match(app, /terminalKeyboardOpen=\{showMobileKeyBar\}/);
});
