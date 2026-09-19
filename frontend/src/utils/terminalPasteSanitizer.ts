/**
 * #18 / SEC-BGSTAB-001 AC-8: the one place a paste payload is made safe to bracket.
 *
 * 실측 2026-09-19, @xterm/xterm 6.0.0 `src/browser/Clipboard.ts`:
 *   paste(text) = triggerDataEvent(bracketTextForPaste(prepareTextForTerminal(text)))
 *   prepareTextForTerminal: /\r?\n/g -> '\r'      (모든 개행이 Enter 가 된다)
 *   bracketTextForPaste:    '\x1b[200~' + text + '\x1b[201~'
 *
 * 둘을 합치면 공격이 나온다. payload 가 자신의 `ESC[201~` 를 품고 있으면 셸은 그
 * 지점에서 paste mode 를 빠져나가고, 뒤따르는 내용은 붙여넣은 텍스트가 아니라
 * 사용자가 타이핑한 명령이 된다. 개행은 이미 `\r` 로 바뀌어 있으므로 그대로 실행된다.
 * 즉 마커 하나가 '클립보드가 바뀌었다' 와 '공격자의 명령이 실행됐다' 사이의 유일한 단계다.
 *
 * 그래서 마커를 **먼저** 통째로 제거한다. 일반 ESC 제거를 먼저 돌리면 `ESC[201~` 가
 * `[201~` 라는 눈에 보이는 쓰레기 텍스트로 남는다 — 안전하긴 해도 붙여넣기 결과가 더럽다.
 *
 * 다섯 입력 경로(키보드 타이핑, 키보드 Ctrl+V, 탭 컨텍스트 메뉴, 그리드 컨텍스트 메뉴,
 * 커맨드 프리셋)가 전부 이 함수를 거치는 것이 #18 이 요구하는 균일성이다.
 */

export interface TerminalPasteSanitizeResult {
  text: string;
  /** 제거된 제어문자 개수. 원문은 담지 않는다 — 관측만 하고 payload 는 기록하지 않는다. */
  removedControlCount: number;
  /** 제거된 bracketed-paste 마커 개수. 0 이 아니면 payload 가 브래킷을 노렸다는 뜻이다. */
  removedBracketedPasteMarkers: number;
}

// 7-bit `ESC [ 200~ | 201~` 와 8-bit `CSI(0x9b) 200~ | 201~` 양쪽. 파서가 둘 다 받으므로
// 한쪽만 막으면 다른 쪽으로 같은 공격이 들어온다.
const BRACKETED_PASTE_MARKER = /\u001b\[20[01]~|\u009b20[01]~/g;

// 남은 제어문자: C0 에서 tab(09) / LF(0a) / CR(0d) 만 남기고, DEL(7f) 과 C1(80-9f) 을 뺀다.
// 이 셋을 남기는 이유는 붙여넣기 의미를 바꾸지 않기 위해서다 — 개행은 xterm 이
// prepareTextForTerminal 에서 처리하고, 여러 줄 판정은 호출자의 기존 가드가 맡는다.
const RESIDUAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeTerminalPasteText(raw: string): TerminalPasteSanitizeResult {
  let removedBracketedPasteMarkers = 0;
  const withoutMarkers = raw.replace(BRACKETED_PASTE_MARKER, () => {
    removedBracketedPasteMarkers += 1;
    return '';
  });

  let removedControlCount = 0;
  const text = withoutMarkers.replace(RESIDUAL_CONTROL, () => {
    removedControlCount += 1;
    return '';
  });

  return { text, removedControlCount, removedBracketedPasteMarkers };
}
