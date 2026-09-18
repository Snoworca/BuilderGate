#!/usr/bin/env python3
"""Probe the rollback ledger-restore site for AC-11 and for #106 reachability.

Answers two questions in one run:
  (1) does `restoreRetainedLedger` land on a NEW streamEpoch?  If it does, every
      retained `committedFactKeys` entry is unreachable, because the key's first
      component is the epoch -- so "retain the ledger" buys nothing.
  (2) does it move `retained.sourceSeq` DOWNWARD while pending reservations are
      outstanding?  That is the state `03.reserved-ordinal-gap.md` measured as
      destroying the headless model.

Every replacement asserts its own match count before writing.
"""
import sys, hashlib, shutil, os

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
SESSMGR = os.path.join(ROOT, 'server/src/services/SessionManager.ts')
BACKUP = os.path.join(os.path.dirname(__file__), '.backup-rollback')

NEEDLE = """    this.setTerminalStreamEpoch(data.session.id, retained, restoredStreamEpoch, 'authority-rollback');
    retained.sourceSeq = restoredSourceSeq;
"""
PROBE = """    if (process.env.ISSUE12_ROLLBACK_PROBE) { console.error('[ISSUE12-RB] epochBefore=%s epochAfter=%s epochChanged=%s seqBefore=%s seqAfter=%s seqLowered=%s keysBefore=%d keysAfter=%d pendingOutputs=%d pendingResizes=%d reservedSeq=%s reservedEpoch=%s', retained.streamEpoch, restoredStreamEpoch, String(retained.streamEpoch !== restoredStreamEpoch), retained.sourceSeq, restoredSourceSeq, String(BigInt(restoredSourceSeq) < BigInt(retained.sourceSeq)), retained.committedFactKeys.size, original.committedFactKeys.size, data.pendingHeadlessOutputs.size, data.pendingRetainedResizes, String(data.nextTerminalAuthoritySourceSeq), String(data.nextTerminalAuthorityStreamEpoch)); }
""" + NEEDLE


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def apply_():
    os.makedirs(BACKUP, exist_ok=True)
    shutil.copy2(SESSMGR, os.path.join(BACKUP, 'SessionManager.ts'))
    print('backup SessionManager.ts', sha(SESSMGR))
    s = open(SESSMGR, encoding='utf-8', newline='').read()
    n = s.count(NEEDLE)
    assert n == 1, f'rollback restore site: expected 1, found {n}'
    open(SESSMGR, 'w', encoding='utf-8', newline='').write(s.replace(NEEDLE, PROBE))
    print('SessionManager.ts patched, match count 1')


def restore():
    shutil.copy2(os.path.join(BACKUP, 'SessionManager.ts'), SESSMGR)
    print('restored SessionManager.ts', sha(SESSMGR))


if __name__ == '__main__':
    {'apply': apply_, 'restore': restore}[sys.argv[1]]()
