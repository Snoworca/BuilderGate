#!/usr/bin/env python3
"""Inject ISSUE12_PROBE-gated diagnostics into two production files.

Every replacement asserts its own match count before writing: a replacement that
matches nothing is indistinguishable from one that succeeded (standing brief).
Run `restore` to put the files back byte-identically.
"""
import sys, hashlib, shutil, os

SERVER = os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'server')
WSROUTER = os.path.normpath(os.path.join(SERVER, 'src/ws/WsRouter.ts'))
SESSMGR = os.path.normpath(os.path.join(SERVER, 'src/services/SessionManager.ts'))
BACKUP = os.path.join(os.path.dirname(__file__), '.backup')

MODE_NEEDLE = """    const mode = snapshot.health === 'healthy' && !(snapshot.truncated && snapshot.data.length === 0)
      ? 'authoritative'
      : 'fallback';
"""
MODE_PROBE = MODE_NEEDLE + """    if (process.env.ISSUE12_PROBE) { console.error('[ISSUE12] site=%s mode=%s health=%s truncated=%s dataLen=%d', 'SITE', mode, snapshot.health, snapshot.truncated, snapshot.data.length); }
"""

ATOMIC_NEEDLE = """    const data = this.sessions.get(sessionId);
    if (!data || data.headlessHealth !== 'healthy' || !data.headless) {
      return { ok: false, reason: 'headless-degraded' };
    }
    if (data.headlessApplyInFlight > 0) {
"""
ATOMIC_PROBE = """    const data = this.sessions.get(sessionId);
    if (process.env.ISSUE12_PROBE) { console.error('[ISSUE12-SM] atomic sid=%s hasData=%s health=%s hasHeadless=%s inFlight=%s tailOverflow=%s', sessionId, !!data, data?.headlessHealth, !!data?.headless, data?.headlessApplyInFlight, data?.parserTailOverflow); }
    if (!data || data.headlessHealth !== 'healthy' || !data.headless) {
      return { ok: false, reason: 'headless-degraded' };
    }
    if (data.headlessApplyInFlight > 0) {
"""

DEG_NEEDLE = """    const message = error instanceof Error ? error.message : String(error);
    this.captureDebugEvent(sessionId, 'headless', 'headless_degraded', {
      phase,"""
DEG_PROBE = """    const message = error instanceof Error ? error.message : String(error);
    if (process.env.ISSUE12_PROBE) { console.error('[ISSUE12-DEG] sid=%s phase=%s err=%s', sessionId, phase, (error instanceof Error ? error.stack : String(error))); }
    this.captureDebugEvent(sessionId, 'headless', 'headless_degraded', {
      phase,"""


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def apply_():
    os.makedirs(BACKUP, exist_ok=True)
    for p in (WSROUTER, SESSMGR):
        shutil.copy2(p, os.path.join(BACKUP, os.path.basename(p)))
        print('backup', os.path.basename(p), sha(p))
    s = open(WSROUTER, encoding='utf-8', newline='').read()
    n = s.count(MODE_NEEDLE)
    assert n == 2, f'WsRouter mode sites: expected 2, found {n}'
    a, b, c = s.split(MODE_NEEDLE)
    open(WSROUTER, 'w', encoding='utf-8', newline='').write(
        a + MODE_PROBE.replace("'SITE'", "'A5053'") + b + MODE_PROBE.replace("'SITE'", "'B5362'") + c)
    print('WsRouter.ts patched, match count 2')
    s = open(SESSMGR, encoding='utf-8', newline='').read()
    for label, needle, probe in (('atomic', ATOMIC_NEEDLE, ATOMIC_PROBE), ('degrade', DEG_NEEDLE, DEG_PROBE)):
        n = s.count(needle)
        assert n == 1, f'SessionManager {label}: expected 1, found {n}'
        s = s.replace(needle, probe)
    open(SESSMGR, 'w', encoding='utf-8', newline='').write(s)
    print('SessionManager.ts patched, match counts 1 and 1')


def restore():
    for p in (WSROUTER, SESSMGR):
        shutil.copy2(os.path.join(BACKUP, os.path.basename(p)), p)
        print('restored', os.path.basename(p), sha(p))


if __name__ == '__main__':
    {'apply': apply_, 'restore': restore}[sys.argv[1]]()
