#!/usr/bin/env python3
"""Probe the SHIPPING rollback entry for the epoch and the dedup ledger.

Closes the reproducibility gap named in 08.shipping-rollback-path.md: the
original run of this probe was applied inline, so the 40/40 epoch claim could
not be re-derived from the tree. This script reproduces it.

Instruments `SessionManager.beginTerminalAuthorityRollback` -- the entry point
the production `rollbackSession` in TerminalAuthorityProductionAdapter calls --
and prints, per rollback:

  * the retained epoch at entry and the epoch being REQUESTED. Note the
    distinction the evidence turns on: `beginRollback` opens a TRANSACTION, so
    the exit row reads the retained epoch BEFORE the commit. The measured claim
    is about the REQUEST, not the committed outcome.
  * `committedFactKeys.size` at entry and exit -- the dedup ledger.

Usage, from the repository root:
    python3 <this script> apply
    cd server && ISSUE12_SHIP_PROBE=1 npx tsx --test src/services/TerminalAuthorityController.test.ts
    python3 <this script> restore

The replacement asserts its own match count before writing: a replacement that
matches nothing is indistinguishable from one that succeeded.
"""
import sys, hashlib, shutil, os

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
SESSMGR = os.path.join(ROOT, 'server/src/services/SessionManager.ts')
BACKUP = os.path.join(os.path.dirname(__file__), '.backup-shipping')

NEEDLE = """    const controller = this.sessions.get(sessionId)?.terminalAuthorityController;
    return controller
      ? controller.beginRollback(request)
      : { ok: false, reason: 'authority-runtime-unavailable' };
"""

PROBE = """    const controller = this.sessions.get(sessionId)?.terminalAuthorityController;
    if (process.env.ISSUE12_SHIP_PROBE) {
      const r = this.sessions.get(sessionId)?.retainedTerminal;
      const req = request as unknown as { nextStreamEpoch?: string; transitionEpoch?: string };
      console.error('[ISSUE12-SHIP] entry retainedEpoch=%s nextStreamEpoch=%s transitionEpoch=%s ledgerKeys=%d facts=%d hasController=%s',
        r?.streamEpoch, req?.nextStreamEpoch, req?.transitionEpoch, r?.committedFactKeys.size ?? -1, r?.facts.length ?? -1, String(!!controller));
    }
    const outcome = controller
      ? controller.beginRollback(request)
      : { ok: false, reason: 'authority-runtime-unavailable' };
    if (process.env.ISSUE12_SHIP_PROBE) {
      void Promise.resolve(outcome).then(o => {
        const r2 = this.sessions.get(sessionId)?.retainedTerminal;
        console.error('[ISSUE12-SHIP] exit ok=%s reason=%s retainedEpoch=%s ledgerKeys=%d facts=%d',
          String(o?.ok), String(o?.reason), r2?.streamEpoch, r2?.committedFactKeys.size ?? -1, r2?.facts.length ?? -1);
      });
    }
    return outcome;
"""


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def apply_():
    os.makedirs(BACKUP, exist_ok=True)
    shutil.copy2(SESSMGR, os.path.join(BACKUP, 'SessionManager.ts'))
    print('backup SessionManager.ts', sha(SESSMGR))
    s = open(SESSMGR, encoding='utf-8', newline='').read()
    n = s.count(NEEDLE)
    assert n == 1, f'shipping rollback entry: expected 1 match, found {n}'
    open(SESSMGR, 'w', encoding='utf-8', newline='').write(s.replace(NEEDLE, PROBE))
    print('SessionManager.ts patched, match count 1')


def restore():
    shutil.copy2(os.path.join(BACKUP, 'SessionManager.ts'), SESSMGR)
    print('restored SessionManager.ts', sha(SESSMGR))


if __name__ == '__main__':
    {'apply': apply_, 'restore': restore}[sys.argv[1]]()
