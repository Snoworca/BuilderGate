/**
 * REL-BGSTAB-022 — one place that publishes a JSON store under `server/data/`.
 *
 * Every publisher used to derive its temp path from its destination, which made
 * that path the same string in every process sharing the checkout. Two dev
 * instances therefore collided by construction: measured on 2026-09-16 on
 * Linux/WSL2, 293 of 600 publishes failed `ENOENT` on the rename, a publish
 * could resolve having moved a peer's document into place, and 13-15% of
 * publishes moved a file that did not parse.
 *
 * The fix is one temp path per write. `McpControlConfigStore` and
 * `WebhookInvocationService` already did this by hand; this generalises it and
 * adds the two things a private temp path does not by itself provide: a backup
 * that is published atomically rather than copied in place, and a bounded retry
 * for the destination contention that survives private naming on Windows.
 *
 * What this deliberately does not do is make concurrent publishes agree. Two
 * instances each own a complete snapshot and there is nothing to merge, so the
 * outcome is last-writer-wins over whole documents. What changes is that a
 * publish either puts its own bytes in place or reports failure.
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Rename failures worth retrying. On Windows a rename onto a destination
 * another process holds open is refused with `EPERM`, which a private temp path
 * does not prevent because both instances still rename onto the same
 * destination. `EACCES` and `EBUSY` reach the same situation by other routes.
 *
 * Anything else — `ENOSPC`, `EROFS`, a deleted directory — is permanent, and
 * retrying it only delays the same failure.
 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * One initial attempt plus four retries. The waits are fixed rather than left
 * open because an unspecified budget cannot be tested: an implementation
 * retrying once and one retrying fifty times would both be "bounded". About
 * 150 ms covers a peer's brief hold on the destination without adding a visible
 * stall to bootstrap. It is a starting value, open to revision against a
 * Windows measurement, which does not yet exist.
 */
export const RENAME_RETRY_WAITS_MS: readonly number[] = [10, 20, 40, 80];

export interface AtomicStoreWriteOptions {
  /**
   * Copy the current destination aside before replacing it. Callers that
   * recover from the backup want this; `RecoveryOptionService` turns it off on
   * its recovery paths, and the two stores that never had a backup keep it off.
   */
  writeBackup?: boolean;
  /** File mode for the published document and every temp file on the way there. */
  mode?: number;
  /**
   * Create the destination directory first. Off by default, and deliberately
   * so: `CommandPresetService`, `WorkspaceService`, `TerminalShortcutService`
   * and `RecoveryOptionService` create their directory once in `initialize()`
   * and their publish path does not, which is what lets REL-BGSTAB-020's and
   * REL-BGSTAB-021's boundary controls prove a genuine I/O failure still
   * reaches the caller by pointing the store at a directory that is not there.
   * A helper that always created it would turn those failures into successes
   * and quietly delete the evidence those requirements rest on. The three
   * stores whose own publish path did create it pass true.
   */
  ensureDirectory?: boolean;

  /**
   * Seam for the retry waits. Defaults to a real timer. A test injects a
   * recorder here so the schedule can be asserted exactly instead of through a
   * wall-clock tolerance.
   */
  delay?: (ms: number) => Promise<void>;
}

const realDelay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A temp path no other process can be using: this pid, plus a random suffix. */
function privateTempPath(destination: string): string {
  return `${destination}.${process.pid}.${randomUUID()}.tmp`;
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Rename `from` onto `to`, retrying only the transient codes and only within
 * the fixed budget. An exhausted budget rethrows the last error, leaving the
 * destination as it was.
 */
async function renameWithRetry(
  from: string,
  to: string,
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = errnoOf(error);
      const retriesLeft = attempt < RENAME_RETRY_WAITS_MS.length;
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || !retriesLeft) {
        throw error;
      }
      await delay(RENAME_RETRY_WAITS_MS[attempt]);
    }
  }
}

/**
 * Removes `temp` from the owned list by value. Position is not assumed: a stale
 * entry left here would make a later failure unlink a path this call no longer
 * owns, which is the same class of bug as the shared temp path itself.
 */
function releaseOwnedTemp(ownedTemps: string[], temp: string): void {
  const index = ownedTemps.indexOf(temp);
  if (index !== -1) {
    ownedTemps.splice(index, 1);
  }
}

/**
 * Publishes `contents` at `destination`.
 *
 * The document is written to a temp path only this call knows, the previous
 * destination is copied aside through a temp path of its own and renamed into
 * the backup slot, and the document is then renamed onto the destination. On
 * failure only the temp files this call created are removed — never a path a
 * peer could also be using — and the original error is rethrown for the caller
 * to map.
 *
 * The backup is best-effort by design: if it cannot be written or published the
 * failure is logged at warn level and the primary rename still runs, because
 * that is the contract every store had before this helper existed.
 */
export async function publishStoreAtomically(
  destination: string,
  contents: string,
  options: AtomicStoreWriteOptions = {},
): Promise<void> {
  const { writeBackup = true, mode = 0o600, delay = realDelay, ensureDirectory = false } = options;

  if (ensureDirectory) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
  }

  const payloadTemp = privateTempPath(destination);
  const ownedTemps: string[] = [payloadTemp];

  try {
    await fs.writeFile(payloadTemp, contents, { encoding: 'utf-8', mode });

    if (writeBackup) {
      // A copyFile straight onto the shared `.bak` path is the same defect as
      // the shared temp path: two processes rewriting one file in place can
      // leave it holding bytes from both, and the backup is exactly what
      // recovery reads when the primary will not parse. So the backup is
      // published the same way the store is.
      let previous: string | null = null;
      try {
        previous = await fs.readFile(destination, 'utf-8');
      } catch {
        // No existing store to back up — first run, or it was removed.
      }
      if (previous !== null) {
        const backupTemp = privateTempPath(`${destination}.bak`);
        ownedTemps.push(backupTemp);
        // The backup is optional; the publish is not. Every store used to do
        // `try { await fs.copyFile(dest, bak); } catch {}`, so a backup failure
        // could never stop the primary write, and that contract has to hold
        // here too: on Windows a peer holding the `.bak` open in its own
        // recoverFromBackup() fails this write or this rename while the primary
        // rename would have succeeded, and losing the caller's change to that
        // is strictly worse than losing the backup.
        //
        // What the old code's silence covered was "there is no file to back
        // up", which is the `previous === null` branch above. A backup that was
        // attempted and failed is a different event and is reported.
        try {
          await fs.writeFile(backupTemp, previous, { encoding: 'utf-8', mode });
          await renameWithRetry(backupTemp, `${destination}.bak`, delay);
          // Published: the temp path no longer names a file this call owns, so
          // a later failure must not unlink whatever now sits there.
          releaseOwnedTemp(ownedTemps, backupTemp);
        } catch (backupError) {
          // Same reasoning in the other direction — drop it from the list and
          // clean it up here, so the primary publish's own failure path cannot
          // unlink a path this call has already dealt with.
          releaseOwnedTemp(ownedTemps, backupTemp);
          try {
            await fs.unlink(backupTemp);
          } catch {
            // Never created, or already gone.
          }
          console.warn(
            `[atomicStoreWrite] Backup of ${destination} failed (${errnoOf(backupError) ?? 'no errno'}: ` +
            `${backupError instanceof Error ? backupError.message : String(backupError)}); ` +
            `publishing anyway. The previous document at ${destination}.bak may now be stale.`,
          );
        }
      }
    }

    await renameWithRetry(payloadTemp, destination, delay);
  } catch (error) {
    for (const temp of ownedTemps) {
      try {
        await fs.unlink(temp);
      } catch {
        // Already gone, or never created.
      }
    }
    throw error;
  }
}
