/**
 * The right side of the Git window: what is selected (a commit, the uncommitted
 * changes, or the comparison with the base), its changed files as a listbox, a
 * splitter, and the diff of the selected file below.
 *
 * @req FR-GIT-006
 * @req FR-GIT-008
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileArea, FileKind, GitClient, GitCommitDetail, GitCompare, GitStatus, RepoSummary, SideInput } from './gitApi.ts';
import { activeLanguage, t, tn, type MessageKey } from '../../i18n/i18n.ts';
import { copyTextToClipboard } from '../../utils/clipboardCopy.ts';
import './gitViewer.css';

export interface GitFileEntry {
  key: string;
  area: FileArea | null;
  kind: FileKind;
  path: string;
  origPath?: string;
  similarity?: number;
  add: number;
  del: number;
  binary: boolean;
  inputs?: { old: SideInput; new: SideInput };
}

export interface GitDiffContext {
  selected: string;
  /** For the comparison: include the working tree. */
  wt: boolean;
  position: { index: number; total: number };
  moveFile: (delta: number) => void;
}

export interface GitSidePanelProps {
  sessionId: string;
  client: Pick<GitClient, 'status' | 'commit' | 'compare'>;
  summary: RepoSummary | null;
  selected: string;
  reloadKey: number;
  onSelectCommit: (sha: string) => void;
  diff: (file: GitFileEntry | null, ctx: GitDiffContext) => ReactNode;
}

type Loaded =
  | { kind: 'worktree'; status: GitStatus }
  | { kind: 'commit'; commit: GitCommitDetail }
  | { kind: 'compare'; compare: GitCompare }
  | null;

const AREA_LABEL = { staged: 'git.files.staged', unstaged: 'git.files.unstaged', untracked: 'git.files.untracked', conflict: 'git.files.conflicted' } as const satisfies Record<FileArea, MessageKey>;
const AREA_BASE = { staged: 'git.files.base.staged', unstaged: 'git.files.base.unstaged', untracked: 'git.files.base.untracked', conflict: 'git.files.base.conflict' } as const satisfies Record<FileArea, MessageKey>;
const KIND_LABEL = { A: 'git.kind.A', M: 'git.kind.M', D: 'git.kind.D', R: 'git.kind.R', C: 'git.kind.C', T: 'git.kind.T', X: 'git.kind.X', '?': 'git.kind.untracked' } as const satisfies Record<FileKind, MessageKey>;
const keyOf = (area: FileArea | null, path: string) => `${area ?? ''}:${path}`;

export function GitSidePanel({ sessionId, client, summary, selected, reloadKey, onSelectCommit, diff }: GitSidePanelProps) {
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [wt, setWt] = useState(false);
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [filesHeight, setFilesHeight] = useState(150);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selected) { setLoaded(null); return; }
    const controller = new AbortController();
    const done = (v: Loaded) => { if (!controller.signal.aborted) setLoaded(v); };
    if (selected === 'WORKTREE') client.status(sessionId, controller.signal).then((status) => done({ kind: 'worktree', status }), () => done(null));
    else if (selected === 'CMP') client.compare(sessionId, wt, controller.signal).then((compare) => done({ kind: 'compare', compare }), () => done(null));
    else client.commit(sessionId, selected, controller.signal).then((commit) => done({ kind: 'commit', commit }), () => done(null));
    return () => controller.abort();
  }, [client, sessionId, selected, reloadKey, wt]);

  const files = useMemo((): GitFileEntry[] => {
    if (!loaded) return [];
    if (loaded.kind === 'worktree') {
      const order: Record<FileArea, number> = { conflict: 0, staged: 1, unstaged: 2, untracked: 3 };
      return loaded.status.files
        .map((f, i) => ({ ...f, key: keyOf(f.area, f.path), i }))
        .sort((a, b) => order[a.area] - order[b.area] || a.i - b.i)
        .map(({ i: _i, ...f }) => f);
    }
    const list = loaded.kind === 'commit' ? loaded.commit.files : loaded.compare.files;
    return list.map((f) => ({ ...f, area: null, key: keyOf(null, f.path) }));
  }, [loaded]);

  const current = files.find((f) => f.key === fileKey) ?? files[0] ?? null;
  useEffect(() => { if (current && current.key !== fileKey) setFileKey(current.key); }, [current, fileKey]);

  const move = (d: number) => {
    if (!files.length) return;
    const i = Math.max(0, files.findIndex((f) => f.key === current?.key));
    setFileKey(files[Math.max(0, Math.min(files.length - 1, i + d))].key);
  };
  const onFilesKey = (e: React.KeyboardEvent) => {
    const map: Record<string, () => void> = {
      ArrowDown: () => move(1), j: () => move(1), ArrowUp: () => move(-1), k: () => move(-1),
      Home: () => files[0] && setFileKey(files[0].key), End: () => files.length && setFileKey(files[files.length - 1].key),
    };
    if (map[e.key]) { e.preventDefault(); map[e.key](); }
  };
  const onSplitKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const max = Math.max(84, (panelRef.current?.clientHeight || 600) * 0.5);
    setFilesHeight((h) => Math.max(84, Math.min(max, h + (e.key === 'ArrowDown' ? 16 : -16))));
  };
  const onSplitDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const startY = e.clientY;
    const startH = filesHeight;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const max = Math.max(84, (panelRef.current?.clientHeight || 600) * 0.5);
    const moveH = (ev: PointerEvent) => setFilesHeight(Math.max(84, Math.min(max, startH + ev.clientY - startY)));
    const up = () => { handle.removeEventListener('pointermove', moveH); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', moveH);
    handle.addEventListener('pointerup', up);
  };

  const lang = activeLanguage();
  let detail: ReactNode = null;
  if (loaded?.kind === 'worktree') {
    const c = summary?.counts;
    detail = (
      <>
        <div className="git-detail-subject">{t('git.detail.worktree', { count: c?.paths ?? files.length })}</div>
        {c && <div className="git-detail-kv">{t('git.detail.worktreeCounts', { staged: c.staged, modified: c.unstaged, untracked: c.untracked })}</div>}
      </>
    );
  } else if (loaded?.kind === 'compare') {
    const cmp = loaded.compare;
    detail = (
      <>
        <div className="git-detail-subject">{t('git.compare.title', { branch: summary?.branch ?? '', base: cmp.base.ref })}</div>
        <div className="git-detail-kv">
          <span>{t('git.compare.forkPoint')} <b>{cmp.mergeBase.slice(0, 7)}</b></span>
          <span>{tn('git.banner.commits', cmp.commits.length)}</span>
          <span className="git-add">+{cmp.add}</span><span className="git-del">−{cmp.del}</span>
          <label className="git-check"><input type="checkbox" checked={wt} onChange={(e) => setWt(e.target.checked)} /> {t('git.compare.includeWorktree')}</label>
        </div>
      </>
    );
  } else if (loaded?.kind === 'commit') {
    const c = loaded.commit;
    const [subject, ...rest] = c.message.split('\n');
    const body = rest.join('\n').trim();
    detail = (
      <>
        <div className="git-detail-subject">{subject}</div>
        {body && <div className="git-detail-body">{body}</div>}
        <div className="git-detail-kv">
          <span>{t('git.detail.commit')} <b>{c.sha.slice(0, 12)}</b> <button type="button" className="git-link" onClick={() => { void copyTextToClipboard(c.sha).catch(() => {}); }}>{t('git.detail.copy')}</button></span>
          <span>{t('git.detail.author')} <b>{c.author}</b></span>
          <span>{new Date(c.time * 1000).toLocaleString(lang)}</span>
          <span>{t('git.detail.parents')} {c.parents.length
            ? c.parents.map((p) => <button key={p} type="button" className="git-link" data-parent={p} onClick={() => onSelectCommit(p)}>{p.slice(0, 7)}</button>)
            : t('git.detail.root')}</span>
        </div>
        {c.parents.length > 1 && <div className="git-detail-kv"><span className="git-pill">{t('git.detail.firstParent', { sha: c.parents[0].slice(0, 7) })}</span></div>}
      </>
    );
  }

  let lastArea: FileArea | null | undefined;
  const rows: ReactNode[] = [];
  files.forEach((f, i) => {
    if (f.area && f.area !== lastArea) {
      const count = files.filter((x) => x.area === f.area).length;
      rows.push(<div key={`g-${f.area}`} className="git-files-group" role="presentation"><span>{t(AREA_LABEL[f.area])} {count}</span><span className="git-files-base">{t(AREA_BASE[f.area])}</span></div>);
      lastArea = f.area;
    }
    const slash = f.path.lastIndexOf('/');
    const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
    const name = f.path.slice(slash + 1);
    const shown = f.origPath ? `${f.origPath.split('/').pop()} → ${name}` : name;
    const sel = f.key === current?.key;
    rows.push(
      <div
        key={f.key}
        id={`git-file-${sessionId}-${i}`}
        role="option"
        aria-selected={sel}
        aria-label={`${t(KIND_LABEL[f.kind])}, ${f.origPath ? `${f.origPath} → ${f.path}` : f.path}`}
        className="git-file"
        title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
        onClick={() => setFileKey(f.key)}
      >
        <span className="git-file-kind" data-kind={f.kind} aria-hidden="true">{f.kind === 'X' ? '!' : f.kind}</span>
        <span className="git-file-dir"><bdi>{dir}</bdi></span>
        <span className="git-file-name">{shown}</span>
        {f.similarity !== undefined && <span className="git-file-sim">R{f.similarity}%</span>}
        <span className="git-file-gap" />
        {f.binary
          ? <span className="git-file-stat git-muted">{t('git.files.binary')}</span>
          : <span className="git-file-stat"><span className="git-add">+{f.add}</span><span className="git-del">{f.del ? `−${f.del}` : ''}</span></span>}
      </div>,
    );
  });

  const activeIndex = files.findIndex((f) => f.key === current?.key);
  return (
    <div className="git-side" ref={panelRef}>
      <div className="git-detail">{detail}</div>
      <div
        className="git-files"
        role="listbox"
        tabIndex={0}
        aria-label={t('git.files.list')}
        aria-activedescendant={activeIndex >= 0 ? `git-file-${sessionId}-${activeIndex}` : undefined}
        style={{ height: filesHeight }}
        onKeyDown={onFilesKey}
      >
        {rows.length ? rows : <div className="git-files-group">{t('git.files.none')}</div>}
      </div>
      <div
        className="git-hsplit"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('git.files.splitter')}
        aria-valuenow={filesHeight}
        tabIndex={0}
        onKeyDown={onSplitKey}
        onPointerDown={onSplitDrag}
        onDoubleClick={() => setFilesHeight(150)}
      />
      <div className="git-diff-slot">{diff(current, { selected, wt, position: { index: Math.max(0, activeIndex), total: files.length }, moveFile: move })}</div>
    </div>
  );
}
