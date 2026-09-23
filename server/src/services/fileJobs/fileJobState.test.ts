// FR-FOP-001 — 파일 조작 작업의 상태 기계 단언.
//
// 계약(T-PH001-02 가 이 형태로 구현한다):
//   FILE_JOB_STATES: readonly FileJobState[]
//   transition(from, to): { next: FileJobState } | { ignored: true }, 허용되지 않은 전이는 throw
// 취소 요청은 transition(from, 'cancelled') 이다. 별도 이벤트 어휘를 두지 않는 이유는
// 전이표 하나가 곧 계약이 되게 하려는 것이다 — 이벤트 이름과 목표 상태를 따로 두면
// 둘 사이의 대응표가 또 하나의 검증 대상이 된다.
//
// 모듈은 테스트마다 동적으로 import 한다. 정적 import 면 모듈이 없을 때 러너가 파일
// 단위로 죽어 테스트 이름이 출력되지 않고, 그 모습은 WSL esbuild 불일치로 러너가 죽는
// 것과 구별되지 않는다. 동적 import 는 부재를 각 테스트의 실패로 드러낸다.
//
// 순수 단위 테스트다 — 파일 시스템·타이머를 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';

type FileJobState =
  | 'queued'
  | 'running'
  | 'awaiting-decision'
  | 'completed'
  | 'cancelled'
  | 'failed';

type TransitionResult = { next: FileJobState } | { ignored: true };

interface FileJobStateModule {
  FILE_JOB_STATES: readonly FileJobState[];
  transition(from: FileJobState, to: FileJobState): TransitionResult;
}

async function load(): Promise<FileJobStateModule> {
  return (await import('./fileJobState.js')) as unknown as FileJobStateModule;
}

test('작업 상태는 queued·running·awaiting-decision·completed·cancelled·failed 여섯 가지다', async () => {
  const { FILE_JOB_STATES } = await load();
  // 순서가 아니라 집합을 단언한다 — 선언 순서는 계약이 아니다.
  // 길이를 따로 보는 이유: 중복 원소가 있으면 Set 비교만으로는 통과해 버린다.
  assert.equal(FILE_JOB_STATES.length, 6);
  assert.deepEqual(
    new Set(FILE_JOB_STATES),
    new Set(['queued', 'running', 'awaiting-decision', 'completed', 'cancelled', 'failed']),
  );
});

test('허용되지 않은 전이(completed → running)는 거부된다', async () => {
  const { transition } = await load();
  // 거부는 조용한 무시가 아니라 throw 여야 한다 — ignored 는 종료 상태의 취소에만 쓴다.
  assert.throws(() => transition('completed', 'running'));
  // 대조군: 같은 목표 상태로의 허용된 전이는 통과한다. 이것이 없으면 모든 전이를
  // throw 하는 구현도 위 단언을 만족한다.
  assert.deepEqual(transition('queued', 'running'), { next: 'running' });
  // queued 는 곧장 awaiting-decision 으로 갈 수 없다 — 묻는 일은 실행 도중에만 생긴다.
  assert.throws(() => transition('queued', 'awaiting-decision'));
});

test('awaiting-decision → running → awaiting-decision 재진입이 허용된다', async () => {
  const { transition } = await load();
  // 한 작업 안에서 여러 번 묻는다(AC-3). 두 바퀴를 돌려 한 번만 허용하는 구현을 거른다.
  let state: FileJobState = 'running';
  for (let round = 0; round < 2; round += 1) {
    const paused = transition(state, 'awaiting-decision');
    assert.deepEqual(paused, { next: 'awaiting-decision' }, `round ${round}: running → awaiting-decision`);
    state = 'awaiting-decision';
    const resumed = transition(state, 'running');
    assert.deepEqual(resumed, { next: 'running' }, `round ${round}: awaiting-decision → running`);
    state = 'running';
  }
  // 답을 받은 뒤에는 running 으로 끝까지 갈 수 있다.
  assert.deepEqual(transition(state, 'completed'), { next: 'completed' });
});

test('취소는 running 과 awaiting-decision 두 상태에서 받아 cancelled 로 간다', async () => {
  const { transition } = await load();
  assert.deepEqual(transition('running', 'cancelled'), { next: 'cancelled' });
  assert.deepEqual(transition('awaiting-decision', 'cancelled'), { next: 'cancelled' });
});

test('종료 상태에 온 취소는 오류가 아니라 ignored 를 돌려준다', async () => {
  const { transition } = await load();
  // 취소와 완료가 경합하면 취소가 늦게 도착할 수 있다. 그것을 오류로 만들면 호출자가
  // 경합마다 예외를 삼켜야 한다.
  for (const terminal of ['completed', 'cancelled', 'failed'] as const) {
    assert.deepEqual(transition(terminal, 'cancelled'), { ignored: true }, `${terminal} + cancel`);
  }
  // ignored 는 취소에만 쓴다 — 종료 상태의 다른 전이는 여전히 거부된다.
  assert.throws(() => transition('failed', 'running'));
});
