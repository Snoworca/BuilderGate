const path = require('path');
const { resolveRuntimePaths } = require('./tools/daemon/runtime-paths');
const { readState } = require('./tools/daemon/state-store');
const { stopDaemon } = require('./tools/daemon/stop-client');

// Issue #50: stop had no way to say WHICH daemon to stop. It read the target out of the state
// file, and the state file's location came from an inherited BUILDERGATE_ROOT. So a shell whose
// environment pointed at the installed copy would stop the OPERATING daemon -- the one holding
// TCP 2001/2002 -- while the caller believed they were stopping their own checkout, and the
// identity check could not save them, because the operating daemon is also a valid BuilderGate
// app. The check passed and the wrong thing stopped.
//
// Two scopes are added, and neither of them replaces the other:
//
//   --port <n>   refuse unless the recorded daemon port is that port. This is the scope a
//                caller can state from memory, and it is checked against the state file rather
//                than against the environment that chose the state file.
//   --root <dir> choose the state file explicitly instead of inheriting it.
//
// And the default changed: when the resolved root is not this checkout, stop refuses rather
// than proceeding. Inheriting a foreign root is exactly the condition that made this dangerous,
// so it now has to be said out loud with --root or --allow-foreign-root.
const CHECKOUT_ROOT = path.resolve(__dirname);

function usage(executable = 'stop') {
  return [
    `Usage: ${executable} [--port <n>] [--root <dir>] [--allow-foreign-root]`,
    '',
    '  --port <n>            Stop only if the recorded daemon port is <n>.',
    '  --root <dir>          Use <dir> as the BuilderGate root instead of the inherited one.',
    '  --allow-foreign-root  Proceed even though the resolved root is not this checkout.',
    '  -h, --help            Print this message.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { port: null, root: null, allowForeignRoot: false, help: false, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') { parsed.help = true; continue; }
    if (argument === '--allow-foreign-root') { parsed.allowForeignRoot = true; continue; }
    if (argument === '--port' || argument === '-p') {
      const value = argv[index += 1];
      const port = Number.parseInt(value ?? '', 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        parsed.error = `--port needs a port number, got ${value === undefined ? '<nothing>' : value}`;
        return parsed;
      }
      parsed.port = port;
      continue;
    }
    if (argument === '--root') {
      const value = argv[index += 1];
      if (!value) { parsed.error = '--root needs a directory'; return parsed; }
      parsed.root = path.resolve(value);
      continue;
    }
    parsed.error = `Unknown argument: ${argument}`;
    return parsed;
  }
  return parsed;
}

async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  const parsed = parseArgs(argv);

  if (parsed.error) { logError(`[stop] ${parsed.error}\n\n${usage()}`); return 2; }
  if (parsed.help) { log(usage()); return 0; }

  const paths = options.paths ?? resolveRuntimePaths({
    ...options.runtimePathOptions,
    env: parsed.root ? { ...env, BUILDERGATE_ROOT: parsed.root } : env,
  });

  // A root the caller did not name and that is not this checkout is the dangerous case: it was
  // inherited from the environment and it points somewhere else -- in this project's history,
  // at the installed copy running on TCP 2001/2002. A root that WAS named -- by --root, or by a
  // caller handing in `paths` directly -- is a stated target, not an inherited one, so it is not
  // what this guard is about.
  const checkoutRoot = options.checkoutRoot ?? CHECKOUT_ROOT;
  const rootWasNamed = Boolean(parsed.root) || Boolean(options.paths);
  if (!rootWasNamed && !parsed.allowForeignRoot && path.resolve(paths.root) !== checkoutRoot) {
    logError(
      `[stop] Refusing to stop a daemon outside this checkout.\n`
      + `         resolved root: ${paths.root}\n`
      + `         this checkout: ${checkoutRoot}\n`
      + `         state file:    ${paths.statePath}\n`
      + `       The root came from the environment (BUILDERGATE_ROOT), not from you. If that is\n`
      + `       really the daemon you mean, say so with --root <dir> or --allow-foreign-root.`,
    );
    return 2;
  }

  if (parsed.port !== null) {
    const state = (options.readState ?? readState)(paths.statePath);
    const recordedPort = state && typeof state.port === 'number' ? state.port : null;
    if (recordedPort !== parsed.port) {
      logError(
        `[stop] Refusing to stop: the daemon on record is not on port ${parsed.port}.\n`
        + `         recorded port: ${recordedPort === null ? '<none>' : recordedPort}\n`
        + `         state file:    ${paths.statePath}`,
      );
      return 2;
    }
  }

  const result = await stopDaemon(paths, options);

  if (result.message) {
    (result.exitCode === 0 ? log : logError)(result.message);
  }

  return result.exitCode;
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error('[stop] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
  usage,
};
