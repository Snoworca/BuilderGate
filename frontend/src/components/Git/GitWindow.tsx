/**
 * A session's Git window: a modeless window like the editor's, with the commit graph
 * on the left and the commit detail, file list and diff on the right.
 * Escape does nothing (as in WindowDialog); minimize sends it to the tray.
 *
 * @req FR-GIT-004
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  /** The graph pane (T12b) and the right side (T13/T14). */
  graph?: (width: number) => ReactNode;
  side?: ReactNode;
}

export function GitWindow({ sessionId, sessionName, cascade, onMinimize, onClose, onFocus, store, graph, side }: GitWindowProps) {
  const git = useGitSummary(sessionId, { visible: true, running: false, mode: 'window', store });
  const summary = git.summary?.repo ? git.summary : null;
  const repo = summary ? summary.root.split(/[\\/]/).filter(Boolean).pop() ?? summary.root : '';
  const branch = summary ? (summary.detached ? (summary.head ?? '').slice(0, 7) : summary.branch ?? '') : '';
  const [split, setSplit] = useState(DEFAULT_SPLIT);
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
      <div className="git-window-body" onPointerDown={onFocus} style={{ gridTemplateColumns: `minmax(380px, ${Math.round(split * 100)}%) 6px minmax(360px, 1fr)` }}>
        <div className="git-pane-graph" data-pane="graph" ref={graphRef}>{graph?.(graphWidth)}</div>
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
        <div className="git-pane-side" data-pane="side">{side}</div>
      </div>
    </WindowDialog>
  );
}
