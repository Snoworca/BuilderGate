// Issue #10 AC-8(ii) / REL-BGSTAB-025 AC-1, by EXECUTION.
// v1 of this probe invented the fixture fields ({skipped: 42, bytes, chunks}).
// The real HiddenOutputState is {skipped: boolean, skippedBytes: number,
// debugTail: string}, so v1 asked its question of a shape the code never sees.
// A fixture whose fields are guessed cannot pose the question it claims to.
import {
  clearHiddenOutputState,
  type HiddenOutputState,
} from '/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/frontend/src/utils/terminalHiddenOutput.ts';

const dirty: HiddenOutputState = { skipped: true, skippedBytes: 4096, debugTail: 'abc' };
const after = clearHiddenOutputState(dirty);

console.log('before:', JSON.stringify(dirty));
console.log('after :', JSON.stringify(after));
console.log('CONTROL input was dirty                       =', dirty.skipped === true);
console.log('SUBJECT dirty flag cleared with no ACK        =', after.skipped === false);
console.log('SUBJECT skipped bytes discarded with no ACK   =', after.skippedBytes === 0);

// Negative control: an already-clean state must be returned unchanged, so the
// "cleared" result above is a real transition and not this function's only mode.
const clean: HiddenOutputState = { skipped: false, skippedBytes: 0, debugTail: '' };
console.log('NEGATIVE CONTROL clean state passes through identically =',
  clearHiddenOutputState(clean) === clean);
