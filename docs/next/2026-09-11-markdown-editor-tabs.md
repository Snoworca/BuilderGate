# 편집기 탭 구조 전환 — 세션 핸드오프

| Field | Value |
| --- | --- |
| 작성일 | 2026-09-11 |
| 저장소 / 브랜치 | `C:\Work\git\_Snoworca\ProjectMaster` / `work/mcp-session-orchestration-20260709` |
| 최종 작업 목표 | 마크다운 편집기를 창 여러 개에서 **창 하나 + 문서 탭** 구조로 바꾸고, 터미널 위에 올라가는 `docked` 배치를 제거한다 |
| 현재 상태 | 설계 확정·구현 미착수. 별건인 편집기 외관 변경 6종은 구현·검증 완료했으나 **전부 미커밋** |
| SSOT | `C:\Work\git\_Snoworca\ProjectMaster\docs\decision\2026-09-11.markdown-editor-tabs.md` |
| 다음 세션 첫 행동 | SSOT 를 정독한 뒤, 이슈 #44 §5 의 **단계 1**(`docked` 배치와 `터미널 채움` 컨트롤 제거)부터 착수한다 |

> 이 문서는 다음 세션이 **이 문서와 SSOT 만 읽고** 자율적으로 작업을 이어갈 수 있도록 정리한 것이다. 대화 히스토리에 의존하지 말 것.

아래에서 `<REPO>` 는 `C:\Work\git\_Snoworca\ProjectMaster` 를 뜻한다.

---

## 0. 다음 세션의 첫 행동

1. 이 문서를 끝까지 읽는다.
2. `<REPO>\docs\decision\2026-09-11.markdown-editor-tabs.md` 를 정독한다. 결정 D-1~D-13, 미해결 O-1~O-6, 요구사항 처리표(§7), 손대야 할 모듈 표(§7.1), 깨질 테스트 목록(§8.1)이 거기 있다.
3. `git status --porcelain` 으로 워킹트리가 아래 §3 과 일치하는지 확인한다. 어긋나면 실제를 믿는다.
4. 미커밋 변경(외관 6종 + 설계 문서)을 커밋할지 사용자에게 확인한다. 구현 단계 1 이 같은 파일들을 크게 건드리므로, **커밋하고 시작하는 편이 되돌리기 쉽다.**
5. 단계 1 착수 — `frontend/src/components/editor/editorWindowPlacement.ts` 의 `docked` 삭제부터. **테스트를 먼저 고친다**(§8 참조).

## 1. 최종 작업 목표

여러 터미널에서 연 문서를 **하나의 편집기 창에 탭으로** 모은다. 그 과정에서 창을 터미널 탭에 묶던 결속을 끊고, 터미널 영역을 덮는 `docked` 배치를 없앤다.

완료 조건은 아래 열한 가지(SSOT §1 의 U-1~U-11)가 전부 참인 것이다.

- 여러 터미널에서 문서를 열면 편집기 상단에 탭이 생기고, 창은 하나다
- 탭이 넘치면 좌우로 스크롤하며 스크롤바는 항상 보이고 4px 다
- 헤더 트레이에서 문서를 고르면 그 탭이 선택된다
- 터미널 경로 컨텍스트 메뉴에서 이미 열린 파일을 고르면 그 탭으로 이동한다
- 터미널 위에 올라가는 모드가 없다
- 최초 표시는 뷰포트의 70% 크기, 가운데. 모바일은 항상 전체화면
- 끌거나 크기를 바꾸면 위치·크기가 캐시되고, 다음에 그 값으로 뜬다
- 캐시가 화면을 벗어나면 보정하되 최소 크기(320×240) 아래로는 줄지 않는다
- 캐시는 전역 하나다
- 마지막 탭을 닫으면 창도 닫힌다
- 문서 세로 스크롤바가 옅은 회색 트랙에 파란 손잡이다 **(이미 완료)**

## 2. 현재까지 완료한 작업

### 2.1 편집기 외관 변경 6종 — 구현·검증 완료, 미커밋

탭 작업과는 **별건**이다. 이 세션 앞부분에서 사용자가 따로 요청한 것들이다.

- [x] 제목 표시줄 버튼을 글자(`S`/`T`/`M`/`_`)에서 그림 아이콘으로 — 신규 `<REPO>\frontend\src\components\common\` (`iconGlyphs.ts`, `Icon.tsx`, `IconButton.tsx`, `IconToggleButton.tsx`, `IconButton.css`, `index.ts`)
- [x] 최대화를 `aria-pressed` 2상태 토글로. **접근성 이름은 `최대화` 로 고정** — 이름을 상태에 따라 바꾸면 그 이름으로 버튼을 찾는 E2E 가 빗나간다
- [x] 헤더 트레이 아이콘에 최소화 개수 배지 — `editorTrayModel.ts` 의 `countMinimizedEditorTrayWindows`, `Header.tsx` 의 `header-editor-tray-badge`
- [x] 트레이 행 라벨을 파일명에서 축약 절대 경로로(등폭 11px) — `editorTrayModel.ts` 의 `listEditorTrayEntries`, 기존 `truncatePathLeft` 재사용, 한도 56자
- [x] 미저장 표식 `*` 을 제목 앞에서 뒤로 — `<REPO>\frontend\src\components\dialog\windowDialogModel.ts` 의 `windowDialogTitleText`
- [x] 문서 영역 흰 바탕·검은 글자, 읽는 열 폭 `min(95%, 1200px)`, 세로 스크롤바 트랙 `#eeeeee`·손잡이 `#0078d4` — 신규 `<REPO>\frontend\src\components\editor\EditorWindow.css`
- [x] 편집기 호스트 높이 95% — `<REPO>\frontend\src\components\editor\EditorWindow.tsx:89` 의 `flex: '0 1 95%'`. **CSS 가 아니다.** `height: 95%` 를 쓰지 않은 이유는 같은 파일 `:84-87` 주석에 있다(저장 실패 배너가 위에 뜨면 배너와 본문이 함께 넘친다)

검증:

- [x] 타입 검사 — `cd <REPO>\frontend && npx tsc -b` 및 `npx tsc -p tsconfig.test.json --noEmit` (2026-09-11 실행, 둘 다 오류 0)
- [x] 프런트엔드 단위 전수 — `cd <REPO>\frontend && node --experimental-strip-types --test tests/unit/*.test.ts` (2026-09-11 실행, **1198개 중 1195 통과 / 3 실패**)
- [x] 편집기 E2E 7개 스위트 — `cd <REPO>\frontend && npx playwright test tests/e2e/markdown-editor-*.spec.ts --project "Desktop Chrome"` (2026-09-10 실행, **65개 중 63 통과 / 2 실패**)
- [x] 외관 spec 단독 — `npx playwright test tests/e2e/markdown-editor-appearance.spec.ts --project "Desktop Chrome"` (2026-09-11 실행, **5개 전부 통과**)

⚠️ 미검증 — 세로 스크롤바 색 변경(마지막 CSS 수정) **이후에는 외관 spec 5개만 돌렸고, 편집기 E2E 7개 스위트 전수는 다시 돌리지 않았다.** 다음 세션이 커밋 전에 한 번 돌려야 한다.

### 2.2 탭 구조 전환 — 설계만 완료

- [x] GitHub 이슈 등록 — https://github.com/Snoworca/BuilderGate/issues/44 (`enhancement` 라벨). 작업 순서 6단계와 각 단계의 범위·변경 대상·검증 방법·되돌리기 난이도가 §5 에 있다
- [x] 결정·설계 문서 — `<REPO>\docs\decision\2026-09-11.markdown-editor-tabs.md`. ⚠️ 미검증 — 서브에이전트 6회차 검증(의도 축·코드 축 병렬)을 거쳤다고 기록하나, **그 검증 로그는 저장소에 남기지 않았다.** 문서 자체의 내용은 확인 가능하다
- [ ] 코드 구현 — **착수 전. 한 줄도 쓰지 않았다**

### 2.3 SRS 사후 동기화 — dry-run 만 생성, mutation 0건

- [x] dry-run 산출물 3개 — `<REPO>\docs\analysis\kiwi-srs-sync-2026-09-10.projectmaster.markdown-editor.sync-0710\` 의 `change_units.json`, `proposed-mutations.json`, `proposed-mutations.md`
- [ ] SRS 실제 반영 — **하지 않았다.** `validate_spec` 에 기존 ERROR `SRS-E002`(중복 ID `REL-BGSTAB-015`)가 남아 있어 스킬이 mutation 을 0건으로 끝냈다

### 2.4 기억과 실제가 달랐던 항목

검증 서브에이전트가 잡아낸 것 중, 다음 세션이 같은 착각을 하지 않도록 남긴다.

| 세션 중 사실로 적었던 것 | 실제 (확인 명령) |
| --- | --- |
| "`clampDialogRect` 가 화면 이탈 보정과 최소 크기 하한을 정확히 수행한다" | **최소 크기 하한을 지키지 않는다.** 뷰포트가 최소보다 작으면 하한을 뷰포트로 내린다. `sed -n '26,53p' frontend/src/components/dialog/dialogGeometry.ts` |
| "그 하한 인하는 `WindowDialog.tsx` 주석이 밝힌 `docked` 전용 계약이다" | **그 주석은 다른 것(`renderedMinSize`)을 설명한다.** `clampDialogRect` 에는 주석이 없다. `sed -n '289,306p' frontend/src/components/dialog/WindowDialog.tsx` |
| "geometry 를 켜는 것은 플래그 하나다" | **최소 셋을 고쳐야 한다.** 저장은 `handleClose` 안에서만 일어나고(`:284`), 읽은 값은 controlled rect 에 가린다(`:74`) |
| "`docked` 삭제로 교체할 `FR-MDE-001` AC 는 넷" | **여덟이다.** AC-6 만 남는다 |
| "`FR-MDE-004` 는 통째로 폐기" | **부분 폐기.** 최소 크기 320×240 상수의 소유자다 |

## 3. 현재 워킹트리·저장소 상태

`git status --porcelain` (2026-09-11 실행) 기준. **이 핸드오프 문서 자신과 `docs/next/LATEST.md` 갱신분은 아래에 포함되어 있지 않다** — 문서를 쓰는 순간 생기므로, 다음 세션이 `git status` 를 돌리면 그 둘이 더 보인다.

- 브랜치: `work/mcp-session-orchestration-20260709`, HEAD = `081de96 docs: Markdown 편집기 병합과 통합 검증 기록`
- **수정 22개** — `CLAUDE.md`, `docs/plan/2026-09-01.remaining-work-backlog.plan.md`, `docs/report/2026-09-08.ack-reservation-progress.md`, `docs/spec/00.index.md`, `docs/worklog/2026-09-08.jsonl`, `frontend/src/App.tsx`, `frontend/src/components/ContextMenu/ContextMenu.css`, `frontend/src/components/ContextMenu/ContextMenu.tsx`, `frontend/src/components/Header/Header.css`, `frontend/src/components/Header/Header.tsx`, `frontend/src/components/dialog/windowDialogModel.ts`, `frontend/src/components/editor/EditorWindow.tsx`, `frontend/src/components/editor/editorTrayModel.ts`, `frontend/src/hooks/useEditorWindows.ts`, `frontend/tests/e2e/markdown-editor-lifecycle.spec.ts`, `frontend/tests/e2e/markdown-editor-persistence.spec.ts`, `frontend/tests/e2e/markdown-editor-save.spec.ts`, `frontend/tests/unit/editorTrayModel.test.ts`, `frontend/tests/unit/editorWindowSave.test.ts`, `frontend/tests/unit/windowDialogContract.test.ts`, `frontend/tsconfig.test.json`, `kiwi/.status.json`
- **미추적 15개**(루트의 `t*_verdict_*.txt` 5개를 각각 셈) — `.codex/config.toml`, `CLAUDE.local.md`, `docs/analysis/kiwi-srs-sync-2026-09-10.projectmaster.markdown-editor.sync-0710/`, `docs/decision/`, `docs/worklog/2026-09-09.jsonl`, `frontend/src/components/common/`, `frontend/src/components/editor/EditorWindow.css`, `frontend/tests/e2e/markdown-editor-appearance.spec.ts`, `frontend/tests/unit/editorTrayPresentation.test.ts`, `frontend/tests/unit/iconGlyphs.test.ts`, 그리고 저장소 루트의 `t1_verdict_1.txt`·`t1_verdict_2.txt`·`t2_verdict_1.txt`·`t2_verdict_2.txt`·`t2_verdict_incomplete_True.txt`

**이번 세션의 변경이 아닌 것** — ⚠️ 미검증. git 은 워킹트리 변경이 언제 생겼는지 기록하지 않으므로 저장소로는 확인할 수 없다. 근거는 세션 시작 시점의 `git status` 스냅샷이며 그 기록은 대화에만 있었다. 아래 목록: `docs/plan/2026-09-01.remaining-work-backlog.plan.md`, `docs/report/2026-09-08.ack-reservation-progress.md`, `docs/worklog/2026-09-08.jsonl`, `kiwi/.status.json`, `.codex/config.toml`, `CLAUDE.local.md`, `docs/worklog/2026-09-09.jsonl`, 루트의 `t*_verdict_*.txt` 5개. **커밋 범위를 잡을 때 이것들을 함께 쓸어 담지 않도록 주의한다.**

**`docs/spec/00.index.md` 는 부작용으로 바뀌었다.** SRS 동기화 중 `set_active_target` 을 호출해 Active Target 이 `wave-5` 에서 `markdown-editor` 로, `wave-5` 의 상태가 `active` 에서 `planned` 로 바뀌었다. 되돌릴지 사용자에게 확인이 필요하다.

**`git commit` 은 반드시 경로를 지정한다** — 이 저장소는 공유 워크트리라 `git add <경로>` 를 해도 `git commit` 이 인덱스 전체를 커밋한다. `git commit -- <경로>` 형태로 쓴다.

## 4. 관련 문서·코드 (절대경로)

| 문서 | 절대경로 | 역할 |
| --- | --- | --- |
| **SSOT** | `C:\Work\git\_Snoworca\ProjectMaster\docs\decision\2026-09-11.markdown-editor-tabs.md` | 결정·설계의 진실 |
| 작업 순서 | https://github.com/Snoworca/BuilderGate/issues/44 | 6단계 실행 순서 (§5) |
| 요구사항 정본 | `C:\Work\git\_Snoworca\ProjectMaster\docs\spec\41.markdown-editor.srs.md` | `FR-MDE-001`~`009`, `CON-MDE-001`·`002`, `IR-MDE-001` |
| SRS 동기화 dry-run | `C:\Work\git\_Snoworca\ProjectMaster\docs\analysis\kiwi-srs-sync-2026-09-10.projectmaster.markdown-editor.sync-0710\proposed-mutations.md` | 외관 변경분의 SRS 반영 제안 (미적용) |

**수정 대상 코드** — SSOT §7.1 이 20개 항목의 전수 표다. 단계 1 에서 손댈 것만 여기 옮긴다.

- `<REPO>\frontend\src\components\editor\editorWindowPlacement.ts` — 배치 union 에서 `docked` 삭제, `isTerminalFillDisabled`(`:83-85`) 삭제, 최대화 상대를 `floating` 으로
- `<REPO>\frontend\src\components\editor\editorWindowVisibility.ts` — `isEditorWindowVisible`(`:103-111`)의 다섯 항을 세 항으로, `hasUsableTerminalArea` 삭제
- `<REPO>\frontend\src\components\editor\editorWindowCascade.ts` — **파일 삭제**
- `<REPO>\frontend\src\components\editor\editorWindowRect.ts` — `docked` 갈래 삭제
- `<REPO>\frontend\src\components\editor\EditorWindowLayer.tsx` — 위 둘의 유일한 소비자. `:458-460` 의 "the five terms" 주석도 낡는다
- `<REPO>\frontend\src\components\editor\EditorWindow.tsx` — `터미널 채움` 컨트롤 삭제(컨트롤 다섯 → 넷)
- `<REPO>\frontend\src\App.tsx` — 위 전부의 최상위 배선

## 5. 확정된 결정 (변경 금지)

전부 SSOT `docs\decision\2026-09-11.markdown-editor-tabs.md` 에 근거가 있으므로 **확정**이다. 재논의하지 않는다.

1. **창 개수**: 워크스페이스마다 하나. 문서는 전부 그 창의 탭 — **확정** (SSOT D-1)
2. **`docked` 배치**: 제거한다. `stage`(전체화면)와 `floating` 은 남긴다 — **확정** (SSOT D-2)
3. **최대화의 상대**: `floating`. 기록된 이전 배치가 없으면 `floating` 으로 간다 — **확정** (SSOT D-3)
4. **가시성**: `!minimized && screen === 'workspace' && windowWorkspaceId === activeWorkspaceId` 세 항만 남긴다. 터미널 탭을 바꿔도 창은 그대로 뜬다 — **확정** (SSOT D-4)
5. **저장 결속**: 창이 아니라 탭이 `tabId` 를 갖는다. `Ctrl+S` 는 포커스가 편집기 안일 때 활성 탭에 쓴다 — **확정** (SSOT D-5)
6. **제목·표식**: 제목은 활성 탭의 파일명. `*` 은 제목과 각 탭 라벨 양쪽에 붙되 함수는 `windowDialogTitleText` 하나만 쓴다 — **확정** (SSOT D-6)
7. **트레이·경로 메뉴**: 창을 되살리는 대신 그 탭을 선택한다. 터미널 탭은 건드리지 않는다 — **확정** (SSOT D-7)
8. **최초 배치·캐시**: 뷰포트 70% 가운데 → 이후 전역 캐시. 화면 이탈 시 보정하되 최소 크기 아래로 안 줄인다. **`clampDialogRect` 는 고치지 않고 전용 함수를 새로 만든다** — **확정** (SSOT D-8)
9. **저장소 배분**: geometry 는 `buildergate.dialog.<id>.geometry`(전역), 나머지 창 상태는 `window_state_<workspaceId>`. **편집기 창의 `dialogId` 를 상수로 고정한다** — **확정** (SSOT D-9)
10. **모바일**: 항상 전체화면이며 캐시를 읽지도 쓰지도 않는다 — **확정** (SSOT D-10)
11. **`FR-MDE-003`**: 통째 폐기가 아니라 **부분 폐기**. 창 올리기는 폐기, `dialogStack` 층 분리는 유지 — **확정** (SSOT D-11)
12. **마지막 탭**: 닫으면 창도 닫힌다. 미저장 확인은 탭마다 먼저 묻는다 — **확정** (SSOT D-12)
13. **탭 줄 스크롤바**: 항상 보이며 4px. `::-webkit-scrollbar` 계열로 구현 — **확정** (SSOT D-13)

## 6. 미결정·유예 항목

SSOT §10 의 O-1~O-6 이 전수다. 각각 어느 단계에서 결정할지도 그 표에 있다.

- **O-1 탭 수 상한** — 상주 CodeMirror 인스턴스 수와 직결. 실측 후 판단 (단계 2)
- **O-2 탭 순서 드래그** — 안 하면 기본 정렬은 열린 순서 (단계 2)
- **O-3 탭 닫기 버튼 노출 조건** — 항상 / 호버·활성 탭만 (단계 6)
- **O-4 창 재개 시 탭 복원 범위** — SSOT D-9 의 탭 목록 저장 위치가 여기 달려 있다 (단계 4)
- **O-5 트레이 배지가 세는 것** — 지금은 최소화된 창 수인데, 창이 하나가 되면 0/1 뿐이라 의미를 잃는다 (단계 3)
- **O-6 제목 표시줄 닫기의 다중 미저장 확인** — 미저장 탭이 여럿일 때 어떻게 묻는가 (단계 2)

**SSOT §10.1 에 "본문에서 정했으나 사용자가 답한 적 없는 결정" 열 개가 표로 있다.** 사용자가 다르게 원하면 거기부터 바꾼다.

## 7. 남은 작업 전체 목록

이슈 #44 §5 의 6단계다. 앞 단계가 뒤 단계의 전제이므로 순서대로 간다.

- [ ] **커밋 정리** — 외관 6종 + 설계 문서를 커밋. 완료 조건: `git log -1` 에 해당 커밋이 있고, §3 의 "이번 세션 변경이 아닌 것" 이 함께 들어가지 않았을 것
- [ ] **단계 1** `docked` 배치와 `터미널 채움` 컨트롤 제거 — 완료 조건: 가시성 술어가 3항이고, `editorWindowCascade.ts` 가 없으며, 프런트엔드 단위 전수와 편집기 E2E 가 이번 변경으로 새로 빨개진 것 0건
- [ ] **단계 2** 창 하나 + 탭 모델 (탭 줄, 탭별 저장 결속, 탭별 dirty, 마지막 탭 닫기) — 완료 조건: 탭을 바꿨다 돌아와도 저장하지 않은 본문이 그대로이고 `extensionsToken` 이 같을 것 (의존성: 단계 1)
- [ ] **단계 3** 트레이·경로 컨텍스트 메뉴를 탭 선택으로 — 완료 조건: 이미 열린 파일을 트레이/경로 메뉴에서 고를 때 탭 수가 늘지 않고 그 탭이 활성이 될 것 (의존성: 단계 2)
- [ ] **단계 4** 최초 70% 중앙 + 전역 geometry 캐시 + 화면 이탈 보정 + 최소 크기 하한 — 완료 조건: 캐시 없음/있음/화면 이탈/최소 미만 네 경우가 단위 테스트로, 캐시 왕복이 E2E 로 초록일 것 (의존성: 단계 1)
- [ ] **단계 5** 모바일 전체화면 — 완료 조건: 모바일 프로젝트에서 실행해 통과. **Desktop 에서 건너뛴 것을 통과로 세지 않는다** (의존성: 단계 4)
- [ ] **단계 6** 탭 줄 가로 스크롤바 (항상 보임, 4px) — 완료 조건: 넘치도록 탭을 만든 뒤 계산된 스타일로 두께와 가시성을 읽어 확인 (의존성: 단계 2)
- [ ] **SRS 반영** — `SRS-E002` 중복 ID 해소 후, SSOT §7 의 요구사항 표대로 `docs/spec/41.markdown-editor.srs.md` 갱신

## 8. 다음 세션 지시서

### 8.1 커밋 정리

1. 외관 6종의 소스·테스트와 `docs/decision/`, 이 핸드오프 문서를 커밋한다 → 검증: `git log -1 --format="%B"` 에 AI 시그니처가 0건
2. `docs/spec/00.index.md` 의 Active Target 변경을 되돌릴지 사용자에게 묻는다 → 검증: 사용자 답변

### 8.2 단계 1 — `docked` 제거

**삭제가 아니라 교체다.** 사라지는 동작을 검사하던 테스트를 그냥 지우면, 그 자리에 남는 동작을 아무도 지키지 않는다.

1. 깨질 테스트를 먼저 연다 → SSOT §8.1 이 단위 10개·E2E 4개·소스 텍스트 계약 11개를 파일명으로 열거한다
2. `editorWindowVisibility.ts` 의 술어를 3항으로 줄이는 실패 테스트를 먼저 쓴다 → 검증: red 확인
3. 술어를 줄이고 `hasUsableTerminalArea` 를 삭제한다 → 검증: 그 테스트 green
4. `editorWindowPlacement.ts` 에서 `docked` 와 `isTerminalFillDisabled` 삭제, 최대화 상대를 `floating` 으로 → 검증: `editorWindowPlacement.test.ts` 를 새 계약으로 고쳐 green
5. `editorWindowCascade.ts` 와 `editorWindowCascade.test.ts` 삭제 → 검증: `npx tsc -b` 오류 0
6. `EditorWindow.tsx` 에서 `터미널 채움` 컨트롤 삭제 → 검증: 제목 표시줄 컨트롤이 넷
7. 전수 회귀 → 검증: 아래 §9 의 명령 세 줄. **이번 변경으로 새로 빨개진 것 0건** (기존 실패는 §10 참조)

## 9. 거버넌스·게이트·함정

### 절대 금지

**TCP 2002 를 점유한 프로세스를 어떤 방법으로도 종료하지 않는다.** 이 프로젝트가 이 시스템에 실제로 배포되어 운영 중인 인스턴스다. 2001 도 같은 프로세스가 함께 점유하므로 2001 도 마찬가지다. `CLAUDE.md` Rules 에 기록해 두었다.

⚠️ 미검증(사건 기록) — 이번 세션에 실제로 밟은 지뢰다. `node stop.js` 를 실행해 그 인스턴스를 내렸고 사용자가 직접 다시 띄웠다. 저장소에 흔적이 남지 않는 사건이라 대조할 수 없다. 금지 규칙 자체는 `CLAUDE.md` Rules 에 기록되어 있다.

### 검증 서버를 2222 로 띄우는 법

`start.bat --port 2222` 는 `A different BuilderGate daemon is already running` 으로 거부된다. 데몬 상태 파일이 설치본(`C:\Work\agent-tools\builder-gate__`)과 공유되기 때문이다. 데몬을 우회해 이 체크아웃의 서버를 직접 띄운다.

```bash
cd C:/Work/git/_Snoworca/ProjectMaster
env -u NODE_ENV npm --prefix frontend run build
UNSETS=$(env | grep -o '^BUILDERGATE_[A-Z_]*' | sort -u | sed 's/^/-u /' | tr '\n' ' ')
env $UNSETS -u NODE_ENV node -e "require('./tools/start-runtime').stageFrontendAssets()"
cd server && env $UNSETS NODE_ENV=production PORT=2222 node dist/index.js
```

함정 둘.

- **`BUILDERGATE_*` 를 남기면** 이 체크아웃이 설치본의 `config.json5`·인증서·TOTP 비밀을 읽는다. ⚠️ 미검증 — 2026-09-11 이 세션의 셸은 그 변수를 30개 상속했으나 **상속 목록은 셸마다 다르다.** 위 레시피의 `UNSETS` 는 개수를 가정하지 않고 그때그때 세므로 그대로 쓰면 된다. 직접 확인하려면 `env | grep -c '^BUILDERGATE_'`
- **`NODE_ENV` 까지 지우면** 서버가 개발 모드로 떠서 Vite(4545)로 프록시한다. Vite 가 없으니 모든 페이지가 `Vite dev server unavailable` 을 반환하고 **E2E 가 한꺼번에 빨개진다.** ⚠️ 미검증 — 2026-09-10 이 세션에서 편집기 4개 스위트를 그 상태로 돌려 39건이 전부 실패한 것을 관측했으나, 그 실행 로그는 저장소에 남기지 않았다. 증상 자체(`Vite dev server unavailable`)는 페이지를 열면 바로 보인다

2026-09-11 기준 2222 와 2002 모두 health 200 이다. 다음 세션은 `curl -sk https://localhost:2222/health` 로 먼저 확인한다.

### 테스트 실행 명령 (복붙 가능)

```bash
cd C:/Work/git/_Snoworca/ProjectMaster/frontend
npx tsc -b
npx tsc -p tsconfig.test.json --noEmit
node --experimental-strip-types --test tests/unit/*.test.ts
npx playwright test tests/e2e/markdown-editor-appearance.spec.ts tests/e2e/markdown-editor-entry.spec.ts tests/e2e/markdown-editor-lifecycle.spec.ts tests/e2e/markdown-editor-persistence.spec.ts tests/e2e/markdown-editor-placement.spec.ts tests/e2e/markdown-editor-save.spec.ts tests/e2e/markdown-editor-modal-regression.spec.ts --project "Desktop Chrome"
```

E2E 를 돌리기 전에 **고아 워크스페이스를 정리한다.** 이름이 같은 워크스페이스가 쌓이면 `selectWorkspace` 가 `.first()` 로 엉뚱한 것을 골라 테스트가 죽는다.

```bash
TOKEN=$(curl -sk -X POST https://localhost:2222/api/auth/login -H 'Content-Type: application/json' -d '{"password":"$BUILDERGATE_PASSWORD"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
curl -sk https://localhost:2222/api/workspaces -H "Authorization: Bearer $TOKEN"
```

`Workspace-1` 과 그 탭 4개는 **사용자의 것이므로 지우지 않는다.** `e2e-` 로 시작하는 것만 ID 를 지정해 DELETE 한다.

### 그 밖의 함정

- **소스 텍스트 계약 테스트가 11개 있다.** `readFileSync` 로 원본 소스를 읽어 식별자나 표현식을 단언한다. **이름이나 시그니처만 바꿔도 빨개진다.** 이 축을 계산에 넣지 않으면 "무관한 테스트가 깨졌다"고 오진한다. 목록은 SSOT §8.1
- **부정 단언은 대상이 실재하는지 함께 확인한다.** locator 가 빗나가면 "없다"는 단언이 0건에서 공허하게 통과한다
- **서버는 프런트엔드만 자동 갱신된다.** 백엔드를 고쳤으면 `npm --prefix server run build` 후 재시작해야 한다. ⚠️ 미검증(사건 기록) — 이번 세션에 저장 404 의 원인이 이것이었다. 라우트가 `src` 에는 있고 `dist` 에는 없었다. 그 시점의 `dist` 는 이후 재빌드로 덮여 대조할 수 없다
- **`git commit -- <경로>`** 로 범위를 지정한다 (§3 참조)

## 10. 리스크·잔존 이슈

### 알려진 실패 — 이번 변경 때문이 아니다

- **단위 3건** — `frontend/tests/unit/terminalHiddenOutput.test.ts` 1건(`REL-BGSTAB-012 settles ledger...`), `frontend/tests/unit/workspaceOwnershipMigration.test.ts` 2건. ⚠️ 미검증 — "이 세션 시작 시점에도 같은 3건"이라는 부분은 재실행해야 확인된다. 파일과 테스트 이름이 실존한다는 것까지는 확인했다. 의심되면 단계 1 착수 **전에** 단위 전수를 한 번 돌려 기준선을 잡아라
- **E2E `markdown-editor-placement.spec.ts:410`** — 탭 6개를 더 만들어야 하는데 `Workspace-1` 에 사용자 탭 4개가 있고 정원이 워크스페이스당 8개라 `tab create failed: 409`. 사용자 탭을 지우지 않는 한 도달할 수 없다
- **E2E `markdown-editor-save.spec.ts:577`** — 첫 시도가 간헐적으로 실패하면 재시도가 같은 이름의 워크스페이스를 하나 더 만들고, `selectWorkspace` 가 `.first()` 로 고르므로 재시도가 반드시 실패한다. **단독으로 돌리면 통과한다**(2026-09-10 확인)

### 갚아야 할 빚

- **탭 N개는 상주 CodeMirror 인스턴스 N개다.** 편집기가 `markdownSource` 를 마운트 때 한 번만 읽으므로 비활성 탭을 언마운트할 수 없다. 상한은 O-1 로 미결
- **`aria-pressed` 토글에 DOM 증거가 없다.** 단언이 순수 함수 `resolveToggleIcon` 에만 걸려 있다
- **트레이 행 스타일이 모바일 컨텍스트 메뉴에 적용되지 않는다.** `ContextMenu.tsx` 의 모바일 렌더러가 `item.className` 을 참조하지 않는다
- **`FR-MDE-006` 본문은 표식이 선행한다고 적는데 코드는 후행이다.** 이번 표식 변경의 SRS 반영이 밀린 결과다. SSOT §11 에 분리해 두었다
