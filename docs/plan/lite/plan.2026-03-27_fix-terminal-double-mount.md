---
title: 터미널 이중 마운트 버그 수정
project: BuilderGate
date: 2026-03-27
type: fix
tech_stack: React 18 + TypeScript, xterm.js, WebSocket
code_path: frontend/src
---

# 터미널 이중 마운트 버그 수정

## 1. 의도 및 요구사항

### 1.1 목적
동일 sessionId에 대해 TerminalView(xterm) 인스턴스가 항상 하나만 마운트되도록 보장하여 커서 두 개 현상을 제거한다.

### 1.2 배경
그리드 모드에서 간헐적으로 터미널 커서가 두 개 보이는 현상이 보고됨. 분석 결과 동일 sessionId에 대해 TerminalContainer/TerminalView가 동시에 2개 마운트될 수 있는 코드 경로가 확인됨.

근본 원인 3가지:
1. **key prefix 불일치**: 그리드 모드(`ws-`)와 탭 모드(`tab-`)에서 같은 sessionId에 다른 key를 사용. 뷰 모드 전환 시 React가 언마운트+마운트를 동시 수행하여 xterm 인스턴스 2개가 공존하는 구간 발생
2. **WS 구독 덮어쓰기**: `subscribeSession`이 Map.set()으로 핸들러를 덮어써, 첫 번째 인스턴스는 데이터를 받지 못하지만 xterm은 살아있어 커서만 보임
3. **콜백 재생성 연쇄**: `renderTerminal`의 useCallback 의존성 체인이 길어 불필요한 리마운트 유발

### 1.3 기능 요구사항
- FR-1: 동일 sessionId에 대해 TerminalView가 동시에 2개 이상 마운트되지 않아야 한다
- FR-2: 그리드↔탭 뷰 모드 전환 시 터미널 세션이 끊김 없이 유지되어야 한다
- FR-3: WS 구독이 동일 sessionId에 대해 중복 등록되지 않아야 한다

### 1.4 비기능 요구사항
- NFR-1: 뷰 모드 전환 시 체감 지연 없음 (기존과 동일)
- NFR-2: 기존 터미널 기능(입력, 출력, 리사이즈, CWD 추적)에 회귀 없음

### 1.5 제약사항
- React 18의 StrictMode가 개발 모드에서 이중 마운트를 유발할 수 있으나, 이는 정상 동작이며 프로덕션에서는 발생하지 않음. 프로덕션 이중 마운트만 수정 대상
- xterm.js v5 API (onFocus/onBlur 없음, dispose()로 정리)

## 2. 현행 코드 분석

### 2.1 영향 범위
| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `frontend/src/App.tsx` | 수정 | key prefix 통일, 콜백 의존성 최적화 |
| `frontend/src/contexts/WebSocketContext.tsx` | 수정 | 구독 중복 방지 가드 추가 |
| `frontend/src/components/Terminal/TerminalContainer.tsx` | 수정 | memo 비교 함수 추가 |

### 2.2 재사용 가능 코드
- `WebSocketContext.subscribeSession` — 기존 구독/해제 로직 구조 유지, 가드만 추가
- `TerminalContainer` memo 래퍼 — 커스텀 비교 함수로 교체

### 2.3 주의사항
- key를 통일하면 뷰 모드 전환 시 React가 기존 인스턴스를 **재사용**한다. 이는 의도된 동작이지만, DOM 위치가 바뀌므로 xterm의 FitAddon이 리사이즈를 감지하는지 확인 필요
- 탭 모드에서는 activeTab 외 TerminalContainer가 언마운트되므로, 그리드→탭 전환 시 비활성 탭의 xterm 히스토리가 유실될 수 있음. 이는 기존 동작과 동일하며 (WS outputBuffer로 복원), key 통일로 인한 신규 회귀가 아님을 확인 필요
- `subscribeSession`의 가드 로직은 정상적인 핸들러 교체(같은 컴포넌트의 리렌더)를 막지 않아야 함. cleanup→re-subscribe 순서는 유지

## 3. 구현 계획

## Phase 1: key prefix 통일로 이중 마운트 방지
- [ ] Phase 1-1: App.tsx의 탭 모드 TerminalContainer key를 `tab-{id}-{sessionId}`에서 `ws-{id}-{sessionId}`로 변경하여 그리드/탭 모드 간 동일 key 사용 `FR-1` `FR-2`
- [ ] Phase 1-2: renderTerminal 콜백과 탭 모드 직접 렌더링에서 동일한 key 생성 함수 사용 `FR-1`
- **테스트:**
  - (정상) 그리드→탭→그리드 전환 시 커서가 항상 1개만 보임
  - (예외) 빠르게 반복 전환(5회 이상) 시에도 커서 1개 유지

## Phase 2: WS 구독 중복 방지
- [ ] Phase 2-1: `subscribeSession`에서 `activeSubscriptionsRef`에 이미 sessionId가 존재하면 WS subscribe 메시지를 보내지 않고 `sessionHandlersRef.set()`만 수행. cleanup이 먼저 실행되면 `activeSubscriptionsRef.delete()`가 호출되어 다음 subscribeSession에서 정상적으로 subscribe 메시지가 전송됨 `FR-3`
- [ ] Phase 2-2: 핸들러 Map.set은 항상 수행 (리렌더 시 최신 콜백으로 교체 필요). WS subscribe 메시지만 조건부 전송 `FR-3`
- **테스트:**
  - (정상) 페이지 로드 시 각 sessionId당 subscribe 메시지가 정확히 1회 전송됨
  - (예외) WS 재연결 후 re-subscribe 시에도 중복 없음

## Phase 3: 콜백 안정화로 불필요한 리마운트 방지
- [ ] Phase 3-1: TerminalContainer에 커스텀 memo 비교 함수 추가 — `(prev, next) => prev.sessionId === next.sessionId && prev.isVisible === next.isVisible`로 콜백 참조 변경을 무시 `FR-1`
- [ ] Phase 3-2: App.tsx에서 handleTerminalStatusChange, handleCwdChange, handleAuthError, handleRestartTab 각각에 대해 useRef로 최신 콜백을 보관하고, 안정적 래퍼 함수를 생성하여 renderTerminal의 useCallback 의존성 배열을 `[]`로 변경. 패턴: `const cbRef = useRef(cb); cbRef.current = cb; const stableCb = useCallback((...args) => cbRef.current(...args), [])` `FR-1`
- [ ] Phase 3-3: TerminalContainer 내부 useEffect의 의존성에서 onStatusChange/onCwdChange를 제거하고, 핸들러 호출 시 ref를 통해 최신 콜백을 읽도록 변경 `FR-1`
- **테스트:**
  - (정상) 다른 탭 상태 변경 시 무관한 TerminalContainer의 useEffect가 재실행되지 않음 — TerminalContainer useEffect 내 `console.count('subscribe-' + sessionId)` 임시 로그로 확인, 탭 전환 10회 후 sessionId 변경 없는 재실행이 0회
  - (예외) 탭 restart 시에는 sessionId가 변경되므로 정상적으로 재구독됨

## 4. 검증 기준
- [ ] 빌드 성공 (tsc 에러 없음)
- [ ] 그리드 모드 8개 터미널에서 커서가 각 1개씩만 표시
- [ ] 그리드↔탭 모드 5회 반복 전환 후 커서 1개 유지
- [ ] 터미널 입력/출력/리사이즈/CWD 추적 정상 동작 (회귀 없음)
- [ ] WS 재연결 후 모든 세션 정상 복구
- [ ] Phase 3 검증: 탭 전환 10회 후 무관한 TerminalContainer의 subscribe useEffect 재실행 0회 (콘솔 로그로 확인)
- [ ] 요구사항 전수 매핑: FR-1 → Phase 1, 3 / FR-2 → Phase 1 / FR-3 → Phase 2
