import { codeToHtml } from 'shiki';

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
    return await codeToHtml(code, { lang: language, theme: 'github-light' });
  } catch {
    return escape(code);
  }
}
