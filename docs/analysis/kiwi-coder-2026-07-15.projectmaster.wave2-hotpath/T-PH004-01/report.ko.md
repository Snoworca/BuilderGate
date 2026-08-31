# T-PH004-01 Clipboard coordinator RED 단위 계약 보고

## 결과

`FR-BGSTAB-021`의 단일 clipboard ownership 계약을 production 변경 없이 8개의 strict RED 단위 테스트로 고정했다. 정확한 target·selection snapshot, 비동기 race, programmatic paste exactly-once admission, multiline, dispose, telemetry redaction을 각각 독립 검증한다.

## RED 계약

1. Clipboard write가 성공하기 전에는 selection clear와 focus를 수행하지 않고, 성공 후에도 동일 target·selection일 때만 각각 한 번 수행한다.
2. Clipboard write 실패는 selection을 보존하고 `clipboard-write-failed`로 명시적으로 거부한다.
3. Target-only 교체와 selection-only 교체가 각각 늦은 copy completion을 무효화한다.
4. Async clipboard read 중 target 교체와 coordinator dispose가 서로 독립적으로 paste admission을 차단한다.
5. 한 programmatic paste는 기존 admission pipeline을 정확히 한 번 통과하고 성공 시에만 focus한다.
6. CRLF/CJK/emoji multiline payload는 exact 전달되며, admission rejection 뒤 우회 fallback이 없다.
7. Dispose 이후 programmatic paste는 side effect 없이 `context-changed`로 거부된다.
8. Result와 observation은 raw copy/paste payload를 포함하지 않고 UTF-8 byte length와 안전한 identity metadata만 남긴다.

의도한 모듈 부재는 `ERR_MODULE_NOT_FOUND`의 `error.url`이 기대 `terminalClipboardCoordinator.ts` URL과 정확히 일치할 때만 semantic RED로 변환한다. Coordinator 내부의 transitive import 실패는 계획된 RED로 위장되지 않는다.

## 검증

```text
node --experimental-strip-types --test tests/unit/terminalClipboardCoordinator.test.ts
exit 1, tests 8, pass 0, fail 8
cancelled 0, skipped 0, todo 0
```

```text
npx eslint tests/unit/terminalClipboardCoordinator.test.ts
exit 0

git diff --check -- frontend/tests/unit/terminalClipboardCoordinator.test.ts
exit 0
```

독립 까칠한 reviewer는 최초 High 2건·Medium 2건, 재검토 Medium 1건을 제기했다. 모든 finding을 수정한 뒤 같은 reviewer의 최종 판정은 정확히 `No findings`였다.

## 변경 파일

- `frontend/tests/unit/terminalClipboardCoordinator.test.ts`
- `docs/analysis/kiwi-coder-2026-07-15.projectmaster.wave2-hotpath/T-PH004-01/red-evidence.json`
- `docs/analysis/kiwi-coder-2026-07-15.projectmaster.wave2-hotpath/T-PH004-01/report.ko.md`

Verification: Tier 2 automated checks and sub-agent review completed.
