# kiwi-srs-sync dry-run — markdown-editor

- run_id: `2026-09-10.projectmaster.markdown-editor.sync-0710`
- target: `markdown-editor` (호출 시점의 활성 target 은 `wave-5` 였고, 사용자 지시로 전환함)
- base → head: `HEAD` → 워킹트리 (커밋되지 않은 변경분)

## §1 변경 분석 요약

| 항목 | 값 |
|---|---|
| 변경 파일 | 20개 (수정 16 / 신규 4 경로) |
| 변경 단위 (CU) | 8개 (독립 검증 후 CU-004 를 둘로 쪼개고 CU-008 을 추가) |
| 4방향 분류 | conflict 3 / update 4 / new-feature 0 / new-scope 0 / SRS 범위 밖 1 |
| 영향 REQ | `FR-MDE-001` · `FR-MDE-005` · `FR-MDE-006` · `FR-MDE-008` · `FR-ARCH-001` · `REL-BGSTAB-001` |
| 외부 모듈 영향 | 없음 (모든 경로가 cwd 내부) |
| `validate_spec` 결과 | **ERROR 1건 / WARN 5건** — `SRS-E002` 중복 ID `REL-BGSTAB-015`, `SRS-W018` 미등록 scope 문서 5건 |

`SRS-E002` 는 이번 변경과 무관한 기존 오류이며 `wave-5`/BGSTAB 쪽 스텝 문서에 있다. 스킬 §10.1 step 0 에 따라 **이번 실행은 mutation 0건으로 끝난다.**

### 절차상의 편차 (명시)

스킬 §2 는 Phase 2 에서 3개의 Sonnet 사전조사(intent / srs-mapping / impact)를 병렬로 돌리도록 규정한다. 이번 실행은 그 세 산출물을 만들지 않았다. 사전조사가 존재하는 이유는 **작성자가 아닌 쪽이 남의 diff 의 의도를 복원**하기 위해서인데, 이 diff 는 같은 세션에서 직접 작성한 것이라 의도가 이미 확정되어 있다. 대신 §0.4 의 독립 검증 서브에이전트는 그대로 붙였고, 그 입력에는 아래 분류의 근거 문장을 넣지 않았다.

## §2 제안 mutation (호출 순서대로)

### CU-002 — **conflict** (문서 범위 경계 + `FR-MDE-005`) — 최초 분류를 정정함

최초에 new-feature 로 분류했으나, 독립 검증에서 정면 충돌 네 곳이 확인되어 정정한다. 아래 인용은 모두 원문에서 직접 대조했다.

| 위치 | 원문 |
|---|---|
| `docs/spec/41.markdown-editor.srs.md:34` | Out of Scope 마지막 항목 — **"라이트 테마 대응."** |
| `docs/spec/41.markdown-editor.srs.md:42` | Assumptions — **"프로젝트는 다크 테마에 고정되어 있다. 편집기의 기본값도 다크이므로 어긋나지 않는다."** |
| `docs/spec/41.markdown-editor.srs.md:696` | FR-MDE-005 본문 — "The defaults are dark and `frontend/src/index.css:6` fixes `color-scheme: dark`, so **no host-side theme work is required**." |
| `docs/spec/41.markdown-editor.srs.md:737` | FR-MDE-005 Trace Link (`frontend/src/index.css`, relation=`verifies`) — "**none of the 31 `--atomic-editor-*` variables needs a host-side definition**" |

`frontend/src/index.css:6` 은 지금도 `color-scheme: dark` 다(실측). `EditorWindow.css:12` 가 `--atomic-editor-fg` 를 host 쪽에서 정의하므로, 위 verifies 링크의 근거 문장은 더 이상 참이 아니다.

- **필요한 동작**: 신규 REQ 하나로는 부족하다. §2 Out of Scope(:34), §3 Assumptions(:42), `FR-MDE-005` 본문(:696)과 Trace Link(:737)를 함께 고치지 않으면 SRS 가 자기모순 상태가 되고, `Status=implemented` 인 `FR-MDE-005` 의 근거 사실 하나가 거짓으로 남는다.
- **자동 테스트 0건**: `frontend/tests/` 전체에서 `data-theme` · `#ffffff` · `rgb(255` 를 찾으면 0건이다. 이 동작 변경을 잡는 검사가 단위·E2E 어디에도 없다.
- **근거**: `markdown-editor` target 의 12개 REQ 중 문서 영역의 색을 규정한 것이 없다. 창은 벤더 편집기의 어두운 기본값으로 나가고 있었다.
- **구현**: `frontend/src/components/editor/EditorWindow.css` 가 `.editor-window-surface .window-dialog-body` 를 흰 바탕·검은 글자로 세우고, 편집기 호스트에 `data-theme="light"` 를 걸어 벤더가 이미 제공하는 밝은 팔레트(`vendor/atomic-editor/styles/inline-preview.css:767-811`)를 켠다. 우리가 따로 정하는 값은 본문 글자색 `#000000` 하나뿐이다.
- **위험**: 신규 REQ 이므로 사용자 검토 권장. AC 초안은 §5 참조.

### CU-005 — **conflict** (`FR-MDE-006`)

- **충돌 지점**:
  - 요구사항 본문 — "shall mark unsaved changes with **a leading `*`** on its title"
  - AC-1 — "then the title carries **a leading `*`**"
  - 코드 — `frontend/src/components/dialog/windowDialogModel.ts:31` 이 `${title}*` 를 반환한다
- **선택한 해소**: 옵션 (1) 요구사항 텍스트와 AC-1 을 후행 표식으로 갱신. 사용자가 코드 동작을 직접 지시했으므로 rollback 은 해당하지 않는다.
- **근거**: 트레이 행은 긴 절대 경로의 **머리**를 생략한다. 표식을 머리에 두면 `...` 에 붙어 그 일부처럼 읽힌다. 또한 꼬리는 두 표면이 함께 정렬되는 끝이다.
- **동반 변경**: 표식 위치를 전제하던 선택자 3곳(`markdown-editor-lifecycle.spec.ts:218`, `markdown-editor-persistence.spec.ts:226`, `markdown-editor-save.spec.ts:272`)을 `^NAME\*?$` 로 옮겼다. 이것을 놓쳤다면 dirty 상태의 창을 찾는 locator 가 0건이 되어, 그 창을 대상으로 한 단언들이 아무것도 검사하지 않은 채 통과했을 것이다.

### CU-001 — update (`FR-MDE-001`)

- **동작**: `append_section_note` (Implementation Notes) + `add_trace_link` (Code → `common/iconGlyphs.ts`)
- **근거**: 다섯 컨트롤의 개수·좌우 순서·레이블(저장 / 터미널 채움 / 최대화 / 최소화 / 닫기)이 그대로다. 바뀐 것은 각 컨트롤이 글자 대신 그림을 그린다는 점과, 최대화가 `aria-pressed` 를 갖는 2상태 컨트롤이 되었다는 점이다. `FR-MDE-001` 의 어느 AC 와도 충돌하지 않는다.
- **AC-1·AC-2 재확인**: 최대화의 접근성 이름은 `최대화` 로 고정했다. ARIA 토글 규약이 이름을 고정하고 `aria-pressed` 로 상태를 알리도록 하며, 이름을 상태에 따라 바꾸면 그 이름으로 컨트롤을 찾는 E2E 가 dirty 상태에서 빗나간다.
- **신규 공용 컴포넌트**: `frontend/src/components/common/` — `iconGlyphs.ts`(글리프 어휘 + `resolveToggleIcon`), `Icon.tsx`, `IconButton.tsx`, `IconToggleButton.tsx`

### CU-003 — update (`FR-MDE-008`, AC 신설)

- **동작**: `append_section_note` (Acceptance Criteria) + `add_trace_link` + `add_verification_evidence`
- **제안 AC-9**: 트레이 아이콘은 현재 워크스페이스에서 최소화된 창의 개수를 배지로 표시하며, 그 수가 0이면 배지를 그리지 않는다.
- **근거**: 최소화된 창은 화면에 다른 흔적을 남기지 않는다. 개수가 없으면 트레이는 "무언가 접혀 있다"까지만 말하고, 몇 개인지는 목록을 열어야 알 수 있다.

### CU-004 — update (`FR-MDE-008`, AC 신설)

- **동작**: `append_section_note` (Acceptance Criteria)
- **제안 AC-10**: 트레이의 각 행은 파일 이름이 아니라 창의 절대 경로를 싣는다. 경로가 행의 한도를 넘으면 머리를 생략하여 파일 이름과 그에 가까운 상위 디렉터리가 살아남는다.
- **근거**: 이 제품에서 열리는 창은 거의 전부 `CLAUDE.md` 라서, 파일 이름 목록은 동일한 행의 목록이 된다.
- **재사용**: 생략 규칙은 헤더가 이미 세션 cwd 에 쓰던 `truncatePathLeft` 를 그대로 쓴다. 한도는 56자.
- **부수 변경**: `ContextMenuActionItem` 에 행별 `className` 을 선택 필드로 추가했다. 트레이 행만 작은 등폭 글꼴로 세우기 위한 것으로, `.context-menu-item` 을 직접 건드리면 애플리케이션의 모든 메뉴가 함께 바뀐다.

### CU-004b — **conflict** (`FR-MDE-008` + `FR-ARCH-001`) — 최초 분류에서 분리함

`ContextMenuActionItem` 에 행별 `className` 을 추가한 부분(`ContextMenu.tsx:25`, `:338`)은 라벨 변경과 분리해야 한다. 세 문장이 "이 컴포넌트는 바뀌지 않는다"고 못박고 있기 때문이다.

| 위치 | 원문 |
|---|---|
| `41.markdown-editor.srs.md:1187` | FR-MDE-008 Implementation Notes — "The list uses the existing `ContextMenu` component **unchanged**" |
| `41.markdown-editor.srs.md:1174` | FR-MDE-008 Trace Link — "reuses this component **unchanged** … **rather than through any new prop**" |
| `41.markdown-editor.srs.md:1030` | FR-MDE-007 — "**adding items requires no change to it**" |

`ContextMenu.tsx` 는 `docs/spec/10.product-architecture.srs.md` 의 `FR-ARCH-001`(**Stability=stable**)이 규정하는 공유 컴포넌트이므로, 이 변경은 변경 통제를 거쳐야 한다.

### CU-008 — update (`REL-BGSTAB-001`) — 최초에 범위 밖으로 잘못 둔 것

`CLAUDE.md` 의 2002 규칙은 SRS 범위 밖이 아니다. `docs/spec/30.buildergate-stability.srs.md` 의 `REL-BGSTAB-001`(**Stability=stable**, Status=implemented)이 정확히 이 주제를 규정한다 — 본문이 "shall **avoid reserved port 2002**", AC-4 가 "uses an explicit **non-2002 port**".

**작업 중 발견한 실제 결함(수정 완료)**: 최초 편집이 기존 문장의 "종료하거나"를 지워 **TCP2001 의 종료 금지가 사라졌다.** 2001 과 2002 는 같은 프로세스가 함께 점유하므로(2026-09-10 실측: 하나의 PID 가 둘을 동시에 LISTENING) 2001 을 내리는 것이 곧 운영 중단이다. 원문을 복원하고 그 사실을 규칙에 함께 적었다.

## §3 분류 모호 / 충돌 항목

| CU | 사안 | 상태 |
|---|---|---|
| CU-002 | Out of Scope·Assumptions·`FR-MDE-005` 본문·Trace Link 네 곳과 충돌 | 사용자 확인 필요 (§6) |
| CU-004b | `FR-MDE-008` 의 "unchanged" 서술 두 곳 + `FR-ARCH-001`(stable) | 사용자 확인 필요 (§6) |
| CU-005 | `FR-MDE-006` 의 본문과 AC-1 이 선행 표식을 못박고 있음 | 사용자 확인 필요 (§6) |

## §4 SRS 범위 밖으로 판정한 변경

| CU | 내용 | 사유 |
|---|---|---|
| CU-006 | `tsconfig.test.json` 에 신규 단위 테스트 2개 등록 | `docs/spec` 전체에서 `tsconfig` 를 규정하는 요구사항이 없다. 다만 독립 단위가 아니라 CU-001·CU-003·CU-004a 의 검증 배선이므로, 그 CU 들이 되돌려지면 함께 되돌려야 한다 |

## §4.5 정정 이력

최초 분류표는 아래 넷을 놓쳤다. 독립 검증 서브에이전트가 지적했고, 인용은 전부 원문에서 재확인했다.

1. CU-002 를 new-feature 로 둔 것 — 실제로는 충돌 4건 (CRITICAL)
2. CU-004 의 `ContextMenu` 변경을 라벨 변경과 묶어 update 로 둔 것 — 실제로는 충돌 (HIGH)
3. CU-007 을 범위 밖으로 둔 것 — 실제로는 `REL-BGSTAB-001` 소관이며, 그 편집이 2001 종료 금지를 지웠다 (HIGH)
4. `docs/spec/00.index.md` 변경을 어느 CU 에도 넣지 않은 것 — `set_active_target` 이 Active Target 을 `wave-5` 에서 `markdown-editor` 로 옮기며 쓴 것이다. 작업이 끝나면 되돌릴지 결정해야 한다 (HIGH)

또한 아래 둘은 발견 즉시 고쳤다.

- `App.tsx` 의 `editorTrayMinimizedCount` 가 소스 텍스트 가드에 등록되지 않아, 지워도 컴파일과 전 테스트가 통과하고 배지만 조용히 사라지는 상태였다. 가드에 추가한 뒤 뮤턴트(그 prop 제거 → 가드 red → 복원 → green)로 실제로 잡히는지 확인했다.
- 표식 위치를 서술한 주석 4곳이 "leading" 인 채로 남아 있었다.

## §5 신규 REQ 초안 (`FR-MDE-010`)

**Requirement.** 편집기 창의 문서 영역은 흰 바탕에 검은 글자로 그려야 한다. 색은 벤더링된 편집기가 이미 갖고 있는 밝은 테마를 켜서 얻으며, 그 팔레트를 우리 시트에 다시 적지 않는다.

**Acceptance Criteria (초안)**

- AC-1: 편집기 창이 열려 있을 때, 문서가 놓이는 `.window-dialog-body` 의 계산된 배경색은 흰색이고 글자색은 검은색이다.
- AC-2: 편집기 호스트 요소가 `data-theme="light"` 를 갖고 있어, 벤더 시트의 `[data-theme="light"] .atomic-cm-editor` 규칙이 적용된다.
- AC-3: `EditorWindow.css` 는 벤더의 밝은 팔레트를 재작성하지 않는다. 그 시트가 정의하는 `--atomic-editor-*` 변수는 요구사항이 벤더 기본값과 다른 것 하나(`--atomic-editor-fg`)뿐이다.
- AC-4: 창 테두리와 제목 표시줄은 다른 창들과 같은 계열로 남고, 밝아지는 것은 문서 영역뿐이다.

**Verification Method (초안).** AC-1·AC-2·AC-4 는 실제 브라우저에서 계산된 스타일을 읽어야 하므로 Playwright E2E. AC-3 은 시트를 읽어 판정하는 소스 텍스트 계약 검사로 단위 스위트에서 가능하다.

## §6 사용자 게이트

이번 실행은 `validate_spec` ERROR 때문에 **mutation 0건**으로 종료한다. 적용하려면 다음 순서를 밟는다.

1. `REL-BGSTAB-015` 중복 ID 를 `speckiwi repair requirement-id-collisions` 절차로 해소한다.
2. CU-005 의 충돌 해소(요구사항 텍스트 갱신)를 확정한다.
3. 이 문서의 §2 순서대로 mutation 을 적용한다.

## §7 현재 검증 상태 (참고)

| 스위트 | 결과 |
|---|---|
| `tsc -b` · `tsc -p tsconfig.test.json` | 통과 |
| 프런트엔드 단위 전수 | 1197건 중 1194 통과. 실패 3건은 `terminalHiddenOutput.test.ts` 1건과 `workspaceOwnershipMigration.test.ts` 2건으로, 이번 변경 이전에도 같은 3건이었다 |
| 편집기 E2E 5개 스위트 | 50건 중 49 통과. 실패 1건(`markdown-editor-save.spec.ts:577`)은 단독 실행 시 통과하며, 재시도가 같은 이름의 워크스페이스를 하나 더 만들고 `selectWorkspace` 가 `.first()` 로 고르는 구조 때문에 재시도가 반드시 실패한다 |
| `markdown-editor-placement.spec.ts:410` | 탭 정원(워크스페이스당 8개) 부족으로 `409`. 사용자의 기존 탭 4개가 있는 인스턴스에서는 도달할 수 없다 |
