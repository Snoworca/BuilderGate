import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSegmentReparseGuard, captureFrozenProvenance } from './fair-readmission-closure-v3.mjs';
import { reportCleanupFailures } from './fixture-actor-cleanup.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docsRoot = path.join(workspaceRoot, 'docs');
const analysisBase = path.join(docsRoot, 'analysis');
const analysisRoot = path.join(analysisBase, 'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');

// PERF-BGSTAB-010 / SDS-AC-5. Native execution still requires canonical preflight.
export function createOwnedAnalysisLeaf(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9-]+$/.test(prefix)) throw new Error('Invalid owned leaf prefix');
  const manifestPath = path.join(analysisRoot, `.admission-${prefix}-${process.pid}-${randomUUID()}.json`);
  if (path.dirname(manifestPath) !== analysisRoot) throw new Error('Owned leaf escaped analysis parent');
  const guard = createSegmentReparseGuard();
  let attempted = false, retired = false, identity;

  function checkPaths() {
    if (path.dirname(manifestPath) !== analysisRoot) throw new Error('Owned leaf escaped analysis parent');
    guard.assertSafeMany([workspaceRoot, docsRoot, analysisBase, analysisRoot, manifestPath], { forceFresh: true });
    for (const directory of [workspaceRoot, docsRoot, analysisBase]) {
      if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) {
        throw new Error(`Required canonical directory is absent or invalid: ${directory}`);
      }
    }
    if (fs.existsSync(analysisRoot) && !fs.lstatSync(analysisRoot).isDirectory()) {
      throw new Error(`Analysis parent is not a directory: ${analysisRoot}`);
    }
  }

  function begin() {
    if (attempted || retired) throw new Error(`Owned leaf capability already used: ${manifestPath}`);
    attempted = true;
    checkPaths();
    if (fs.existsSync(manifestPath)) throw new Error(`Owned leaf collision: ${manifestPath}`);
    if (!fs.existsSync(analysisRoot)) fs.mkdirSync(analysisRoot, { recursive: true });
    // Parent creation changes the frontier; repeat native admission before leaf mutation.
    checkPaths();
  }

  function identify(role) {
    const stat = fs.lstatSync(manifestPath, { bigint: true });
    if (stat.isSymbolicLink() || stat.isReparsePoint?.()
        || (role === 'file' ? !stat.isFile() : !stat.isDirectory())
        || ['dev', 'ino', 'birthtimeNs'].some(key => typeof stat[key] !== 'bigint')) {
      throw new Error(`Owned leaf role or identity is unconfirmed: ${manifestPath}`);
    }
    return { role, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
  }

  function capture(phase) {
    begin();
    const manifest = captureFrozenProvenance({ workspaceRoot, manifestPath, phase });
    identity = identify('file');
    return manifest;
  }

  function createDirectory() {
    begin();
    fs.mkdirSync(manifestPath);
    identity = identify('directory');
  }

  function createFile(text) {
    if (typeof text !== 'string') throw new Error('Owned fixture contents must be a UTF-8 string');
    begin();
    fs.writeFileSync(manifestPath, text, { encoding: 'utf8', flag: 'wx' });
    identity = identify('file');
  }

  function removeOwned() {
    if (retired) return;
    checkPaths();
    if (!fs.existsSync(manifestPath)) {
      identity = undefined;
      retired = true;
      return;
    }
    if (!identity) throw new Error(`Preserved unconfirmed leaf: ${manifestPath}`);
    const current = identify(identity.role);
    if (['dev', 'ino', 'birthtimeNs'].some(key => current[key] !== identity[key])) {
      throw new Error(`Preserved replaced owned leaf: ${manifestPath}`);
    }
    if (identity.role === 'directory') {
      if (fs.readdirSync(manifestPath).length !== 0) throw new Error(`Preserved nonempty owned directory: ${manifestPath}`);
      fs.rmdirSync(manifestPath);
    } else {
      fs.unlinkSync(manifestPath);
    }
    identity = undefined;
    retired = true;
  }

  function cleanup(priorFailure) {
    const failures = priorFailure === undefined ? [] : [priorFailure.error];
    try { removeOwned(); } catch (error) { failures.push(error); }
    reportCleanupFailures(failures, 'Admission fixture cleanup failed');
  }

  return Object.freeze({ workspaceRoot, manifestPath, capture, createDirectory, createFile, cleanup });
}
