import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import nodePtyUtils from 'node-pty/lib/utils.js';

/**
 * OPS-BGSTAB-017 AC-7: make node-pty's macOS spawn-helper executable.
 *
 * On macOS node-pty starts every PTY by posix_spawn-ing
 * `prebuilds/darwin-<arch>/spawn-helper` (src/unix/pty.cc, `__APPLE__`), and
 * the path it passes is computed once from node-pty's own __dirname. Two things
 * make that file unexecutable, and either one fails every session with
 * `posix_spawnp failed.`:
 *
 * - node-pty 1.1.0 publishes the helper as -rw-r--r--, so a plain `npm ci`
 *   checkout cannot spawn.
 * - In the pkg executable the path is `/snapshot/...`, which exists only in the
 *   executable's virtual filesystem; no execute bit can make the kernel run it.
 *
 * The helper path is a module-level constant inside node-pty, so it is fixed at
 * the one place it is consumed: the native `fork` call. Patching node-pty's
 * files instead would be undone by every `npm ci` while an existing `dist/`
 * keeps starting without a rebuild.
 *
 * Windows (ConPTY/winpty) and Linux (direct fork) have no helper; everything
 * here is a no-op off macOS.
 */

export interface SpawnHelperFs {
  accessSync: typeof fs.accessSync;
  chmodSync: typeof fs.chmodSync;
  readFileSync: typeof fs.readFileSync;
  writeFileSync: typeof fs.writeFileSync;
  renameSync: typeof fs.renameSync;
  mkdirSync: typeof fs.mkdirSync;
  existsSync: typeof fs.existsSync;
}

export interface ResolveSpawnHelperOptions {
  platform?: NodeJS.Platform;
  /** Where an executable copy is written when the original cannot be made executable. */
  cacheDir?: string;
  fs?: Partial<SpawnHelperFs>;
}

const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'buildergate-node-pty');
const resolvedHelpers = new Map<string, string>();

function isSnapshotPath(file: string): boolean {
  return /^(?:[A-Za-z]:)?[\\/]snapshot[\\/]/.test(file);
}

function canExecute(io: SpawnHelperFs, file: string): boolean {
  try {
    io.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function materializeExecutableCopy(io: SpawnHelperFs, helperPath: string, cacheDir: string): string {
  const contents = io.readFileSync(helperPath);
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const target = path.join(cacheDir, digest, path.basename(helperPath));
  if (io.existsSync(target) && canExecute(io, target)) {
    return target;
  }
  io.mkdirSync(path.dirname(target), { recursive: true });
  const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
  io.writeFileSync(staging, contents, { mode: 0o755 });
  io.chmodSync(staging, 0o755);
  io.renameSync(staging, target);
  return target;
}

/**
 * Return a path to an executable copy of `helperPath`: the file itself when it
 * is (or can be made) executable, otherwise a content-keyed copy under
 * `cacheDir`. On any failure the original path comes back, so node-pty still
 * reports its own error.
 */
export function resolveExecutableSpawnHelper(helperPath: string, options: ResolveSpawnHelperOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return helperPath;
  }
  const io: SpawnHelperFs = {
    accessSync: fs.accessSync,
    chmodSync: fs.chmodSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    mkdirSync: fs.mkdirSync,
    existsSync: fs.existsSync,
    ...options.fs,
  };
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const memoKey = `${cacheDir}\0${helperPath}`;
  const memo = resolvedHelpers.get(memoKey);
  // Re-checked on every spawn: macOS periodically cleans the temp directory.
  if (memo && io.existsSync(memo) && canExecute(io, memo)) {
    return memo;
  }

  let resolved = helperPath;
  try {
    if (isSnapshotPath(helperPath)) {
      resolved = materializeExecutableCopy(io, helperPath, cacheDir);
    } else if (!io.existsSync(helperPath)) {
      return helperPath;
    } else if (!canExecute(io, helperPath)) {
      try {
        io.chmodSync(helperPath, 0o755);
      } catch {
        // Read-only installation; fall through to a copy.
      }
      if (!canExecute(io, helperPath)) {
        resolved = materializeExecutableCopy(io, helperPath, cacheDir);
      }
    }
  } catch (error) {
    console.warn(`[node-pty] could not prepare an executable spawn-helper from ${helperPath}: ${
      error instanceof Error ? error.message : String(error)}`);
    return helperPath;
  }
  resolvedHelpers.set(memoKey, resolved);
  return resolved;
}

interface NativePtyModule {
  fork: (...args: unknown[]) => unknown;
}

export interface InstallSpawnHelperGuardOptions {
  platform?: NodeJS.Platform;
  /** node-pty's native addon exports; loaded the way node-pty itself loads them when omitted. */
  nativeModule?: NativePtyModule;
  resolve?: (helperPath: string) => string;
}

const GUARDED = Symbol.for('buildergate.nodePtySpawnHelperGuard');
/** Index of `helperPath` in node-pty 1.1.0's `pty.fork(...)` call (lib/unixTerminal.js). */
const HELPER_ARG_INDEX = 9;

/**
 * Wrap node-pty's native `fork` so its helper argument always names an
 * executable file. Returns true when the guard was installed by this call.
 */
export function installNodePtySpawnHelperGuard(options: InstallSpawnHelperGuardOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return false;
  }
  const native = options.nativeModule
    ?? (nodePtyUtils.loadNativeModule('pty').module as NativePtyModule);
  const original = native.fork as NativePtyModule['fork'] & { [GUARDED]?: true };
  if (typeof original !== 'function' || original[GUARDED]) {
    return false;
  }
  const resolve = options.resolve ?? ((helperPath: string) => resolveExecutableSpawnHelper(helperPath));
  const guarded = function guardedFork(this: unknown, ...args: unknown[]): unknown {
    if (typeof args[HELPER_ARG_INDEX] === 'string') {
      args[HELPER_ARG_INDEX] = resolve(args[HELPER_ARG_INDEX] as string);
    }
    return original.apply(this, args);
  } as NativePtyModule['fork'] & { [GUARDED]?: true };
  guarded[GUARDED] = true;
  native.fork = guarded;
  return true;
}
