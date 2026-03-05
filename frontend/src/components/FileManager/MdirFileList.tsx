import { useRef, useEffect } from 'react';
import type { DirectoryEntry } from '../../types';
import './MdirPanel.css';

interface Props {
  entries: DirectoryEntry[];
  columns: number;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpen: (entry: DirectoryEntry) => void;
  highlightedName?: string | null;
  markedDirName?: string | null;
  isActive?: boolean;
}

/**
 * Format file entry name - show full name including extension.
 */
function formatName(name: string): string {
  return name.toUpperCase();
}

function formatExt(entry: DirectoryEntry): string {
  if (entry.type === 'directory') return '<DIR>';
  return '';
}

function formatSize(entry: DirectoryEntry): string {
  if (entry.type === 'directory') return '';
  return entry.size.toLocaleString();
}

function formatDate(modified: string): string {
  const d = new Date(modified);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}-${dd}-${yy}`;
}

function formatTime(modified: string): string {
  const d = new Date(modified);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function getEntryColor(entry: DirectoryEntry): string | undefined {
  if (entry.type === 'directory') return 'var(--mdir-dir)';
  if (entry.extension === '.md') return 'var(--mdir-md)';
  return undefined; // default --mdir-text via CSS
}

export function MdirFileList({ entries, columns, selectedIndex, onSelect, onOpen, highlightedName, markedDirName, isActive }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  const rowCount = Math.ceil(entries.length / columns);

  return (
    <div className="mdir-file-list-wrapper" ref={listRef}>
      <div
        className="mdir-file-list"
        style={{
          gridTemplateColumns: columns > 1 ? 'minmax(0, 1fr) minmax(0, 1fr)' : '1fr',
          gridTemplateRows: `repeat(${rowCount}, auto)`,
        }}
      >
        {entries.map((entry, index) => {
          const isSelected = index === selectedIndex;
          const isHighlighted = highlightedName != null && entry.name === highlightedName;
          const isMarked = markedDirName != null && entry.type === 'directory' && entry.name === markedDirName;
          const color = getEntryColor(entry);
          const isCol2 = columns > 1 && index >= rowCount;

          const classNames = [
            'mdir-entry',
            isSelected ? (isActive === false ? 'mdir-entry-selected-inactive' : 'mdir-entry-selected') : '',
            isHighlighted ? 'mdir-entry-highlighted' : '',
            isMarked && !isSelected && !isHighlighted ? 'mdir-entry-marked' : '',
            isCol2 ? 'mdir-entry-col2' : '',
          ].filter(Boolean).join(' ');

          return (
            <div
              key={`${entry.name}-${index}`}
              ref={el => { itemRefs.current[index] = el; }}
              className={classNames}
              style={isSelected || isHighlighted ? undefined : (color ? { color } : undefined)}
              onClick={() => onSelect(index)}
              onDoubleClick={() => onOpen(entry)}
              title={entry.name}
              role="row"
            >
              <span className="mdir-entry-name">{formatName(entry.name)}</span>
              {entry.type === 'directory' && (
                <span className="mdir-entry-ext">{formatExt(entry)}</span>
              )}
              {entry.type === 'file' && (
                <>
                  <span className="mdir-entry-size">{formatSize(entry)}</span>
                  <span className="mdir-entry-date">{formatDate(entry.modified)}</span>
                  <span className="mdir-entry-time">{formatTime(entry.modified)}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
