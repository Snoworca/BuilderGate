/**
 * A session's Git window: a modeless window like the editor's, with the commit graph
 * on the left and the commit detail, file list and diff on the right.
 * Escape does nothing (as in WindowDialog); minimize sends it to the tray.
 *
 * @req FR-GIT-004
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { GitClient, LogScope } from './gitApi.ts';
import { GitGraphList } from './GitGraphList.tsx';
import { GitWindowBanner, pickGitBanner } from './GitWindowBanner.tsx';
import { GitSidePanel, type GitDiffContext, type GitFileEntry } from './GitSidePanel.tsx';
import { GitDiffView } from './GitDiffView.tsx';
import type { GitCompare, GitLogCommit } from './gitApi.ts';
import type { GitOpenTarget } from './gitWindowModel.ts';
import { gitApi } from '../../services/api.ts';
import { WindowDialog } from '../dialog/WindowDialog';
import { IconButton } from '../common';
import type { GitSummaryStore } from './gitSummaryStore.ts';
import { useGitSummary } from './useGitSummary.ts';
import { CASCADE_PX } from './gitWindowModel.ts';
import { t } from '../../i18n/i18n.ts';
import './gitViewer.css';

export const GIT_WINDOW_MIN_SIZE = { width: 760, height: 420 } as const;
const DEFAULT_SPLIT = 0.46;
const SPLIT_STEP = 16;

/** Columns of the commit list a graph pane of this width can show. */
export function graphColumns(width: number): { author: boolean; sha: boolean } {
  return { author: width >= 520, sha: width >= 450 };
}

export function clampSplit(ratio: number): number {
  return Math.min(0.7, Math.max(0.3, ratio));
}

export function defaultGitWindowRect(cascade: number, viewport = { width: typeof window === 'undefined' ? 1440 : window.innerWidth, height: typeof window === 'undefined' ? 900 : window.innerHeight }) {
  const width = Math.max(GIT_WINDOW_MIN_SIZE.width, Math.round(viewport.width * 0.5));
  const height = Math.max(GIT_WINDOW_MIN_SIZE.height, Math.round(viewport.height * 0.9));
  const offset = cascade * CASCADE_PX;
  return { x: Math.max(0, viewport.width - width - 16) - offset, y: 16 + offset, width, height };
}

export interface GitWindowProps {
  sessionId: string;
  sessionName: string;
  cascade: number;
  onMinimize: () => void;
  onClose: () => void;
  onFocus: () => void;
  store?: GitSummaryStore;
  client?: GitClient;
  /** The last open request (target and nonce) from the chip, the menu or the tray. */
  request?: { target: GitOpenTarget; nonce: number };
  nameOf?: (sessionId: string) => string;
  /** The session's cwd as the tab reports it, for the "moved" banner. */
  cwd?: string | null;
  /** The session is gone: keep the last state, stop refreshing. */
  ended?: boolean;
  /** Replaces the diff of the selected file (tests). */
  renderDiff?: (file: GitFileEntry | null, ctx: GitDiffContext) => ReactNode;
  /** Opens a working-tree file in the editor (FR-GIT-007). */
  onOpenEditor?: (path: string) => void;
}

export function GitWindow({ sessionId, sessionName, cascade, onMinimize, onClose, onFocus, store, client = gitApi, request, nameOf = (id) => id, cwd = null, ended = false, renderDiff, onOpenEditor }: GitWindowProps) {
  // "Keep this window" after a move freezes the window on what it showed.
  const [frozen, setFrozen] = useState(false);
  const git = useGitSummary(sessionId, { visible: !ended && !frozen, running: false, mode: 'window', store, cwd });
  const live = git.summary;
  const [root0, setRoot0] = useState<string | null>(null);
  const [shown, setShown] = useState(live);
  useEffect(() => {
    if (!live || frozen) return;
    if (root0 === null && live.repo) setRoot0(live.root);
    if (root0 === null || (live.repo && live.root === root0)) setShown(live);
  }, [live, frozen, root0]);
  const summary = shown?.repo ? shown : null;
  const moved = !frozen && root0 !== null && live !== null && (!live.repo || live.root !== root0)
    ? { path: cwd ?? '', repo: live.repo }
    : null;
  const repo = summary ? summary.root.split(/[\\/]/).filter(Boolean).pop() ?? summary.root : '';
  const branch = summary ? (summary.detached ? (summary.head ?? '').slice(0, 7) : summary.branch ?? '') : '';
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [scope, setScope] = useState<LogScope>('head');
  const [selected, setSelected] = useState<string>('');
  const [reloadKey, setReloadKey] = useState(0);
  const applied = useRef<number>(-1);
  // FR-GIT-003: what the chip or menu asked for: the uncommitted row when there are
  // changes (or when asked), else HEAD; "compare" switches the scope.
  useEffect(() => {
    if (!summary) return;
    const nonce = request?.nonce ?? 0;
    if (applied.current === nonce) return;
    applied.current = nonce;
    const target = request?.target ?? 'auto';
    if (target === 'compare' && 'ref' in summary.compare) { setScope('cmp'); setSelected('CMP'); return; }
    setScope('head');
    setSelected(target === 'worktree' || summary.counts.paths > 0 ? 'WORKTREE' : summary.head ?? '');
  }, [request, summary]);
  // A new HEAD or a changed working tree reloads the list; the selection stays by sha.
  const headKey = summary ? `${summary.head}:${summary.counts.paths}` : '';
  useEffect(() => { setReloadKey((k) => k + 1); }, [headKey]);
  // FR-GIT-009: the selected commit vanishing (amend, reset, rebase) keeps it on screen.
  const subjects = useRef(new Map<string, string>());
  const [loadedKeys, setLoadedKeys] = useState<Set<string> | null>(null);
  const onLoaded = useCallback((commits: GitLogCommit[]) => {
    for (const c of commits) subjects.current.set(c.sha, c.subject);
    setLoadedKeys(new Set(commits.map((c) => c.sha)));
  }, []);
  const vanished = loadedKeys && selected && selected !== 'WORKTREE' && selected !== 'CMP' && !loadedKeys.has(selected) && subjects.current.has(selected)
    ? { sha: selected, subject: subjects.current.get(selected) ?? '' }
    : null;
  const [compare, setCompare] = useState<GitCompare | null>(null);
  const banner = pickGitBanner({
    ended,
    moved,
    vanished,
    compare: scope === 'cmp' && compare ? { base: compare.base.ref, mergeBase: compare.mergeBase, commits: compare.commits.length, fetchedAt: compare.fetchedAt } : null,
  });
  const [graphWidth, setGraphWidth] = useState(600);

  const onSplitKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const total = e.currentTarget.parentElement?.clientWidth || 1000;
    setSplit((s) => clampSplit(s + ((e.key === 'ArrowRight' ? 1 : -1) * SPLIT_STEP) / total));
  }, []);
  const onSplitDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const body = handle.parentElement;
    if (!body) return;
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = body.getBoundingClientRect();
      if (r.width > 0) setSplit(clampSplit((ev.clientX - r.left) / r.width));
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }, []);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const sideRef = useRef<HTMLDivElement | null>(null);
  const [sideWidth, setSideWidth] = useState(800);
  useLayoutEffect(() => {
    const el = sideRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSideWidth(el.clientWidth || 800));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setGraphWidth(el.clientWidth || 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <WindowDialog
      dialogId={`git-window-${sessionId}`}
      title={t('git.window.title', { repo: repo || sessionName })}
      mode="modeless"
      defaultRect={defaultGitWindowRect(cascade)}
      minSize={GIT_WINDOW_MIN_SIZE}
      onClose={onClose}
      showCloseButton
      surfaceClassName="git-window"
      titlebarActions={(
        <>
          <span className="git-window-sub">{t('git.window.subtitle', { session: sessionName, branch })}</span>
          <IconButton icon="minimize" label={t('git.window.minimize')} onClick={onMinimize} />
        </>
      )}
    >
      <GitWindowBanner
        banner={banner}
        onFollow={() => { setRoot0(live?.repo ? live.root : null); setShown(live); setSelected(''); applied.current = -1; }}
        onStay={() => setFrozen(true)}
        onLatestHead={() => setSelected(summary?.head ?? '')}
      />
      <div className="git-window-body" onPointerDown={onFocus} style={{ gridTemplateColumns: `minmax(380px, ${Math.round(split * 100)}%) 6px minmax(360px, 1fr)` }}>
        <div className="git-pane-graph" data-pane="graph" ref={graphRef}>
          <GitGraphList
            sessionId={sessionId}
            client={client}
            summary={summary}
            scope={scope}
            onScope={(next) => { setScope(next); if (next === 'cmp') setSelected('CMP'); else if (selected === 'CMP') setSelected(summary?.head ?? ''); }}
            selected={selected}
            onSelect={setSelected}
            width={graphWidth}
            reloadKey={reloadKey}
            nameOf={nameOf}
            vanished={vanished}
            onLoaded={onLoaded}
            onCompare={setCompare}
          />
        </div>
        <div
          className="git-vsplit"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('git.window.splitter')}
          aria-valuemin={30}
          aria-valuemax={70}
          aria-valuenow={Math.round(split * 100)}
          tabIndex={0}
          onKeyDown={onSplitKey}
          onPointerDown={onSplitDrag}
          onDoubleClick={() => setSplit(DEFAULT_SPLIT)}
        />
        <div className="git-pane-side" data-pane="side" ref={sideRef}>
          <GitSidePanel
            sessionId={sessionId}
            client={client}
            summary={summary}
            selected={selected}
            reloadKey={reloadKey}
            onSelectCommit={setSelected}
            diff={(file, ctx) => (renderDiff ? renderDiff(file, ctx) : (
              <GitDiffView
                sessionId={sessionId}
                client={client}
                file={file}
                selected={ctx.selected}
                wt={ctx.wt}
                reloadKey={reloadKey}
                width={sideWidth}
                position={ctx.position}
                onMoveFile={ctx.moveFile}
                onOpenEditor={onOpenEditor}
              />
            ))}
          />
        </div>
      </div>
    </WindowDialog>
  );
}
