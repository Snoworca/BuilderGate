// Issue #10 AC-12(iii) probe v2. v1 was INVALID: its control fired for the wrong
// reason (checkpoint-authority-conflict, not the cap) and its subject arm poisoned
// itself by omitting settlementLedger options (default 0 => immediate 'overflow').
// v2 mirrors the committed fixture BOUNDED_COORDINATOR_LIMITS and uses a control
// that fires on the CAP specifically.
import { createTerminalWriteCoordinator } from '/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/frontend/src/utils/terminalWriteCoordinator.ts';

const LIMITS = {
  postCheckpointMaxBytes: 1024 * 1024, postCheckpointMaxChunks: 1024,
  pendingInputMaxBytes: 1024 * 1024, pendingInputMaxCount: 1024, pendingInputTtlMs: 60_000,
  settlementLedgerMaxEntries: 1024, settlementLedgerTtlMs: 60_000,
};
const CHUNK = 4096;
const N = 20000;

function mkAdapter() {
  const events: string[] = []; const recoveries: string[] = [];
  let writes = 0;
  return { events, recoveries, get writes() { return writes; }, adapter: {
    write: (c: any, _o: () => void) => { writes += 1; events.push(c.kind); },
    resetParser: () => { events.push('reset'); }, resize: () => {}, applyModes: () => {},
    clearScreen: () => {}, fit: () => ({ cols: 80, rows: 24 }), setWindowsPty: () => {},
    markReady: () => {}, releaseInput: () => {}, settleInput: () => {},
    requestFreshRecovery: (r: string) => { recoveries.push(r); },
    requestRuntimeRecreation: () => {}, compatibilityRecoveryDrained: () => {},
    checkpointApplied: () => {}, checkpointDrained: () => {}, settle: () => {},
  } };
}
const mk = (a: any, gen = 7) => createTerminalWriteCoordinator({
  viewGeneration: gen, adapter: a, digestBytes: () => 'd'.repeat(16), ...LIMITS,
  checkpointMaxBytes: LIMITS.postCheckpointMaxBytes, checkpointMaxChunks: LIMITS.postCheckpointMaxChunks,
} as any);
const beginCmd = (gen: number) => ({
  type: 'checkpoint-begin', streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10',
  snapshotSeq: '10', oldestRetainedSeq: '1', retentionPolicyId: 'p1', viewGeneration: gen,
  chunkCount: 1, encodedByteTotal: 8, digest: 'd'.repeat(16), cols: 80, rows: 24,
  modes: {}, parserTail: new Uint8Array(0),
});

// ---- POSITIVE CONTROL: the cap must fire, by name, on the held lane ----
{
  const h = mkAdapter(); const c = mk(h.adapter);
  c.dispatch(beginCmd(7) as any);
  let accepted = 0, reason: string | undefined;
  for (let i = 0; i < N; i += 1) {
    const r = c.dispatch({ type: 'live', streamEpoch: '1', sourceSeq: String(11 + i),
      viewGeneration: 7, data: new Uint8Array(CHUNK), settlementToken: 'c' + i } as any);
    if (r.accepted) accepted += 1; else { reason = r.reason; break; }
  }
  console.log('CONTROL accepted=' + accepted + ' reason=' + reason);
  console.log('CONTROL CAP_FIRED_BY_NAME=' + (reason === 'post-checkpoint-hold-overflow')
    + '  (expected at ~' + Math.floor(LIMITS.postCheckpointMaxBytes / CHUNK) + ' writes)');
}

// ---- SUBJECT: after rollback-to-compatibility, is anything bounded? ----
for (const lane of ['compatibility-write', 'live-dispatch'] as const) {
  const h = mkAdapter(); const c = mk(h.adapter);
  const rb = c.dispatch({ type: 'rollback-to-compatibility', viewGeneration: 8, reason: 'capability-withdrawn' } as any);
  let accepted = 0, reason: string | undefined;
  for (let i = 0; i < N; i += 1) {
    const r = lane === 'compatibility-write'
      ? c.submitCompatibility({ type: 'write', viewGeneration: 8, kind: 'live', data: new Uint8Array(CHUNK) } as any)
      : c.dispatch({ type: 'live', streamEpoch: '1', sourceSeq: String(1 + i), viewGeneration: 8,
          data: new Uint8Array(CHUNK), settlementToken: 's' + i } as any);
    if (r.accepted) accepted += 1; else { reason = r.reason; break; }
  }
  const s = c.getState();
  console.log('SUBJECT[' + lane + '] rollback=' + JSON.stringify(rb));
  console.log('SUBJECT[' + lane + '] accepted=' + accepted + ' firstReject=' + reason
    + ' pendingCommands=' + s.pendingCommands + ' writeInFlight=' + s.writeInFlight
    + ' adapterWriteCalls=' + h.writes + ' recoveries=' + JSON.stringify(h.recoveries.slice(0, 3)));
  console.log('SUBJECT[' + lane + '] retained=' + ((accepted * CHUNK) / 1048576).toFixed(1)
    + ' MiB vs byte cap ' + (LIMITS.postCheckpointMaxBytes / 1048576) + ' MiB, chunks ' + accepted
    + ' vs chunk cap ' + LIMITS.postCheckpointMaxChunks);
  console.log('SUBJECT[' + lane + '] BOUNDED=' + (reason !== undefined));
}
