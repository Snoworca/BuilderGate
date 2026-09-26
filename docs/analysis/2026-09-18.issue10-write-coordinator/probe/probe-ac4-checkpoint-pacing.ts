// Issue #10 AC-4 second half, executable: does ANY time budget pace the
// checkpoint write lane? If the frame CPU budget applied, the number of
// physical writes in one turn would depend on elapsed time. If slicing is by a
// fixed byte constant alone, the count is a pure function of body size and is
// identical whether each write takes 0ms or 1000ms.
import { createTerminalWriteCoordinator } from '/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/frontend/src/utils/terminalWriteCoordinator.ts';

const SLICE = 32 * 1024;      // checkpointWriteSliceBytes default
const BODY = SLICE * 4;       // four slices' worth

function run(msPerWrite: number) {
  let clock = 0;
  let writes = 0;
  const held: Array<() => void> = [];
  const adapter = {
    write: (_c: unknown, onWritten: () => void) => { writes += 1; clock += msPerWrite; held.push(onWritten); },
    resetParser: () => {}, resize: () => {}, applyModes: () => {}, clearScreen: () => {},
    fit: () => ({ cols: 80, rows: 24 }), setWindowsPty: () => {}, markReady: () => {},
    releaseInput: () => {}, settleInput: () => {}, requestFreshRecovery: () => {},
    requestRuntimeRecreation: () => {}, compatibilityRecoveryDrained: () => {},
    checkpointApplied: () => {}, checkpointDrained: () => {}, settle: () => {},
  };
  const c = createTerminalWriteCoordinator({
    viewGeneration: 7, adapter, digestBytes: () => 'd'.repeat(16),
    now: () => clock,
    setTimer: (cb: () => void) => ({ cb }), clearTimer: () => {},
    postCheckpointMaxBytes: 64 * 1024 * 1024, postCheckpointMaxChunks: 100000,
    checkpointMaxBytes: 64 * 1024 * 1024, checkpointMaxChunks: 100000,
    pendingInputMaxBytes: 1 << 20, pendingInputMaxCount: 1024, pendingInputTtlMs: 60000,
    settlementLedgerMaxEntries: 100000, settlementLedgerTtlMs: 60000,
  } as never) as { dispatch(c: Record<string, unknown>): { accepted: boolean; reason?: string } };

  const body = new Uint8Array(BODY);
  const base = {
    streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10', snapshotSeq: '10',
    oldestRetainedSeq: '1', retentionPolicyId: 'p1', viewGeneration: 7,
    chunkCount: 1, encodedByteTotal: BODY, digest: 'd'.repeat(16),
    cols: 80, rows: 24, modes: {}, parserTail: new Uint8Array(0),
  };
  c.dispatch({ ...base, type: 'checkpoint-begin' });
  c.dispatch({ ...base, type: 'checkpoint-chunk', index: 0, count: 1, data: body });
  c.dispatch({ ...base, type: 'checkpoint-commit' });
  // Drain every callback the adapter is holding; each may release the next slice.
  let guard = 0;
  while (held.length > 0 && guard < 10000) { held.shift()?.(); guard += 1; }
  return { writes, elapsed: clock };
}

const fast = run(0);
const slow = run(1000);
console.log('body bytes            =', BODY, '(slice constant', SLICE + ')');
console.log('fast clock (0ms/write)  writes =', fast.writes, ' elapsed =', fast.elapsed);
console.log('slow clock (1000ms/write) writes =', slow.writes, ' elapsed =', slow.elapsed);
console.log('CONTROL the two arms really did differ in elapsed time =', fast.elapsed !== slow.elapsed);
console.log('SUBJECT write count is independent of elapsed time    =', fast.writes === slow.writes,
  '=> no frame CPU budget paces the checkpoint lane');
