/**
 * The chip's tooltip (WCAG 1.4.13: hoverable, dismissable with Escape) and the
 * error popover with the cause and, for safe.directory, the command to run in the
 * session's environment.
 *
 * @req FR-GIT-003
 */
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RepoSummary } from './gitApi.ts';
import { activeLanguage, t, type MessageKey } from '../../i18n/i18n.ts';
import { localizeApiError } from '../../services/apiErrorMessages.ts';
import { formatRelativeTime } from '../../utils/relativeTime.ts';
import { operationText } from './GitBranchChip.tsx';

function usePlacement(anchor: HTMLElement | null, ref: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, a.left))}px`;
    el.style.top = `${a.top - h - 4 < 8 ? a.bottom + 4 : a.top - h - 4}px`;
  });
}

const POP: CSSProperties = { position: 'fixed', left: 0, top: 0, zIndex: 1200 };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <><dt>{label}</dt><dd>{children}</dd></>;
}

export interface GitChipTooltipProps {
  id: string;
  anchor: HTMLElement | null;
  summary: RepoSummary;
  cwd: string;
  /** When the store last heard an answer; the summary object may be an older, unchanged one. */
  checkedAt?: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function GitChipTooltip({ id, anchor, summary, cwd, checkedAt, onMouseEnter, onMouseLeave }: GitChipTooltipProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  usePlacement(anchor, ref);
  const repo = summary.root.split(/[\\/]/).filter(Boolean).pop() ?? summary.root;
  const c = summary.counts;
  const changes = [
    c.staged ? t('git.tip.staged', { count: c.staged }) : '',
    c.unstaged ? t('git.tip.modified', { count: c.unstaged }) : '',
    c.untracked ? t('git.tip.untracked', { count: c.untracked }) : '',
    c.conflicted ? t('git.tip.conflicted', { count: c.conflicted }) : '',
  ].filter(Boolean).join(' · ');
  const upstream = summary.upstream
    ? `${summary.upstream}${summary.ahead ? ` ↑${summary.ahead}` : ''}${summary.behind ? ` ↓${summary.behind}` : ''}`
    : summary.base ? t('git.tip.noUpstreamBase', { base: summary.base.ref, count: summary.base.ahead }) : t('git.tip.none');
  const checked = formatRelativeTime(checkedAt ?? summary.checkedAt, Date.now(), activeLanguage(), t('git.time.justNow'));
  return createPortal(
    <div ref={ref} id={id} role="tooltip" className="git-tip" style={POP} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <dl>
        <Row label={t('git.tip.repo')}>{repo}</Row>
        {summary.detached
          ? <Row label={t('git.tip.head')}>{(summary.head ?? '').slice(0, 7)}</Row>
          : <Row label={t('git.tip.branch')}>{summary.branch}</Row>}
        {summary.operation && <Row label={t('git.tip.operation')}>{operationText(summary.operation)}</Row>}
        <Row label={t('git.tip.upstream')}>{upstream}</Row>
        <Row label={t('git.tip.changes')}>{changes ? `${changes} (${t('git.tip.paths', { count: c.paths })})` : t('git.tip.none')}</Row>
        <Row label={t('git.tip.path')}>{cwd}</Row>
      </dl>
      {summary.detached && <p className="git-tip-note">{t('git.tip.detachedNote')}</p>}
      {summary.untrackedScan === 'off' && <p className="git-tip-note">{t('git.chip.untrackedOff')}</p>}
      <p className="git-tip-foot">{t('git.tip.foot', { time: checked })}</p>
    </div>,
    document.body,
  );
}

const ERROR_TITLE = {
  GIT_UNSAFE_REPO: 'git.err.title.unsafe',
  GIT_TIMEOUT: 'git.err.title.timeout',
} as const satisfies Record<string, MessageKey>;
const ERROR_BODY = {
  GIT_UNSAFE_REPO: 'git.err.body.unsafe',
  GIT_TIMEOUT: 'git.err.body.timeout',
} as const satisfies Record<string, MessageKey>;

export interface GitErrorPopoverProps {
  anchor: HTMLElement | null;
  code: string;
  cwd: string;
  onClose: (focusChip: boolean) => void;
  onRetry: () => void;
  onCopy: (text: string) => void;
}

export function GitErrorPopover({ anchor, code, cwd, onClose, onRetry, onCopy }: GitErrorPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  usePlacement(anchor, ref);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [anchor, onClose]);
  const wsl = cwd.startsWith('/');
  const command = code === 'GIT_UNSAFE_REPO' ? `git config --global --add safe.directory ${wsl ? cwd : cwd.replace(/\\/g, '/')}` : '';
  const title = code in ERROR_TITLE ? t(ERROR_TITLE[code as keyof typeof ERROR_TITLE]) : (localizeApiError(code, undefined) ?? code);
  const body = code in ERROR_BODY ? t(ERROR_BODY[code as keyof typeof ERROR_BODY]) : '';
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby="git-error-title"
      data-git-error=""
      className="git-error-pop"
      style={POP}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(true); } }}
    >
      <div id="git-error-title" className="git-error-title">{title}</div>
      {body && <p>{body}</p>}
      {command && (
        <>
          <pre>{command}</pre>
          <p className="git-tip-note">{t(wsl ? 'git.err.hint.wsl' : 'git.err.hint.windows')}</p>
          <button type="button" className="git-btn" onClick={() => onCopy(command)}>{t('git.err.copyCommand')}</button>
        </>
      )}
      <button type="button" className="git-btn" onClick={() => { onRetry(); onClose(true); }}>{t('git.err.retry')}</button>
      <div className="git-error-code">{code}</div>
    </div>,
    document.body,
  );
}
