# 팀 리드 승인 기록

## 현재 레인 배치 (2026-09-03 03:45 기준)

| 레인 | 역할 | 상태 |
|---|---|---|
| `lane-L-e2egreen` | **작성자** — 승인 9건 + HIGH 둘 실행 | running |
| `lane-M-approved` | **독립 검증자** — L 이 끝난 뒤 시작 | 대기 |

`lane-L-e2egreen` 은 `NEEDS_USER` 로 보고한 뒤 승인 메시지가 뒤늦게 도달해 **재개**한 것이다. 별개 레인이 아니며 같은 결함을 둘이 모른 채 고치는 상황이 아니다.

`lane-M-approved` 는 **아무것도 쓰지 말 것.** L 이 끝나면 팀 리드가 알린다. 그때 자기 서버 인스턴스를 띄우고 교차검증을 시작한다.

---


메시지 전달이 반복적으로 엇갈려 이 파일에 남긴다. **여기 적힌 것은 전부 승인된 것이다.**

## PH-007 E2E 스펙 수정 — 전부 승인

전부 판정을 낮추지 않는 수정이다. `toHaveCount(0)` · inert 복원 · 박스 크기 비교 · `partial > 0` 같은 단언은 한 줄도 바꾸지 않는다.

| # | 파일·위치 | 무엇을 | 승인 |
|---|---|---|---|
| 1 | `markdown-editor-placement.spec.ts:410` | 이웃 탭 3개 → **5개** (총 6개, 3열, 타일 ≈293px) | ✅ |
| 2 | `markdown-editor-placement.spec.ts:574` | 누르는 지점을 **도달 가능한 곳**으로 | ✅ |
| 3 | `markdown-editor-placement.spec.ts:620` | Escape 를 **누르되 모달이 여전히 보이는 것**을 단언 | ✅ (아래 주의) |
| 4 | `markdown-editor-placement.spec.ts:716` | Escape → **닫기 버튼**으로 닫음 | ✅ |
| 5 | `frontend/src/App.tsx` | `onRaise` 자리표 한 줄 제거 | ✅ |
| 6 | `markdown-editor-lifecycle.spec.ts` 의 `editorWindowFor` 헬퍼 | 제목의 앞머리 `*` 를 허용 | ✅ |

### 3번과 4번은 처리가 다르다

같은 Escape 문제처럼 보이나 두 AC 가 요구하는 것이 다르다.

- **`:620` (`FR-MDE-003` AC-6)** — 그 AC 가 검증하려는 것이 "**Escape handling** … behave exactly as they do with no editor window present" 다. 닫기 버튼으로 바꾸면 Escape 를 한 번도 누르지 않게 되어 **AC 의 절반이 검증되지 않는다.** Escape 를 누르고 모달이 **여전히 보이는 것**을 단언한다. 그것이 `FR-MDE-003` AC-7 이 지키려는 회귀(스택 분리가 기존 모달의 Escape 처리를 바꾸는 것)를 실제로 잡는 유일한 방법이다.
- **`:716` (`CON-MDE-001` AC-6)** — "until the modal closes" 라고만 하고 **닫는 수단을 말하지 않는다.** 닫기 버튼으로 바꾸면 되고 판정하는 사실은 그대로다.

### 5번 — 계획도 고쳤다

`T-PH007-08` 의 `files` 에 `frontend/src/App.tsx` 를 추가했다. validator errors 0. `onRaise` prop 과 자리표를 **함께** 지운다 — 선택 prop 으로 낮춰 두면 아무도 읽지 않는 줄이 남고, 그것을 지우는 일이 그 사실을 모르는 다음 Task 로 넘어간다.

### 6번 — 올바른 구현에서도 반드시 실패한다

`FR-MDE-006` AC-1 이 "타이핑하면 제목이 앞머리에 `*` 를 지닌다"를 요구하고 제품이 그대로 한다. 그런데 헬퍼가 `getByText(fileName, { exact: true })` 로 찾으므로 타이핑 직후 못 찾는다. 정규식(`^\*?CLAUDE\.md$` 등)으로 앞머리 `*` 를 허용한다. 다섯 테스트가 전부 이 헬퍼 하나를 쓴다.

## save 스펙 3건 — 전부 승인

| # | 위치 | 무엇을 | 승인 |
|---|---|---|---|
| 7 | `markdown-editor-save.spec.ts:353` | 누르는 지점을 **도달 가능한 곳**으로 (placement `:574` 와 같은 기하 문제) | ✅ |
| 8 | `markdown-editor-save.spec.ts:418` | 관찰 리스너의 `{ once: true }` 제거 또는 일치 시에만 자기 제거 | ✅ |
| 9 | `markdown-editor-save.spec.ts:715` | `selectTab` 뒤 창이 숨는 것을 먼저 기다린 뒤 레지스트리를 읽음 | ✅ |

### 8번이 특히 명확하다

`press('Control+s')` 는 `Control` keydown 을 **먼저** 보낸다. `{ once: true }` 리스너가 거기서 소진되어 `s` keydown 을 못 보고, 플래그가 `false` 가 아니라 `undefined` 로 남는다.

**`preventDefault` 는 실제로 호출된다** — `editorWindowSaveShortcut.test.ts` 가 호출 횟수를 세고 green 이다. 제품이 옳고 관찰 방법이 틀렸다.

### 9번 — 형제 스펙이 같은 전이를 통과시킨다

placement 스펙은 같은 전이를 검증하면서 **창이 숨는 것을 먼저 기다려** 통과한다. 같은 대기를 넣으면 된다.

## T-PH007-12 파일 범위 확대 — 승인

독립 검증이 찾은 **HIGH 둘**이 실제 결함이며, 고치려면 목록 밖 파일 셋이 필요하다. `files` 를 일곱으로 넓혔다(validator errors 0).

```
frontend/src/App.tsx                                  ← 추가
frontend/src/components/editor/editorWindowVisibility.ts  ← 추가
frontend/src/hooks/useEditorWindows.ts                ← 추가
```

### HIGH 1 — 배치 판정이 레이어에만 있다

`AC-4` 는 "**placement state 가 floating 이 된다**"고 상태 전이로 씌어 있다. 레이어에서 그리는 것만으로는 그 요구를 만족하지 않는다. `App.tsx` 가 `editorWindow.placement` 를 그대로 읽어 `terminalFillDisabled` 와 `boundsElement` 를 정하므로, 고아 창 하나가 **서로 다른 두 배치**를 갖는다 — 레이어는 floating 으로 그리는데 터미널 채움 버튼은 docked 인 줄 알고 비활성이 된다.

### HIGH 2 — 저장되지 않은 본문이 사라진다

가시성 술어의 `viewMode === 'grid' || windowTabId === activeTabId` 항이 여전히 고아 창을 감춘다. 앱에서 탭을 닫으면 `closeTab` 이 `activeTabId` 를 **형제 탭으로 옮기므로**, 탭 모드에서 저장되지 않은 본문을 든 창이 사라진다.

`CON-MDE-002` 가 "The unsaved body stays on screen and cannot be written anywhere" 를 요구하므로 AC 위반이다.

**그리고 E2E 가 그것을 못 잡는다** — 테스트가 서버 DELETE 를 직접 호출해 `activeTabId` 가 죽은 탭을 계속 가리키는 경로로만 검증한다. 지금의 green 은 사용자 경로를 전혀 보증하지 않는다. **고칠 때 그 경로를 실제로 밟는 케이스를 함께 넣을 것.**

## 10번 — placement `:480` 의 1px 겹침 단언 (조건부 승인)

같은 테스트 안의 두 허용치가 서로 모순이다.

```
expect(box.x).toBeGreaterThanOrEqual(target.x - 1);                     // ±1 허용
expect(box.x + box.width).toBeLessThanOrEqual(target.x + target.width + 1);
expect(overlaps).toBe(false);                                          // 0 허용
```

앞의 단언이 타일을 1px 넘어서는 것을 허용하는데 타일들이 맞닿아 있으므로 그 1px 이 곧 이웃과의 겹침이다. **타일이 인접한 한 두 단언은 동시에 만족될 수 없다.**

**승인하되 순서를 지킬 것.**

1. **먼저 앞의 두 단언에서 `-1`·`+1` 을 빼고 돌려 볼 것.** 통과하면 양쪽 다 0 허용으로 맞추는 것이 낫다 — 그 편이 AC-8 의 "no part of the window may extend over a neighbouring tile" 에 더 가깝다.
2. **서브픽셀 때문에 그것이 불안정하면** 겹침 판정에도 같은 1px 여유를 준다. 그때는 두 허용치가 일치하므로 모순이 사라지고, 진짜 침범(캐스케이드 28px, 최솟값 강제 시 수십 px)은 그대로 잡힌다.

어느 쪽을 택했는지와 그 근거를 보고할 것. 1을 시도하지 않고 2로 가면 안 된다.

## 11번 — `tabClosed` 를 필수 필드로 (승인)

지금은 선택 필드이고 **기본값이 창을 잃는 쪽**이다. 호출자가 정확히 하나이고 그것은 플래그를 넘기므로, 선택으로 둔 유일한 이득은 기존 테스트 팩토리를 안 고쳐도 된다는 것뿐이다.

**기본값이 안전하지 않은 선택 필드는 다음 호출자가 생기는 순간 조용히 창을 잃는다.** 그 창에는 저장되지 않은 본문이 들어 있을 수 있다.

`editorWindowVisibility.test.ts` 의 `visibleInput()` 에 한 줄을 더하는 것이 비용의 전부다. 그 파일이 작성자의 `test_files` 가 아니지만 **이 한 줄에 한해 승인**한다.

## 12번 — `PH-009` 로 넘기는 것 둘

지금 처리하지 않는다. 검증이 먼저다.

| 무엇 | 왜 넘기나 |
|---|---|
| `resolveTabSession(...) === undefined` 가 두 파일 세 곳에 각각 적힘 | 같은 판정이 세 곳에 있어 한쪽만 고쳐지면 어긋난다. `EditorWindowRenderContext` 가 `tabClosed` 를 실어 나르면 하나로 준다. 다만 지금 고치면 검증 대상이 또 움직인다 |
| `editorWindowDialogId` 가 컴포넌트 모듈에 있어 단위 스위트가 import 할 수 없음 | 판정 공백이며 급하지 않다 |

## 팀 리드가 마지막에 할 일 — 테스트 등재

`frontend/tsconfig.test.json` 은 `files` 허용목록 방식이라 등재되지 않은 테스트는 **타입 검사를 받지 않는다.** 이번 run 이 만든 것 중 아직 미등재인 다섯이다.

```
tests/unit/editorFileMenu.test.ts
tests/unit/editorTrayModel.test.ts
tests/unit/editorWindowClose.test.ts
tests/unit/editorWindowSave.test.ts
tests/unit/editorWindowSaveShortcut.test.ts
```

`PH-008` 이 만들 `windowStateStorage.test.ts` · `editorWindowRestore.test.ts` 도 같다.

**검증이 끝난 뒤 일괄 등재한다** — 지금 넣으면 검증자가 돌리는 `typecheck:tests` 의 결과가 도중에 바뀐다.

목록에 원래부터 없던 것들(`commandPreset*` · `contextMenu*` · `mosaic*` 등)은 이번 run 의 산물이 아니므로 건드리지 않는다.

## PH-007 종결 (2026-09-03 05:2x)

교차검증 완료. **E2E 39/39**, 편집기 단위 74/74, 승인 열한 건 전부 `assertion_preserved`, 뮤턴트 열셋 전부 red.

`dirty` 판정 공백도 닫혔다 — 양방향 뮤턴트가 **서로 다른 줄**에서 죽는다(`true` 고정은 `:848` "열면 깨끗함", `false` 고정은 `:851` "`*` 가 켜짐"). 한쪽만 재는 것이 아니다.

### PH-009 가 알아야 할 재현성 결함 둘 — 제품 결함 아님

| 심각도 | 무엇 | 왜 중요한가 |
|---|---|---|
| MEDIUM | `markdown-editor-save.spec.ts:577` 이 **단독 실행으로 재현되지 않는다** | 3회 연속 `selectWorkspace`(:176)에서 실패. API 로 만든 워크스페이스가 10초 안에 사이드바에 안 나타난다. 파일 단위로는 3회 모두 통과. **나중에 그 케이스로 이분 탐색을 하면 제품과 무관한 이유로 오진한다** |
| LOW | `markdown-editor-lifecycle.spec.ts:551` 이 4스펙 배치에서 간헐 실패 | 단독 3.4초 통과, 파일 단독 8/8, 최종 배치 38/38 재통과. 교차 스펙 타이밍 |

### 뮤턴트 적용이 실패했는데 통과로 보인 사례

검증자가 겪었다. Python 이 MSYS 경로(`/c/...`)를 못 읽어 **파일이 안 바뀐 채 테스트가 통과**했다. 적용 전후 해시 비교가 그것을 잡았다.

**뮤턴트를 걸 때는 적용이 실제로 됐는지 해시로 먼저 확인할 것.** 안 그러면 "죽지 않았다"가 아니라 "걸지도 않았다"를 "살아남았다"로 기록하게 된다.

## 넘긴 것

| 무엇 | 왜 여기서 안 하나 | 누가 |
|---|---|---|
| `stackOrder` 를 raise 가 갱신하지 않음 — 클릭 순서가 새로고침에 남지 않음 | 증상이 영속화 문제다. 갱신하려면 `useEditorWindows.ts` 와 `App.tsx` 가 필요한데 `T-PH007-12` 의 files 에 없다 | **`PH-008`** — 그 Phase 의 files 에 `useEditorWindows.ts` 를 넣어 처리한다 |
| 프로브의 독립 증인 — spread 뒤 prop 을 덮어쓰면 여전히 안 잡힘 | 진짜 독립 증인은 편집기 핸들의 `documentId` 되읽기이고 그것은 `src/editor` 에 있다 | 미정 — `PH-009` 회귀 검증에서 판단 |

## 서버

- `https://localhost:2232` (pid 24084). 신뢰 두 줄 확인됨.
- 새로 띄울 때 **앞뒤가 모두 빈 포트**를 골라야 한다 — `server/src/index.ts:131` 의 `HTTP_PORT = Number(PORT) - 1`.
- 환경변수를 `env -u` 로 씻어야 한다. 서브셸 안의 `unset` 은 효과 없음.
- `server/config.json5` 는 비추적 파일이며 2FA 해제 설정이 들어 있다. 지우지 말 것.
