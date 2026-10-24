/**
 * PERF-GIT-001: a local benchmark of the git viewer's server side. Not a test: it prints one
 * JSON object of measurements. Run on Windows from server/:
 *
 *   npx tsx src/benchmarks/gitSummaryBench.ts [--commits 50000] [--files 10000] [--no-wsl]
 *
 * It builds a repository of the given size with git fast-import (in the OS temp folder and,
 * unless --no-wsl, in /tmp of the default WSL distro), then measures through GitService:
 *   - summary p50/p95. One service, as on the server, with a clock moved a minute ahead before
 *     each call so no time-based reuse (1 s summary, 10 s repository, 30 s base ref) hides
 *     the cost; the remembered WSL path conversions stay, as they do on the server
 *   - chip click → first diff: with the chip's summary in hand, log and status at once (as the
 *     window asks), then the first file's diff
 *   - one wsl.exe call (wsl.exe -e true)
 *   - load: 6 sessions × 2 clients polling every 3 s for 30 s: event loop delay p99,
 *     the server's own CPU, and the time git processes were running (an upper bound of
 *     git's CPU, since child CPU is not visible to the process)
 * Both repositories are removed at the end.
 *
 * @req PERF-GIT-001
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { GitService } from '../services/git/GitService.js';
import { createGitRunner, type RunGit } from '../services/git/gitRunner.js';
import { createRepoWatcher } from '../services/git/gitRepoWatcher.js';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const COMMITS = arg('--commits', 50_000);
const FILES = arg('--files', 10_000);
const WITH_WSL = !process.argv.includes('--no-wsl') && process.platform === 'win32';
const WSL_DIR = '/tmp/buildergate-gitbench';

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] * 10) / 10;
}
const stats = (v: number[]) => ({ n: v.length, p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: quantile(v, 1) });

/** A fast-import stream: one commit adding every file, then commits changing one file each. */
function importStream(commits: number, files: number): string {
  const out: string[] = [];
  const at = 1_700_000_000;
  const who = (t: number) => `bench <bench@example.invalid> ${t} +0000`;
  out.push('commit refs/heads/main', `committer ${who(at)}`, 'data 4', 'init');
  for (let i = 0; i < files; i += 1) {
    const body = `file ${i}\n`;
    out.push(`M 100644 inline src/d${i % 100}/f${i}.txt`, `data ${Buffer.byteLength(body)}`, body.slice(0, -1));
  }
  for (let c = 1; c < commits; c += 1) {
    const msg = `change ${c}`;
    const body = `file ${c % files} rev ${c}\n`;
    out.push(`commit refs/heads/main`, `committer ${who(at + c)}`, `data ${msg.length}`, msg);
    out.push(`M 100644 inline src/d${(c % files) % 100}/f${c % files}.txt`, `data ${Buffer.byteLength(body)}`, body.slice(0, -1));
  }
  return out.join('\n') + '\n';
}

function buildNative(stream: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-gitbench-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.autocrlf=false', ...a], { stdio: ['pipe', 'ignore', 'inherit'], maxBuffer: 1 << 30 });
  git('init', '-q', '-b', 'main');
  execFileSync('git', ['-C', dir, 'fast-import', '--quiet'], { input: stream, stdio: ['pipe', 'ignore', 'inherit'], maxBuffer: 1 << 30 });
  git('checkout', '-q', '-f', 'main');
  return dir;
}

function buildWsl(stream: string): void {
  const script = `rm -rf ${WSL_DIR} && mkdir -p ${WSL_DIR} && cd ${WSL_DIR} && git init -q -b main && git fast-import --quiet && git -c core.autocrlf=false checkout -q -f main`;
  const r = spawnSync('wsl.exe', ['-e', 'sh', '-c', script], { input: stream, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`WSL repository build failed: ${r.stderr?.toString()}`);
}

/** Leaves three changed files and one untracked file, as an agent at work would. */
function dirty(write: (rel: string, text: string) => void): void {
  for (const i of [3, 4, 5]) write(`src/d${i}/f${i}.txt`, `file ${i} edited\n`);
  write('untracked.txt', 'new\n');
}

function service(cwd: string, launch: string, runGit?: RunGit, now?: () => number) {
  return new GitService({
    sessions: { getLastCwd: () => cwd, getSessionLaunchCommand: () => launch },
    runGit: runGit ?? createGitRunner(),
    listSessionIds: () => ['s1', 's2', 's3', 's4', 's5', 's6'],
    now,
    watchRepo: createRepoWatcher(), // as on the server; the cold clock below outruns its 30 s
  });
}

/** A service whose clock jumps a minute per tick(), so every time-based reuse has expired. */
function coldService(cwd: string, launch: string) {
  let skew = 0;
  const s = service(cwd, launch, undefined, () => Date.now() + skew);
  return { s, tick: () => { skew += 61_000; } };
}

async function measureSummary(cwd: string, launch: string, n: number): Promise<number[]> {
  const out: number[] = [];
  const { s, tick } = coldService(cwd, launch);
  await s.summary('s1'); // warm the OS file cache and the path conversions
  for (let i = 0; i < n; i += 1) {
    tick();
    const t0 = performance.now();
    await s.summary('s1');
    out.push(performance.now() - t0);
  }
  return out;
}

async function measureFirstDiff(cwd: string, launch: string, n: number): Promise<number[]> {
  const out: number[] = [];
  const { s, tick } = coldService(cwd, launch);
  for (let i = 0; i < n; i += 1) {
    tick();
    await s.summary('s1'); // the chip already holds the summary when it is clicked
    const t0 = performance.now();
    // The window asks for the list and the uncommitted files at once, then the first file's diff.
    const [, st] = await Promise.all([s.log('s1', { scope: 'head' }), s.status('s1')]);
    const f = st.files[0];
    if (f) await s.diff('s1', { src: f.area === 'untracked' ? 'untracked' : f.area === 'staged' ? 'staged' : 'unstaged', path: f.path });
    out.push(performance.now() - t0);
  }
  return out;
}

async function measureWslCall(n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    await new Promise<void>((resolve, reject) => {
      const p = spawn('wsl.exe', ['-e', 'true'], { stdio: 'ignore', windowsHide: true });
      p.on('error', reject);
      p.on('exit', () => resolve());
    });
    out.push(performance.now() - t0);
  }
  return out;
}

async function measureLoad(cwd: string, launch: string, seconds: number) {
  let gitBusyMs = 0;
  const base = createGitRunner();
  const timed = (async (...a: Parameters<RunGit>) => {
    const t0 = performance.now();
    try { return await base(...a); } finally { gitBusyMs += performance.now() - t0; }
  }) as RunGit;
  const shared = service(cwd, launch, timed);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const inflight: Promise<unknown>[] = [];
  for (let round = 0; round * 3 < seconds; round += 1) {
    for (let client = 0; client < 2; client += 1) {
      for (let s = 1; s <= 6; s += 1) inflight.push(shared.summary(`s${s}`).catch(() => {}));
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await Promise.all(inflight);
  const wall = performance.now() - t0;
  delay.disable();
  const cpu = process.cpuUsage(cpu0);
  return {
    seconds: Math.round(wall / 100) / 10,
    eventLoopDelayP99Ms: Math.round(delay.percentile(99) / 1e5) / 10,
    serverCpuPctOfCore: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 1000) / 10,
    gitBusyPctOfWall: Math.round((gitBusyMs / wall) * 1000) / 10,
  };
}

async function main() {
  const t0 = performance.now();
  const stream = importStream(COMMITS, FILES);
  const native = buildNative(stream);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  dirty((rel, text) => { const p = path.join(native, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); });
  const result: Record<string, unknown> = { commits: COMMITS, files: FILES, platform: process.platform, buildSeconds: 0 };
  try {
    if (WITH_WSL) {
      buildWsl(stream);
      const sh = (cmd: string) => spawnSync('wsl.exe', ['-e', 'sh', '-c', cmd]);
      dirty((rel, text) => sh(`printf '%s' '${text}' > ${WSL_DIR}/${rel}`));
    }
    result.buildSeconds = Math.round((performance.now() - t0) / 100) / 10;
    result.windowsSummaryMs = stats(await measureSummary(native, 'powershell.exe', 30));
    result.windowsFirstDiffMs = stats(await measureFirstDiff(native, 'powershell.exe', 20));
    if (WITH_WSL) {
      result.wslExeCallMs = stats(await measureWslCall(20));
      result.wslSummaryMs = stats(await measureSummary(WSL_DIR, 'wsl.exe', 30));
      result.wslFirstDiffMs = stats(await measureFirstDiff(WSL_DIR, 'wsl.exe', 20));
    }
    result.load = await measureLoad(native, 'powershell.exe', 30);
  } finally {
    rmSync(native, { recursive: true, force: true });
    if (WITH_WSL) spawnSync('wsl.exe', ['-e', 'rm', '-rf', WSL_DIR]);
  }
  console.log(JSON.stringify(result, null, 2));
}

void main().catch((e) => { console.error(e); process.exitCode = 1; });
