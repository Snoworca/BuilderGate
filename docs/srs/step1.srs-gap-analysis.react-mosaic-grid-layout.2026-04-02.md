# SRS GAP 분석: React Mosaic 그리드 레이아웃

**참조 PRD**: PRD-MOSAIC-001 v1.2 Final
**분석일**: 2026-04-02
**분석 목적**: SRS 작성에 앞서 PRD에서 구현 수준으로 내려갈 때 모호하거나 누락된 기술 상세를 식별한다.
**분석 방법**: PRD 전문 + 현행 코드베이스(GridContainer.tsx, useWorkspaceManager.ts, workspace.ts 타입 등) 교차 검토

---

## 분석 요약

| 카테고리 | GAP 수 | CONFLICT 수 |
|----------|--------|------------|
| 함수 시그니처/알고리즘 | 6 | 0 |
| 상태 전이 미정의 | 5 | 1 |
| 데이터 스키마 불완전 | 5 | 1 |
| 에러 핸들링 미정의 | 6 | 0 |
| 타이밍/순서 미정의 | 5 | 0 |
| 미해결 기술 질문 | 7 | 0 |
| **합계** | **34** | **2** |

---

## 1. 함수 시그니처 / 알고리즘 누락

### GAP-1.1 — `buildEqualMosaicTree` 알고리즘의 방향 선택 기준 미정의

**참조**: PRD §6.6
**현상**: PRD가 제시한 의사코드에서 `direction`을 `depth % 2 === 0 ? 'row' : 'column'`으로 결정하지만, `depth`가 재귀 깊이인지 루트로부터의 레벨인지 명시하지 않는다.
**질문**: 재귀 호출 시 `depth` 파라미터를 호출자가 주입하는가, 아니면 내부에서 `Math.floor(Math.log2(ids.length))`를 매번 재계산하는가? 후자라면 N=3일 때 `depth=1`(column), N=2일 때 `depth=1`(column)으로 동일해져 최상위 분기가 항상 column이 된다.
**impact**: 타일 배치가 항상 수직 혹은 수평으로 치우칠 수 있음.
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-1.2 — 포커스 확대 모드의 `splitPercentage` 재계산 함수 인터페이스 미정의

**참조**: PRD §FR-5, §6.3
**현상**: "Mosaic 트리의 splitPercentage 재계산(FR-5.3)"이라고만 기술되며, 이진 트리 구조에서 특정 leaf를 최대화하기 위해 각 중간 노드의 splitPercentage를 어떻게 산출하는지 알고리즘이 없다.
**질문**: `focusTileId: string`을 받아 전체 트리를 순회하면서 각 노드의 `splitPercentage`를 재계산하는 함수의 시그니처와 알고리즘은 무엇인가? 포커스 타일이 `second` 서브트리에 있을 때와 `first` 서브트리에 있을 때 계산 방식이 달라야 한다.
**impact**: FR-5의 핵심 구현 불가 — 이진 트리 구조상 leaf 하나를 확대하려면 경로상 모든 조상 노드의 `splitPercentage`를 연쇄 계산해야 함.
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-1.3 — 오토 모드에서 idle 세션 비율 배분 알고리즘 미정의

**참조**: PRD §FR-6.2, FR-6.3
**현상**: "idle 세션들만 균등 확대"라고 기술하지만, 이진 트리 구조에서 복수의 idle 세션에 동등 비율을 주려면 트리 재구성이 필요한지 splitPercentage 조정만으로 가능한지 명시되지 않는다.
**질문**: idle 세션이 3개, running 세션이 5개일 때, 이진 트리의 어느 조상 노드를 어떤 비율로 설정하는가? idle 세션들이 트리상 흩어져 있을 때 "균등 확대"를 splitPercentage 조정만으로 구현할 수 있는가, 아니면 트리를 재구성해야 하는가?
**impact**: FR-6.3의 구현 방식이 확정되지 않으면 useMosaicLayout.ts 설계 불가.
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-1.4 — 세션 추가 시 Mosaic 트리 "전체 균등 재배치" 구현 방식 미정의

**참조**: PRD §FR-3.2
**현상**: 세션 추가 후 "Mosaic 트리 전체 균등 재배치"라고만 기술. 기존 트리를 버리고 `buildEqualMosaicTree`로 완전 재생성하는지, 기존 트리에 새 노드를 삽입하는지 명확하지 않다.
**질문**: 세션 추가 시 기존 트리 구조(사용자가 드래그로 조정한 위치 포함)를 완전히 버리는가, 아니면 새 세션만 삽입하고 나머지 splitPercentage를 균등하게 재조정하는가?
**impact**: 사용자가 드래그로 배치한 레이아웃 정보의 보존 여부에 영향.
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-1.5 — `useFocusHistory` 훅의 "마지막 사용(입력)" 추적 기준 미정의

**참조**: PRD §FR-3.5, §5.2
**현상**: "마지막으로 사용(입력)한 세션으로 포커스 이동"이 요구되며, `useFocusHistory` 훅 생성이 명시되어 있다. 그러나 "사용"의 이벤트 기준이 없다.
**질문**: 다음 중 무엇을 "마지막 사용" 이벤트로 기록하는가?
(a) xterm.js `onKey` 이벤트 발생 시
(b) 터미널 컨테이너 `click` 이벤트 시
(c) `terminal.focus()` 호출 시
(d) 복합 (키 입력 > 클릭 > 포커스 순위)
**impact**: FR-3.5, FR-3 수용 조건("마지막 사용 순서 추적을 위한 타임스탬프/스택 관리")의 구현 방식이 달라짐.
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-1.6 — 레거시 GridLayout → MosaicNode 마이그레이션 함수의 입력 불완전 처리 미정의

**참조**: PRD §6.7
**현상**: "기존 GridLayout이 감지되면 `buildEqualMosaicTree(tabOrder)`로 변환"이라고 명시하지만, `tabOrder`가 비어있거나 실제 탭 목록과 불일치하는 경우 처리 방침이 없다.
**질문**: 마이그레이션 시 `tabOrder`가 null/빈 배열이거나 서버의 실제 탭 목록과 다를 때 어떤 fallback을 사용하는가? 서버 측(`WorkspaceService.ts`)과 클라이언트 측(`useMosaicLayout.ts`) 중 어디서 마이그레이션을 수행하는가?
**impact**: 마이그레이션 코드 작성 시 방어 로직의 범위가 결정되지 않음. 현재 서버 `GridLayout` 타입에 `tabOrder: string[]`가 존재하므로 빈 배열 케이스가 실제로 발생함.
**type**: GAP
**source**: requirements
**satisfied**: false

---

## 2. 상태 전이 미정의

### GAP-2.1 — 크기 모드 상태 머신의 전이 조건표 불완전

**참조**: PRD §6.2
**현상**: PRD가 다이어그램 형태로 전이를 제시하지만, 전이 조건이 부분적으로만 명시됨.

현재 명시된 전이:
- 수동 리사이즈 시: 오토 → 균등
- 포커스 대상 탭 닫힘: 포커스 → 균등

**누락된 전이 조건**:
- 수동 리사이즈 시 포커스 모드 → ? (균등인가, 그대로인가?)
- 균등 모드에서 수동 리사이즈 후 모드 상태는?
- 오토 모드 활성 중 idle 세션이 닫힐 때의 전이
- 포커스 모드에서 포커스 대상이 소멸(서버 소멸)했을 때

**질문**: 위 4가지 케이스 각각의 결과 상태는 무엇인가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-2.2 — 오토 모드 해제 트리거 "수동 분할선 드래그" 감지 방법 미정의

**참조**: PRD §FR-6 수용 조건: "오토 모드 중 사용자가 수동으로 분할선을 조절하면 오토 모드 해제 (균등 모드로 전환)"
**현상**: React Mosaic의 `onChange` 콜백은 분할선 드래그와 프로그래매틱 트리 업데이트 모두 동일한 콜백으로 호출된다. PRD는 이 두 가지를 구별하는 방법을 제시하지 않는다.
**질문**: 사용자의 수동 드래그를 프로그래매틱 변경과 어떻게 구별하는가? `onDragStart`/`onDragEnd` 이벤트 플래그를 사용하는가, 아니면 변경 출처를 ref로 추적하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-2.3 — 포커스 모드에서 "현재 타일" 정의 미정의

**참조**: PRD §FR-4.4, FR-5
**현상**: "현재 타일 최대화"라고 기술하지만, "현재 타일"이 아이콘 버튼을 클릭한 타일인지, 포커스(입력 포커스)가 있는 타일인지 명확하지 않다.
**질문**: 포커스 확대 버튼을 클릭할 때 "현재 타일"은 (a) 해당 아이콘 박스가 속한 타일인가, 아니면 (b) xterm.js focus를 가진 타일인가? 두 경우가 다를 때 어느 것을 우선하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-2.4 — 그리드 모드 전환 시 기존 Mosaic 트리 초기화 시점 미정의

**참조**: PRD §5.1 (WorkspaceTabBar.tsx "그리드 모드 전환 시 Mosaic 초기화")
**현상**: 탭 모드 → 그리드 모드 전환 시 저장된 레이아웃이 있으면 복원, 없으면 균등 생성임은 PRD §FR-7.3에서 유추 가능하다. 그러나 그리드 → 탭 → 그리드로 돌아왔을 때 처리 방침이 없다.
**질문**: 그리드 → 탭 전환 시 현재 Mosaic 트리 상태를 즉시 localStorage에 저장하는가, 아니면 이미 디바운스된 저장이 처리하는가? 탭 모드에 있는 동안 다른 워크스페이스에서 세션이 추가/삭제될 경우 다시 그리드 모드로 복귀 시 저장된 트리와 실제 세션 목록의 정합성을 어떻게 보장하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-2.5 — 오토 모드 상태 전환 디바운스와 FR-6.4(300ms) 제약의 충돌

**참조**: PRD §FR-6.4, §7 리스크 표
**현상**: FR-6.4는 status 변경 후 300ms 이내 레이아웃 재조정을 요구한다. §7 리스크 표에서는 "오토 모드 점핑 방지"를 위해 "상태 전환 디바운스(300ms)"를 완화 전략으로 제시한다. 디바운스가 300ms라면, 실제 레이아웃 변경은 status 변경으로부터 최소 300ms 후에 발생하므로 FR-6.4의 "300ms 이내" 조건을 충족하기 어렵다.
**질문**: 디바운스 지연을 FR-6.4 제약(300ms) 내에서 허용하려면 디바운스 값을 얼마로 설정해야 하는가? 또는 FR-6.4의 측정 기준(타임스탬프 비교 방식)이 디바운스를 포함하지 않는 것인가?
**type**: CONFLICT
**source**: requirements
**satisfied**: false

---

## 3. 데이터 스키마 불완전

### GAP-3.1 — localStorage 저장 스키마의 버전 관리 필드 누락

**참조**: PRD §6.4
**현상**: PRD가 제시한 localStorage value 스키마:
```json
{
  "tree": "MosaicNode<string>",
  "mode": "equal | focus | auto",
  "focusTarget": "string | null",
  "savedAt": "ISO timestamp"
}
```
버전 필드(`schemaVersion`)가 없다. 향후 스키마 변경 시 역직렬화 실패가 발생할 수 있다.
**질문**: 초기 스키마 버전을 `schemaVersion: 1`로 포함할 것인가? 구버전 스키마 감지 시 마이그레이션 전략은 무엇인가(균등 폴백 vs. 마이그레이션 함수)?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-3.2 — 서버 측 MosaicNode 저장 스키마 미정의

**참조**: PRD §5.3 (workspaces.json 스키마 변경), §FR-7.4
**현상**: PRD는 서버의 `GridLayout` 타입을 `mosaicTree: MosaicNode`로 변경한다고 명시하지만, 서버 측 스키마를 JSON으로 어떻게 표현하는지 구체적이지 않다. 현재 서버 `GridLayout`:
```typescript
{ workspaceId, columns, rows, tabOrder, cellSizes }
```
새 구조에서 `columns`, `rows`, `cellSizes`를 제거하고 `mosaicTree`를 추가하면, 마이그레이션 전 데이터와 구별할 방법이 없다.
**질문**: 서버 `GridLayout`의 새 TypeScript 타입 정의는 무엇인가? `mosaicTree`가 null일 때(레이아웃 미저장 상태)와 레거시 필드가 있을 때를 구별하는 discriminant 필드가 필요한가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-3.3 — `workspaces.json` 마이그레이션 스크립트 존재 여부 및 실행 시점 미정의

**참조**: PRD §5.3, §7 리스크 표 ("마이그레이션 스크립트 작성, 기존 데이터 백업")
**현상**: 마이그레이션이 필요하다고 언급하지만, 실행 시점(서버 시작 시 자동, 또는 수동 스크립트)과 `.bak` 파일 네이밍 규칙이 없다. 현재 코드베이스에는 `workspaces.json.bak`이 이미 존재하므로 충돌 가능성이 있다.
**질문**: 마이그레이션은 서버 초기화(`WorkspaceService` 생성자)에서 자동 실행되는가? `.bak` 파일이 이미 존재할 때 덮어쓰는가, 타임스탬프를 붙이는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-3.4 — FR-7.5 "빈 슬롯에 새 세션 자동 생성" 시 새 세션의 초기 속성 미정의

**참조**: PRD §FR-7.5
**현상**: 서버 재시작 후 소멸된 세션의 슬롯에 새 세션을 자동 생성한다고 명시하지만, 새 세션의 `name`, `shellType`, `cwd`, `colorIndex` 초기값이 정의되지 않는다.
**질문**: 새 세션의 속성을 기존 `WorkspaceTab` 레코드(소멸 전 탭 정보)에서 복원하는가, 아니면 기본값을 사용하는가? 소멸된 탭의 메타데이터는 어디에 보존되는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-3.5 — `MosaicNode<string>`에서 `string`이 탭 ID인지 세션 ID인지 혼용 가능성

**참조**: PRD §6.1
**현상**: PRD는 "T = string (탭 ID)"라고 명시하지만, 현재 코드베이스에서 탭과 세션은 별개의 ID를 가진다(`WorkspaceTab.id` vs `WorkspaceTab.sessionId`). 컨텍스트 메뉴(FR-2)에서 "새 세션 열기"는 현재 세션의 `cwd`를 사용하므로, Mosaic 노드 ID로부터 `cwd`를 조회하려면 탭 ID가 필요하다.
**질문**: Mosaic 노드의 leaf 값으로 `WorkspaceTab.id`(탭 ID)를 사용하는 것이 확정인가? `WorkspaceTab.sessionId`가 아닌 탭 ID를 사용하는 이유와 두 ID 간 매핑 방식은?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-3.6 — 서버 측 GridLayout API 엔드포인트 스키마 변경과 기존 클라이언트 호환성

**참조**: PRD §5.3 (workspaceRoutes.ts 수정)
**현상**: 현재 `updateGrid` API는 `{ columns, rows, tabOrder, cellSizes }` 형태를 받는다. MosaicNode 기반으로 변경하면 기존 API 계약이 깨진다. PRD는 마이그레이션 방향만 제시하고 API 버전 관리나 하위 호환성 전략이 없다.
**질문**: API를 새 스키마로 변경할 때 기존 요청 형식을 거부하는가(breaking change), 아니면 두 형식을 모두 수용하는 어댑터 레이어를 두는가? 버전 헤더(`api-version`) 또는 별도 엔드포인트를 사용하는가?
**type**: CONFLICT
**source**: requirements
**satisfied**: false

---

## 4. 에러 핸들링 미정의

### GAP-4.1 — Clipboard API 권한 에러 처리 미정의

**참조**: PRD §FR-2.5, FR-2.6
**현상**: 복사/붙여넣기 기능이 요구되지만, `navigator.clipboard.readText()` 및 `writeText()`는 브라우저 권한 정책에 따라 실패할 수 있다(HTTPS 아닌 환경, 권한 거부).
**질문**: Clipboard API 실패 시 사용자에게 어떤 피드백을 주는가? 폴백으로 `document.execCommand('copy'/'paste')`를 사용하는가? 에러 토스트의 메시지와 표시 위치는?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-4.2 — localStorage Quota 초과 처리 미정의

**참조**: PRD §FR-7.1, FR-7.2
**현상**: `localStorage`의 용량 제한(브라우저별 5~10MB)을 초과할 경우 `QuotaExceededError`가 발생한다. 8개 세션의 깊은 Mosaic 트리 + 여러 워크스페이스의 레이아웃이 누적될 때 발생 가능성이 있다.
**질문**: `localStorage.setItem` 실패 시 어떻게 처리하는가? IndexedDB로의 폴백 전략이 있는가(FR-7.1에 "localStorage/IndexedDB"로 병기되어 있으나 기본 선택이 불명확)? 또는 오래된 워크스페이스 레이아웃을 자동 삭제하는 LRU 정책을 사용하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-4.3 — Mosaic 트리 역직렬화 실패 상세 처리 미정의

**참조**: PRD §7 리스크 ("저장 전 validation, 실패 시 기본 균등 그리드 폴백"), §TC-10
**현상**: TC-10에서 손상된 JSON 처리는 "콘솔 경고 허용, UI 크래시 없음"으로 명시하지만, 폴백 범위가 모호하다.
**질문**: JSON 파싱 성공 + 스키마 불일치(예: `tree`가 null, `mode`가 알 수 없는 값, `splitPercentage`가 범위 초과) 케이스는 어떻게 처리하는가? Zod 등 런타임 스키마 검증을 사용하는가? 부분적으로 유효한 트리(일부 노드만 손상)의 경우 전체 폴백인가, 부분 복원인가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-4.4 — React Mosaic 라이브러리 내부 에러 처리 미정의

**참조**: PRD §FR-1
**현상**: `react-mosaic-component`의 내부 에러(예: 드래그 중 포인터 이벤트 누락, DnD 컨텍스트 없음) 발생 시 처리 방침이 없다.
**질문**: React Error Boundary를 MosaicContainer 수준에서 감싸는가? 에러 발생 시 균등 그리드로 폴백하는 리셋 버튼 UI를 제공하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-4.5 — 세션 생성 API 실패 시 Mosaic 트리 롤백 미정의

**참조**: PRD §FR-3.1, FR-3.2
**현상**: "새 세션 열기" 시 서버 API 호출 후 Mosaic 트리가 재구성된다. 서버 API 호출이 실패하면(네트워크 오류, 세션 한도 초과 등) Mosaic 트리가 새 슬롯을 포함한 상태가 되는지, 아니면 롤백되는지 명시되지 않는다.
**질문**: 세션 생성 API 실패 시 Mosaic 트리를 이전 상태로 롤백하는가? 사용자에게 어떤 에러 메시지를 표시하는가? 낙관적 업데이트(optimistic update) 방식을 사용하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-4.6 — `beforeunload` 저장 중 비동기 작업 실패 처리 미정의

**참조**: PRD §FR-7.2
**현상**: `beforeunload` 이벤트에서 localStorage 저장을 수행하는데, 브라우저가 페이지를 unload하는 동안 동기 작업 이외의 작업은 보장되지 않는다.
**질문**: `beforeunload` 핸들러 내에서 `localStorage.setItem`은 동기 방식이므로 문제없으나, 서버 측 Mosaic 트리 저장(`updateGrid` API)도 `beforeunload`에서 수행하는가? 수행한다면 `navigator.sendBeacon()`을 사용하는가 아니면 무시하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

## 5. 타이밍 / 순서 미정의

### GAP-5.1 — 새 세션 추가 시 이벤트 시퀀스의 정확한 순서 미정의

**참조**: PRD §FR-3.1, FR-3.2, FR-3 수용 조건
**현상**: PRD 시나리오 3에서 "새 세션 열기 → Mosaic 트리 균등 재배치 → 새 세션으로 포커스 이동"의 순서는 기술되어 있으나, 각 단계의 전제 조건이 불명확하다.
**질문**: 다음 시퀀스가 맞는가?
1. 컨텍스트 메뉴 "새 세션 열기" 클릭
2. 서버 `POST /api/sessions` 호출 (sessionId 획득)
3. 서버 `POST /api/workspaces/:id/tabs` 호출 (tabId 획득)
4. 로컬 `tabs` 상태 업데이트
5. `buildEqualMosaicTree(새 tabIds)` 호출하여 Mosaic 트리 재생성
6. `terminal.focus()` 호출
단계 2-3은 순서가 바뀔 수 있는가? 단계 4-5 사이에 WebSocket으로 탭 추가 이벤트가 도달하면 중복 업데이트가 발생하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-5.2 — 세션 닫기 확인 모달과 포커스 이동의 타이밍 미정의

**참조**: PRD §FR-3.4, FR-3.5
**현상**: 세션 닫기 → 확인 모달 → 삭제 → 포커스 이동 순서이지만, 삭제 API 응답 전에 포커스를 이동하는가(낙관적), 응답 후에 이동하는가가 명시되지 않는다.
**질문**: 세션 삭제 API(`DELETE /api/workspaces/:id/tabs/:tabId`) 응답을 기다린 후 포커스를 이동하는가, 아니면 낙관적 업데이트를 사용하는가? 삭제 API 실패 시 포커스는 어디로 이동하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-5.3 — xterm.js `FitAddon.fit()` 호출 타이밍과 Mosaic 리사이즈 완료 감지 방법 미정의

**참조**: PRD §FR-1.4, §6.5, FR-1 수용 조건("리사이즈 완료 후 500ms 이내에 FitAddon.fit() 호출 완료")
**현상**: PRD §6.5는 "ResizeObserver가 자동 감지하므로 추가 코드 불필요"라고 하지만, 분할선 드래그 중에는 `ResizeObserver`가 매 픽셀마다 발화하여 `fit()`이 수십 번 호출될 수 있다.
**질문**: 드래그 중 `fit()` 호출을 throttle하는 현재 메커니즘(`rAF` + `100ms debounce`)이 Mosaic 분할선 드래그에도 그대로 적용되는가? "리사이즈 완료" 시점을 `ResizeObserver`의 마지막 발화 후 100ms 정적(quiet)으로 정의하는가, 아니면 Mosaic의 `onRelease` 이벤트를 사용하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-5.4 — 크기 모드 전환 시 CSS transition과 Mosaic `onChange` 콜백의 관계 미정의

**참조**: PRD §FR-5 수용 조건("CSS transition duration 200~300ms"), FR-6.5(부드러운 애니메이션)
**현상**: React Mosaic은 `splitPercentage`를 상태로 관리하며, 상태 변경은 즉각적이다. PRD는 "CSS transition으로 부드러운 전환"을 요구하지만, React Mosaic의 분할선 위치는 CSS 속성이 아닌 React 상태이므로 CSS transition이 직접 적용되지 않는다.
**질문**: `splitPercentage` 변경 시 부드러운 애니메이션을 구현하기 위해 어떤 방법을 사용하는가?
(a) `requestAnimationFrame` 기반 점진적 상태 업데이트 (스텝 애니메이션)
(b) CSS `transition`이 가능한 방식으로 Mosaic 내부 DOM에 직접 접근
(c) React Mosaic의 애니메이션 지원 API (있다면)
(d) 애니메이션 없이 즉시 전환 허용 (FR-6.5가 P2이므로)
**type**: GAP
**source**: requirements
**satisfied**: false

---

### GAP-5.5 — 레이아웃 디바운스 저장 중 컴포넌트 언마운트 시 처리 미정의

**참조**: PRD §FR-7.2 ("1초 디바운스")
**현상**: 1초 디바운스 중 컴포넌트가 언마운트되면(탭 전환, 워크스페이스 전환) 디바운스 타이머가 실행되어 언마운트된 컴포넌트의 상태를 참조할 수 있다.
**질문**: `useMosaicLayout` 훅의 cleanup 함수에서 디바운스 타이머를 취소하는가? 취소 시 마지막 변경이 저장되지 않을 수 있으므로, cleanup 직전에 즉시 저장을 수행하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

## 6. 미해결 기술 질문 (SRS 작성 전 결정 필요)

### Q-1 — localStorage vs. IndexedDB 기본 저장소 선택

**참조**: PRD §FR-7.1 ("localStorage/IndexedDB에 저장")
**현상**: PRD가 두 가지를 병기하여 기본 선택이 결정되지 않음.
**질문**: 기본 저장소는 localStorage인가 IndexedDB인가? IndexedDB는 비동기 API이므로 `beforeunload` 핸들러에서 사용이 불가능하다(비동기 작업 미완료로 데이터 손실 위험). 이 제약을 고려했을 때 localStorage가 유일한 실용적 선택 아닌가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### Q-2 — react-mosaic-component 버전 호환성 확인 필요

**참조**: PRD §5.4 ("latest" 버전 명시)
**현상**: `react-mosaic-component`의 최신 버전이 React 18과 호환되는지, `react-dnd` peer dependency 버전 요구사항이 현재 프로젝트의 다른 의존성과 충돌하지 않는지 검증되지 않았다.
**질문**: `react-mosaic-component@latest`의 정확한 버전 번호와 React 18 지원 여부를 확인하였는가? `react-dnd`와 `react-dnd-html5-backend`의 required 버전은 무엇인가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### Q-3 — 롱프레스 구현과 xterm.js 터치 이벤트 충돌 회피 방법

**참조**: PRD §FR-2.2 수용 조건 ("롱프레스가 xterm.js 터치 이벤트와 충돌하지 않음")
**현상**: xterm.js는 터치 이벤트를 자체 처리하며(스크롤, 선택 등), `touchstart`/`touchend` 이벤트를 막으면 터미널 스크롤이 불가해진다.
**질문**: 롱프레스 감지를 위한 이벤트 캡처를 xterm.js 컨테이너 외부(MosaicTile 레벨)에서 처리하는가, 아니면 xterm.js 내부에서 처리하는가? `pointer-events: none` 오버레이 레이어를 사용하는 방식을 검토하였는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### Q-4 — `ConfirmModal` 재사용 시 세션 닫기 확인의 비동기 패턴

**참조**: PRD §FR-3.4, §5.2 ("기존 ConfirmModal.tsx 재사용")
**현상**: 현재 `ConfirmModal.tsx`의 인터페이스가 어떤 패턴을 사용하는지(콜백 vs. Promise vs. 상태 기반) 명시되지 않았다. 컨텍스트 메뉴에서 모달을 열고 확인을 기다리는 비동기 흐름을 어떻게 처리하는지 정의 필요.
**질문**: `ConfirmModal`은 `onConfirm` / `onCancel` 콜백 방식인가, 아니면 Promise를 반환하는 방식인가? 컨텍스트 메뉴 → 모달 → 삭제 흐름에서 컨텍스트 메뉴 상태(`useContextMenu`)는 언제 닫히는가(모달 열기 시 즉시, 또는 모달 완료 후)?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### Q-5 — 모바일 그리드 비활성화의 구체적 감지 기준

**참조**: PRD §FR-1.6, §3.2
**현상**: "모바일에서는 그리드 모드 비활성화"라고 하지만, 감지 기준이 `useResponsive` 훅의 `isMobile`인지, viewport 너비 임계값인지, User-Agent인지 명시되지 않는다. 현재 코드에 `useResponsive` 훅이 존재하므로 연계가 자연스럽지만, 태블릿(768~1024px)은 어느 쪽인지 정의가 없다.
**질문**: 그리드 모드 비활성화의 기준 viewport 너비는 얼마인가? `useResponsive` 훅의 `isMobile` 기준과 동일한가? 태블릿 크기에서는 그리드 모드를 허용하는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

### Q-6 — `splitPercentage` 최솟값 강제의 적용 레벨

**참조**: PRD §FR-1.5, §6.3, TC-11
**현상**: "splitPercentage 기반, 최소 5%"라는 제약이 어느 레벨에서 적용되는지 불명확하다. Mosaic의 `onChange` 콜백에서 후처리로 clamp하는 방식은 React Mosaic이 이미 DOM에 반영한 후 state만 보정하므로 시각적 점프가 발생할 수 있다.
**질문**: 최소 비율 강제를 (a) Mosaic의 `onChange` 콜백에서 트리를 받아 후처리 clamp, (b) Mosaic에 `minSize` prop이 있다면 해당 prop 사용, (c) 커스텀 DnD 핸들러 재정의 중 어느 방식으로 구현하는가? react-mosaic-component가 최소 크기 prop을 지원하는지 확인이 필요하다.
**type**: GAP
**source**: requirements
**satisfied**: false

---

### Q-7 — `MosaicToolbar` 아이콘 박스의 호버 타이머와 Mosaic 포커스 추적의 독립성

**참조**: PRD §FR-4.1, FR-4 수용 조건 ("300ms 후 사라짐")
**현상**: PRD가 "마우스가 아이콘 박스를 벗어나면 300ms 후 사라짐"을 명시하지만, 8개 타일이 있을 때 각 타일이 독립적인 호버 타이머를 가지는지, 공유 상태인지 불명확하다. 또한 아이콘 박스 표시 중 모드 전환 버튼을 클릭하면 타이머가 즉시 취소되어야 하는지 명시되지 않는다.
**질문**: 호버 타이머와 표시 상태는 각 `MosaicTile` 컴포넌트의 로컬 state인가, `useMosaicLayout` 훅의 공유 상태인가? 버튼 클릭 후 아이콘 박스는 즉시 사라지는가, 300ms 타이머 후 사라지는가?
**type**: GAP
**source**: requirements
**satisfied**: false

---

## 부록: GAP 색인 (SRS 섹션 매핑용)

| GAP ID | 관련 FR | SRS 섹션 (예정) | 우선순위 |
|--------|---------|----------------|---------|
| GAP-1.1 | FR-1, 구현 | 알고리즘 상세 | P0 |
| GAP-1.2 | FR-5 | 포커스 확대 알고리즘 | P0 |
| GAP-1.3 | FR-6 | 오토 모드 로직 | P0 |
| GAP-1.4 | FR-3.2 | 세션 추가 동작 | P0 |
| GAP-1.5 | FR-3.5 | 포커스 이력 | P0 |
| GAP-1.6 | §6.7 | 마이그레이션 | P1 |
| GAP-2.1 | FR-4, FR-5, FR-6 | 상태 머신 | P0 |
| GAP-2.2 | FR-6 수용 조건 | 오토 모드 트리거 | P0 |
| GAP-2.3 | FR-4.4 | 포커스 대상 정의 | P0 |
| GAP-2.4 | §5.1 | 모드 전환 | P1 |
| GAP-2.5 | FR-6.4 | 타이밍 충돌 | P0 |
| GAP-3.1 | FR-7.1 | 저장 스키마 | P1 |
| GAP-3.2 | §5.3 | 서버 스키마 | P0 |
| GAP-3.3 | §5.3 | 마이그레이션 | P1 |
| GAP-3.4 | FR-7.5 | 세션 복원 | P1 |
| GAP-3.5 | §6.1 | 타입 정의 | P0 |
| GAP-3.6 | §5.3 | API 호환성 | P0 |
| GAP-4.1 | FR-2.5, FR-2.6 | 에러 처리 | P1 |
| GAP-4.2 | FR-7.1 | 저장 에러 | P1 |
| GAP-4.3 | FR-7.3, TC-10 | 역직렬화 에러 | P0 |
| GAP-4.4 | FR-1 | 라이브러리 에러 | P1 |
| GAP-4.5 | FR-3.1 | API 실패 롤백 | P0 |
| GAP-4.6 | FR-7.2 | beforeunload | P1 |
| GAP-5.1 | FR-3.1, FR-3.2 | 세션 추가 시퀀스 | P0 |
| GAP-5.2 | FR-3.4, FR-3.5 | 세션 닫기 시퀀스 | P0 |
| GAP-5.3 | FR-1.4, FR-1 수용 조건 | FitAddon 타이밍 | P0 |
| GAP-5.4 | FR-5 수용 조건, FR-6.5 | 애니메이션 구현 | P2 |
| GAP-5.5 | FR-7.2 | 언마운트 cleanup | P1 |
| Q-1 | FR-7.1 | 저장소 선택 | P0 |
| Q-2 | §5.4 | 의존성 호환성 | P0 |
| Q-3 | FR-2.2 수용 조건 | 터치 이벤트 | P1 |
| Q-4 | FR-3.4 | 모달 패턴 | P0 |
| Q-5 | FR-1.6 | 모바일 감지 | P1 |
| Q-6 | FR-1.5, TC-11 | 최솟값 강제 | P0 |
| Q-7 | FR-4.1 | 호버 타이머 | P2 |
