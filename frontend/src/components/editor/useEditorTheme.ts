import { useCallback, useEffect, useState } from 'react';
import {
  readThemePreference,
  writeThemePreference,
  THEME_CHANGE_EVENT,
  type EditorTheme,
} from './editorTheme.ts';

/**
 * The editor's light/dark choice as React state. Every caller -- the window
 * chrome and each document panel -- follows a toggle made in any of them.
 * @req FR-MDE-020
 */
export function useEditorTheme(): [EditorTheme, () => void] {
  const [theme, setTheme] = useState<EditorTheme>(() => readThemePreference());
  useEffect(() => {
    const onThemeChange = (event: Event) => {
      setTheme((event as CustomEvent<EditorTheme>).detail);
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  }, []);
  const toggleTheme = useCallback(() => {
    const next: EditorTheme = theme === 'light' ? 'dark' : 'light';
    writeThemePreference(next);
    window.dispatchEvent(new CustomEvent<EditorTheme>(THEME_CHANGE_EVENT, { detail: next }));
  }, [theme]);
  return [theme, toggleTheme];
}
