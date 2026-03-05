/**
 * MarkdownViewer Component
 * Phase 5: File Viewer (FR-2301, FR-2302)
 *
 * Renders Markdown with GFM support, code highlighting, and Mermaid diagrams.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import 'highlight.js/styles/github.css';
import './MarkdownViewer.css';

interface Props {
  content: string;
  filePath: string;
}

/**
 * Mermaid diagram renderer for code blocks with language "mermaid".
 */
function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize({ startOnLoad: false, theme: 'default' });
        const { svg } = await mermaid.render(idRef.current, code);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message || 'Diagram render failed');
        }
      }
    };

    renderDiagram();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-error">
        <pre><code>{code}</code></pre>
        <div className="mermaid-error-msg">Diagram render failed: {error}</div>
      </div>
    );
  }

  return <div ref={containerRef} className="mermaid-container" data-testid="mermaid-svg" />;
}

export function MarkdownViewer({ content, filePath }: Props) {
  const components: Components = useCallback(() => ({
    code({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
      const match = /language-(\w+)/.exec(className || '');
      const lang = match ? match[1] : '';

      // Mermaid blocks get special rendering
      if (lang === 'mermaid') {
        const code = String(children).replace(/\n$/, '');
        return <MermaidBlock code={code} />;
      }

      // Inline code
      if (!className) {
        return <code className="inline-code" {...props}>{children}</code>;
      }

      // Code block with language label
      return (
        <div className="code-block-wrapper">
          {lang && <span className="code-block-lang">{lang}</span>}
          <code className={className} {...props}>{children}</code>
        </div>
      );
    },
  }), [])();

  // Extract filename for display
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  return (
    <div className="markdown-viewer">
      <div className="markdown-viewer-header">
        <span className="markdown-viewer-filename">{fileName}</span>
      </div>
      <div className="markdown-viewer-content">
        {content.length === 0 ? (
          <p className="markdown-viewer-empty">(Empty file)</p>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={components}
          >
            {content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}
