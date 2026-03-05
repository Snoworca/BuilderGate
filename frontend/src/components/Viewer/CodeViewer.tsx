/**
 * CodeViewer Component
 * Phase 5: File Viewer (FR-2303)
 *
 * Syntax-highlighted code display with line numbers.
 * Uses highlight.js core with selective language registration (16 languages).
 */

import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import bash from 'highlight.js/lib/languages/bash';
import htmlLang from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import 'highlight.js/styles/vs2015.css';
import './CodeViewer.css';

// Register 16 languages
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('html', htmlLang);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdown);

// Extension → hljs language mapping
const EXTENSION_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.go': 'go',
  '.rs': 'rust',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.json': 'json',
  '.json5': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.sql': 'sql',
  '.md': 'markdown',
};

function getLanguage(filePath: string, lang?: string): string | null {
  if (lang && hljs.getLanguage(lang)) return lang;
  const ext = '.' + filePath.split('.').pop()?.toLowerCase();
  return EXTENSION_MAP[ext] || null;
}

interface Props {
  content: string;
  filePath: string;
  language?: string;
}

export function CodeViewer({ content, filePath, language }: Props) {
  const lang = getLanguage(filePath, language);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  const { lines } = useMemo(() => {
    let highlighted: string;
    if (lang) {
      try {
        highlighted = hljs.highlight(content, { language: lang }).value;
      } catch {
        highlighted = escapeHtml(content);
      }
    } else {
      highlighted = escapeHtml(content);
    }
    const lineArray = highlighted.split('\n');
    // Remove trailing empty line from split
    if (lineArray.length > 1 && lineArray[lineArray.length - 1] === '') {
      lineArray.pop();
    }
    return { lines: lineArray };
  }, [content, lang]);

  return (
    <div className="code-viewer">
      <div className="code-viewer-header">
        <span className="code-viewer-filename">{fileName}</span>
        {lang && <span className="code-viewer-lang">{lang}</span>}
      </div>
      {content.length === 0 ? (
        <div className="code-viewer-empty">(Empty file)</div>
      ) : (
        <div className="code-viewer-body">
          <table className="code-viewer-table">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="line-number">{i + 1}</td>
                  <td
                    className="line-content hljs"
                    dangerouslySetInnerHTML={{ __html: line || '\n' }}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
