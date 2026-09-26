import type { InputRejectedReason } from '../types/ws-protocol';

/**
 * REL-BGSTAB-016 / #18 — 서버가 거절한 입력 중 사용자에게 알려야 하는 것을 가른다.
 *
 * 기준은 하나다: **그 쓰기가 PTY 에 도달했는가.** 도달했다면 잃은 것이 없으므로
 * 경고는 거짓말이고, 도달하지 않았다면 사용자는 자기가 친 것을 잃었으므로 들어야 한다.
 *
 * 실측 2026-09-19 — 이 규칙은 원래 호출 지점의 `reason !== 'duplicate-operation'` 한 줄이었고,
 * 그 옆 주석은 "나머지 전부는 PTY 에 도달하지 않았다" 고 단언하고 있었다. `expired-operation`
 * 에 대해 그것은 **거짓**이다. terminalInputLedger 의 tombstone 집합은 `operations` 에서
 * 축출된 id 로만 채워지고, id 는 admit 된 것 — 즉 PTY 에 기록된 것 — 만 `operations` 에
 * 들어간다. 따라서 `expired` 는 `duplicate` 와 똑같이 "도달했다" 를 뜻하며, 둘의 차이는
 * 일어났는지 여부가 아니라 서버가 그것을 아직 증명할 수 있는지다.
 *
 * 이것이 화면에 만드는 피해는 장식적이지 않다. 실제로 실행된 명령에 대해 "입력이
 * 버려졌다" 고 경고하면 사용자는 자연스럽게 **다시 친다.** 그러면 손으로 만든 진짜
 * 중복 실행이 되고, 그것은 ledger 가 막으려던 결과가 보호 장치를 통해 들어온 것이다.
 *
 * 인라인 조건이 아니라 함수인 이유: 한 호출 지점에 적힌 규칙은 주석을 다시 읽는 사람에게만
 * 검사된다. buildTerminalInputIdentityFields 와 같은 교훈이다.
 */

/**
 * 이 둘만 조용하다. 둘 다 "쓰기는 이미 PTY 에 도달했다" 를 뜻한다.
 *
 * - `duplicate-operation`: 서버가 그 기록을 아직 들고 있다.
 * - `expired-operation`: 기록은 축출됐지만 tombstone 이 남아 일어났다는 사실은 안다.
 *
 * `unknown-operation` 은 여기 없다 — 그것은 기록의 **부재**이고, 서버가 실행 여부를
 * 말할 수 없다는 뜻이므로 침묵이 유일하게 틀린 답이다. `payload-mismatch` 도 없다 —
 * 그 쓰기는 도달한 적이 없다.
 */
const REACHED_THE_PTY: ReadonlySet<string> = new Set<InputRejectedReason>([
  'duplicate-operation',
  'expired-operation',
]);

export function shouldSurfaceInputRejection(reason: InputRejectedReason): boolean {
  return !REACHED_THE_PTY.has(reason);
}
