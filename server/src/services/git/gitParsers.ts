/**
 * Parsers for the git output the git viewer reads. Pure functions; git runs elsewhere.
 *
 * @req FR-GIT-001
 * @req FR-GIT-005
 * @req FR-GIT-006
 * @req FR-GIT-007
 */

export type FileKind = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'X' | '?';
export type FileArea = 'staged' | 'unstaged' | 'untracked' | 'conflict';

export interface StatusFile {
  path: string;
  origPath?: string;
  similarity?: number;
  kind: FileKind;
  area: FileArea;
  /** Blob ids from porcelain v2 (hH, hI): HEAD and index sides; absent for untracked/conflicts. */
  headId?: string | null;
  indexId?: string | null;
}

export interface StatusBranch {
  oid: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ParsedStatus {
  branch: StatusBranch;
  files: StatusFile[];
  counts: { staged: number; unstaged: number; untracked: number; conflicted: number; paths: number };
}

const KINDS = new Set(['A', 'M', 'D', 'R', 'C', 'T']);
const fields = (record: string, n: number) => {
  const parts = record.split(' ');
  return { head: parts.slice(0, n), rest: parts.slice(n).join(' ') };
};

/** `git status --porcelain=v2 --branch -z` */
export function parseStatusV2(out: string): ParsedStatus {
  const branch: StatusBranch = { oid: null, head: null, detached: false, upstream: null, ahead: 0, behind: 0 };
  const files: StatusFile[] = [];
  const records = out.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (!r) continue;
    if (r.startsWith('# ')) {
      const [key, ...v] = r.slice(2).split(' ');
      const value = v.join(' ');
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        if (value === '(detached)') { branch.detached = true; branch.head = null; } else branch.head = value;
      } else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]); }
      }
      continue;
    }
    const type = r[0];
    if (type === '1' || type === '2') {
      const { head, rest } = fields(r, type === '1' ? 8 : 9);
      const [x, y] = head[1];
      let origPath: string | undefined;
      let similarity: number | undefined;
      if (type === '2') {
        origPath = records[i + 1];
        i += 1;
        const score = /^[RC](\d+)$/.exec(head[8]);
        if (score) similarity = Number(score[1]);
      }
      // hH / hI: all zeros when that side has no file.
      const blob = (id: string) => (/^0+$/.test(id) ? null : id);
      const headId = blob(head[6]);
      const indexId = blob(head[7]);
      if (KINDS.has(x)) {
        const f: StatusFile = { path: rest, kind: x as FileKind, area: 'staged', headId, indexId };
        if (origPath !== undefined && (x === 'R' || x === 'C')) { f.origPath = origPath; if (similarity !== undefined) f.similarity = similarity; }
        files.push(f);
      }
      if (KINDS.has(y)) files.push({ path: rest, kind: y as FileKind, area: 'unstaged', headId, indexId });
    } else if (type === 'u') {
      files.push({ path: fields(r, 10).rest, kind: 'X', area: 'conflict' });
    } else if (type === '?') {
      files.push({ path: r.slice(2), kind: '?', area: 'untracked' });
    }
  }
  const count = (a: FileArea) => files.filter((f) => f.area === a).length;
  return {
    branch,
    files,
    counts: { staged: count('staged'), unstaged: count('unstaged'), untracked: count('untracked'), conflicted: count('conflict'), paths: new Set(files.map((f) => f.path)).size },
  };
}

export type RefKind = 'head' | 'local' | 'remote' | 'tag';
export interface Ref { kind: RefKind; name: string }

/** `%D` with `--decorate=full` */
export function parseRefs(d: string): Ref[] {
  if (!d.trim()) return [];
  return d.split(', ').map((item): Ref => {
    if (item === 'HEAD') return { kind: 'head', name: 'HEAD' };
    if (item.startsWith('HEAD -> ')) return { kind: 'head', name: item.slice(8).replace(/^refs\/heads\//, '') };
    if (item.startsWith('tag: ')) return { kind: 'tag', name: item.slice(5).replace(/^refs\/tags\//, '') };
    if (item.startsWith('refs/remotes/')) return { kind: 'remote', name: item.slice(13) };
    if (item.startsWith('refs/heads/')) return { kind: 'local', name: item.slice(11) };
    return { kind: 'local', name: item.replace(/^refs\//, '') };
  });
}

export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e';

export interface LogCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  refs: Ref[];
}

/** `git log --decorate=full --format=LOG_FORMAT` */
export function parseLog(out: string): LogCommit[] {
  return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [sha, parents, author, email, time, subject, d] = r.split('\x1f');
    return { sha, parents: parents ? parents.split(' ').filter(Boolean) : [], author, email, time: Number(time), subject, refs: parseRefs(d ?? '') };
  });
}

export interface NameStatus { kind: FileKind; path: string; origPath?: string; similarity?: number }

/** `--name-status -z` */
export function parseNameStatusZ(out: string): NameStatus[] {
  const t = out.split('\0');
  const result: NameStatus[] = [];
  for (let i = 0; i < t.length; i += 1) {
    const status = t[i];
    if (!status) continue;
    const kind = status[0] as FileKind;
    if (kind === 'R' || kind === 'C') {
      result.push({ kind, origPath: t[i + 1], path: t[i + 2], similarity: Number(status.slice(1)) || 0 });
      i += 2;
    } else {
      result.push({ kind: (KINDS.has(kind) ? kind : 'M') as FileKind, path: t[i + 1] });
      i += 1;
    }
  }
  return result;
}

export interface NumStat { path: string; origPath?: string; add: number; del: number; binary: boolean }

/** `--numstat -z` */
export function parseNumstatZ(out: string): NumStat[] {
  const t = out.split('\0');
  const result: NumStat[] = [];
  for (let i = 0; i < t.length; i += 1) {
    const rec = t[i];
    if (!rec) continue;
    const [a, d, p] = rec.split('\t');
    const binary = a === '-';
    const base = { add: binary ? 0 : Number(a), del: binary ? 0 : Number(d), binary };
    if (p === '') {
      result.push({ path: t[i + 2], origPath: t[i + 1], ...base });
      i += 2;
    } else {
      result.push({ path: p, ...base });
    }
  }
  return result;
}

export interface DiffLine { k: ' ' | '+' | '-'; o: number | null; n: number | null; t: string }
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; lines: DiffLine[] }
export interface DiffFile {
  oldPath: string;
  newPath: string;
  binary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  mode?: string;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `git diff` unified output (one or more files). */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: DiffHunk | null = null;
  let o = 0, n = 0, remO = 0, remN = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      f = { oldPath: m?.[1] ?? '', newPath: m?.[2] ?? '', binary: false, isNew: false, isDeleted: false, hunks: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (h && (remO > 0 || remN > 0)) {
      const k = line[0];
      if (k === ' ') { h.lines.push({ k: ' ', o, n, t: line.slice(1) }); o += 1; n += 1; remO -= 1; remN -= 1; continue; }
      if (k === '-') { h.lines.push({ k: '-', o, n: null, t: line.slice(1) }); o += 1; remO -= 1; continue; }
      if (k === '+') { h.lines.push({ k: '+', o: null, n, t: line.slice(1) }); n += 1; remN -= 1; continue; }
      if (k === '\\') continue;
    }
    if (line.startsWith('\\')) continue;
    const hm = HUNK.exec(line);
    if (hm) {
      h = {
        oldStart: Number(hm[1]), oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]), newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        header: line, lines: [],
      };
      f.hunks.push(h);
      o = h.oldStart; n = h.newStart; remO = h.oldLines; remN = h.newLines;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^new file mode (\d+)/.exec(line))) { f.isNew = true; f.newMode = m[1]; f.mode = m[1]; }
    else if ((m = /^deleted file mode (\d+)/.exec(line))) { f.isDeleted = true; f.oldMode = m[1]; f.mode = m[1]; }
    else if ((m = /^old mode (\d+)/.exec(line))) f.oldMode = m[1];
    else if ((m = /^new mode (\d+)/.exec(line))) { f.newMode = m[1]; f.mode = m[1]; }
    else if ((m = /^index \S+ (\d+)$/.exec(line))) f.mode = m[1];
    else if ((m = /^similarity index (\d+)%/.exec(line))) f.similarity = Number(m[1]);
    else if (line.startsWith('rename from ')) f.oldPath = line.slice(12);
    else if (line.startsWith('rename to ')) f.newPath = line.slice(10);
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') f.binary = true;
    else if (line.startsWith('--- ')) { const p = line.slice(4); if (p !== '/dev/null') f.oldPath = p.replace(/^a\//, ''); }
    else if (line.startsWith('+++ ')) { const p = line.slice(4); if (p !== '/dev/null') f.newPath = p.replace(/^b\//, ''); }
  }
  return files;
}

const LFS = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?/;

export function parseLfsPointer(text: string): { oid: string; size: number } | null {
  const m = LFS.exec(text);
  return m ? { oid: m[1], size: Number(m[2]) } : null;
}
