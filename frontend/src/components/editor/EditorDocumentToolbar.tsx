import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { EditorTheme } from './editorTheme.ts';
import { truncatedPathLabel } from './editorPathLabel.ts';

// The one-line toolbar above each editor document (FR-MDE-020): the absolute
// path on the left -- click to copy, `...\name` when it does not fit -- and on
// the right the light/dark toggle, with code mode's wrap toggle to its right.
// Colours are the surface tokens, so the bar follows the panel's theme.
// @req FR-MDE-020

const BAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '2px 6px 2px 8px',
  borderBottom: '1px solid var(--line)',
  flex: '0 0 auto',
  minWidth: 0,
};

const PATH_BOX_STYLE: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
};

const PATH_BUTTON_STYLE: CSSProperties = {
  display: 'block',
  maxWidth: '100%',
  padding: '1px 2px',
  border: 'none',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontSize: '11.5px',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  cursor: 'copy',
};

// Holds the full path at its natural width so the fit can be measured
// whatever the button is currently showing.
const MEASURE_STYLE: CSSProperties = {
  position: 'absolute',
  visibility: 'hidden',
  whiteSpace: 'nowrap',
  fontSize: '11.5px',
  padding: '1px 2px',
  pointerEvents: 'none',
};

// The session path at the bottom (MetadataRow) shows the same label for the
// same time, so the two paths answer a click the same way.
const COPIED_LABEL = '✓ Copied';
const COPIED_MS = 1500;

export const ICON_BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  width: '24px',
  height: '22px',
  padding: 0,
  border: '1px solid transparent',
  borderRadius: '4px',
  background: 'transparent',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
};

export const ICON_BUTTON_PRESSED_STYLE: CSSProperties = {
  ...ICON_BUTTON_STYLE,
  borderColor: 'var(--line-strong)',
  background: 'var(--bg-active)',
  color: 'var(--fg)',
};

function MoonIcon() {
  return (
    <svg data-icon="moon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M6.2 1.3a6.7 6.7 0 1 0 8.5 8.5A5.6 5.6 0 0 1 6.2 1.3z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg data-icon="sun" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
      <path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3 3l1.3 1.3M11.7 11.7 13 13M3 13l1.3-1.3M11.7 4.3 13 3" />
    </svg>
  );
}

/** Angle brackets: switch a markdown document to its raw source (FR-MDE-023). */
function SourceIcon() {
  return (
    <svg data-icon="source" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" />
    </svg>
  );
}

/** The markdown mark (M and a down arrow in a frame): back to the md editor. */
function MarkdownIcon() {
  return (
    <svg data-icon="markdown" width="16" height="14" viewBox="0 0 18 14" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.75" y="1.75" width="16.5" height="10.5" rx="1.75" />
      <path d="M3.5 9.5v-5l2 2.25 2-2.25v5M12.5 4.5v5M10.5 7.5l2 2 2-2" />
    </svg>
  );
}

/** A window with its left column set apart: the file tree toggle. */
function SidebarIcon() {
  return (
    <svg data-icon="sidebar" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M6 2.75v10.5" />
    </svg>
  );
}

/** Text running to the edge and returning under itself: the wrap toggle. */
export function WrapIcon() {
  return (
    <svg data-icon="wrap" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3.5h12M2 8h9.5a2.25 2.25 0 0 1 0 4.5H8M2 12.5h3" />
      <path d="M9.5 10.8 7.8 12.5l1.7 1.7" />
    </svg>
  );
}

/** The window's file tree toggle, handed to each document's toolbar. */
export interface EditorPaneToggle {
  pressed: boolean;
  disabled: boolean;
  /** 파일 트리, or the reason it cannot open. */
  label: string;
  onToggle: () => void;
}

export interface EditorDocumentToolbarProps {
  filePath: string;
  theme: EditorTheme;
  onToggleTheme: () => void;
  wrap?: boolean;
  /** Given for code mode only; without it there is no wrap toggle. */
  onToggleWrap?: () => void;
  /** The file tree toggle, left of the wrap toggle (FR-MDE-020 AC-8). */
  paneToggle?: EditorPaneToggle;
  /** Markdown only: raw source or md editor, left of the theme toggle (FR-MDE-023). */
  markdownView?: { raw: boolean; onToggle: () => void };
}

export function EditorDocumentToolbar({
  filePath,
  theme,
  onToggleTheme,
  wrap = false,
  onToggleWrap,
  paneToggle,
  markdownView,
}: EditorDocumentToolbarProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [copied, setCopied] = useState(false);

  // Re-measured when the path changes and whenever the bar is resized.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (box === null || measure === null) return undefined;
    const update = () => setTruncated(measure.offsetWidth > box.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, [filePath]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyPath = useCallback(() => {
    void navigator.clipboard?.writeText(filePath).then(
      () => setCopied(true),
      (error: unknown) => console.warn('[editor] could not copy the path', error),
    );
  }, [filePath]);

  return (
    <div style={BAR_STYLE} className="editor-document-toolbar">
      <div ref={boxRef} style={PATH_BOX_STYLE}>
        <span ref={measureRef} style={MEASURE_STYLE} aria-hidden="true">{filePath}</span>
        <button
          type="button"
          style={PATH_BUTTON_STYLE}
          className="editor-document-path"
          title={copied ? 'Copied!' : filePath}
          aria-label={`경로 복사: ${filePath}`}
          data-truncated={truncated ? 'true' : 'false'}
          data-copied={copied ? 'true' : 'false'}
          onClick={copyPath}
        >
          {copied ? COPIED_LABEL : (truncated ? truncatedPathLabel(filePath) : filePath)}
        </button>
      </div>
      {markdownView !== undefined && (
        <button
          type="button"
          style={markdownView.raw ? ICON_BUTTON_PRESSED_STYLE : ICON_BUTTON_STYLE}
          className="editor-markdown-view-toggle"
          aria-pressed={markdownView.raw}
          title={markdownView.raw ? 'md 편집기 보기' : '원문 보기'}
          aria-label={markdownView.raw ? 'md 편집기 보기' : '원문 보기'}
          onClick={markdownView.onToggle}
        >
          {markdownView.raw ? <MarkdownIcon /> : <SourceIcon />}
        </button>
      )}
      <button
        type="button"
        style={ICON_BUTTON_STYLE}
        className="editor-theme-toggle"
        data-theme-state={theme}
        title={theme === 'light' ? '야간 모드' : '주간 모드'}
        aria-label={theme === 'light' ? '야간 모드로 전환' : '주간 모드로 전환'}
        onClick={onToggleTheme}
      >
        {theme === 'light' ? <MoonIcon /> : <SunIcon />}
      </button>
      {paneToggle !== undefined && (
        <button
          type="button"
          style={paneToggle.pressed ? ICON_BUTTON_PRESSED_STYLE : ICON_BUTTON_STYLE}
          className="editor-tree-toggle"
          aria-pressed={paneToggle.pressed}
          aria-label="파일 트리"
          title={paneToggle.label}
          disabled={paneToggle.disabled}
          onClick={paneToggle.onToggle}
        >
          <SidebarIcon />
        </button>
      )}
      {onToggleWrap !== undefined && (
        <button
          type="button"
          style={wrap ? ICON_BUTTON_PRESSED_STYLE : ICON_BUTTON_STYLE}
          className="editor-code-wrap-toggle"
          aria-pressed={wrap}
          title={wrap ? '줄 바꿈 끄기' : '줄 바꿈 켜기'}
          aria-label="줄 바꿈"
          onClick={onToggleWrap}
        >
          <WrapIcon />
        </button>
      )}
    </div>
  );
}
