#!/usr/bin/env node
// OPS-BGSTAB-024: fails a Linux release build whose native modules ask for a glibc newer than the
// oldest distribution BuilderGate supports (Ubuntu 24.04, glibc 2.39).
//
//   node tools/check-linux-glibc.mjs <file.node> [...]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MAX_GLIBC = '2.39';

/** The highest GLIBC_x.y a binary references, from `objdump -T` output. */
export function highestGlibc(objdumpText) {
  const versions = [...objdumpText.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)].map((match) => match[1]);
  return versions.reduce((highest, version) => (highest === undefined || versionAbove(version, highest) ? version : highest), undefined);
}

/** Whether version a is newer than b, comparing each dotted part as a number. */
export function versionAbove(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function main(files) {
  if (files.length === 0) {
    console.error('usage: node tools/check-linux-glibc.mjs <file.node> [...]');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const highest = highestGlibc(execFileSync('objdump', ['-T', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const tooNew = highest !== undefined && versionAbove(highest, MAX_GLIBC);
    console.log(`${tooNew ? 'FAIL' : 'ok'} ${file}: needs GLIBC ${highest ?? '(none)'} (allowed up to ${MAX_GLIBC})`);
    failed ||= tooNew;
  }
  if (failed) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
