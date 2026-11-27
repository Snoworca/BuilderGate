// @req FR-BGSTAB-039
// Patches the composition helper of @xterm/xterm 6.0.0 in lib/xterm.js and lib/xterm.mjs.
//
// xterm sends a committed composition from a setTimeout(0) and keeps the pending send in one
// boolean (xtermjs/xterm.js#6089). When the page delays its timers -- many terminals each
// arming write and snapshot timers -- that timer runs after the next compositionend, and a
// Korean syllable goes out twice or not at all. A key that ends a composition at once (a
// digit) reads the end that compositionupdate records from another delayed timer, so the
// syllable can be lost there too (#6250).
//
// The patch keeps how far into the helper textarea it has sent (_sentUpTo) and how many
// delayed sends are pending (_pendingSends). Every send goes from _sentUpTo to a boundary and
// moves _sentUpTo there, so timers that run late or out of order can neither repeat a range
// nor skip one. A key that ends a composition at once reads the textarea's current length.
//
// The bundles are one long line each, so a patch-package diff would be over 1 MB; this
// script rewrites the one class instead. It runs from postinstall, refuses any other xterm
// version, and does nothing when the bundles are already patched. Remove it, and unpin the
// version in package.json, once upstream ships a fix for #6089.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PATCHED_XTERM_VERSION = '6.0.0';
// Bump when the replacement below changes, so an install patched by an older revision is noticed.
export const PATCH_REVISION = 5;
export const PATCH_MARKER = `_bgPatchRevision(){return ${PATCH_REVISION}}`;

const XTERM_DIR = fileURLToPath(new URL('../node_modules/@xterm/xterm/', import.meta.url));
const BUNDLES = ['lib/xterm.js', 'lib/xterm.mjs'];

function fail(message) {
  throw new Error(`[xterm-composition] ${message}`);
}

/** Returns the bundle source with the composition helper replaced. */
export function patchBundle(source, name) {
  if (source.includes(PATCH_MARKER)) return source;
  if (source.includes('this._sentUpTo')) {
    fail(`${name}: patched by an older revision of this script; delete node_modules/@xterm/xterm and run npm install again`);
  }

  const ctorOld = 'this._compositionPosition={start:0,end:0},this._dataAlreadySent=""}';
  if (source.split(ctorOld).length !== 2) fail(`${name}: CompositionHelper constructor not found exactly once`);
  let s = source.replace(ctorOld, 'this._compositionPosition={start:0,end:0},this._dataAlreadySent="",this._sentUpTo=0,this._pendingSends=0,this._flushEpoch=0}');

  const start = s.indexOf('compositionstart(){this._isComposing=!0');
  if (start < 0) fail(`${name}: compositionstart not found`);
  const endMatch = /updateCompositionElements\(\w\)\{if\(this\._is/g;
  endMatch.lastIndex = start;
  const end = endMatch.exec(s);
  if (!end) fail(`${name}: updateCompositionElements not found after compositionstart`);
  const old = s.slice(start, end.index);

  const update = /compositionupdate\(\w\)\{.*?\}\)?,0\)\}/.exec(old);
  if (!update) fail(`${name}: compositionupdate not found`);
  const del = /triggerDataEvent\(`\$\{([\w.]+)\}`,!0\)/.exec(old);
  if (!del) fail(`${name}: the DEL constant of _handleAnyTextareaChanges not found`);
  if (!old.includes('this._isSendingComposition')) fail(`${name}: the class does not look like xterm ${PATCHED_XTERM_VERSION}`);

  const replacement = [
    // A composition that starts after every earlier one was sent starts a fresh range.
    'compositionstart(){this._isComposing=!0,this._clampSent(),',
    '0===this._pendingSends&&(this._sentUpTo=this._textarea.value.length),',
    'this._compositionPosition.start=this._textarea.value.length,',
    'this._compositionView.textContent="",this._dataAlreadySent="",',
    'this._compositionView.classList.add("active")}',
    update[0],
    'compositionend(){this._finalizeComposition(!0)}',
    // xterm empties the textarea right after handling Enter or Ctrl+C, and on blur; the next
    // key is the first chance to see that, before the IME inserts anything new.
    'keydown(e){if(this._clampSent(),this._isComposing||this._pendingSends>0){',
    'if(20===e.keyCode||229===e.keyCode)return!1;',
    'if(16===e.keyCode||17===e.keyCode||18===e.keyCode)return!1;',
    'this._finalizeComposition(!1)}',
    'return 229!==e.keyCode||(this._handleAnyTextareaChanges(),!1)}',
    // xterm clears the textarea on Enter, Ctrl+C and blur; never point past its end.
    '_clampSent(){this._sentUpTo>this._textarea.value.length&&(this._sentUpTo=this._textarea.value.length)}',
    '_sendUpTo(e){if(this._clampSent(),e>this._sentUpTo){',
    'const t=this._textarea.value.substring(this._sentUpTo,e);',
    'this._sentUpTo=e,this._coreService.triggerDataEvent(t,!0)}}',
    '_finalizeComposition(e){if(this._compositionView.classList.remove("active"),this._isComposing=!1,e)',
    'this._pendingSends++,setTimeout((()=>{this._pendingSends--,',
    'this._sendUpTo(this._isComposing?this._compositionPosition.start:this._textarea.value.length)}),0);',
    // A key that ends the composition at once sends everything typed so far. xterm then clears
    // the textarea for Enter and Ctrl+C, so a timer armed before this must not read the
    // shorter value as the user deleting a character.
    'else this._flushEpoch++,this._sendUpTo(this._textarea.value.length)}',
    // A character the IME inserts without composing (a digit or Space in Hangul mode) is a
    // delayed send too: it counts as pending, so a later key or composition cannot move
    // _sentUpTo past it before it goes out.
    '_handleAnyTextareaChanges(){const e=this._textarea.value,n=this._flushEpoch;',
    'this._clampSent(),0===this._pendingSends&&(this._sentUpTo=e.length),this._pendingSends++,',
    'setTimeout((()=>{if(this._pendingSends--,!this._isComposing){const t=this._textarea.value;',
    // Growth is new input. So is anything after a flush: the textarea it compares with is gone,
    // and characters typed since then may have no timer of their own.
    'if(t.length>e.length||n!==this._flushEpoch)return void this._sendUpTo(t.length);',
    `t.length<e.length?(this._coreService.triggerDataEvent(\`\${${del[1]}}\`,!0),this._clampSent()):`,
    't.length===e.length&&t!==e&&(this._coreService.triggerDataEvent(t,!0),this._sentUpTo=t.length)}}),0)}',
    `_bgPatchRevision(){return ${PATCH_REVISION}}`,
  ].join('');

  return s.slice(0, start) + replacement + s.slice(end.index);
}

function main() {
  const pkg = JSON.parse(readFileSync(`${XTERM_DIR}package.json`, 'utf8'));
  if (pkg.version !== PATCHED_XTERM_VERSION) {
    fail(`installed @xterm/xterm is ${pkg.version}; this patch is for ${PATCHED_XTERM_VERSION}. `
      + 'Check whether upstream fixed #6089, then update or remove patches/xterm-composition.mjs.');
  }
  for (const bundle of BUNDLES) {
    const path = `${XTERM_DIR}${bundle}`;
    const source = readFileSync(path, 'utf8');
    const patched = patchBundle(source, bundle);
    if (patched === source) {
      console.log(`[xterm-composition] ${bundle}: already patched`);
      continue;
    }
    writeFileSync(path, patched, 'utf8');
    console.log(`[xterm-composition] ${bundle}: patched`);
  }
}

// Compare real paths: under a junction, subst drive or symlink the two spellings differ, and a
// plain comparison would skip the patch without a word.
function isRunDirectly() {
  return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isRunDirectly()) main();
