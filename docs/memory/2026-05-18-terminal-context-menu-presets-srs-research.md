# 터미널 컨텍스트 메뉴 저장 항목 붙여넣기 SRS 연구

| Field | Value |
|---|---|
| Date | 2026-05-18 |
| Purpose | SRS 추가 전 선행 연구 |
| Scope | 세션 터미널 컨텍스트 메뉴, 중첩 메뉴, 모바일 다이얼로그, 커맨드/디렉토리/프롬프트 등록 항목 붙여넣기 |

## 1. 용어 제안

- 최상위 메뉴명은 `사용자 정의 명령`보다 `등록 항목 붙여넣기`가 더 정확하다.
- 이유: 하위 항목은 커맨드뿐 아니라 디렉토리와 프롬프트를 포함하며, 선택 동작은 실행이 아니라 터미널 입력 영역으로 붙여넣기다.
- 카테고리명은 기존 UI와 맞추기 위해 `커맨드 라인`, `디렉토리`, `프롬프트`를 권장한다.

## 2. 현재 코드 상태

- SRS 구조
  - `docs/spec/00.index.md`는 `docs/rule/SRS-MD-Rules-v1.0.0.md` 우선 준수를 지시한다.
  - 현재 SpecKiwi active target은 `v1.0.0`이며 MCP 기준 등록 요구사항은 0개다.
  - `docs/spec/10.product-architecture.srs.md`의 Requirements 섹션은 비어 있다.

- 컨텍스트 메뉴
  - `frontend/src/components/ContextMenu/ContextMenu.tsx`는 `ContextMenuActionItem.children?: ContextMenuItem[]`를 이미 지원한다.
  - `Submenu`와 `MenuItemList`가 재귀 렌더링 구조라 다단 메뉴 자체는 가능하다.
  - 현재 한계:
    - 최대 깊이 5단계 제한이 없다.
    - 모바일 다이얼로그 모드가 없다.
    - 메뉴 높이가 viewport보다 커질 때 스크롤 처리가 없다.
    - 위치 보정은 오른쪽/아래쪽 중심이며, 왼쪽으로 연 하위 메뉴가 다시 화면 왼쪽 밖으로 나가는 경우까지 일반화되어 있지 않다.
    - 루트 메뉴도 위쪽/왼쪽 clamp가 명시적이지 않다.

- 터미널 컨텍스트 메뉴 조립
  - `frontend/src/utils/contextMenuBuilder.ts`가 현재 세션 메뉴를 만든다.
  - 현재 항목은 `새 세션`, `세션 닫기`, `복사`, `붙여넣기`이며, `새 세션`에서만 하위 메뉴를 사용한다.
  - `frontend/src/App.tsx`는 우클릭 대상 tab id를 `useContextMenu()`로 보관하고, 해당 tab ref의 `sendInput()`으로 붙여넣기한다.

- 등록 항목 도메인
  - `CommandPresetKind`는 `command | directory | prompt`다.
  - 프런트엔드 API: `frontend/src/services/api.ts`의 `commandPresetApi`.
  - 프런트엔드 상태 훅: `frontend/src/components/CommandPresetManager/useCommandPresets.ts`.
  - 서버 저장소: `server/src/services/CommandPresetService.ts`, 기본 파일 `server/data/command-presets.json`.
  - 서버 검증: label 1-80자, value 최대 12000자, NUL 문자 금지.

- 기존 실행 규칙과 새 요구의 차이
  - `frontend/src/components/CommandPresetManager/commandPresetExecution.ts`의 `buildTerminalInput()`은 `command`와 `directory`에 `\r`을 붙여 실행한다.
  - 새 컨텍스트 메뉴 요구는 실행이 아니라 붙여넣기이므로 이 함수를 그대로 재사용하면 안 된다.
  - 새 메뉴는 기본적으로 저장된 `preset.value` 원문을 `sendInput(value)`로 보내는 것이 요구 문장과 가장 일치한다.

## 3. SRS 후보 요구사항

### 3.1 컨텍스트 메뉴 중첩

- 데스크톱 컨텍스트 메뉴는 최대 5단계까지 하위 메뉴를 표시해야 한다.
- 자식 항목이 없는 메뉴는 일반 액션으로 동작해야 한다.
- 자식 항목이 있는 데스크톱 메뉴 항목은 hover 또는 클릭으로 하위 메뉴를 열 수 있어야 한다.
- 비어 있는 자식 메뉴는 표시하지 않아야 한다.
- 구분선은 표시 가능한 인접 액션 항목 사이에서만 의미 있게 렌더링되어야 한다.

### 3.2 화면 경계 보정

- 루트 메뉴와 모든 하위 메뉴는 viewport 밖으로 벗어나지 않아야 한다.
- 오른쪽으로 벗어날 경우 가능한 한 부모 항목의 왼쪽에 표시해야 한다.
- 왼쪽으로도 벗어나는 경우 viewport 내부 margin 안으로 clamp해야 한다.
- 아래로 벗어날 경우 위쪽으로 이동해야 한다.
- 위로 벗어날 경우 아래쪽으로 이동하거나 viewport 내부 margin 안으로 clamp해야 한다.
- 메뉴 내용이 viewport보다 길어질 수밖에 없는 경우 `max-height`와 세로 스크롤을 제공해야 한다.
- 긴 라벨은 레이아웃을 깨지 않도록 최대 너비, ellipsis 또는 줄바꿈 정책을 가져야 한다.

### 3.3 모바일 다이얼로그 모드

- 모바일 viewport에서 컨텍스트 메뉴는 위치 기반 floating menu가 아니라 항상 다이얼로그 형태로 표시해야 한다.
- 모바일 다이얼로그 상단에는 현재 경로를 표시해야 한다. 예: `메뉴 > 커맨드 라인`.
- 자식 항목이 있는 모바일 메뉴 항목은 삼각형 표시를 제공하고, 선택 시 현재 다이얼로그 내용이 자식 항목 목록으로 전환되어야 한다.
- 모바일 다이얼로그 상단의 `뒤로가기` 버튼은 이전 메뉴 단계로 돌아가야 한다.
- Android 브라우저 뒤로 가기 버튼은 현재 메뉴 depth가 1 이상이면 한 단계 뒤로 이동하고, root depth에서는 다이얼로그를 닫아야 한다.
- 이 동작은 브라우저 history/popstate를 명시적으로 다루는 방식으로 검증 가능해야 한다.

### 3.4 등록 항목 붙여넣기

- 세션 터미널 컨텍스트 메뉴 최하단에는 표시 가능한 등록 항목이 있을 때만 `등록 항목 붙여넣기` 메뉴를 표시해야 한다.
- 등록된 항목이 하나도 없으면 최상위 `등록 항목 붙여넣기` 메뉴 자체를 표시하지 않아야 한다.
- `command`, `directory`, `prompt` 중 해당 종류의 등록 항목이 하나도 없으면 그 카테고리 메뉴를 표시하지 않아야 한다.
- 등록 항목은 종류별 `sortOrder` 순서대로 표시해야 한다.
- 등록 항목을 선택하면 해당 항목의 저장된 값을 대상 세션 터미널에 붙여넣어야 한다.
- 붙여넣기 시 `Enter`, `\r`, `\n`을 자동 추가해서는 안 된다.
- 붙여넣기 후 대상 터미널 focus는 유지 또는 복원되어야 한다.
- 붙여넣기 실패, API 로딩 실패 등 의미 있는 오류는 디버그 로그나 사용자 관찰 가능한 경로로 추적 가능해야 한다.

## 4. 구현 영향

- 백엔드 데이터 모델과 API는 이미 존재하므로 새 저장소는 필요 없어 보인다.
- `AppContent` 또는 `buildTerminalContextMenuItems()` 주변에서 `CommandPreset` 목록을 공급해야 한다.
- 기존 `useCommandPresets()`는 dialog 전용 훅이지만 API 호출/정렬 로직 재사용이 가능하다.
- `buildTerminalInput()`은 실행용 함수이므로 새 붙여넣기 메뉴에서는 사용하지 않는 것이 안전하다.
- 컨텍스트 메뉴 위치 계산은 현재 DOM style 직접 변경보다 pure helper로 분리하면 unit test가 쉬워진다.
- 모바일 모드는 `ContextMenu`에 `mobile` 또는 `mode` prop을 추가하고, `AppContent`의 기존 `isMobile` 값을 전달하는 방식이 가장 좁은 변경이다.

## 5. 권장 테스트

- Unit
  - 메뉴 geometry helper: 오른쪽/왼쪽/위/아래 overflow, viewport보다 큰 메뉴의 scroll 필요 여부.
  - preset menu builder: 빈 목록에서는 최상위 메뉴 숨김, 종류별 빈 카테고리 숨김, sortOrder 보존.
  - paste payload: command/directory/prompt 모두 저장 원문만 반환하고 Enter를 추가하지 않음.

- E2E Desktop Chrome
  - 등록 항목이 없으면 우클릭 메뉴에 `등록 항목 붙여넣기`가 없음.
  - command만 있으면 최상위 메뉴와 `커맨드 라인`만 보이고 `디렉토리`/`프롬프트`는 없음.
  - command/directory/prompt 선택 시 터미널 입력줄에 값이 들어가지만 실행 output은 발생하지 않음.
  - 화면 우하단/좌하단/상단 근처에서 연 다단 메뉴가 viewport 안에 남음.
  - 긴 목록은 스크롤 가능함.

- E2E Mobile Safari
  - 우클릭/long press에 해당하는 진입 경로에서 컨텍스트 메뉴가 다이얼로그로 표시됨.
  - 자식 항목 선택 시 경로가 `메뉴 > 커맨드 라인`처럼 갱신됨.
  - `뒤로가기` 버튼으로 이전 depth로 돌아감.
  - browser back/popstate로 이전 depth 또는 닫힘 동작이 수행됨.

## 6. 결정 필요 사항

1. 디렉토리 항목 선택 시 저장된 경로 원문을 붙여넣을지, shell별 `cd ...` 명령 문자열을 붙여넣을지 결정이 필요하다.
   - 연구 기준 권장값: 저장된 값 원문. 이유는 사용자가 "등록된 값"을 "단순히 붙여넣기"라고 명시했기 때문이다.
2. 최상위 메뉴명은 `등록 항목 붙여넣기`를 권장하지만, 더 제품다운 명칭으로 `저장 항목 붙여넣기`도 가능하다.
3. 메뉴가 열린 뒤 다른 창에서 등록 항목이 변경되는 경우 즉시 반영할지, 다음 메뉴 open 시 reload할지 정책이 필요하다.
   - 권장값: 메뉴 open 시 최신 목록을 reload하고, 열린 상태에서는 snapshot을 유지한다.
4. 최대 5단계를 초과하는 children이 들어온 경우 렌더링을 막을지, 초과 depth를 disabled로 표시할지 결정이 필요하다.
   - 권장값: 5단계까지만 렌더링하고 초과 children은 개발 로그로 추적한다.

## 7. 검증 메모

- `mcp__speckiwi__.validate_spec(strict=false)` 결과: diagnostics 없음.
- `mcp__speckiwi__.list_requirements(target=v1.0.0)` 결과: 등록 요구사항 없음.
- 이번 작업은 연구 문서 작성이며, SRS 파일과 구현 코드는 아직 변경하지 않았다.
