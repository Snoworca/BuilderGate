// The row of document tabs across the top of the editor window.
//
// One tab per open document, in the order they were opened. The row scrolls
// sideways when the tabs overflow it, and its scrollbar stays visible rather
// than fading out -- a hidden scrollbar takes with it the only sign that there
// are more tabs than fit. That is styling, and it lives in `EditorWindow.css`
// beside the window's other rules.
//
// @req FR-MDE-012

import { useEffect, useRef } from 'react';
import { windowDialogTitleText } from '../dialog/windowDialogModel.ts';

/** What the row needs of a document. */
export interface EditorTabBarTab {
  /** The normalized absolute path, which is the tab's identity. */
  filePath: string;
  /** The document differs from the file it was read from. */
  dirty: boolean;
}

export interface EditorTabBarProps {
  tabs: readonly EditorTabBarTab[];
  activeFilePath: string | null;
  onSelect: (filePath: string) => void;
  onClose: (filePath: string) => void;
}

function fileNameOf(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

/**
 * @req FR-MDE-012
 */
export function EditorTabBar({ tabs, activeFilePath, onSelect, onClose }: EditorTabBarProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // A tab selected from somewhere other than this row -- the header tray, or
  // the path context menu -- can be scrolled out of sight, and the user would
  // have no sign that their choice landed.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFilePath]);

  return (
    <div className="editor-tab-bar" role="tablist" aria-label="열린 문서">
      {tabs.map((tab) => {
        const active = tab.filePath === activeFilePath;

        return (
          <div
            key={tab.filePath}
            className={active ? 'editor-tab is-active' : 'editor-tab'}
          >
            {/* The label and the close control are separate buttons rather than
                one button with another inside it: nesting them is invalid, and
                browsers resolve it by lifting the inner one out of the tab. */}
            <button
              ref={active ? activeRef : undefined}
              type="button"
              role="tab"
              aria-selected={active}
              className="editor-tab-label"
              // The full path, because nearly every one of these is named
              // CLAUDE.md and the name alone does not say which is which.
              title={windowDialogTitleText(tab.filePath, tab.dirty)}
              onClick={() => onSelect(tab.filePath)}
            >
              {/* The same function the window title draws through, so the
                  marker cannot end up on one side in one place and the other
                  side in the other. */}
              {windowDialogTitleText(fileNameOf(tab.filePath), tab.dirty)}
            </button>
            <button
              type="button"
              className="editor-tab-close"
              aria-label={`${fileNameOf(tab.filePath)} 닫기`}
              title="닫기"
              onClick={() => onClose(tab.filePath)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
