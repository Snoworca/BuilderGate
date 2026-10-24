/**
 * A resident git helper inside a WSL distribution (PERF-GIT-001 AC-9).
 *
 * Starting wsl.exe costs ~360 ms (p50) and up to 1.6 s (p95) on the measured host, and a WSL
 * session used to start one per git command. The helper is one wsl.exe running a small Perl
 * loop (perl-base is part of every Debian/Ubuntu install). It reads length-prefixed frames on
 * stdin, runs `git` with exactly those arguments through exec (no shell, so no argument is
 * ever interpreted), and writes back the exit code, stdout and stderr.
 *
 * A command that runs past its time limit kills that helper; the next command starts a new one.
 * A helper that cannot start (no Perl, distribution missing, no answer in 15 s) marks the
 * distribution unavailable for a minute, and the caller uses one wsl.exe per command meanwhile.
 *
 * Frames are big-endian uint32 lengths. Request: count, then (length, bytes) per argument.
 * Response: exit code, stdout (length, bytes), stderr (length, bytes).
 *
 * @req PERF-GIT-001
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const HELPER_SCRIPT = String.raw`
use strict; use warnings;
$| = 1; binmode STDIN; binmode STDOUT;
$ENV{LC_ALL} = 'C'; $ENV{GIT_TERMINAL_PROMPT} = '0';
sub rd { my ($n) = @_; my $b = ''; while (length($b) < $n) { my $r = read(STDIN, $b, $n - length($b), length($b)); return undef unless $r; } return $b; }
print STDOUT "BGOK";
while (defined(my $h = rd(4))) {
  my $argc = unpack('N', $h); my @a;
  for (1 .. $argc) { my $l = unpack('N', rd(4)); push @a, ($l ? rd($l) : ''); }
  pipe(my $or, my $ow) or die; pipe(my $er, my $ew) or die;
  my $pid = fork();
  if (!$pid) {
    close $or; close $er;
    open(STDIN, '<', '/dev/null'); open(STDOUT, '>&', $ow); open(STDERR, '>&', $ew);
    exec { 'git' } 'git', @a;
    print STDERR "git: command not found\n"; exit 127;
  }
  close $ow; close $ew;
  my ($out, $err) = ('', ''); my %open = (fileno($or) => $or, fileno($er) => $er);
  while (%open) {
    my $rin = ''; vec($rin, $_, 1) = 1 for keys %open;
    select(my $rout = $rin, undef, undef, undef);
    for my $fd (keys %open) {
      next unless vec($rout, $fd, 1);
      my $n = sysread($open{$fd}, my $buf, 65536);
      if (!$n) { delete $open{$fd}; next; }
      if ($fd == fileno($or)) { $out .= $buf } else { $err .= $buf }
    }
  }
  waitpid($pid, 0);
  my $code = ($? & 127) ? 128 + ($? & 127) : ($? >> 8);
  print STDOUT pack('N', $code), pack('N', length $out), $out, pack('N', length $err), $err;
}
`;

export interface WslHelperRunOptions {
  timeout: number;
  maxBuffer: number;
  encoding: 'utf8' | 'buffer';
}

export interface WslGitHelper {
  /** Runs git with these arguments in the distribution (undefined: the default one). */
  run(distro: string | undefined, gitArgs: readonly string[], options: WslHelperRunOptions): Promise<{ stdout: string | Buffer }>;
  /** False once the distribution's helper could not start: use one wsl.exe per command. */
  available(distro: string | undefined): boolean;
  close(): void;
}

interface Job {
  frame: Buffer;
  options: WslHelperRunOptions;
  resolve: (v: { stdout: string | Buffer }) => void;
  reject: (e: unknown) => void;
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };

function encode(args: readonly string[]): Buffer {
  const parts = [u32(args.length)];
  for (const arg of args) { const bytes = Buffer.from(arg, 'utf8'); parts.push(u32(bytes.length), bytes); }
  return Buffer.concat(parts);
}

/** One wsl.exe + Perl loop, one command at a time. */
class HelperProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** Received bytes, joined only when a whole header or frame is there (no copy per chunk). */
  private chunks: Buffer[] = [];
  private received = 0;
  private ready = false;
  private queue: Job[] = [];
  private current: Job | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  dead = false;

  constructor(
    private readonly distro: string | undefined,
    private readonly settings: { interpreter: string; script: string; startTimeoutMs: number },
    private readonly onLaunch: () => void,
    private readonly onFailedStart: () => void,
    /** Commands still queued when this helper died for another reason: run them elsewhere. */
    private readonly onOrphans: (jobs: Job[]) => void,
  ) {}

  busy(): number { return this.queue.length + (this.current ? 1 : 0); }

  enqueue(job: Job): void {
    this.queue.push(job);
    if (!this.child) this.start();
    this.pump();
    this.hold();
  }

  /** The helper keeps the process alive only while it has commands, like the git workers. */
  private hold(): void {
    const child = this.child;
    if (!child) return;
    const busy = this.busy() > 0;
    for (const h of [child, child.stdin, child.stdout, child.stderr] as Array<{ ref?: () => void; unref?: () => void }>) {
      if (busy) h.ref?.(); else h.unref?.();
    }
  }

  private start(): void {
    this.onLaunch();
    const args = [...(this.distro ? ['-d', this.distro] : []), '-e', this.settings.interpreter, '-e', this.settings.script];
    const child = spawn('wsl.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    // A distribution that hangs while booting must not hold the commands forever.
    this.timer = setTimeout(() => this.fail(new Error('wsl helper did not start in time'), true), this.settings.startTimeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { this.chunks.push(chunk); this.received += chunk.length; this.drain(); });
    child.stderr.on('data', () => {});
    // Without these a write after the helper died (EPIPE) would be an uncaught error.
    child.stdin.on('error', (err) => this.fail(err, !this.ready));
    child.on('error', (err) => this.fail(err, !this.ready));
    child.on('exit', () => this.fail(new Error('wsl helper exited'), !this.ready));
  }

  private pump(): void {
    if (!this.ready || this.current || !this.child) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    this.timer = setTimeout(() => {
      // Past the time limit: this helper is abandoned; the next command starts a new one.
      this.fail(Object.assign(new Error('git timed out'), { killed: true, code: 'ETIMEDOUT' }), false);
    }, job.options.timeout);
    this.child.stdin.write(job.frame);
  }

  /** The first `n` received bytes as one buffer, or null while fewer have arrived. */
  private head(n: number): Buffer | null {
    if (this.received < n) return null;
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks, this.received)];
    return this.chunks[0];
  }

  private consume(n: number): void {
    this.chunks = [this.chunks[0].subarray(n), ...this.chunks.slice(1)].filter((c) => c.length);
    this.received -= n;
  }

  private drain(): void {
    if (!this.ready) {
      const hello = this.head(4);
      if (!hello) return;
      if (hello.subarray(0, 4).toString('latin1') !== 'BGOK') { this.fail(new Error('wsl helper did not start'), true); return; }
      this.consume(4);
      this.ready = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.pump();
    }
    while (this.current) {
      const header = this.head(8);
      if (!header) return;
      const outLen = header.readUInt32BE(4);
      if (outLen > this.current.options.maxBuffer) {
        // Too large for the caller anyway: stop reading it. The helper is replaced.
        this.fail(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), false);
        return;
      }
      const withErrLen = this.head(8 + outLen + 4);
      if (!withErrLen) return;
      const errLen = withErrLen.readUInt32BE(8 + outLen);
      const total = 12 + outLen + errLen;
      const b = this.head(total);
      if (!b) return;
      const code = b.readUInt32BE(0);
      const stdout = b.subarray(8, 8 + outLen);
      const stderr = b.subarray(12 + outLen, total).toString('utf8');
      this.consume(total);
      const job = this.current;
      this.current = null;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (code !== 0) {
        job.reject(Object.assign(new Error(`git exited with ${code}: ${stderr.split('\n')[0]}`), { code, stderr }));
      } else if (stdout.length > job.options.maxBuffer) {
        job.reject(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr }));
      } else {
        job.resolve({ stdout: job.options.encoding === 'buffer' ? Buffer.from(stdout) : stdout.toString('utf8') });
      }
      this.pump();
      this.hold();
    }
  }

  /**
   * Ends this helper once. The running command gets the error. Queued commands get it too when
   * the helper never started (the caller falls back to one wsl.exe per command); otherwise they
   * move to another helper, so a timeout never strands them.
   */
  fail(err: Error, failedStart: boolean): void {
    if (this.dead) return;
    this.dead = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const current = this.current;
    const queued = this.queue;
    this.current = null;
    this.queue = [];
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
    current?.reject(err);
    if (failedStart) {
      for (const job of queued) job.reject(err);
      this.onFailedStart();
    } else if (queued.length) {
      this.onOrphans(queued);
    }
  }
}

export interface WslGitHelperOptions {
  size?: number;
  interpreter?: string;
  onLaunch?: () => void;
  /** Tests only: the program the interpreter runs. */
  script?: string;
  startTimeoutMs?: number;
  /** After a failed start, the distribution uses one wsl.exe per command this long, then tries again. */
  retryAfterMs?: number;
  now?: () => number;
}

export function createWslGitHelper(options: WslGitHelperOptions = {}): WslGitHelper {
  const size = options.size ?? 2;
  const settings = { interpreter: options.interpreter ?? 'perl', script: options.script ?? HELPER_SCRIPT, startTimeoutMs: options.startTimeoutMs ?? 15_000 };
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const now = options.now ?? Date.now;
  const pools = new Map<string, HelperProcess[]>();
  const unavailableUntil = new Map<string, number>();
  const key = (distro: string | undefined) => distro ?? '';
  let closed = false;
  // After close() every command uses one wsl.exe again.
  const available = (distro: string | undefined) => !closed && (unavailableUntil.get(key(distro)) ?? 0) <= now();

  const dispatch = (distro: string | undefined, job: Job) => {
    const k = key(distro);
    if (closed || !available(distro)) { job.reject(new Error('wsl helper unavailable')); return; }
    let pool = (pools.get(k) ?? []).filter((p) => !p.dead);
    let member = pool.find((p) => p.busy() === 0);
    if (!member && pool.length < size) {
      member = new HelperProcess(distro, settings, options.onLaunch ?? (() => {}),
        () => unavailableUntil.set(k, now() + retryAfterMs),
        (jobs) => { for (const j of jobs) dispatch(distro, j); });
      pool = [...pool, member];
    }
    member ??= pool.reduce((a, b) => (b.busy() < a.busy() ? b : a));
    pools.set(k, pool);
    member.enqueue(job);
  };

  return {
    available,
    run(distro, gitArgs, runOptions) {
      return new Promise((resolve, reject) => dispatch(distro, { frame: encode(gitArgs), options: runOptions, resolve, reject }));
    },
    close() {
      closed = true;
      for (const pool of pools.values()) for (const p of pool) p.fail(new Error('wsl helper closed'), false);
      pools.clear();
    },
  };
}
