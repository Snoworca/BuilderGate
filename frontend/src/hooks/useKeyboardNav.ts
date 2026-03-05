import { useState, useCallback } from 'react';
import type { DirectoryEntry } from '../types';

interface UseKeyboardNavOptions {
  onEnter: (entry: DirectoryEntry) => void;
  onEsc: () => void;
  onLeft?: () => void;
  onRight?: () => void;
}

interface UseKeyboardNavReturn {
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  handleKeyDown: (e: KeyboardEvent | React.KeyboardEvent) => void;
}

export function useKeyboardNav(
  entries: DirectoryEntry[],
  columns: number,
  options: UseKeyboardNavOptions
): UseKeyboardNavReturn {
  const [rawIndex, setRawIndex] = useState(0);

  // Derive a safe index clamped to entries bounds (no effect needed)
  const selectedIndex = entries.length > 0 ? Math.min(rawIndex, entries.length - 1) : 0;

  const handleKeyDown = useCallback((e: KeyboardEvent | React.KeyboardEvent) => {
    const count = entries.length;
    if (count === 0) return;

    const rowCount = Math.ceil(count / columns);
    const row = selectedIndex % rowCount;
    const col = Math.floor(selectedIndex / rowCount);

    let newIndex = selectedIndex;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        if (row > 0) {
          newIndex = col * rowCount + (row - 1);
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        if (row < rowCount - 1) {
          const candidate = col * rowCount + (row + 1);
          if (candidate < count) {
            newIndex = candidate;
          }
        }
        break;

      case 'ArrowLeft':
        e.preventDefault();
        if (columns === 1 && options.onLeft) {
          options.onLeft();
          return;
        }
        if (col > 0) {
          const candidate = (col - 1) * rowCount + row;
          if (candidate < count) {
            newIndex = candidate;
          }
        }
        break;

      case 'ArrowRight':
        e.preventDefault();
        if (columns === 1 && options.onRight) {
          options.onRight();
          return;
        }
        if (col < columns - 1) {
          let candidate = (col + 1) * rowCount + row;
          // If candidate exceeds entries, clamp to last entry in that column
          if (candidate >= count) {
            candidate = count - 1;
          }
          if (candidate > selectedIndex) {
            newIndex = candidate;
          }
        }
        break;

      case 'Home':
        e.preventDefault();
        newIndex = 0;
        break;

      case 'End':
        e.preventDefault();
        newIndex = count - 1;
        break;

      case 'PageUp':
        e.preventDefault();
        newIndex = Math.max(0, selectedIndex - rowCount);
        break;

      case 'PageDown':
        e.preventDefault();
        newIndex = Math.min(count - 1, selectedIndex + rowCount);
        break;

      case 'Enter':
        e.preventDefault();
        if (entries[selectedIndex]) {
          options.onEnter(entries[selectedIndex]);
        }
        return;

      case 'Backspace':
        e.preventDefault();
        // Find and enter ".." entry
        {
          const dotDot = entries.find(e => e.name === '..');
          if (dotDot) options.onEnter(dotDot);
        }
        return;

      case 'Escape':
        e.preventDefault();
        options.onEsc();
        return;

      default:
        return; // Don't prevent default for unhandled keys
    }

    // Clamp and set
    newIndex = Math.max(0, Math.min(count - 1, newIndex));
    setRawIndex(newIndex);
  }, [entries, columns, selectedIndex, options]);

  return { selectedIndex, setSelectedIndex: setRawIndex, handleKeyDown };
}
