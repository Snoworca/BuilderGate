/**
 * ViewerPanel Component
 * Phase 5: File Viewer (FR-2301, FR-2303, FR-2304)
 *
 * Routes to MarkdownViewer or CodeViewer based on file extension.
 * Manages file content loading via useFileContent hook.
 */

import { useFileContent } from '../../hooks/useFileContent';
import { MarkdownViewer } from './MarkdownViewer';
import { CodeViewer } from './CodeViewer';
import './ViewerPanel.css';

// Extensions rendered by MarkdownViewer
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

interface Props {
  sessionId: string;
  filePath: string;
  onClose: () => void;
}

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
}

export function ViewerPanel({ sessionId, filePath, onClose }: Props) {
  const { content, isLoading, error } = useFileContent(sessionId, filePath);
  const ext = getExtension(filePath);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  if (isLoading) {
    return (
      <div className="viewer-panel viewer-panel-center">
        <div className="viewer-loading">Loading {fileName}...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="viewer-panel viewer-panel-center">
        <div className="viewer-error">
          <div className="viewer-error-icon">!</div>
          <div className="viewer-error-message">{error}</div>
          <button className="viewer-error-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return <MarkdownViewer content={content} filePath={filePath} />;
  }

  return <CodeViewer content={content} filePath={filePath} />;
}
