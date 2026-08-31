# T-PH003-01 Restore coordinator RED 단위 계약 보고

## 결과

`REL-BGSTAB-009`의 bounded remount restore coordinator 계약을 프로덕션 코드 변경 없이 9개의 strict RED 단위 테스트로 고정했다. 계획된 테스트 파일 외에는 task 구현 코드를 변경하지 않았다.

## 테스트 계약

다음 9개 계약을 각각 고유한 semantic assertion과 failure signature로 검증한다.

1. 실제 `TextEncoder`와 fresh coordinator를 사용해 관측한 ASCII/CJK/emoji/empty 및 byte·chunk N-1/N/N+1 held accounting matrix
2. byte/chunk overflow의 generation 폐기, held accounting 0, fresh recovery exactly-once
3. snapshot 이전 tail scheduling 0 → held tail credits → matching ready → ACK → queued input release 순서
4. authoritative snapshot writer와 기존 live scheduler 사이의 idle fence 및 snapshot 후 tail 직렬화
5. 같은 session에서 stale view/xterm generation callback·timer·IME·ACK 격리
6. held/in-flight/timer를 priming한 dispose/remount의 queue·callback·timer·listener ownership 격리
7. replay 중 xterm auto-reply의 outbound 경로 0과 ACK failure 후 queued input 유지
8. 실제 empty FIFO completion probe 순서와 wedged probe의 timer/listener leak fence
9. authoritative incomplete escape tail에서 reconnect 후 complete snapshot·matching ready·ACK로 수렴하는 ready barrier

테스트 limit은 fixture의 실제 UTF-8 byte 수와 fixture 개수에서 파생했다. 신규 product default나 사용자 옵션은 만들지 않았다.

## 검증

기존 기준선:

```text
node --experimental-strip-types --test tests/unit/visibleOutputRecovery.test.ts
exit 0, tests 11, pass 11, fail 0
```

Strict RED:

```text
node --experimental-strip-types --test tests/unit/terminalRestoreCoordinator.test.ts
exit 1, tests 9, pass 0, fail 9
cancelled 0, skipped 0, todo 0
```

9개 실패는 모두 계획된 `AssertionError`와 고유 signature로 발생했다. `ERR_MODULE_NOT_FOUND`, import, parse, module 초기화 실패는 0건이다. 오케스트레이터와 S4 reviewer의 독립 재실행에서도 동일하게 `tests 9 / fail 9`와 semantic signature 9개가 확인됐다.

`kiwi-coder` 4축 검증은 전역 thread cap 때문에 동일 child reviewer를 축별로 격리해 순차 재사용했다. S1의 최초 6 HIGH/1 MEDIUM과 재검토 2 HIGH를 모두 수정했고, 최종 S1·S2·S3·S4 판정은 각각 `No CRITICAL/HIGH findings`다.

`git diff --check -- frontend/tests/unit/terminalRestoreCoordinator.test.ts`도 통과했다.
`npx eslint tests/unit/terminalRestoreCoordinator.test.ts`도 오류 없이 통과했다.

## 변경 파일

- `frontend/tests/unit/terminalRestoreCoordinator.test.ts`
- `docs/analysis/kiwi-coder-2026-07-15.projectmaster.wave2-hotpath/T-PH003-01/red-evidence.json`
- `docs/analysis/kiwi-coder-2026-07-15.projectmaster.wave2-hotpath/T-PH003-01/tdd-review.json`
- `docs/analysis/kiwi-coder-2026-07-15.projectmaster.wave2-hotpath/T-PH003-01/report.ko.md`

PM/checklist/sidecar/SRS/task status는 변경하지 않았다.

Verification: Tier 2 automated checks and independent orchestration verification completed.
