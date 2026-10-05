import { createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import { shikiLanguageFor } from './code-block-languages.ts';

/**
 * 코드 하이라이팅 (`CON-ARCH-005` AC-6).
 *
 * 조항이 `shiki` 를 이름으로 지목한다. CodeMirror 의 문법 하이라이팅과
 * 다른 자리인 이유는 그쪽이 **편집 중**의 색이고 이쪽이 **읽기 화면**의
 * 색이기 때문이다 — 옵시디언의 읽기 화면이 그렇다.
 *
 * 문서에는 아무 언어나 적힌다. 모르는 언어에 던지면 그 코드블록 하나가
 * 화면 전체를 멈춘다.
 */

/** 칠할 수 있는가 — 언어가 없으면 추측하지 않는다. */
export function isHighlightable(language: string): boolean {
  // 추측해 칠하면 엉뚱한 색이 붙고, 그 색이 코드의 뜻을 잘못 읽게 만든다.
  return language.trim() !== '';
}

/**
 * Both palettes are rendered: the light colours inline, the dark ones as `--shiki-dark`
 * custom properties that `editor.css` switches to under the dark editor theme.
 */
const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/**
 * One highlighter for the page, with the JavaScript regex engine (`FR-MDE-024` AC-4).
 *
 * shiki's default engine is Oniguruma compiled to WebAssembly. The server's CSP is
 * `script-src 'self'` without `'wasm-unsafe-eval'`, so the browser refused to compile it,
 * every call threw, and every block fell back to plain text. The JavaScript engine needs no
 * WebAssembly, so the CSP stays as strict as it is. `forgiving` skips the rare grammar
 * pattern it cannot translate instead of failing the whole block.
 */
let highlighter: Promise<Highlighter> | null = null;
const loadedLanguages = new Map<string, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({
    themes: [THEMES.light, THEMES.dark],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

function ensureLanguage(instance: Highlighter, language: string): Promise<void> {
  let loading = loadedLanguages.get(language);
  if (!loading) {
    loading = instance.loadLanguage(language as BundledLanguage);
    // A failed load (an unknown language) is not cached, so it is retried rather than
    // remembered as loaded.
    loading.catch(() => loadedLanguages.delete(language));
    loadedLanguages.set(language, loading);
  }
  return loading;
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 칠한 HTML. **던지지 않는다.**
 *
 * 실패하면 원문을 그대로 이스케이프해 돌려준다 — 색이 없는 코드는 읽을
 * 수 있지만 사라진 코드는 읽을 수 없다.
 */
export async function highlightCode(code: string, language: string): Promise<string> {
  if (!isHighlightable(language)) return escape(code);

  try {
    const instance = await getHighlighter();
    const lang = shikiLanguageFor(language);
    await ensureLanguage(instance, lang);
    return instance.codeToHtml(code, { lang, themes: THEMES });
  } catch {
    return escape(code);
  }
}

/**
 * Tokens for colouring a fence while it is being edited, for languages CodeMirror has no
 * parser for (`FR-MDE-026` AC-3). One array per source line. `null` when the language is
 * unknown or highlighting fails — the block is then left uncoloured, never broken.
 */
export async function tokenizeCode(code: string, language: string): Promise<ThemedToken[][] | null> {
  if (!isHighlightable(language)) return null;
  try {
    const instance = await getHighlighter();
    const lang = shikiLanguageFor(language);
    await ensureLanguage(instance, lang);
    return instance.codeToTokens(code, { lang: lang as BundledLanguage, themes: THEMES, defaultColor: 'light' }).tokens;
  } catch {
    return null;
  }
}
