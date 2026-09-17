// Issue #10 AC-8(ii), the orchestrator's reduction: does clearing
// hiddenOutputState.skipped remove a SYSTEM-VISIBLE indication that output is
// unaccounted for? That is behavioural, not lexical.
//
// The indication is the hidden-output recovery trigger at
// TerminalContainer.tsx:3713-3715:
//     useEffect(() => { if (!isVisible || !hiddenOutputStateRef.current.skipped) return; ... })
// It re-attempts recovery when the view becomes visible. Its predicate is
// evaluated here against the REAL output of the real clear function, so the
// composition is measured rather than assumed — this rules out the possibility
// that some path leaves `skipped` truthy.
import {
  clearHiddenOutputState,
  type HiddenOutputState,
} from '/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/frontend/src/utils/terminalHiddenOutput.ts';

// The guard's predicate, transcribed from the call site.
const recoveryArmed = (isVisible: boolean, state: HiddenOutputState): boolean =>
  !(!isVisible || !state.skipped);

const cases: Array<[string, HiddenOutputState]> = [
  ['skipped with bytes and tail', { skipped: true, skippedBytes: 4096, debugTail: 'abc' }],
  ['skipped, no tail',            { skipped: true, skippedBytes: 1, debugTail: '' }],
  ['skipped, zero bytes',         { skipped: true, skippedBytes: 0, debugTail: '' }],
];
for (const [label, dirty] of cases) {
  const before = recoveryArmed(true, dirty);
  const after = recoveryArmed(true, clearHiddenOutputState(dirty));
  console.log(`${label}: armed before = ${before}, armed after clear = ${after}`);
}
// NEGATIVE CONTROL: a state that was never dirty is already disarmed, so the
// transitions above are real rather than this predicate's only value.
const clean: HiddenOutputState = { skipped: false, skippedBytes: 0, debugTail: '' };
console.log('NEGATIVE CONTROL never-dirty state armed =', recoveryArmed(true, clean));
// SECOND CONTROL: the predicate can return true, else "disarmed" means nothing.
console.log('CONTROL predicate can be true            =',
  recoveryArmed(true, { skipped: true, skippedBytes: 0, debugTail: '' }));
