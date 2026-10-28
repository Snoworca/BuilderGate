/**
 * A session's Git window: a modeless window like the editor's, with the commit graph
 * on the left and the commit detail, file list and diff on the right.
 * Escape does nothing (as in WindowDialog); minimize sends it to the tray.
 *
 * @req FR-GIT-004
 * @req FR-GIT-009
 * @req FR-GIT-010
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
import { gitSummaryStore } from './gitStores.ts';
import { CASCADE_PX } from './gitWindowModel.ts';
import { activeLanguage, t } from '../../i18n/i18n.ts';
import { formatRelativeTime } from '../../utils/relativeTime.ts';
import { MOBILE_LAYOUT_QUERY } from '../../utils/layoutMode.ts';
import './gitViewer.css';

export const GIT_WINDOW_MIN_SIZE = { width: 760, height: 420 } as const;
const DEFAULT_SPLIT = 0.46;
const SPLIT_STEP = 16;
const CHECKED_TICK_MS = 10_000;
export const GIT_MOBILE_BELOW = 900;

/** True while the viewport is narrower than the phone breakpoint, or the app shows its mobile layout (FR-UIDS-015). */
function useNarrowViewport(): boolean {
  const read = () => (typeof window === 'undefined'
    ? false
    : window.innerWidth < GIT_MOBILE_BELOW || window.matchMedia(MOBILE_LAYOUT_QUERY).matches);
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    const onResize = () => setNarrow(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

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
  /** Phone layout (FR-GIT-010); by default the viewport width decides. */
  mobile?: boolean;
}

export function GitWindow({ sessionId, sessionName, cascade, onMinimize, onClose, onFocus, store, client = gitApi, request, nameOf = (id) => id, cwd = null, ended = false, renderDiff, onOpenEditor, mobile: mobileProp }: GitWindowProps) {
  const narrow = useNarrowViewport();
  const mobile = mobileProp ?? narrow;
  // "Keep this window" after a move freezes the window on what it showed.
  const [frozen, setFrozen] = useState(false);
  const git = useGitSummary(sessionId, { visible: !ended && !frozen, running: false, mode: 'window', store, cwd });
  const live = git.summary;
  const [root0, setRoot0] = useState<string | null>(null);
  const [shown, setShown] = useState(live);
  // FR-GIT-009: with auto refresh off, a new state waits behind a badge on the list.
  const [auto, setAuto] = useState(true);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), CHECKED_TICK_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!live || frozen) return;
    setCheckedAt(Date.now());
    if (root0 === null && live.repo) setRoot0(live.root);
    if (root0 === null) { setShown(live); return; }
    if (live.repo && live.root === root0 && (auto || !shown)) setShown(live);
    // shown is read only to tell the first answer apart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, frozen, root0, auto]);
  const summary = shown?.repo ? shown : null;
  const pending = !auto && live?.repo && summary && live.root === summary.root && (live.head !== summary.head || JSON.stringify(live.counts) !== JSON.stringify(summary.counts));
  const refresh = useCallback(() => { (store ?? gitSummaryStore()).refresh(sessionId); }, [store, sessionId]);
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
  // The uncommitted row vanishing (a commit, a stash, a reset) moves to HEAD with a note.
  const [toast, setToast] = useState<'committed' | 'discarded' | null>(null);
  const prevSummary = useRef(summary);
  useEffect(() => {
    const prev = prevSummary.current;
    prevSummary.current = summary;
    if (!prev || !summary || selected !== 'WORKTREE' || summary.counts.paths > 0 || prev.counts.paths === 0) return;
    setSelected(summary.head ?? '');
    setToast(prev.head !== summary.head ? 'committed' : 'discarded');
    // Runs when the shown summary changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);
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
  // FR-GIT-010: on a phone the window is a stack of list (0), commit (1) and diff (2).
  // Each step has a history entry, so the browser's back steps out and finally closes.
  const [step, setStep] = useState(0);
  const stepRef = useRef(0);
  const closing = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useLayoutEffect(() => {
    if (!mobile) return;
    // A soft keyboard (the terminal's input) goes down before the window opens.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active.matches('input, textarea, select, [contenteditable]')) active.blur();
    window.history.pushState({ gitWindow: sessionId, step: 0 }, '');
    stepRef.current = 0;
    setStep(0);
    const onPop = () => {
      if (closing.current) return;
      if (stepRef.current > 0) { stepRef.current -= 1; setStep(stepRef.current); return; }
      closing.current = true;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [mobile, sessionId]);
  const goStep = useCallback((next: number) => {
    while (stepRef.current < next) {
      stepRef.current += 1;
      window.history.pushState({ gitWindow: sessionId, step: stepRef.current }, '');
    }
    setStep(stepRef.current);
  }, [sessionId]);
  const closeMobile = useCallback(() => {
    closing.current = true;
    const entries = stepRef.current + 1;
    onCloseRef.current();
    window.history.go(-entries);
  }, []);
  // R refreshes from anywhere in the window except a text field.
  const onWindowKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'r' && e.key !== 'R')) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    refresh();
  }, [refresh]);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const sideRef = useRef<HTMLDivElement | null>(null);
  const [sideWidth, setSideWidth] = useState(800);
  useLayoutEffect(() => {
    const el = sideRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSideWidth(el.clientWidth || 800));
    observer.observe(el);
    return () => observer.disconnect();
  }, [mobile]);
  useLayoutEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setGraphWidth(el.clientWidth || 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, [mobile]);

  const title = t('git.window.title', { repo: repo || sessionName });
  const subtitle = t('git.window.subtitle', { session: sessionName, branch });
  const bannerEl = (
    <GitWindowBanner
      banner={banner}
      onFollow={() => { setRoot0(live?.repo ? live.root : null); setShown(live); setSelected(''); applied.current = -1; }}
      onStay={() => setFrozen(true)}
      onLatestHead={() => setSelected(summary?.head ?? '')}
    />
  );
  const toolsEl = (
    <div className="git-window-tools">
      <label className="git-check"><input type="checkbox" data-opt="auto" checked={auto} onChange={(e) => { setAuto(e.target.checked); if (e.target.checked && live) setShown(live); }} />{t('git.window.autoRefresh')}</label>
      <button type="button" className="git-icon-btn" data-refresh="" aria-label={t('git.window.refresh')} title={t('git.window.refresh')} onClick={refresh}>↻</button>
      <span className="git-muted" data-checked="">{t('git.window.checked', { time: formatRelativeTime((frozen || !auto ? undefined : git.checkedAt) ?? checkedAt, Date.now(), activeLanguage(), t('git.time.justNow')) })}</span>
      <span className="git-spacer" />
      <span role="status" className="git-window-status">
        {pending && <button type="button" className="git-badge" data-list-badge="" onClick={() => live && setShown(live)}>{t('git.window.listBadge')}</button>}
        {toast && <span className="git-toast" data-toast={toast}>{t(toast === 'committed' ? 'git.window.committed' : 'git.window.discarded')}</span>}
      </span>
    </div>
  );
  const graphEl = (
    <GitGraphList
      sessionId={sessionId}
      client={client}
      summary={summary}
      scope={scope}
      onScope={(next) => { setScope(next); if (next === 'cmp') setSelected('CMP'); else if (selected === 'CMP') setSelected(summary?.head ?? ''); }}
      selected={selected}
      onSelect={setSelected}
      onOpen={mobile ? () => goStep(1) : undefined}
      width={graphWidth}
      reloadKey={reloadKey}
      nameOf={nameOf}
      vanished={vanished}
      onLoaded={onLoaded}
      onCompare={setCompare}
    />
  );
  const sideEl = (
    <GitSidePanel
      sessionId={sessionId}
      client={client}
      summary={summary}
      selected={selected}
      reloadKey={reloadKey}
      onSelectCommit={setSelected}
      layout={mobile ? (step === 2 ? 'diff' : 'files') : undefined}
      onOpenFile={mobile ? () => goStep(2) : undefined}
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
          root={summary?.root}
          mobile={mobile}
        />
      ))}
    />
  );

  if (mobile) {
    return (
      <div className="git-mobile" role="dialog" aria-modal="true" aria-label={title} data-step={step} onKeyDown={onWindowKey}>
        <div className="git-mobile-head">
          <button type="button" className="git-mobile-btn" data-back="" aria-label={t('git.window.back')} onClick={() => window.history.back()}>‹</button>
          <span className="git-mobile-title"><b>{title}</b><span className="git-window-sub">{subtitle}</span></span>
          <button type="button" className="git-mobile-btn" data-close="" aria-label={t('common.close')} onClick={closeMobile}>×</button>
        </div>
        {bannerEl}
        {toolsEl}
        <div className="git-mobile-step" data-pane="graph" ref={graphRef} hidden={step !== 0}>{graphEl}</div>
        <div className="git-mobile-step" data-pane="side" ref={sideRef} hidden={step === 0}>{sideEl}</div>
      </div>
    );
  }

  return (
    <WindowDialog
      dialogId={`git-window-${sessionId}`}
      title={title}
      mode="modeless"
      defaultRect={defaultGitWindowRect(cascade)}
      minSize={GIT_WINDOW_MIN_SIZE}
      onClose={onClose}
      showCloseButton
      surfaceClassName="git-window"
      titlebarActions={(
        <>
          <span className="git-window-sub">{subtitle}</span>
          <IconButton icon="minimize" label={t('git.window.minimize')} onClick={onMinimize} />
        </>
      )}
    >
      {bannerEl}
      {toolsEl}
      <div className="git-window-body" onPointerDown={onFocus} onKeyDown={onWindowKey} style={{ gridTemplateColumns: `minmax(380px, ${Math.round(split * 100)}%) 6px minmax(360px, 1fr)` }}>
        <div className="git-pane-graph" data-pane="graph" ref={graphRef}>{graphEl}</div>
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
        <div className="git-pane-side" data-pane="side" ref={sideRef}>{sideEl}</div>
      </div>
    </WindowDialog>
  );
}
