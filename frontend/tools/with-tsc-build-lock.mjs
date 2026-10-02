#!/usr/bin/env node
// #55: run one command while holding the tsc build lock (see tscBuildLock.mjs).
import { spawn } from 'node:child_process';
import { acquireTscBuildLock } from './tscBuildLock.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) { console.error('usage: with-tsc-build-lock <command> [args...]'); process.exit(2); }

const release = await acquireTscBuildLock({ label: `${command} ${args.join(' ')}`.trim() });
try {
  const code = await new Promise((resolve, reject) => {
    // On Windows the shell resolves .cmd shims, but it also joins the arguments with spaces,
    // so an argument containing a space ('C:\Program Files\nodejs\node.exe') or a quote has
    // to be quoted here or cmd splits it.
    const shell = process.platform === 'win32';
    const quote = (arg) => (shell && /[\s"]/u.test(arg) ? `"${arg.replace(/"/gu, '\\"')}"` : arg);
    const child = spawn(quote(command), args.map(quote), { stdio: 'inherit', shell });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  process.exitCode = code;
} finally {
  release();
}
