/**
 * #111 / #18 criterion 11 — the client identity a dedup record can be keyed by.
 *
 * 실측 2026-09-19: 서버는 `connectionId` 와 `clientId` 를 소켓마다 uuidv4() 로 새로
 * 만들었고(WsRouter.ts:1723-1725), control WebSocket URL 은 token/mode/channel 만
 * 실었다. 즉 **재연결을 넘어 살아남는 식별자가 양쪽 어디에도 없었다.** 그래서 중복
 * 제거 장부가 연결에 매여 있었고, 끊기는 순간 사라져 재전송된 입력이 PTY 에 두 번
 * 기록됐다 — 이슈 #18 이 첫 문단에서 드는 바로 그 증상이다.
 *
 * 범위를 의도적으로 좁게 잡는다. 이것은 **탭 단위** 신원이며 재연결과 새로고침을
 * 넘어 살아남되, 사용자 단위도 기기 단위도 아니다. 탭 둘은 클라이언트 둘이다 —
 * sequencer 가 탭마다 번호를 1 부터 다시 매기므로, 신원을 공유하면 한 탭의 입력이
 * 다른 탭의 입력을 중복으로 눌러 **조용히 삼킨다.** 그것은 막으려던 중복 실행보다
 * 나쁜 결함이다. 그래서 sessionStorage 다 — 탭마다 다르고, 새로고침에는 살아남는다.
 */

export const LOGICAL_CLIENT_ID_STORAGE_KEY = 'buildergate.logicalClientId';

/** sessionStorage 의 필요한 부분만. 테스트가 실제 저장소 없이 구동할 수 있게 한다. */
export interface LogicalClientIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function generateLogicalClientId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  // randomUUID 가 없는 환경(구형 브라우저, 일부 비보안 컨텍스트)을 위한 대체.
  // 충돌 확률이 중요한 값이 아니다 — 같은 탭 안에서만 안정적이면 된다.
  return `lc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 이 탭의 logical client id 를 돌려준다. 없으면 만들어 저장한다.
 *
 * 저장소가 막혀 있어도(프라이빗 모드, 사이트 데이터 차단) **던지지 않는다.**
 * 그 경우 재연결 간 중복 제거를 잃는 것은 받아들일 수 있지만, 접속 자체가 실패하는
 * 것은 받아들일 수 없다 — 서버는 신원이 없으면 기존의 연결 단위 동작으로 되돌아간다.
 */
export function resolveLogicalClientId(storage: LogicalClientIdStorage): string {
  let stored: string | null = null;
  try {
    stored = storage.getItem(LOGICAL_CLIENT_ID_STORAGE_KEY);
  } catch {
    stored = null;
  }

  if (stored !== null && stored.trim().length > 0) {
    return stored;
  }

  const generated = generateLogicalClientId();
  try {
    storage.setItem(LOGICAL_CLIENT_ID_STORAGE_KEY, generated);
  } catch {
    // 저장하지 못하면 이번 연결 동안만 유효한 신원이 된다.
  }
  return generated;
}
