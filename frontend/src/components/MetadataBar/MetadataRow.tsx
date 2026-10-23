import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { useDoubleTap } from '../../hooks/useDoubleTap';
import { DOUBLE_TAP_WINDOW_MS } from '../../hooks/doubleTap';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { getRecoveryIconLabel } from '../../types/recoveryOption';
import { useInlineRename } from '../../hooks/useInlineRename';
import { copyTextToClipboard, resolveCopyOutcome } from '../../utils/clipboardCopy';
import { recordTerminalDebugEvent } from '../../utils/terminalDebugCapture';
import { t } from '../../i18n/i18n.ts';
import { GitBranchChip, gitChipLabel } from '../Git/GitBranchChip.tsx';
import { GitChipTooltip, GitErrorPopover } from '../Git/GitChipPopups.tsx';
import { buildGitChipMenu } from '../Git/gitChipMenu.ts';
import { gitSummaryStore } from '../Git/gitStores.ts';
import { ContextMenu } from '../ContextMenu/ContextMenu.tsx';
import { availableChipWidth, chipView, nameMaxWidth, stageFor } from '../Git/gitChipModel.ts';
import { useGitSummary } from '../Git/useGitSummary.ts';
import type { GitSummaryStore } from '../Git/gitSummaryStore.ts';

interface Props {
  tab: WorkspaceTabRuntime;
  onRename?: (name: string) => void;
  /** Right click on the cwd path. Both render sites pass it. @req FR-MDE-007 */
  onPathContextMenu?: (x: number, y: number) => void;
  /** Opens the session's Git window; passing it turns the branch chip on. @req FR-GIT-003 */
  onOpenGitWindow?: (sessionId: string, target?: 'auto' | 'worktree' | 'compare') => void;
  /** Tests pass their own store; passing it also turns the chip on. */
  gitStore?: GitSummaryStore;
}

function formatElapsed(createdAt: string): string {
  const elapsed = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (elapsed < 0) return '00:00';
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/** Truncate absolute path if it would exceed ~30% of status bar width.
 *  Heuristic: status bar ≈ 50 chars at 12px mono. 30% ≈ 15 chars budget.
 *  Subtract name (~10) + elapsed (~8) + padding → path budget ≈ 30 chars.
 */
function truncatePath(cwd: string, maxChars = 30): string {
  if (cwd.length <= maxChars) return cwd;
  // Find last separator
  const sep = cwd.includes('/') ? '/' : '\\';
  const lastSep = cwd.lastIndexOf(sep);
  if (lastSep <= 0) return cwd;
  const tail = cwd.slice(lastSep);
  if (tail.length >= maxChars - 4) return '...' + tail.slice(-(maxChars - 3));
  return '...' + tail;
}

function getSafeRecoveryIconLabel(recoveryIcon: WorkspaceTabRuntime['recoveryIcon']): string | null {
  if (recoveryIcon?.type === 'builtin') {
    return getRecoveryIconLabel(recoveryIcon);
  }
  if (recoveryIcon?.type === 'text' && typeof recoveryIcon.value === 'string') {
    return getRecoveryIconLabel(recoveryIcon);
  }
  // Unsupported persisted icons are omitted.
  return null;
}

/** Git errors that mean "no chip": git missing on the server, or not a repository. */
const SILENT_GIT_ERRORS = new Set(['GIT_UNAVAILABLE', 'NOT_A_REPO', 'SESSION_NOT_FOUND']);

export function MetadataRow({ tab, onRename, onPathContextMenu, onOpenGitWindow, gitStore }: Props) {
  // FR-GIT-001/002: the branch chip. The row measures itself: its width picks the chip's
  // stage, and a width of 0 (display:none) means nobody sees it, so it stops polling.
  const gitEnabled = onOpenGitWindow !== undefined || gitStore !== undefined;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLSpanElement | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !gitEnabled) return;
    const measure = () => setRowWidth(row.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [gitEnabled]);
  const git = useGitSummary(tab.sessionId, {
    visible: gitEnabled && rowWidth > 0,
    running: tab.status === 'running',
    mode: 'chip',
    status: tab.status,
    cwd: tab.cwd,
    store: gitStore,
  });
  const repoSummary = git.summary?.repo ? git.summary : null;
  const showErrorChip = !repoSummary && git.error !== null && !SILENT_GIT_ERRORS.has(git.error);
  const stageRef = useRef<number | undefined>(undefined);
  const stage = stageFor(availableChipWidth(rowWidth, nameRef.current?.scrollWidth ?? 0), stageRef.current);
  stageRef.current = stage;
  const isRepo = gitEnabled && repoSummary !== null;
  const view = chipView(repoSummary ? {
    branch: repoSummary.branch, detached: repoSummary.detached, head: repoSummary.head, upstream: repoSummary.upstream,
    ahead: repoSummary.ahead, behind: repoSummary.behind, base: repoSummary.base, operation: repoSummary.operation,
    paths: repoSummary.counts.paths, untrackedScan: repoSummary.untrackedScan, stale: git.stale,
  } : null, stage, isRepo);
  const nameMax = isRepo ? nameMaxWidth(stage, rowWidth) : 150;


  const [elapsed, setElapsed] = useState(() => formatElapsed(tab.createdAt));
  const [copyAttempt, setCopyAttempt] = useState<{ ok: boolean } | null>(null);

  const rename = useInlineRename({ onRename: onRename ?? (() => {}) });

  useEffect(() => {
    const timer = setInterval(() => setElapsed(formatElapsed(tab.createdAt)), 1000);
    return () => clearInterval(timer);
  }, [tab.createdAt]);

  // Issue #83: a copy that did not happen must not be indistinguishable from one
  // that did. The previous bare catch left no trace anywhere, so the badge simply
  // never appeared - which is also what the user sees before clicking - and they
  // pasted the clipboard's previous contents believing it had worked.
  // FR-UIDS-013: after a touch tap the copied badge waits out the double-tap window. The badge
  // is shorter than the path and the span is right-aligned, so showing it at once moved the
  // path from under the finger and the second tap of a double tap missed it.
  const lastTouchEndRef = useRef(0);
  const handleCopy = useCallback(async () => {
    if (!tab.cwd) return;
    const feedbackDelay = Date.now() - lastTouchEndRef.current < 1000 ? DOUBLE_TAP_WINDOW_MS : 0;
    let attempt: { ok: boolean };
    try {
      await copyTextToClipboard(tab.cwd);
      attempt = { ok: true };
    } catch (error) {
      attempt = { ok: false };
      recordTerminalDebugEvent(tab.sessionId, 'metadata_cwd_copy_failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    setTimeout(() => setCopyAttempt(attempt), feedbackDelay);
    setTimeout(() => setCopyAttempt(null), feedbackDelay + 1500);
  }, [tab.cwd, tab.sessionId]);

  // FR-GIT-003: the chip's menu, tooltip and error popover.
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [chipMenu, setChipMenu] = useState<{ x: number; y: number } | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const tipHide = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressTipOnFocus = useRef(false);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout> | null; at: number }>({ timer: null, at: 0 });
  const tipId = `git-tip-${tab.id}`;
  const openGit = useCallback((target?: 'auto' | 'worktree' | 'compare') => onOpenGitWindow?.(tab.sessionId, target), [onOpenGitWindow, tab.sessionId]);
  const showTip = useCallback(() => {
    if (tipHide.current) { clearTimeout(tipHide.current); tipHide.current = null; }
    setTipOpen(true);
  }, []);
  const hideTipSoon = useCallback(() => {
    if (tipHide.current) clearTimeout(tipHide.current);
    tipHide.current = setTimeout(() => setTipOpen(false), 100);
  }, []);
  useEffect(() => () => { if (tipHide.current) clearTimeout(tipHide.current); if (longPress.current.timer) clearTimeout(longPress.current.timer); }, []);
  useEffect(() => {
    if (!tipOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTipOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tipOpen]);
  const openChipMenu = useCallback((x: number, y: number) => { setTipOpen(false); setChipMenu({ x, y }); }, []);
  const chipMenuItems = useMemo(() => (chipMenu && repoSummary ? buildGitChipMenu({
    summary: repoSummary,
    cwdHidden: !view.showCwd,
    onOpen: () => openGit('auto'),
    onOpenWorktree: () => openGit('worktree'),
    onCompare: () => openGit('compare'),
    onCopy: (text) => { void copyTextToClipboard(text).catch(() => {}); },
    onCopyPath: () => { void handleCopy(); },
    onPathMenu: () => onPathContextMenu?.(chipMenu.x, chipMenu.y),
  }) : []), [chipMenu, repoSummary, view.showCwd, openGit, handleCopy, onPathContextMenu]);
  const closeChipMenu = useCallback(() => {
    setChipMenu(null);
    suppressTipOnFocus.current = true;
    chipRef.current?.focus();
  }, []);
  const chipButtonProps = repoSummary ? {
    'aria-describedby': tipOpen ? tipId : undefined,
    onMouseEnter: showTip,
    onMouseLeave: hideTipSoon,
    onFocus: () => { if (suppressTipOnFocus.current) { suppressTipOnFocus.current = false; return; } showTip(); },
    onBlur: () => setTipOpen(false),
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - longPress.current.at < 800) return;
      openChipMenu(e.clientX, e.clientY);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        openChipMenu(r.left, r.top);
      }
    },
    onTouchStart: () => {
      longPress.current.timer = setTimeout(() => {
        longPress.current.at = Date.now();
        const r = chipRef.current?.getBoundingClientRect();
        openChipMenu(r?.left ?? 0, r?.top ?? 0);
      }, 500);
    },
    onTouchEnd: () => { if (longPress.current.timer) clearTimeout(longPress.current.timer); },
  } : {
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': errorOpen,
  };

  const copyOutcome = resolveCopyOutcome(copyAttempt);

  // The tile root and the tab wrapper both open the terminal menu on a right
  // click, so the press is stopped here or two menus answer it.
  // @req FR-MDE-007
  const handlePathContextMenu = useCallback((event: ReactMouseEvent) => {
    if (!onPathContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onPathContextMenu(event.clientX, event.clientY);
  }, [onPathContextMenu]);

  // FR-UIDS-013: a double tap opens the same menu; isolated so the grid tile's own menu
  // does not answer the same touches.
  const pathDoubleTap = useDoubleTap(({ clientX, clientY }) => onPathContextMenu?.(clientX, clientY), { isolate: true });

  const displayPath = useMemo(() => {
    if (!tab.cwd) return '';
    return truncatePath(tab.cwd);
  }, [tab.cwd]);

  const color = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];
  const recoveryIconLabel = getSafeRecoveryIconLabel(tab.recoveryIcon);

  return (
    <div ref={rowRef} data-git-row={gitEnabled ? "" : undefined} style={{
      display: 'flex',
      alignItems: 'center',
      height: '28px',
      backgroundColor: '#2a2a2a',
      fontSize: '13px',
      padding: '0 8px 0 0',
    }}>
      {/* Color label */}
      <div style={{
        width: '4px',
        height: '100%',
        backgroundColor: color,
        flexShrink: 0,
      }} />

      {/* Session name — 더블클릭 시 인라인 편집 */}
      {recoveryIconLabel && (
        <span
          title={tab.recoveryCommand ? t('metadata.recoveryCommand', { command: tab.recoveryCommand }) : t('metadata.recovery')}
          style={{
            color: '#d7d7d7',
            marginLeft: '8px',
            fontSize: '11px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {recoveryIconLabel}
        </span>
      )}
      {rename.isEditing ? (
        <input
          ref={rename.inputRef}
          value={rename.editName}
          maxLength={32}
          onChange={rename.handleChange}
          onKeyDown={rename.handleKeyDown}
          onBlur={rename.handleBlur}
          style={{
            color: '#fff',
            marginLeft: recoveryIconLabel ? '4px' : '8px',
            background: 'transparent',
            border: '1px solid #555',
            borderRadius: '2px',
            fontSize: '13px',
            width: '120px',
            flexShrink: 0,
            padding: '0 2px',
          }}
        />
      ) : (
        <span
          ref={nameRef}
          onDoubleClick={onRename ? () => rename.startEdit(tab.name) : undefined}
          style={{
            color: '#fff',
            marginLeft: recoveryIconLabel ? '4px' : '8px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: `${nameMax}px`,
            flexShrink: 0,
            cursor: onRename ? 'text' : 'default',
          }}
        >
          {tab.name}
        </span>
      )}

      {(isRepo || (gitEnabled && showErrorChip)) && (
        <GitBranchChip
          ref={chipRef}
          view={isRepo ? view : null}
          error={git.error}
          label={gitChipLabel(repoSummary, git.error, git.stale)}
          onOpen={repoSummary ? () => { setTipOpen(false); openGit('auto'); } : () => setErrorOpen((v) => !v)}
          buttonProps={chipButtonProps}
        />
      )}
      {tipOpen && repoSummary && (
        <GitChipTooltip id={tipId} anchor={chipRef.current} summary={repoSummary} cwd={tab.cwd ?? ''} onMouseEnter={showTip} onMouseLeave={hideTipSoon} />
      )}
      {errorOpen && !repoSummary && git.error && (
        <GitErrorPopover
          anchor={chipRef.current}
          code={git.error}
          cwd={tab.cwd ?? ''}
          onClose={(focusChip) => { setErrorOpen(false); if (focusChip) chipRef.current?.focus(); }}
          onRetry={() => (gitStore ?? gitSummaryStore()).refresh(tab.sessionId)}
          onCopy={(text) => { void copyTextToClipboard(text).catch(() => {}); }}
        />
      )}
      {chipMenu && chipMenuItems.length > 0 && (
        <ContextMenu position={chipMenu} items={chipMenuItems} onClose={closeChipMenu} restoreFocusElement={chipRef.current} />
      )}

      {/* CWD path — click to copy */}
      {displayPath && view.showCwd && (
        <span
          className="metadata-cwd-path"
          onClick={handleCopy}
          onContextMenu={handlePathContextMenu}
          onTouchStart={pathDoubleTap.onTouchStart}
          onTouchEnd={(event) => {
            lastTouchEndRef.current = Date.now();
            pathDoubleTap.onTouchEnd(event);
          }}
          title={copyOutcome === 'copied' ? t('metadata.copied') : copyOutcome === 'failed' ? t('metadata.copyFailed') : (tab.cwd || '')}
          style={{
            color: copyOutcome === 'copied' ? '#22c55e' : copyOutcome === 'failed' ? '#ef4444' : '#e0e0e0',
            marginLeft: 'auto',
            cursor: 'pointer',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
            fontSize: '12px',
            textDecorationLine: 'underline',
            textDecorationColor: '#666',
            textDecorationStyle: 'solid' as const,
            textUnderlineOffset: '3px',
            letterSpacing: '0.5px',
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {copyOutcome === 'copied' ? `✓ ${t('metadata.copied')}` : copyOutcome === 'failed' ? `✗ ${t('metadata.copyFailed')}` : displayPath}
        </span>
      )}

      {/* Separator */}
      {displayPath && view.showCwd && view.showTime && (
        <span style={{
          color: '#555',
          margin: '0 3px',
          flexShrink: 0,
          fontSize: '16px',
          lineHeight: '1',
          position: 'relative',
          top: '-1px',
        }}>│</span>
      )}

      {/* Elapsed time */}
      {view.showTime && <span style={{
        color: '#e0e0e0',
        marginLeft: displayPath && view.showCwd ? '0' : 'auto',
        fontFamily: 'monospace',
        fontSize: '12px',
        flexShrink: 0,
      }}>
        {elapsed}
      </span>}
      {!view.showTime && !view.showCwd && <span style={{ marginLeft: 'auto' }} />}
    </div>
  );
}
