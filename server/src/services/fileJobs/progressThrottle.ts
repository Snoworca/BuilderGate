// IR-FOP-002 AC-5 — 작업 하나의 진행 보고를 간격당 한 번으로 줄인다.
//
// 러너는 청크·항목마다 제한 없이 보고한다. 그대로 보내면 큰 복사 하나가 초당 수백 개의
// WebSocket 프레임을 만들고, 받는 쪽은 그것을 그리느라 멈춘다.
//
// leading + trailing 이다. leading 이 없으면 작업 시작 뒤 첫 간격 동안 막대가 비어 보이고,
// trailing 이 없으면 창에 막힌 마지막 값(예: 항목 완료)이 다음 보고가 올 때까지 — 다음 항목이
// 오래 걸리면 한참 — 보이지 않는다. 대기 값은 늘 최신 하나만 둔다: 진행은 누적값이라 중간
// 값을 건너뛰어도 잃는 것이 없다.
//
// 시계·타이머는 주입받는다. 관리자와 같은 이유다 — 테스트가 창을 실제로 기다리지 않고,
// dispose() 가 대기 타이머를 거둘 수 있게.

/**
 * 작업마다의 진행 보고 최소 간격. 100ms 가 아니라 ceil(1000/9) 인 이유: done 직전의 flush 는
 * 간격을 무시하고 한 번 나간다. 100ms 로 잇달아 보내던 중이면 그 flush 가 1초 창의 열한 번째가
 * 된다. 간격 보고를 창마다 9회 이하로 두어 flush 한 번의 자리를 남긴다 — 어느 1초 창에서도 10회 이하.
 */
export const FILE_JOB_PROGRESS_INTERVAL_MS = Math.ceil(1000 / 9);

export interface ProgressThrottleTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProgressThrottle<T> {
  /** 간격이 지났으면 바로 보내고, 아니면 최신 값으로 대기시켜 간격이 끝날 때 보낸다. */
  push(value: T): void;
  /** 대기 값이 있으면 간격과 무관하게 지금 보낸다. 끝(done) 직전에 한 번만 부른다 — 창 예산이 그 한 번을 가정한다. */
  flush(): void;
  /** 대기 값과 타이머를 버린다. 이후의 push·flush 는 아무것도 하지 않는다. */
  dispose(): void;
}

// @req IR-FOP-002
export function createProgressThrottle<T>(
  send: (value: T) => void,
  clock: { now(): number },
  timers: ProgressThrottleTimers,
  intervalMs: number = FILE_JOB_PROGRESS_INTERVAL_MS,
): ProgressThrottle<T> {
  let lastSentAt = -Infinity;
  let pending: { value: T } | null = null;
  let timer: unknown = undefined;
  let disposed = false;

  const sendNow = (value: T): void => {
    lastSentAt = clock.now();
    send(value);
  };

  const clearTimer = (): void => {
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    timer = undefined;
  };

  const fire = (): void => {
    timer = undefined;
    if (disposed || !pending) return;
    const { value } = pending;
    pending = null;
    sendNow(value);
  };

  return {
    push(value: T): void {
      if (disposed) return;
      // 타이머가 걸려 있으면 간격이 지났더라도 그 타이머에 맡긴다 — 실제 타이머가 늦게 불려도
      // 대기 값과 새 값이 순서를 바꿔 나가지 않는다.
      if (timer === undefined && clock.now() - lastSentAt >= intervalMs) {
        sendNow(value);
        return;
      }
      pending = { value };
      if (timer === undefined) {
        // 시계가 뒤로 가도(벽시계 보정) 대기가 간격보다 길어지지 않게 자른다.
        timer = timers.setTimeout(fire, Math.min(intervalMs, Math.max(0, lastSentAt + intervalMs - clock.now())));
      }
    },
    flush(): void {
      if (disposed) return;
      clearTimer();
      if (!pending) return;
      const { value } = pending;
      pending = null;
      sendNow(value);
    },
    dispose(): void {
      disposed = true;
      pending = null;
      clearTimer();
    },
  };
}
