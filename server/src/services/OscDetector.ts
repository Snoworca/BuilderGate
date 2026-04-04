/**
 * OSC 133 Shell Integration Detector
 *
 * OSC 133 마커를 PTY 출력 스트림에서 파싱하여 셸 상태를 감지한다.
 *
 * 마커 종류:
 * - \x1b]133;A\x07  (또는 \x1b]133;A\x1b\\) → PromptStart: 프롬프트 시작 (idle)
 * - \x1b]133;B\x07  → PromptEnd: 프롬프트 끝, 사용자 입력 대기
 * - \x1b]133;C\x07  → CommandStart: 명령 실행 시작 (running)
 * - \x1b]133;D;{exitcode}\x07 → CommandEnd: 명령 종료 (idle)
 *
 * ST(String Terminator)는 \x07(BEL) 또는 \x1b\\(ESC \) 두 가지.
 */

export type OscEvent =
  | { type: 'prompt-start' }          // A marker
  | { type: 'prompt-end' }            // B marker
  | { type: 'command-start' }         // C marker
  | { type: 'command-end'; exitCode: number }; // D marker

export type ShellStatus = 'idle' | 'running';

export type OscStatusCallback = (status: ShellStatus, event: OscEvent) => void;

/**
 * OSC 133 시퀀스를 감지하는 정규식.
 *
 * 캡처 그룹:
 * - group[1]: 마커 문자 (A, B, C, D)
 * - group[2]: D 마커의 exit code (선택)
 *
 * ST는 \x07 또는 \x1b\\ 두 형태를 모두 매칭.
 */
const OSC_133_REGEX = /\x1b\]133;([A-D])(?:;(\d+))?(?:\x07|\x1b\\)/g;

export class OscDetector {
  /** 마커가 한 번이라도 감지되었는지 */
  private detected = false;

  /** 불완전한 시퀀스를 위한 잔여 버퍼 (청크 경계에 걸치는 경우) */
  private residual = '';

  /** 상태 변경 콜백 */
  private onStatus: OscStatusCallback | null = null;

  constructor() {}

  /**
   * 상태 변경 시 호출할 콜백 등록.
   */
  setCallback(cb: OscStatusCallback): void {
    this.onStatus = cb;
  }

  /**
   * PTY 출력 데이터를 처리한다.
   *
   * @param data - PTY onData에서 받은 raw 문자열
   * @returns stripped - OSC 133 시퀀스가 제거된 출력 (터미널에 표시용)
   *
   * OSC 133 시퀀스는 터미널에 표시할 필요 없으므로 strip한다.
   * 단, xterm.js가 자체적으로 무시하므로 strip은 선택사항.
   * 여기서는 strip하여 깔끔한 출력을 보장한다.
   */
  process(data: string): { stripped: string; foundMarker: boolean } {
    // 이전 잔여 버퍼와 합침
    const input = this.residual + data;
    this.residual = '';

    let foundMarker = false;
    let stripped = '';
    let lastIndex = 0;

    // 정규식 매칭 (global flag이므로 모든 매치)
    OSC_133_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = OSC_133_REGEX.exec(input)) !== null) {
      foundMarker = true;
      if (!this.detected) this.detected = true;

      // 마커 앞의 일반 텍스트 추가
      stripped += input.slice(lastIndex, match.index);
      lastIndex = match.index + match[0].length;

      const marker = match[1] as 'A' | 'B' | 'C' | 'D';
      this.handleMarker(marker, match[2]);
    }

    // 잔여 텍스트
    const remaining = input.slice(lastIndex);

    // 끝에 불완전한 ESC 시퀀스가 있을 수 있음 (\x1b]133 까지만 온 경우)
    // \x1b로 시작하는 미완성 시퀀스를 residual로 보관
    const escIdx = remaining.lastIndexOf('\x1b');
    if (escIdx >= 0 && escIdx > remaining.length - 15) {
      // 미완성 가능성: 마지막 \x1b부터 끝까지를 residual로
      stripped += remaining.slice(0, escIdx);
      this.residual = remaining.slice(escIdx);
    } else {
      stripped += remaining;
    }

    return { stripped, foundMarker };
  }

  /**
   * 마커를 처리하여 콜백 호출.
   */
  private handleMarker(marker: 'A' | 'B' | 'C' | 'D', exitCodeStr?: string): void {
    if (!this.onStatus) return;

    switch (marker) {
      case 'A': // PromptStart → idle
        this.onStatus('idle', { type: 'prompt-start' });
        break;
      case 'B': // PromptEnd (informational, no state change)
        this.onStatus('idle', { type: 'prompt-end' });
        break;
      case 'C': // CommandStart → running
        this.onStatus('running', { type: 'command-start' });
        break;
      case 'D': { // CommandEnd → idle
        const exitCode = exitCodeStr ? parseInt(exitCodeStr, 10) : 0;
        this.onStatus('idle', { type: 'command-end', exitCode });
        break;
      }
    }
  }

  /**
   * OSC 133 마커가 한 번이라도 감지되었는지 반환.
   * 이 값이 true가 되면 SessionManager에서 detectionMode를 'osc133'으로 승격.
   */
  isDetected(): boolean {
    return this.detected;
  }

  /**
   * 리소스 정리.
   */
  destroy(): void {
    this.onStatus = null;
    this.residual = '';
  }
}
