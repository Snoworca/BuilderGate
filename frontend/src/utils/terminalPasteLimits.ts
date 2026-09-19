/**
 * #18 criterion 8 — the paste size cap and the local/WAN input timeout.
 *
 * 실측 2026-09-19 (이 모듈 이전):
 *
 * - **크기 상한이 브라우저에 아예 없었다.** 서버는 64 KiB 를 넘는 입력을
 *   `MAX_REPLAY_QUEUED_INPUT_BYTES` 로 하드 거부하며 그 사유가 `invalid-payload` 다.
 *   그것은 이 저장소 자신이 "blamed the client for a message that was never malformed"
 *   라고 적어 둔 바로 그 종류의 답이다. 즉 큰 파일을 붙여넣으면 실패하는데 사용자는
 *   "너무 크다" 가 아니라 "메시지가 잘못됐다" 를 듣는다. 상한을 서버와 **같은 값**으로
 *   두는 이유가 이것이다 — 브라우저가 서버보다 관대하면 그 차이만큼이 전부
 *   오해를 부르는 실패가 된다.
 *
 * - **타임아웃이 배포 환경과 무관하게 하나였다.** `inputQueueTtlMs` 기본 1500ms 는
 *   loopback 에는 맞지만 WAN 에서는 "아직 가는 중" 인 입력을 거절할 만큼 짧고,
 *   사용자에게는 키 입력이 사라지는 것으로 보인다. 이슈는 구체적 수치를 명시하지
 *   않으므로 아래 값은 **고른 뒤 적어 둔** 둥근 수이지 유도된 값이 아니다.
 *
 * 잘라내기(chunk)는 여기 없다. 이 코드베이스에는 입력을 바이트로 자르는 지점이
 * 아직 존재하지 않으므로(실측: 입력 경로에 절단 없음) 멀티바이트 중간 절단 위험도
 * 아직 없다. 자르는 쪽은 상한을 넘으면 **거부**하며, 그것이 OSC52 와 같은 규칙이다.
 */

/** 서버의 MAX_REPLAY_QUEUED_INPUT_BYTES 와 같은 값. 더 관대해지면 안 된다. */
export const TERMINAL_PASTE_MAX_BYTES = 64 * 1024;

/** loopback 기본값. 기존 inputQueueTtlMs 기본값과 같아 로컬 동작은 변하지 않는다. */
export const TERMINAL_INPUT_TTL_LOCAL_MS = 1500;

/** 원격 기본값. 둥근 수이며, 유도한 것이 아니라 고른 것이다. */
export const TERMINAL_INPUT_TTL_WAN_MS = 5000;

const pasteTextEncoder = new TextEncoder();

// 대괄호 형태([::1])까지 포함한다 — location.hostname 이 IPv6 를 그렇게 준다.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function measurePasteBytes(text: string): number {
  return pasteTextEncoder.encode(text).length;
}

export function isPasteWithinCap(text: string): boolean {
  return measurePasteBytes(text) <= TERMINAL_PASTE_MAX_BYTES;
}

/**
 * 어느 타임아웃을 쓸지 고른다.
 *
 * 모르면 **원격으로 친다.** 로컬로 잘못 치면 느린 링크에 짧은 상한을 걸어 입력을
 * 버리고, 원격으로 잘못 치면 거절이 늦어질 뿐이다. 두 오류의 대가가 다르다.
 */
export function resolveTerminalInputTtlMs(hostname: string | undefined): number {
  if (!hostname) return TERMINAL_INPUT_TTL_WAN_MS;
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
    ? TERMINAL_INPUT_TTL_LOCAL_MS
    : TERMINAL_INPUT_TTL_WAN_MS;
}
