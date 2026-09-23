// FR-FOP-001 — 파일 조작 작업의 상태 기계.
//
// 전이표 하나가 곧 계약이다. 취소도 별도 이벤트가 아니라 transition(from, 'cancelled')
// 로 표현한다 — 이벤트 이름과 목표 상태를 따로 두면 둘 사이의 대응표가 또 하나의
// 검증 대상이 된다.
//
// 순수 모듈이다. 러너·관리자가 이 위에 파일 시스템과 타이머를 얹는다.

// @req FR-FOP-001
export type FileJobState =
  | 'queued'
  | 'running'
  | 'awaiting-decision'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type FileJobTransitionResult = { next: FileJobState } | { ignored: true };

export const FILE_JOB_STATES: readonly FileJobState[] = Object.freeze([
  'queued',
  'running',
  'awaiting-decision',
  'completed',
  'cancelled',
  'failed',
]);

// queued 는 곧장 awaiting-decision 으로 갈 수 없다 — 묻는 일은 실행 도중에만 생긴다.
// awaiting-decision ↔ running 은 한 작업 안에서 여러 번 오갈 수 있다.
const ALLOWED: Readonly<Record<FileJobState, readonly FileJobState[]>> = Object.freeze({
  queued: ['running'],
  running: ['awaiting-decision', 'completed', 'failed', 'cancelled'],
  'awaiting-decision': ['running', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
});

const TERMINAL: ReadonlySet<FileJobState> = new Set(['completed', 'cancelled', 'failed']);

// @req FR-FOP-001
export function isTerminalFileJobState(state: FileJobState): boolean {
  return TERMINAL.has(state);
}

// @req FR-FOP-001
export function transition(from: FileJobState, to: FileJobState): FileJobTransitionResult {
  // 취소와 완료가 경합하면 취소가 늦게 도착할 수 있다. 그것을 오류로 만들면 호출자가
  // 경합마다 예외를 삼켜야 하므로, 종료 상태에 온 취소만은 ignored 로 흡수한다.
  if (to === 'cancelled' && TERMINAL.has(from)) {
    return { ignored: true };
  }
  const allowed = ALLOWED[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`File job transition not allowed: ${from} -> ${to}`);
  }
  return { next: to };
}
