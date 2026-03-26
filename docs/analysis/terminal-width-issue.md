# 터미널 너비 문제 분석 및 react-mosaic 도입 검토

**날짜**: 2026-03-27
**증상**: 터미널 콘텐츠가 사용 가능한 너비의 65~80%만 차지함
**현상**: Claude Code의 가로 구분선이 터미널 컨테이너의 오른쪽 끝까지 도달하지 못함
**추가 검토**: 다음 스프린트에서 react-mosaic 도입 시 터미널 리사이즈 호환성

---

# Part 1: 현재 터미널 너비 문제

## 1. 문제 요약

BuilderGate 터미널에서 전체 너비 TUI 애플리케이션(예: Claude Code)을 실행하면, 콘텐츠가 화면의 약 65~80%만 채운다. 가로 구분선(─────)과 오른쪽 정렬 텍스트(예: `medium · /effort`)가 오른쪽 끝보다 훨씬 앞에서 멈추며, 나머지는 검은색 빈 공간으로 남는다.

## 2. 스크린샷 분석

![터미널 너비 문제](../../.screenshot/img.png)

스크린샷에서 관찰된 핵심 사항:
- PowerShell 프롬프트 함수 삽입 명령이 Claude Code 콘텐츠와 같은 열에서 줄바꿈됨
- Claude Code 구분선(─────)이 시각적 터미널 너비의 약 65% 지점에서 끝남
- 오른쪽 정렬 상태 텍스트(`medium · /effort`)가 구분선 끝에 맞춰 정렬됨
- 터미널 배경색은 컨테이너 전체 너비를 100% 채움(어두운 회색)

**결론**: PTY의 열(column) 수가 **컨테이너가 표시할 수 있는 것보다 상당히 적다**.

## 3. 실측 DOM 크기 (Playwright)

| 요소 | 너비 (px) | 기대값 | 상태 |
|------|----------|--------|------|
| 뷰포트 | 2560 | — | — |
| 사이드바 | 220 | 220 | 정상 |
| `.content` | 2340 | 2340 (뷰포트 - 사이드바) | 정상 |
| `.workspace-screen` | 2340 | 2340 | 정상 |
| Tab-wrapper | **1170** | **2340** | **50%만 차지** |
| `.terminal-view` | **1170** | 2340 | **50%만 차지** |
| `.terminal-container` | **1170** | 2340 | **50%만 차지** |
| `.xterm-screen` | 1148 | ~2318 (스크롤바 제외) | **50%만 차지** |

## 4. 근본 원인 분석

### 4.1 PTY 초기 크기 = 80열 (하드코딩된 기본값)

```typescript
// server/src/services/SessionManager.ts:41-44
const ptyProcess = pty.spawn(shellCmd, shellArgs, {
  cols: this.runtimePtyConfig.defaultCols,  // 80
  rows: this.runtimePtyConfig.defaultRows,  // 24
});
```

### 4.2 Resize 흐름의 타이밍 취약점

```
[1] 터미널 열림 → term.open(terminalRef.current)
[2] setTimeout(0) → fitAddon.fit() → onResize(cols, rows)
[3] ResizeObserver 발동 → fitAddon.fit() → onResize(cols, rows)
```

- **단계 [2]**: `setTimeout(0)`은 flex 레이아웃 완료 전에 실행될 수 있음
- **단계 [3]**: ResizeObserver와 FitAddon의 측정 대상이 일치하지 않을 수 있음

### 4.3 flex 체인에서 `min-width: 0` 누락

TerminalContainer 외부 div와 `.terminal-view`에 `min-width: 0`이 없어 xterm 캔버스의 intrinsic size가 올바른 축소를 방해할 수 있음.

### 4.4 FitAddon 측정 방식 상세

FitAddon 소스 분석 결과 (`@xterm/addon-fit` v0.11.0):

```typescript
// FitAddon.proposeDimensions() 핵심 로직
const parentStyle = window.getComputedStyle(terminal.element.parentElement);
const parentWidth = parseInt(parentStyle.getPropertyValue('width'));   // parseInt로 소수점 손실
const parentHeight = parseInt(parentStyle.getPropertyValue('height'));

const scrollbarWidth = scrollback > 0 ? 14 : 0;  // 하드코딩된 14px
const availableWidth = parentWidth - paddingHor - scrollbarWidth;
const cols = Math.floor(availableWidth / cellWidth);
```

**주요 발견**:
- `clientWidth`가 아닌 `getComputedStyle().width`를 사용하고 `parseInt`로 파싱 → 소수점 손실
- 스크롤바 너비가 **14px로 하드코딩** — 실제 스크롤바와 다를 수 있음
- `terminal.element.parentElement`를 측정 → 현재 프로젝트에서는 `.terminal-view`

## 5. 제안하는 수정 방안

| 수정 | 내용 | 위험도 | 효과 |
|------|------|--------|------|
| 수정 1 | `setTimeout(0)` → 이중 `requestAnimationFrame` | 낮음 | 높음 |
| 수정 2 | flex 체인 전체에 `min-width: 0` 추가 | 낮음 | 높음 |
| 수정 3 | ResizeObserver 감시 대상 추가 | 낮음 | 중간 |
| 수정 4 | `.terminal-container`에 `width: 100%` 추가 | 낮음 | 낮음 |
| 수정 5 | 500ms 후 1회성 재측정 (안전망) | 낮음 | 중간 |

---

# Part 2: react-mosaic 라이브러리 분석

## 6. react-mosaic 개요

| 항목 | 값 |
|------|-----|
| npm 패키지 | `react-mosaic-component` |
| 최신 안정 버전 | 6.1.1 |
| 최신 프리릴리즈 | 7.0.0-beta0 (2026-03-13) |
| 주간 다운로드 | ~22,400 |
| GitHub 별 | ~4,733 |
| 라이선스 | Apache-2.0 |
| React 호환 | React 16, 17, 18, 19 |

**핵심 개념**: React 기반 **타일링 윈도우 매니저**. VS Code, JetBrains IDE의 패널 시스템과 유사하게, React 컴포넌트를 동적으로 분할/재배치/리사이즈할 수 있다.

### 6.1 레이아웃 모델

| 버전 | 트리 구조 | 설명 |
|------|----------|------|
| v6 (안정) | **이진 트리** | `{ direction, first, second, splitPercentage }` |
| v7 (베타) | **N-ary 트리** | `{ direction, children, splitPercentages }` + 탭 지원 |

```json
// v6 이진 트리 예시
{
  "direction": "row",
  "first": "terminal-1",
  "second": {
    "direction": "column",
    "first": "terminal-2",
    "second": "terminal-3"
  },
  "splitPercentage": 40
}
```

### 6.2 DOM 구조

react-mosaic는 **CSS Grid나 Flexbox가 아닌, absolute positioning + 퍼센트 기반 `top/right/bottom/left`** 를 사용한다:

```html
<div class="mosaic-root">              <!-- position: absolute, 부모를 채움 -->
  <div class="mosaic-tile"             <!-- position: absolute -->
    style="top:0%; right:60%; bottom:0%; left:0%">
    [터미널 A 콘텐츠]
  </div>
  <div class="mosaic-split -row"       <!-- 드래그 가능한 스플리터 바 -->
    style="left:40%">
  </div>
  <div class="mosaic-tile"
    style="top:0%; right:0%; bottom:0%; left:40%">
    [터미널 B 콘텐츠]
  </div>
</div>
```

**핵심 특성**:
- 타일은 `position: absolute`로 배치됨 → 퍼센트 기반 크기
- 스플리터 바: 6px 너비, 마우스/터치 드래그 지원
- 부모 컨테이너에 **반드시 `position: relative`와 명시적 높이/너비** 필요
- `overflow: hidden`이 타일 콘텐츠에 적용됨

### 6.3 리사이즈 메커니즘

| 이벤트 | 발동 시점 | 빈도 |
|--------|----------|------|
| `onChange` | 스플리터 드래그 중 | ~30fps (내부 throttle) |
| `onRelease` | 스플리터 드래그 종료 | 1회 |

- 드래그 중 `onChange`는 **내부적으로 ~30fps(33ms 간격)로 throttle**됨
- 마우스 업 시 `onRelease`가 최종 트리 상태와 함께 1회 발동
- `minimumPaneSizePercentage` 옵션 (기본 10%)으로 최소 패널 크기 제한

### 6.4 v7 베타의 주목할 기능

- **N-ary 트리**: 2개 이상의 자식 패널 지원 (v6은 이진 트리만)
- **탭 노드**: `MosaicTabsNode`로 여러 리프를 탭 인터페이스로 스택
- **주의**: v6 → v7 마이그레이션은 **Breaking Change** (트리 구조 변경)
- **권장**: 프로덕션에는 v6.1.1 사용, v7은 탭 기능 필요 시 모니터링

---

# Part 3: react-mosaic + xterm.js 호환성 심층 분석

## 7. 핵심 질문: 터미널이 자연스럽게 확장/축소되는가?

### 7.1 absolute positioning과 xterm.js의 궁합

**좋음**. react-mosaic의 `position: absolute` + 퍼센트 기반 레이아웃은 xterm.js와 잘 작동한다:

1. 타일이 구체적인 픽셀 크기를 받음 (브라우저가 퍼센트 → 픽셀 변환)
2. xterm.js의 FitAddon이 `getComputedStyle().width`로 측정 가능
3. ResizeObserver가 absolute 포지션 변경으로 인한 크기 변화를 감지함

### 7.2 드래그 리사이즈 중 동작 시나리오

```
사용자가 스플리터 드래그 시작
  ↓
mosaic onChange 발동 (~30fps throttle)
  ↓
React 상태 업데이트 → 타일의 top/right/bottom/left 퍼센트 변경
  ↓
브라우저 레이아웃 재계산
  ↓
ResizeObserver 발동 (각 터미널마다)
  ↓
fitAddon.fit() → getComputedStyle().width → 새 cols/rows 계산
  ↓
terminal.resize(newCols, newRows) → xterm 렌더러 갱신
  ↓
onResize(cols, rows) → sessionApi.resize() → 서버 PTY 리사이즈
```

### 7.3 확인된 문제점과 위험도

| # | 문제 | 위험도 | 설명 |
|---|------|--------|------|
| 1 | **서버 PTY resize 폭주** | **심각** | 4개 터미널 × 30fps = **초당 120회 HTTP POST**. 서버 과부하 및 SIGWINCH 폭주로 터미널 디스플레이 깨질 수 있음 |
| 2 | **fitAddon.fit() 과다 호출** | **중간** | `terminal.resize()`마다 전체 행 재렌더링. 4개 터미널 × 30fps = 초당 120회 전체 재렌더 |
| 3 | **parseInt 소수점 손실** | **낮음** | CSS 전환 중 `"612.5px"` → `parseInt` → `612`. cols가 1 차이로 진동 가능 |
| 4 | **React 재렌더 비용** | **중간** | `onChange`마다 Mosaic 루트 재렌더 → 모든 타일 재렌더. `React.memo` 없으면 비용 증가 |
| 5 | **숨김 타일 문제** | **낮음** | mosaic의 `hide()` 기능이 `display: none`을 사용하면 xterm이 크기를 잘못 계산 |

### 7.4 성능 시뮬레이션

| 시나리오 | 터미널 수 | 드래그 fps | fit() 호출/초 | HTTP resize/초 | 판정 |
|----------|----------|-----------|-------------|---------------|------|
| 탭 모드 전환 | 1 | — | 1 (1회성) | 1 | 안전 |
| 그리드 리사이즈 (현재) | 4 | 없음 | 0 | 0 | 안전 |
| **mosaic 드래그 (디바운스 없음)** | 4 | 30 | **120** | **120** | **위험** |
| **mosaic 드래그 (디바운스 적용)** | 4 | 30 | **30** (rAF) | **4** (100ms) | **안전** |

## 8. 필수 선행 수정 사항

### 8.1 ResizeObserver 콜백에 rAF 스로틀 + 디바운스 적용 (필수)

현재 코드 (문제):
```typescript
// TerminalView.tsx — 현재 (위험)
const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();                        // 매 프레임 호출
  onResize(term.cols, term.rows);        // 매 프레임 HTTP POST
});
```

권장 코드:
```typescript
// TerminalView.tsx — 개선안
let rafId: number | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

const resizeObserver = new ResizeObserver(() => {
  // 1) fit()은 rAF로 스로틀 → 프레임당 최대 1회
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    fitAddon.fit();
    rafId = null;

    // 2) 서버 PTY resize는 100ms 디바운스 → 드래그 멈춘 후 1회만
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      onResize(term.cols, term.rows);
      resizeTimer = null;
    }, 100);
  });
});
```

**효과**:
- `fitAddon.fit()`: 60fps → rAF 기반 최대 60fps (시각적 즉시 반영)
- `onResize()` (HTTP POST): 드래그 중 0회, 멈춘 후 100ms 뒤 1회

### 8.2 초기 fit에 이중 requestAnimationFrame 적용 (필수)

```typescript
// 변경 전
setTimeout(() => { fitAddon.fit(); onResize(term.cols, term.rows); }, 0);

// 변경 후
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    fitAddon.fit();
    onResize(term.cols, term.rows);
    term.focus();
  });
});
```

### 8.3 flex 체인에 min-width: 0 추가 (필수)

```css
.terminal-view { min-width: 0; }
.terminal-container { min-width: 0; }
```
```tsx
// TerminalContainer.tsx
<div style={{ display: 'flex', flex: 1, minWidth: 0 }}>
```

### 8.4 타일 콘텐츠 React.memo 적용 (권장)

```tsx
// mosaic의 renderTile에서 반환하는 터미널 컴포넌트를 memo로 감싸기
const MemoizedTerminalContainer = React.memo(TerminalContainer);
```

### 8.5 window.resize 리스너 제거 (권장)

ResizeObserver가 이미 모든 크기 변화를 감지하므로 `window.addEventListener('resize', ...)` 는 중복됨. 제거하여 이중 호출 방지.

## 9. react-mosaic 도입 시 구현 가이드

### 9.1 필요한 패키지

```bash
npm install react-mosaic-component@6.1.1
# Blueprint.js는 선택사항 — 커스텀 다크 테마 사용 시 불필요
```

### 9.2 Mosaic 호스트 컨테이너 요구사항

```tsx
// 부모에 반드시 position: relative + 명시적 높이 필요
<div style={{ position: 'relative', width: '100%', height: '100%' }}>
  <Mosaic<string>
    renderTile={(id, path) => <MemoizedTerminalTile id={id} />}
    value={mosaicTree}
    onChange={setMosaicTree}
    onRelease={setMosaicTree}
    className="" // Blueprint 테마 비활성화
  />
</div>
```

### 9.3 기존 GridContainer와의 비교

| 항목 | 현재 GridContainer | react-mosaic |
|------|-------------------|--------------|
| 레이아웃 | CSS Grid (`repeat(N, 1fr)`) | absolute + 퍼센트 |
| 리사이즈 | 불가 (자동 균등 분할) | **스플리터 드래그** |
| 셀 순서 변경 | 미지원 | **드래그 앤 드롭** |
| 분할/병합 | 미지원 | **동적 분할/제거** |
| 최소 크기 | 없음 | `minimumPaneSizePercentage` |
| 셀 크기 기억 | gridLayout.cellSizes | 트리 구조에 포함 |

## 10. 결론 및 권장사항

### 즉시 적용 (현재 터미널 너비 문제 해결)

1. **이중 rAF** + **min-width: 0** + **ResizeObserver 대상 확인** → 현재 너비 문제 해결

### 다음 스프린트 (react-mosaic 도입 전 필수)

2. **ResizeObserver 콜백에 rAF 스로틀 + 디바운스** → 서버 과부하 방지
3. **window.resize 리스너 제거** → 중복 호출 제거
4. **TerminalContainer React.memo** → 불필요한 재렌더 방지

### react-mosaic 도입 판단

| 판단 | 근거 |
|------|------|
| **도입 가능** | xterm.js + FitAddon과 기술적으로 호환됨 |
| **조건부** | 위 필수 수정 사항 (8.1~8.3) 적용 후에만 안전 |
| **버전 권장** | v6.1.1 (안정) 사용, v7 베타는 탭 기능 필요 시 모니터링 |
| **성능 안전** | 터미널 8개 이내에서는 디바운스 적용 시 문제 없음 |

---

## 검증 방법

```javascript
// 브라우저 콘솔에서 실행하여 확인:
const term = document.querySelector('.terminal-container');
const screen = document.querySelector('.xterm-screen');
console.log('컨테이너 너비:', term.clientWidth);
console.log('스크린 너비:', screen.clientWidth);
console.log('기대 열 수:', Math.floor((term.clientWidth - 14) / 8.4));
```
