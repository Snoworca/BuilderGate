// FR-FOP-001 · FR-FOP-002 · SEC-FOP-001 — 파일 조작 작업 하나를 끝까지 실행한다.
//
// 두 단계로 나뉜다. scanning 은 출발지만 훑어 항목 수와 바이트를 세고 아무것도 만들지
// 않는다. transferring 은 센 트리를 출발지 순서·readdir 순서로 걸으며 항목마다
// 목적지를 그 자리에서 확인한다. 충돌을 미리 모아 두지 않는 이유는, 첫 질문을 받기
// 전까지 사용자가 본 적 없는 목적지를 건드리지 않고, 답에 따라 뒤의 트리 모양(재명명·
// 병합·건너뜀)이 바뀌기 때문이다.
//
// 진행 보고는 청크·항목마다 제한 없이 낸다. 초당 횟수 제한은 관리자 층의 몫이다.
//
// 취소(FR-FOP-005)는 되돌리지 않는다. 끝난 항목은 그대로 두고, 취소 순간 쓰던 파일 하나만
// 지운다. 되돌리기는 그 자체가 도중에 실패할 수 있는 두 번째 작업이라, 취소를 "알 수 없는
// 중간 상태" 로 만들 뿐이다. 대신 항목마다 취소를 확인해 새 일을 시작하지 않는다.
//
// 이동은 먼저 rename 한 번을 시도한다. 같은 장치면 그것으로 원자적으로 끝난다. EXDEV 면
// 파일마다 복사 → 그 원본 삭제를 교대로 한다. 전부 복사한 뒤 전부 지우면 도중에 멈췄을 때
// 모든 파일이 두 벌 남고, 삭제를 앞세우면 사본이 완성되기 전에 원본을 잃는다.
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { resolveNameCollision } from '../fileNameCollision.js';
import type { FileJobFsOps, FileJobFsStat } from './fileJobFsOps.js';
import { transition, type FileJobState } from './fileJobState.js';

// @req FR-FOP-002
export interface FileJobSpec {
  operation: 'copy' | 'move' | 'delete';
  /** 절대 경로. */
  sources: string[];
  /** copy·move 의 목적지 디렉터리. 절대 경로. */
  destDir?: string;
}

// @req FR-FOP-002
export interface FileJobProgress {
  phase: 'scanning' | 'transferring';
  processedBytes: number;
  totalBytes: number;
  processedEntries: number;
  totalEntries: number;
  currentPath: string | null;
}

export type FileJobConflictChoice = 'overwrite' | 'rename' | 'skip';

/** 일반 충돌의 선택지. */
export const FILE_JOB_CONFLICT_CHOICES: readonly FileJobConflictChoice[] = Object.freeze(['overwrite', 'rename', 'skip']);
/**
 * 출발지와 목적지가 같은 항목(제자리 붙여넣기)의 선택지. 자기 자신 위로의 덮어쓰기는 쓰기
 * 스트림이 여는 순간 원본을 잘라 빈 파일을 남기므로 선택지에서 뺀다.
 */
export const FILE_JOB_IN_PLACE_CHOICES: readonly FileJobConflictChoice[] = Object.freeze(['rename', 'skip']);
/**
 * 종류가 다른 항목끼리의 충돌(파일 ↔ 디렉터리)의 선택지. 그 교체는 한쪽 트리를 지워야 해서
 * 하지 않으므로 overwrite 는 늘 실패한다 — 고를 수 없는 답을 내놓지 않는다.
 */
export const FILE_JOB_KIND_MISMATCH_CHOICES: readonly FileJobConflictChoice[] = FILE_JOB_IN_PLACE_CHOICES;
/**
 * 따라갈 수 없는 링크(대상이 출발지 세션 밖·blocked·순환·풀 수 없음)의 선택지. 그 항목을 옮길
 * 방법이 없으니 건너뛰기뿐이다. 작업 전체를 멈추려면 취소한다.
 */
export const FILE_JOB_LINK_ERROR_CHOICES: readonly FileJobConflictChoice[] = Object.freeze(['skip']);

// @req FR-FOP-001
// @req FR-FOP-004
export interface FileJobDecisionRequest {
  /** conflict: 목적지에 이미 항목이 있다. error: 출발지 항목을 옮길 수 없다(따라갈 수 없는 링크). */
  kind: 'conflict' | 'error';
  /** conflict 면 이미 있는 목적지 경로, error 면 옮길 수 없는 출발지 항목. */
  path: string;
  /** 이 질문에 받아들일 수 있는 답. 답의 검증은 이 목록을 기준으로 한다. */
  choices: readonly FileJobConflictChoice[];
  /**
   * error 의 이유. 사용자가 왜 건너뛰어야 하는지 보게 한다. 링크 대상의 실제 위치는 싣지 않는다 —
   * path 가 보여 주는 것 이상을 드러내면 거부한 대상의 존재와 위치가 새어 나간다.
   */
  detail?: string;
}

/** 링크를 따라가지 않은 이유. 사람이 읽는 문장이고 경로를 담지 않는다. */
export const FILE_JOB_LINK_REFUSAL = Object.freeze({
  outside: 'link target is outside the session folder',
  blocked: 'link target is blocked',
  unresolvable: 'link target does not exist or cannot be read',
  cycle: 'link points back into a folder being copied',
  unchecked: 'links cannot be followed here',
  changed: 'link target changed while scanning',
  notMovable: 'link cannot be moved to this destination',
});

// 링크 대상 검증기가 던지는 코드 중 "정책상 거부" 만 링크 건너뛰기로 바꾼다. 세션이 사라졌거나
// 디스크 오류면 그 링크 하나의 문제가 아니므로 작업을 실패로 드러낸다 — 건너뛰기로 바꾸면 복사가
// 조용히 빠진 채 completed 로 끝난다. 문자열로 비교한다: 러너는 검증기의 오류 타입에 묶이지 않는다.
const LINK_POLICY_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  PATH_TRAVERSAL: FILE_JOB_LINK_REFUSAL.outside,
  PATH_BLOCKED: FILE_JOB_LINK_REFUSAL.blocked,
});

// @req FR-FOP-001
export interface FileJobRunnerDeps {
  fsOps: FileJobFsOps;
  /** 만들기 직전의 모든 경로를 받는다. 거부는 throw 로 한다. */
  validatePath: (p: string) => void | Promise<void>;
  /**
   * 출발지 세션 정책 검증기. 복사 중 만난 링크의 실제 대상을 받는다. 없으면 링크를 따라가지
   * 않는다 — 검증할 수 없는 대상을 읽으면 출발지 세션 밖의 내용이 목적지로 새어 나간다.
   */
  validateSourcePath?: (p: string) => void | Promise<void>;
  decide: (req: FileJobDecisionRequest) => Promise<{ choice: FileJobConflictChoice }>;
  onProgress: (p: FileJobProgress) => void;
  onStateChange?: (s: FileJobState) => void;
  signal?: AbortSignal;
}

// @req FR-FOP-001
export interface FileJobResult {
  outcome: 'completed' | 'cancelled' | 'failed';
  processedEntries: number;
  /** 실패 원인. 던져진 객체를 감싸지 않고 그대로 싣는다. */
  error?: unknown;
  /** move 가 완료되었고 모든 최상위 항목이 같은 장치 안의 rename 한 번으로 끝났을 때만 true. */
  atomic?: boolean;
}

interface ScannedEntry {
  /** 사용자가 보는 경로. 목적지 이름(basename)과 진행·질문 표시에 쓴다. */
  path: string;
  /**
   * 실제로 읽는 경로. 따라간 링크와 그 자손은 검증한 실제 경로 아래를 가리키고, 그 밖에는 path 와
   * 같다. 링크 경로로 다시 읽으면 스캔 뒤(질문에 멈춘 사이 등) 다시 걸린 링크의 새 대상을 읽는다 —
   * 검증은 스캔 때 대상에 했으므로 그 내용이 검증 없이 목적지로 새어 나간다.
   */
  readPath: string;
  /**
   * link 는 따라가지 않은 링크 자신이다. 따라간 링크는 대상의 종류(file·directory)로 담긴다.
   */
  kind: 'file' | 'directory' | 'link';
  /** 복사 중 따라가지 않은 링크면 그 이유(FILE_JOB_LINK_REFUSAL). 결정의 detail 로 나간다. */
  refusal?: string;
  size: number;
  /** 디렉터리만. readdir 순서. */
  children: ScannedEntry[];
}

// NTFS·APFS 기본값은 대소문자를 구분하지 않는다. 정확 비교로 '빈 이름' 을 고르면
// 'A (2).txt' 가 있는 자리에 'a (2).txt' 를 골라 기존 파일을 묻지 않고 덮어쓴다.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const foldName = (name: string): string => (CASE_INSENSITIVE_FS ? name.toLowerCase() : name);

function samePath(a: string, b: string): boolean {
  return foldName(resolve(a)) === foldName(resolve(b));
}

/** child 가 parent 자신이거나 그 아래인가. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(foldName(resolve(parent)), foldName(resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function countEntries(entry: ScannedEntry): number {
  return entry.children.reduce((n, child) => n + countEntries(child), 1);
}

function countBytes(entry: ScannedEntry): number {
  return entry.children.reduce((n, child) => n + countBytes(child), entry.size);
}

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

// node:stream pipeline 이 signal 로 끊길 때 던지는 것과 같은 모양으로 맞춘다.
function abortError(): Error {
  const err = codedError('ABORT_ERR', 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}

class JobRun {
  private state: FileJobState = 'queued';
  private totalEntries = 0;
  private totalBytes = 0;
  private processedEntries = 0;
  private processedBytes = 0;
  private phase: FileJobProgress['phase'] = 'scanning';
  /** move 중 rename 한 번으로 끝나지 않은 항목(EXDEV 폴백·병합)을 만났는가. */
  private movedPiecewise = false;

  constructor(
    private readonly spec: FileJobSpec,
    private readonly deps: FileJobRunnerDeps,
  ) {}

  // @req FR-FOP-001
  async run(): Promise<FileJobResult> {
    this.moveTo('running');
    try {
      const roots = await this.scan();
      this.phase = 'transferring';
      this.report(null);

      switch (this.spec.operation) {
        case 'copy':
          await this.copyAll(roots);
          break;
        case 'move':
          await this.moveAll(roots);
          break;
        case 'delete':
          for (const root of roots) await this.deleteEntry(root);
          break;
        default:
          throw new Error(`File job operation not implemented: ${String(this.spec.operation)}`);
      }

      this.moveTo('completed');
      const result: FileJobResult = { outcome: 'completed', processedEntries: this.processedEntries };
      if (this.spec.operation === 'move') result.atomic = !this.movedPiecewise;
      return result;
    } catch (error) {
      // 취소 뒤에 올라온 오류는 취소 자체(AbortError)이거나 끊긴 스트림의 여파다. 사용자가
      // 고른 결과이므로 실패로 보고하지 않는다.
      if (this.deps.signal?.aborted) {
        this.moveTo('cancelled');
        return { outcome: 'cancelled', processedEntries: this.processedEntries };
      }
      this.moveTo('failed');
      return { outcome: 'failed', processedEntries: this.processedEntries, error };
    }
  }

  private moveTo(to: FileJobState): void {
    const result = transition(this.state, to);
    if ('ignored' in result) return;
    this.state = result.next;
    this.deps.onStateChange?.(this.state);
  }

  private throwIfAborted(): void {
    if (this.deps.signal?.aborted) throw abortError();
  }

  /** p 가 끝나기 전에 취소되면 기다리지 않고 AbortError 로 reject 한다. */
  private untilAborted<T>(p: Promise<T>): Promise<T> {
    const signal = this.deps.signal;
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  private report(currentPath: string | null): void {
    this.deps.onProgress({
      phase: this.phase,
      // 세는 동안 막대가 움직이면 안 되고, 삭제는 바이트를 진행 지표로 쓰지 않는다.
      // 스캔 뒤에 자란 파일이 100% 를 넘기지 않게 분모에서 자른다.
      processedBytes: this.phase === 'scanning' ? 0 : Math.min(this.processedBytes, this.totalBytes),
      totalBytes: this.totalBytes,
      processedEntries: this.processedEntries,
      totalEntries: this.totalEntries,
      currentPath,
    });
  }

  // ── scanning ────────────────────────────────────────────────────────────

  private async scan(): Promise<ScannedEntry[]> {
    this.report(null);
    const roots: ScannedEntry[] = [];
    for (const source of this.spec.sources) roots.push(await this.scanEntry(source, source, new Set()));
    return roots;
  }

  /**
   * ancestors 는 지금 내려온 디렉터리들의 실제 경로(foldName)다. 링크를 따라가는 복사만 채운다 —
   * 링크가 없으면 디렉터리 트리는 순환할 수 없다.
   */
  // @req FR-FOP-002
  // @req SEC-FOP-001
  private async scanEntry(path: string, readPath: string, ancestors: Set<string>): Promise<ScannedEntry> {
    const { fsOps } = this.deps;
    this.throwIfAborted();
    const stat = await fsOps.lstat(readPath);
    if (!stat) {
      throw codedError('ENOENT', `Source not found: ${path}`);
    }
    let kind: ScannedEntry['kind'];
    let size = 0;
    let realDir: string | null = null;
    let refusal: string | undefined;
    if (stat.kind === 'symlink') {
      // 링크를 따라가는 것은 복사뿐이다. 이동·삭제는 링크 자신을 다룬다 — 이동 중에 대상을 따라가
      // 원본을 지우거나, 삭제가 링크 너머의 트리를 지우면 사용자가 고른 적 없는 파괴다.
      const target = this.spec.operation === 'copy' ? await this.resolveLink(readPath, ancestors) : null;
      if (target && 'real' in target) {
        kind = target.kind;
        size = target.kind === 'file' ? target.size : 0;
        realDir = target.real;
        readPath = target.real;
      } else {
        kind = 'link';
        refusal = target?.refused;
      }
    } else {
      kind = stat.kind;
      size = stat.kind === 'file' ? stat.size : 0;
    }
    const entry: ScannedEntry = { path, readPath, kind, size, children: [] };
    if (refusal !== undefined) entry.refusal = refusal;
    this.totalEntries += 1;
    // 삭제는 바이트로 진행하지 않으므로 분모에도 싣지 않는다 — 0/450 막대가 멈춰 보이지 않게.
    if (this.spec.operation !== 'delete') this.totalBytes += entry.size;
    this.report(path);
    if (entry.kind === 'directory') {
      const key = this.spec.operation === 'copy' ? foldName(realDir ?? (await this.realOf(readPath))) : null;
      const added = key !== null && !ancestors.has(key);
      if (added) ancestors.add(key);
      try {
        for (const name of await fsOps.readdir(readPath)) {
          entry.children.push(await this.scanEntry(join(path, name), join(readPath, name), ancestors));
        }
      } finally {
        if (added) ancestors.delete(key);
      }
    }
    return entry;
  }

  /**
   * 링크를 따라가도 되면 대상의 실제 경로와 종류를, 아니면 거부 이유를 돌려준다. 따라가도 되는 것은
   * 대상이 풀리고, 지금 내려온 디렉터리가 아니며(순환), 출발지 세션 정책을 통과할 때뿐이다.
   * 판단할 수단(realpath·출발지 검증기)이 없으면 따라가지 않는다 — 모르면 거부한다.
   */
  // @req SEC-FOP-001
  private async resolveLink(
    path: string,
    ancestors: ReadonlySet<string>,
  ): Promise<{ real: string; kind: 'file' | 'directory'; size: number } | { refused: string }> {
    const { fsOps, validateSourcePath } = this.deps;
    if (!fsOps.realpath || !validateSourcePath) return { refused: FILE_JOB_LINK_REFUSAL.unchecked };
    let real: string;
    try {
      real = await fsOps.realpath(path);
    } catch {
      // 대상이 없는 링크·권한 없는 대상. 어느 쪽이든 옮길 내용을 확인할 수 없다.
      return { refused: FILE_JOB_LINK_REFUSAL.unresolvable };
    }
    this.throwIfAborted();
    if (ancestors.has(foldName(real))) return { refused: FILE_JOB_LINK_REFUSAL.cycle };
    try {
      await validateSourcePath(real);
    } catch (err) {
      // 검증 중의 취소는 거부가 아니라 취소다.
      this.throwIfAborted();
      const code = errnoCode(err);
      const reason = code !== undefined && Object.hasOwn(LINK_POLICY_REFUSALS, code) ? LINK_POLICY_REFUSALS[code] : undefined;
      if (reason === undefined) throw err;
      return { refused: reason };
    }
    this.throwIfAborted();
    const target = await fsOps.lstat(real);
    // realpath 의 결과는 링크일 수 없지만, 그 사이에 바뀌었으면 다시 풀지 않고 거부한다.
    if (!target || target.kind === 'symlink') return { refused: FILE_JOB_LINK_REFUSAL.changed };
    return { real, kind: target.kind, size: target.size };
  }

  /** 순환 판정용 실제 경로. 풀 수 없으면 입력 경로로 대신한다 — 디렉터리 자체의 읽기가 곧 실패를 드러낸다. */
  private async realOf(path: string): Promise<string> {
    const { fsOps } = this.deps;
    if (!fsOps.realpath) return resolve(path);
    return fsOps.realpath(path).catch(() => resolve(path));
  }

  /** 따라갈 수 없는 링크를 사용자에게 알리고 건너뛴다. 그 아래로는 아무것도 만들지 않는다. */
  // @req SEC-FOP-001
  private async refuseLink(entry: ScannedEntry): Promise<void> {
    // 이유가 없는 링크는 이동 중 링크로 옮길 수 없는 자리의 것이다 — 복사는 스캔에서 늘 이유를 남긴다.
    const detail = entry.refusal ?? FILE_JOB_LINK_REFUSAL.notMovable;
    const choice = await this.ask('error', entry.path, FILE_JOB_LINK_ERROR_CHOICES, detail);
    if (!FILE_JOB_LINK_ERROR_CHOICES.includes(choice)) {
      throw codedError('EINVAL', `Unknown link error choice: ${String(choice)}`);
    }
    this.markSkipped(entry);
  }

  // ── copy ────────────────────────────────────────────────────────────────

  private async copyAll(roots: ScannedEntry[]): Promise<void> {
    const destDir = this.spec.destDir;
    if (!destDir) throw new Error('File job copy requires destDir');
    // 디렉터리를 자기 안으로 복사하면 스캔한 트리를 쓰는 동안 그 트리가 자란다. 무엇이
    // 만들어졌든 사용자가 뜻한 결과가 아니므로 아무것도 만들기 전에 거부한다.
    for (const root of roots) {
      if (root.kind === 'directory' && isWithin(root.path, destDir)) {
        throw codedError('EINVAL', `Cannot copy a directory into itself: ${root.path} -> ${destDir}`);
      }
    }
    for (const root of roots) await this.copyEntry(root, join(destDir, basename(root.path)));
  }

  // @req FR-FOP-001
  // @req SEC-FOP-001
  private async copyEntry(entry: ScannedEntry, dst: string): Promise<void> {
    const { fsOps } = this.deps;
    this.throwIfAborted();
    // 목적지를 보기 전에 거른다 — 옮길 수 없는 항목에 충돌 질문부터 하면 답해도 소용없는 질문이 된다.
    if (entry.kind === 'link') {
      await this.refuseLink(entry);
      return;
    }
    // 목적지는 도달한 그 순간에만 본다 — 사전 스캔 없이 만나는 순서대로 묻는다.
    const existing = await fsOps.lstat(dst);
    let target = dst;
    let mergeInto = false;
    let replace = false;

    if (existing) {
      const choice = await this.askConflictFor(entry, dst, existing.kind);
      if (choice === 'skip') {
        this.markSkipped(entry);
        return;
      }
      if (choice === 'rename') {
        target = await this.freeSiblingName(dst);
      } else if (entry.kind === 'directory') {
        // 디렉터리 덮어쓰기는 병합이다. 자식마다 다시 충돌을 확인한다 — 기존 트리를
        // 통째로 지우는 것은 사용자가 고른 적 없는 파괴다. 종류가 다르면 askConflictFor 가
        // overwrite 를 이미 막았으므로 여기의 기존 항목은 디렉터리다.
        mergeInto = true;
      } else {
        replace = true;
      }
    }

    if (entry.kind === 'directory') {
      if (!mergeInto) {
        await this.deps.validatePath(target);
        await fsOps.mkdir(target);
      }
      this.processedEntries += 1;
      this.report(entry.path);
      for (const child of entry.children) {
        await this.copyEntry(child, join(target, basename(child.path)));
      }
      return;
    }

    await this.writeFile(entry.readPath, target, replace);
    this.processedEntries += 1;
    this.report(entry.path);
  }

  /**
   * 파일 하나를 target 에 쓴다. replace 면 target 에 이미 파일이 있다.
   * 실패·취소하면 이 호출이 쓰던 경로 하나만 지우고 원래 오류를 다시 던진다.
   */
  // @req FR-FOP-005
  // @req SEC-FOP-001
  private async writeFile(src: string, target: string, replace: boolean, durable = false): Promise<void> {
    const { fsOps } = this.deps;
    this.throwIfAborted();
    // 덮어쓰기도 쓰기이므로 검증을 거친다.
    await this.deps.validatePath(target);
    // 덮어쓰기는 목적지에 바로 쓰지 않는다. 쓰기 스트림은 여는 순간 파일을 자르므로, 도중에
    // 취소·실패하면 지키려던 원래 파일이 부분본으로 바뀐다. 같은 디렉터리의 임시 이름에 다 쓴
    // 뒤 rename 으로 교체한다 — 같은 디렉터리라 장치 경계를 넘지 않는다. 임시 이름도 이 작업이
    // 만드는 경로이므로 검증을 거친다.
    const writePath = replace ? this.tempSiblingName(target) : target;
    if (replace) await this.deps.validatePath(writePath);
    try {
      await fsOps.copyFileStream(
        src,
        writePath,
        (n) => {
          this.processedBytes += n;
          this.report(src);
        },
        this.deps.signal,
        durable ? { durable: true } : undefined,
      );
      if (replace) await fsOps.rename(writePath, target);
    } catch (err) {
      // EEXIST 는 배타 생성이 막은 것이다 — 그 경로의 파일은 이 작업이 만든 것이 아니므로
      // 정리한다고 지우면 남의 파일을 지운다.
      if (errnoCode(err) !== 'EEXIST') {
        // copyFileStream 이 settle 된 뒤라 쓰기 핸들은 닫혀 있다(열린 핸들 아래 unlink 는 Windows
        // 에서 실패한다). 원래 오류가 보고 대상이므로 정리 실패로 그것을 덮지 않는다.
        await fsOps.unlink(writePath).catch(() => {});
      }
      throw err;
    }
  }

  /** 목적지 옆의 임시 이름. 원래 이름을 싣지 않아 이름 길이 한도에 걸리지 않는다. */
  private tempSiblingName(target: string): string {
    return join(dirname(target), `.bg-part-${randomBytes(8).toString('hex')}`);
  }

  // ── move ────────────────────────────────────────────────────────────────

  private async moveAll(roots: ScannedEntry[]): Promise<void> {
    const destDir = this.spec.destDir;
    if (!destDir) throw new Error('File job move requires destDir');
    for (const root of roots) {
      if (root.kind === 'directory' && isWithin(root.path, destDir)) {
        throw codedError('EINVAL', `Cannot move a directory into itself: ${root.path} -> ${destDir}`);
      }
    }
    for (const root of roots) await this.moveEntry(root, join(destDir, basename(root.path)), true);
  }

  /**
   * entry 를 dst 로 옮긴다. tryRename 이면 먼저 rename 한 번을 시도한다.
   * 출발지에서 entry 가 전부 사라졌으면 true — 부모 디렉터리를 rmdir 해도 되는지의 근거다.
   */
  // @req FR-FOP-005
  // @req SEC-FOP-001
  private async moveEntry(entry: ScannedEntry, dst: string, tryRename: boolean): Promise<boolean> {
    const { fsOps } = this.deps;
    this.throwIfAborted();
    // rename 은 링크를 링크로 옮긴다(대상을 읽지 않는다). 그럴 수 없는 자리에서는 링크를 재현할
    // 수단이 없으므로 묻고 건너뛴다 — 출발지에 남으므로 부모를 rmdir 할 근거가 아니다.
    if (entry.kind === 'link' && !tryRename) {
      await this.refuseLink(entry);
      return false;
    }
    const existing = await fsOps.lstat(dst);
    let target = dst;
    let mergeInto = false;
    let replace = false;

    if (existing) {
      // 제자리 이동: 항목이 이미 사용자가 고른 자리에 있다. 묻거나 이름을 바꾸면 고른 적 없는
      // 이름이 생기므로 아무것도 건드리지 않고 처리한 것으로만 센다. 출발지가 그대로 남으므로
      // 부모를 rmdir 할 근거가 아니다(false).
      if (samePath(entry.path, dst)) {
        this.markSkipped(entry);
        return false;
      }
      const choice = await this.askConflictFor(entry, dst, existing.kind);
      if (choice === 'skip') {
        this.markSkipped(entry);
        return false;
      }
      if (choice === 'rename') {
        target = await this.freeSiblingName(dst);
      } else if (entry.kind === 'directory') {
        mergeInto = true;
      } else {
        replace = true;
      }
    }

    // 병합은 기존 디렉터리를 갈아치울 수 없으므로 rename 한 번으로 끝낼 수 없다.
    if (tryRename && !mergeInto) {
      await this.deps.validatePath(target);
      try {
        // 파일 덮어쓰기면 rename 이 기존 파일을 원자적으로 교체한다(POSIX·Windows 모두).
        await fsOps.rename(entry.path, target);
        this.processedEntries += countEntries(entry);
        this.processedBytes += countBytes(entry);
        this.report(entry.path);
        return true;
      } catch (err) {
        if (errnoCode(err) !== 'EXDEV') throw err;
      }
    }
    this.movedPiecewise = true;
    if (entry.kind === 'link') {
      await this.refuseLink(entry);
      return false;
    }

    if (entry.kind === 'directory') {
      if (!mergeInto) {
        await this.deps.validatePath(target);
        await fsOps.mkdir(target);
      }
      // EXDEV 면 자식도 같은 장치 경계를 넘으므로 다시 rename 하지 않는다. 병합이면 자식은
      // 아직 rename 을 시도하지 않았다.
      const childTryRename = tryRename && mergeInto;
      let emptied = true;
      for (const child of entry.children) {
        if (!(await this.moveEntry(child, join(target, basename(child.path)), childTryRename))) emptied = false;
      }
      // 건너뛴 자식이 남아 있으면 출발지 디렉터리를 지울 수 없고, 지워서도 안 된다.
      if (emptied) await fsOps.rmdir(entry.path);
      this.processedEntries += 1;
      this.report(entry.path);
      return emptied;
    }

    // durable: 원본을 곧 지우므로 사본이 디스크에 닿은 뒤에야 돌아오게 한다.
    await this.writeFile(entry.path, target, replace, true);
    // 사본이 완전히 쓰이고(덮어쓰기면 교체까지) 난 뒤에만 원본을 지운다. 여기서는 취소를 보지
    // 않는다 — 이 파일은 이미 끝났으므로 목적지에만 있어야 한다.
    await fsOps.unlink(entry.path);
    this.processedEntries += 1;
    this.report(entry.path);
    return true;
  }

  /**
   * 이미 있는 dst 에 대해 묻고, 그 질문의 선택지 안에 드는 답만 돌려준다. 출발지와 목적지가
   * 같으면(제자리 붙여넣기) 실패가 아니라 덮어쓰기를 뺀 충돌이다. 종류가 다르면(파일 ↔
   * 디렉터리) 덮어쓰기는 늘 실패하므로 역시 뺀다.
   */
  // @req FR-FOP-001
  // @req FR-FOP-004
  private async askConflictFor(
    entry: ScannedEntry,
    dst: string,
    existingKind: FileJobFsStat['kind'],
  ): Promise<FileJobConflictChoice> {
    const choices = samePath(entry.path, dst)
      ? FILE_JOB_IN_PLACE_CHOICES
      : entry.kind !== existingKind
        ? FILE_JOB_KIND_MISMATCH_CHOICES
        : FILE_JOB_CONFLICT_CHOICES;
    const choice = await this.ask('conflict', dst, choices);
    // 관리자가 이미 질문별로 거르지만, 러너를 직접 쓰는 호출자도 있다. 선택지 밖의 답을
    // 흘려보내면 제자리 붙여넣기의 overwrite 가 원본을 비우고, 종류가 다른 충돌의 overwrite 는
    // 병합·교체 어느 쪽에도 맞지 않으며, 모르는 답은 가장 파괴적인 선택(덮어쓰기)이 기본값이 된다.
    if (!choices.includes(choice)) {
      throw codedError('EINVAL', `Unknown conflict choice: ${String(choice)}`);
    }
    return choice;
  }

  // @req FR-FOP-001
  private async ask(
    kind: FileJobDecisionRequest['kind'],
    path: string,
    choices: readonly FileJobConflictChoice[],
    detail?: string,
  ): Promise<FileJobConflictChoice> {
    this.moveTo('awaiting-decision');
    try {
      // 답을 기다리는 동안의 취소는 답을 기다리지 않고 바로 끝낸다 — 사용자가 대화상자를
      // 닫지 않은 채 취소했을 수 있다.
      // detail 은 있을 때만 싣는다 — 충돌 요청의 모양({ kind, path, choices })을 바꾸지 않는다.
      const req: FileJobDecisionRequest = detail === undefined ? { kind, path, choices } : { kind, path, choices, detail };
      const { choice } = await this.untilAborted(this.deps.decide(req));
      return choice;
    } finally {
      // 전이표에 awaiting-decision → failed 가 없다. 결정이 실패해도 running 으로 돌아온 뒤
      // run() 의 catch 가 failed 로 보낸다. 대기 중 취소면 running 을 거치지 않고 바로
      // cancelled 로 보낸다 — 취소를 누른 뒤 '실행 중' 이 잠깐 보이면 안 된다.
      if (this.state === 'awaiting-decision') this.moveTo(this.deps.signal?.aborted ? 'cancelled' : 'running');
    }
  }

  private async freeSiblingName(dst: string): Promise<string> {
    const parent = dirname(dst);
    const taken = new Set((await this.deps.fsOps.readdir(parent)).map(foldName));
    return join(parent, resolveNameCollision(basename(dst), (name) => taken.has(foldName(name))));
  }

  /** 건너뛴 항목도 처리된 것으로 센다 — 끝났을 때 막대가 100% 에 닿아야 한다. */
  private markSkipped(entry: ScannedEntry): void {
    this.processedEntries += countEntries(entry);
    this.processedBytes += countBytes(entry);
    this.report(entry.path);
  }

  // ── delete ──────────────────────────────────────────────────────────────

  // @req FR-FOP-002
  private async deleteEntry(entry: ScannedEntry): Promise<void> {
    const { fsOps } = this.deps;
    this.throwIfAborted();
    if (entry.kind === 'directory') {
      for (const child of entry.children) await this.deleteEntry(child);
      await fsOps.rmdir(entry.path);
    } else {
      // 링크는 링크 자신만 지운다(unlink 는 대상을 따라가지 않는다). 스캔이 삭제에서는 링크를 따라가지 않는다.
      await fsOps.unlink(entry.path);
    }
    this.processedEntries += 1;
    this.report(entry.path);
  }
}

// @req FR-FOP-001
// @req FR-FOP-002
// @req FR-FOP-005
// @req SEC-FOP-001
export function runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult> {
  return new JobRun(spec, deps).run();
}
