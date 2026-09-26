// Independent probe for issue #10 AC-12(iii): does the post-rollback compatibility
// writer honour the byte cap and the chunk cap?
// Subject arm + a positive control that proves the cap CAN fire in this harness.
import { createTerminalWriteCoordinator } from '../../../../../mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/frontend/src/utils/terminalWriteCoordinator.ts';

const CAP_BYTES = 1048576;   // postCheckpointMaxBytes
const CAP_CHUNKS = 1024;     // postCheckpointMaxChunks
const CHUNK = 4096;
const N = 20000;

function mkAdapter() {
  const events: string[] = [];
  let writes = 0;
  return {
    events, get writes() { return writes; },
    adapter: {
      // deliberately never calls onWritten -> one write stays in flight,
      // which is the real xterm async shape and what makes the queue grow.
      write: (c: any, _onWritten: () => void) => { writes += 1; events.push(c.kind); },
      resetParser: () => { events.push('reset'); },
      resize: () => {}, applyModes: () => {}, clearScreen: () => {},
      fit: () => ({ cols: 80, rows: 24 }), setWindowsPty: () => {},
      markReady: () => {}, releaseInput: () => {}, settleInput: () => {},
      requestFreshRecovery: (r: string) => { events.push('recovery:' + r); },
      requestRuntimeRecreation: () => {}, compatibilityRecoveryDrained: () => {},
      checkpointApplied: () => {}, checkpointDrained: () => {}, settle: () => {},
    },
  };
}
const opts = (a: any) => ({
  viewGeneration: 7, adapter: a, digestBytes: () => 'd'.repeat(64),
  postCheckpointMaxBytes: CAP_BYTES, postCheckpointMaxChunks: CAP_CHUNKS,
  checkpointMaxBytes: CAP_BYTES, checkpointMaxChunks: CAP_CHUNKS,
});

// ---------- POSITIVE CONTROL: with a checkpoint open, the cap must fire ----------
{
  const h = mkAdapter();
  const c = createTerminalWriteCoordinator(opts(h.adapter) as any);
  const begin = c.dispatch({
    type: 'checkpoint-begin', streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10',
    snapshotSeq: '10', oldestRetainedSeq: '1', retentionPolicyId: 'p1', viewGeneration: 7,
    chunkCount: 1, encodedByteTotal: 4, digest: 'd'.repeat(64), cols: 80, rows: 24,
    modes: {}, parserTail: new Uint8Array(0),
  } as any);
  let accepted = 0, firstReject: string | undefined;
  for (let i = 0; i < N; i += 1) {
    const r = c.submitCompatibility({ type: 'write', viewGeneration: 7, kind: 'live', data: new Uint8Array(CHUNK) } as any);
    if (r.accepted) accepted += 1; else { firstReject = r.reason; break; }
  }
  console.log('CONTROL  checkpoint-open: begin=' + JSON.stringify(begin));
  console.log('CONTROL  accepted=' + accepted + ' firstReject=' + firstReject
    + '  (cap would fire at chunks>' + CAP_CHUNKS + ' or bytes>' + CAP_BYTES + ' i.e. ~' + Math.floor(CAP_BYTES / CHUNK) + ' writes)');
  console.log('CONTROL  FIRED=' + (firstReject !== undefined));
}

// ---------- SUBJECT: after rollback-to-compatibility ----------
{
  const h = mkAdapter();
  const c = createTerminalWriteCoordinator(opts(h.adapter) as any);
  const rb = c.dispatch({ type: 'rollback-to-compatibility', viewGeneration: 8, reason: 'capability-withdrawn' } as any);
  console.log('SUBJECT  rollback=' + JSON.stringify(rb) + ' state=' + JSON.stringify(c.getState()));
  // AC-12(i): is new authoritative OUTPUT admission stopped before a fresh snapshot?
  const live = c.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 8,
    data: new Uint8Array(8), settlementToken: 't-live',
  } as any);
  console.log('SUBJECT  AC-12(i) live-before-snapshot=' + JSON.stringify(live) + ' events=' + JSON.stringify(h.events));
  let accepted = 0, firstReject: string | undefined;
  for (let i = 0; i < N; i += 1) {
    const r = c.submitCompatibility({ type: 'write', viewGeneration: 8, kind: 'live', data: new Uint8Array(CHUNK) } as any);
    if (r.accepted) accepted += 1; else { firstReject = r.reason; break; }
  }
  const s = c.getState();
  console.log('SUBJECT  accepted=' + accepted + ' firstReject=' + firstReject);
  console.log('SUBJECT  pendingCommands=' + s.pendingCommands + ' writeInFlight=' + s.writeInFlight
    + ' adapterWriteCalls=' + h.writes);
  console.log('SUBJECT  retainedBytes=' + (accepted * CHUNK) + ' (=' + ((accepted * CHUNK) / 1048576).toFixed(1)
    + ' MiB) vs declared byte cap ' + CAP_BYTES + ' and chunk cap ' + CAP_CHUNKS);
  console.log('SUBJECT  CAP_FIRED=' + (firstReject !== undefined));
}
