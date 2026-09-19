/**
 * SEC-BGSTAB-001: OSC52 clipboard escape policy.
 *
 * OSC 52 의 형식은 `OSC 52 ; Pc ; Pd ST` 이고, xterm 의 OSC 핸들러가 받는 문자열은
 * 식별자(52)를 뺀 `Pc;Pd` 다. Pc 는 선택 대상(c, p, s, q, 0-7 … 비어 있을 수도 있다),
 * Pd 는 base64 payload 이거나 읽기를 뜻하는 `?` 다.
 *
 * 정책은 비대칭이며 그것이 의도다.
 *
 * - **읽기는 영구 금지다.** 켤 수 있는 설정을 두지 않는다. 읽기 응답은 PTY 의 input
 *   채널로 주입되므로 사용자가 마지막으로 복사한 것에 대한 직접적인 유출 원시수단이고,
 *   설정으로 두면 에이전트가 켜도록 설득당할 수 있다. 이를 막을 브라우저 권한은
 *   origin 단위라 세션별로 좁힐 수도 없다.
 * - **쓰기는 기본 허용**이며 `terminal.osc52.allowWrite` 하나로만 제어된다.
 *
 * 확인 프롬프트는 어느 방향으로도 띄우지 않는다. N 개의 비동기 에이전트가 아무도
 * 보고 있지 않은 세션에서 만들어 내는 프롬프트는 붙일 사용자 행위가 없고, 사용자는
 * 프롬프트를 습관적으로 통과시켜 보안 통제를 부채로 바꾼다.
 *
 * 이 모듈은 순수 함수다 — 판정만 하고 클립보드를 건드리지 않는다. 실제 쓰기는
 * 호출자가 terminalClipboardCoordinator 로 넘겨 FR-BGSTAB-021 의 generation guard 와
 * 관측 채널을 상속한다.
 */

/** 디코드 후 상한. OOM 방지가 아니라 피해 범위 제한이므로 넘으면 자르지 않고 거부한다. */
export const OSC52_MAX_DECODED_BYTES = 102_400;

export type Osc52Decision =
  | { kind: 'deny-read' }
  | { kind: 'deny-write-disabled' }
  | { kind: 'refuse-oversize'; decodedBytes: number }
  | { kind: 'refuse-malformed'; detail: 'syntax' | 'base64' | 'utf8' }
  | { kind: 'allow-write'; text: string; decodedBytes: number };

export interface Osc52PolicyOptions {
  allowWrite: boolean;
}

// 엄격 base64: 표준 알파벳만, 4의 배수 길이, 패딩은 끝에서만 최대 2개.
// 관대하게 받으면 '무엇이 유효한가' 가 구현 세부사항이 되고 그것은 검증이 아니다.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * base64 문자열이 디코드되면 몇 바이트가 되는지를 **디코드하지 않고** 계산한다.
 * 상한 초과를 거부하는 데 굳이 100KB 넘는 버퍼를 만들 이유가 없다.
 */
function decodedByteLength(base64: string): number {
  if (base64.length === 0) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function decodeBase64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function evaluateOsc52Request(data: string, options: Osc52PolicyOptions): Osc52Decision {
  const separator = data.indexOf(';');
  if (separator < 0) {
    return { kind: 'refuse-malformed', detail: 'syntax' };
  }

  // Pd 는 첫 세미콜론 뒤의 전부다. base64 알파벳에 ';' 가 없으므로 더 쪼갤 필요가 없다.
  const payload = data.slice(separator + 1);

  // 읽기 판정이 가장 먼저다. 읽기는 정책이 아니라 금지이므로 allowWrite 를 보지 않는다.
  if (payload === '?') {
    return { kind: 'deny-read' };
  }

  if (!options.allowWrite) {
    // 크기를 재기 전에 끊는다. 거부 사유가 크기가 아니라 정책이어야 운영자가
    // 무엇을 바꿔야 하는지 안다.
    return { kind: 'deny-write-disabled' };
  }

  if (!STRICT_BASE64.test(payload)) {
    return { kind: 'refuse-malformed', detail: 'base64' };
  }

  const decodedBytes = decodedByteLength(payload);
  if (decodedBytes > OSC52_MAX_DECODED_BYTES) {
    return { kind: 'refuse-oversize', decodedBytes };
  }

  const bytes = decodeBase64ToBytes(payload);
  if (!bytes) {
    return { kind: 'refuse-malformed', detail: 'base64' };
  }

  let text: string;
  try {
    // fatal: true 가 핵심이다. 기본 디코더는 잘못된 바이트를 U+FFFD 로 바꿔
    // '조용히 다른 내용' 을 만들어 낸다.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'refuse-malformed', detail: 'utf8' };
  }

  return { kind: 'allow-write', text, decodedBytes: bytes.byteLength };
}
