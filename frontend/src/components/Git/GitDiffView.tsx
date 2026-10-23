/**
 * The diff of the selected file: a header (kind, path, +/-, position, options,
 * previous/next file), notices for special files, and the unified lines with two
 * line numbers, hunk headers and word marks. Long diffs draw only the rows in view.
 *
 * @req FR-GIT-007
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiffRequest, DiffSpecial, GitClient, GitDiff } from './gitApi.ts';
import type { GitFileEntry } from './GitSidePanel.tsx';
import { buildDiffRows, expandGaps, pairSplitRows, virtualRange, type DiffRow, type GapReveal } from './gitDiffModel.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import './gitViewer.css';

const ROW_H = 20;
const VIRTUAL_FROM = 2000;
const DEBOUNCE_MS = 150;

/** What to ask the server for, from the selection and the file's area. */
export function diffRequestFor(selected: string, wt: boolean, file: GitFileEntry): DiffRequest {
  const orig = file.origPath ? { origPath: file.origPath } : {};
  if (selected === 'WORKTREE') {
    const src = file.area === 'staged' ? 'staged' : file.area === 'untracked' ? 'untracked' : 'unstaged';
    return { src, path: file.path, ...orig };
  }
  if (selected === 'CMP') return { src: 'cmp', wt, path: file.path, ...orig };
  return { src: 'commit', sha: selected, path: file.path, ...orig };
}

export function formatBytes(n: number | null): string {
  if (n === null) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND_KEY = { A: 'git.kind.A', M: 'git.kind.M', D: 'git.kind.D', R: 'git.kind.R', C: 'git.kind.C', T: 'git.kind.T', X: 'git.kind.X', '?': 'git.kind.untracked' } as const satisfies Record<string, MessageKey>;

function Marked({ text, marks }: { text: string; marks?: Array<[number, number]> }) {
  if (!marks || !marks.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  marks.forEach(([s, e], i) => {
    if (s > pos) parts.push(text.slice(pos, s));
    parts.push(<mark key={i}>{text.slice(s, e)}</mark>);
    pos = e;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}

export function SpecialNotice({ special, onForce }: { special: DiffSpecial; onForce?: () => void }) {
  let body: ReactNode;
  switch (special.kind) {
    case 'binary': body = <b>{t('git.special.binary', { from: formatBytes(special.from), to: formatBytes(special.to) })}</b>; break;
    case 'large': body = <><b>{t('git.special.large', { add: special.add, del: special.del })}</b><span>{t('git.special.largeNote')}</span>{onForce && <button type="button" className="git-btn" data-force="" onClick={onForce}>{t('git.special.expandAnyway')}</button>}</>; break;
    case 'mode': body = <b>{t('git.special.mode', { from: special.from, to: special.to })}</b>; break;
    case 'eol': body = <><b>{t('git.special.eol', { from: special.from, to: special.to, count: special.count })}</b>{onForce && <button type="button" className="git-btn" data-force="" onClick={onForce}>{t('git.special.showAnyway')}</button>}</>; break;
    case 'wsOnly': body = <b>{t('git.special.wsOnly')}</b>; break;
    case 'symlink': body = <b>{t('git.special.symlink', { from: special.from ?? '—', to: special.to ?? '—' })}</b>; break;
    case 'lfs': body = <b>{t('git.special.lfs', { from: formatBytes(special.from), to: formatBytes(special.to) })}</b>; break;
    case 'submodule': body = <b>{t('git.special.submodule', { from: special.from ?? '—', to: special.to ?? '—' })}</b>; break;
    case 'encoding': body = <b>{t('git.special.encoding')}</b>; break;
    default: body = <b>{t('git.special.emptyNew')}</b>;
  }
  return <div className="git-notice">{body}</div>;
}

export interface GitDiffViewProps {
  sessionId: string;
  client: Pick<GitClient, 'diff'>;
  file: GitFileEntry | null;
  selected: string;
  wt: boolean;
  reloadKey: number;
  /** Width of the diff pane (for the folded options). */
  width: number;
  position: { index: number; total: number };
  onMoveFile: (delta: number) => void;
  onOpenEditor?: (path: string) => void;
  /** Repository root as git reports it (C:/a/b on Windows, /home/... in WSL). */
  root?: string;
}

/** Repository root + relative path, in the separator style of the root (as the tab path menu uses). */
export function editorPathFor(root: string, rel: string): string {
  if (/^[A-Za-z]:\//.test(root)) return `${root.replace(/\//g, '\\').replace(/\\$/, '')}\\${rel.replace(/\//g, '\\')}`;
  return `${root.replace(/\/$/, '')}/${rel}`;
}

export function GitDiffView({ sessionId, client, file, selected, wt, reloadKey, width, position, onMoveFile, onOpenEditor, root }: GitDiffViewProps) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [force, setForce] = useState(false);
  const [hunk, setHunk] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<'unified' | 'split'>('unified');
  const [reveal, setReveal] = useState<Record<string, GapReveal>>({});
  const [fullNew, setFullNew] = useState<string[] | null>(null);

  const request = useMemo(() => (file ? { ...diffRequestFor(selected, wt, file), ...(ignoreWs ? { ignoreWs: true } : {}), ...(force ? { force: true } : {}) } : null), [file, selected, wt, ignoreWs, force]);
  const requestKey = request ? JSON.stringify(request) : '';
  useEffect(() => { setForce(false); setHunk(0); setScrollTop(0); setReveal({}); setFullNew(null); }, [file?.key, selected]);
  useEffect(() => {
    if (!request) { setDiff(null); return; }
    const controller = new AbortController();
    setLoading(true);
    const slowTimer = setTimeout(() => setSlow(true), 400);
    const timer = setTimeout(() => {
      client.diff(sessionId, request, controller.signal).then((d) => { if (!controller.signal.aborted) setDiff(d); }, () => { if (!controller.signal.aborted) setDiff(null); })
        .finally(() => { if (!controller.signal.aborted) { setLoading(false); setSlow(false); clearTimeout(slowTimer); } });
    }, DEBOUNCE_MS);
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(slowTimer); };
    // requestKey stands for the request's content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sessionId, requestKey, reloadKey]);

  const baseRows = useMemo<DiffRow[]>(() => (diff && !diff.special ? buildDiffRows(diff.hunks, { gapAfter: diff.gapAfter }) : []), [diff]);
  const rows = useMemo<DiffRow[]>(() => (diff && fullNew ? expandGaps(baseRows, diff.hunks, reveal, fullNew) : baseRows), [baseRows, diff, reveal, fullNew]);
  const revealGap = useCallback((key: string, action: GapReveal) => {
    const apply = () => setReveal((r) => {
      const prev = r[key];
      const cur = typeof prev === 'object' ? prev : prev === 'all' ? { head: 1e9, tail: 0 } : prev === 'down20' ? { head: 20, tail: 0 } : prev === 'up20' ? { head: 0, tail: 20 } : { head: 0, tail: 0 };
      const next = action === 'all' ? 'all' : action === 'down20' ? { head: cur.head + 20, tail: cur.tail } : action === 'up20' ? { head: cur.head, tail: cur.tail + 20 } : action;
      return { ...r, [key]: next };
    });
    if (fullNew || !request) { apply(); return; }
    client.diff(sessionId, { ...request, full: true }).then((d) => {
      if (!d.full) return;
      const text = d.full.new.endsWith('\n') ? d.full.new.slice(0, -1) : d.full.new;
      setFullNew(text.split('\n'));
      apply();
    }, () => {});
  }, [client, fullNew, request, sessionId]);
  const hunkCount = diff?.hunks.length ?? 0;
  const maxDigits = useMemo(() => String(Math.max(1, ...rows.map((r) => (r.type === 'line' ? Math.max(r.o ?? 0, r.n ?? 0) : 0)))).length, [rows]);

  const goHunk = useCallback((delta: number) => {
    if (!hunkCount) return;
    setHunk((h) => {
      const next = Math.max(0, Math.min(hunkCount - 1, h + delta));
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-hunk-index="${next}"]`);
      el?.scrollIntoView?.({ block: 'start' });
      return next;
    });
  }, [hunkCount]);
  const onBodyKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n') { e.preventDefault(); goHunk(1); }
    else if (e.key === 'p') { e.preventDefault(); goHunk(-1); }
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewport(el.clientHeight || 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!file) return <div className="git-diff"><div className="git-notice">{t('git.files.none')}</div></div>;

  const compact = width < 600;
  const splitBlocked = width < 560 ? t('git.diff.splitTooNarrow') : (file.kind === 'A' || file.kind === 'D' || file.kind === '?') ? t('git.diff.splitOneSided') : '';
  const mode = splitBlocked ? 'unified' : view;
  const editable = selected === 'WORKTREE' && file.kind !== 'D' && !file.binary && !diff?.special;
  const options = (
    <>
      <span className="git-seg" role="group" aria-label={t('git.diff.view')}>
        <button type="button" data-view="unified" aria-pressed={mode === 'unified'} onClick={() => setView('unified')}>{t('git.diff.unified')}</button>
        <button type="button" data-view="split" aria-pressed={mode === 'split'} disabled={!!splitBlocked} title={splitBlocked || undefined} onClick={() => setView('split')}>{t('git.diff.split')}</button>
      </span>
      <label className="git-check"><input type="checkbox" data-opt="ws" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />{t('git.diff.ignoreWs')}</label>
      <label className="git-check"><input type="checkbox" data-opt="wrap" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />{t('git.diff.wrap')}</label>
    </>
  );
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const pathTitle = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
  const virtual = rows.length > VIRTUAL_FROM;
  const range = virtual ? virtualRange({ scrollTop, viewport, rowHeight: ROW_H, total: rows.length, overscan: 20 }) : { start: 0, end: rows.length };
  const noWidth = `calc(${maxDigits}ch + 8px)`;

  const renderRow = (r: DiffRow, i: number) => {
    if (r.type === 'hunk') return <div key={`h${i}`} className="git-hunk" data-hunk-index={r.index}>{r.header}</div>;
    if (r.type === 'gap') {
      const key = r.at === 'between' ? `between:${r.hunk}` : r.at;
      return (
        <div key={`g${i}`} className="git-gap" data-gap={r.at}>
          <span>{t('git.diff.hidden', { count: r.count })}</span>
          {r.at === 'between'
            ? <>
                <button type="button" onClick={() => revealGap(key, 'up20')}>{t('git.diff.expandUp')}</button>
                <button type="button" onClick={() => revealGap(key, 'down20')}>{t('git.diff.expandDown')}</button>
                <button type="button" onClick={() => revealGap(key, 'all')}>{t('git.diff.expandAll')}</button>
              </>
            : <button type="button" onClick={() => revealGap(key, 'all')}>{t('git.diff.expand')}</button>}
        </div>
      );
    }
    const cls = r.k === '+' ? ' add' : r.k === '-' ? ' del' : '';
    return (
      <div key={`l${i}`} className={`git-dl${cls}`} style={virtual ? { height: ROW_H } : undefined}>
        <span className="git-dl-no" style={{ width: noWidth }}>{r.o ?? ''}</span>
        <span className="git-dl-no" style={{ width: noWidth }}>{r.n ?? ''}</span>
        <span className="git-dl-sign" aria-hidden="true">{r.k === ' ' ? '' : r.k === '-' ? '−' : '+'}</span>
        <span className="git-dl-text"><Marked text={r.t} marks={r.marks} /></span>
      </div>
    );
  };

  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <span className="git-file-kind" data-kind={file.kind} aria-label={t(KIND_KEY[file.kind])}>{file.kind === 'X' ? '!' : file.kind}</span>
        <span className="git-diff-path" title={pathTitle}>
          {file.origPath
            ? <><span className="git-diff-pp"><bdi>{file.origPath.split('/').pop()}</bdi></span><span>→</span><span className="git-diff-pp"><bdi>{name}</bdi></span>{file.similarity !== undefined && <span className="git-muted">(R{file.similarity}%)</span>}</>
            : <span className="git-diff-pp"><bdi><span className="git-muted">{file.path.slice(0, slash + 1)}</span>{name}</bdi></span>}
        </span>
        {!file.binary && <span className="git-add">+{file.add}</span>}
        {!file.binary && <span className="git-del">−{file.del}</span>}
        <span className="git-muted git-diff-pos">
          {t('git.diff.position', { file: position.index + 1, files: position.total })}
          {hunkCount > 0 && ` · ${t('git.diff.hunkPosition', { hunk: hunk + 1, hunks: hunkCount })}`}
          {ignoreWs && ` · ${t('git.diff.ignoringWs')}`}
        </span>
        <span className="git-spacer" />
        <button type="button" className="git-icon-btn" data-nav="prev" aria-label={t('git.diff.prevFile')} title={t('git.diff.prevFile')} onClick={() => onMoveFile(-1)}>‹</button>
        <button type="button" className="git-icon-btn" data-nav="next" aria-label={t('git.diff.nextFile')} title={t('git.diff.nextFile')} onClick={() => onMoveFile(1)}>›</button>
        {compact
          ? <details className="git-view-menu"><summary role="button">{t('git.diff.view')} ▾</summary><div className="git-view-menu-body">{options}</div></details>
          : options}
        {selected === 'WORKTREE' && onOpenEditor && (
          <button
            type="button"
            className="git-btn"
            data-open-editor=""
            disabled={!editable || !root}
            title={editable ? undefined : t('git.diff.openEditorDisabled')}
            onClick={() => root && onOpenEditor(editorPathFor(root, file.path))}
          >
            {t('git.diff.openEditor')}
          </button>
        )}
      </div>
      <div
        ref={bodyRef}
        className={`git-diff-body${wrap ? ' wrap' : ''}`}
        tabIndex={0}
        aria-label={t('git.diff.body')}
        aria-busy={loading}
        onKeyDown={onBodyKey}
        onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
      >
        {loading && slow && <div className="git-diff-loading" aria-label={t('git.diff.loading')}><div className="git-skel" /><div className="git-skel" /><div className="git-skel" /></div>}
        {!loading && diff?.special && <SpecialNotice special={diff.special} onForce={diff.special.kind === 'large' || diff.special.kind === 'eol' ? () => setForce(true) : undefined} />}
        {!loading && diff && !diff.special && rows.length === 0 && <div className="git-notice">{t('git.diff.noChanges')}</div>}
        {!(loading && slow) && !diff?.special && mode === 'split' && <SplitPanes rows={rows} renderRow={renderRow} noWidth={noWidth} />}
        {!(loading && slow) && !diff?.special && mode === 'unified' && (virtual
          ? <div style={{ height: rows.length * ROW_H, position: 'relative' }}><div style={{ position: 'absolute', top: range.start * ROW_H, left: 0, right: 0 }}>{rows.slice(range.start, range.end).map((r, i) => renderRow(r, range.start + i))}</div></div>
          : rows.map(renderRow))}
      </div>
    </div>
  );
}

function SplitPanes({ rows, renderRow, noWidth }: { rows: DiffRow[]; renderRow: (r: DiffRow, i: number) => ReactNode; noWidth: string }) {
  const left = useRef<HTMLDivElement | null>(null);
  const right = useRef<HTMLDivElement | null>(null);
  const syncing = useRef(false);
  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => { syncing.current = false; });
  };
  const pairs = pairSplitRows(rows);
  const cell = (line: Extract<DiffRow, { type: 'line' }> | null, side: 'l' | 'r', i: number) => {
    if (!line) return <div key={`e${i}`} className="git-dl empty"><span className="git-dl-no" style={{ width: noWidth }} /><span className="git-dl-sign" /><span className="git-dl-text"> </span></div>;
    const cls = line.k === '+' ? ' add' : line.k === '-' ? ' del' : '';
    return (
      <div key={`${side}${i}`} className={`git-dl${cls}`}>
        <span className="git-dl-no" style={{ width: noWidth }}>{side === 'l' ? line.o ?? '' : line.n ?? ''}</span>
        <span className="git-dl-sign" aria-hidden="true">{line.k === ' ' ? '' : line.k === '-' ? '−' : '+'}</span>
        <span className="git-dl-text"><Marked text={line.t} marks={line.marks} /></span>
      </div>
    );
  };
  const side = (s: 'l' | 'r') => pairs.map((p, i) => (p.type === 'pair' ? cell(s === 'l' ? p.left : p.right, s, i) : <div key={`x${i}`}>{renderRow(p, i)}</div>));
  return (
    <div className="git-split">
      <div className="git-split-pane" ref={left} onScroll={() => sync(left.current, right.current)}>{side('l')}</div>
      <div className="git-split-pane" ref={right} onScroll={() => sync(right.current, left.current)}>{side('r')}</div>
    </div>
  );
}
