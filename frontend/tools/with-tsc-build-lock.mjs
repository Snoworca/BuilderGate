#!/usr/bin/env node
// #55: run one command while holding the tsc build lock (see tscBuildLock.mjs).
import { spawn } from 'node:child_process';
import { acquireTscBuildLock } from './tscBuildLock.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) { console.error('usage: with-tsc-build-lock <command> [args...]'); process.exit(2); }

const release = await acquireTscBuildLock({ label: `${command} ${args.join(' ')}`.trim() });
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  process.exitCode = code;
} finally {
  release();
}
