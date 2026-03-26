# Integration Test Guide — Step 7: CMUX-Style Workspace Pivot

## E2E 테스트 시나리오

### 시나리오 1: 전체 워크플로우
1. 앱 접속 → 기본 Workspace 1개 존재 (빈 상태)
2. 터미널 탭 추가 (PowerShell) → TabBar에 Blue 탭 표시
3. 터미널에서 `echo hello` → 출력 확인 → running 상태 → 초록 breathing
4. idle 전환 대기 → breathing 효과 제거
5. 탭 2개 더 추가 (Emerald, Amber)
6. Grid Mode 전환 → 2×2 격자 확인
7. 셀 경계 드래그 리사이즈 → 크기 변경 반영
8. Tab Mode 전환 → 단일 터미널 표시
9. Metadata Bar 확인 → 3줄, 경과 시간 증가
10. CWD 복사 → 클립보드 확인
11. 브라우저 새로고침 → 전체 레이아웃 복원

### 시나리오 2: 멀티 Workspace
1. Workspace 2개 생성 (WS-1, WS-2)
2. WS-1에 탭 3개, WS-2에 탭 2개
3. WS-1 ↔ WS-2 전환 → 각각 독립 상태 유지
4. WS-2에서 에이전트 실행 → WS-1 사이드바에서 WS-2 뱃지 확인
5. WS-1 삭제 → 확인 모달 → 3개 PTY 종료

### 시나리오 3: 크로스 디바이스
1. 브라우저 A에서 Workspace + 탭 생성
2. 브라우저 B에서 접속 → 동일 레이아웃 확인
3. 브라우저 A에서 탭 추가 → 브라우저 B에 SSE로 반영

### 시나리오 4: 서버 재시작
1. Workspace 2개, 총 탭 5개 상태
2. 서버 재시작
3. 클라이언트 재접속 → Workspace/탭 레이아웃 복원
4. 모든 탭 disconnected → 재시작 버튼 표시
5. 재시작 클릭 → 새 PTY 생성, 정상 동작

### 시나리오 5: 모바일
1. 320px 뷰포트에서 접속
2. 햄버거 버튼 → 드로어 열림
3. Workspace 선택 → 드로어 닫힘
4. 탭 전환 (Tab Mode만, Grid 토글 없음)
5. 좌측 스와이프 → 드로어 열림

### 시나리오 6: 제한값
1. Workspace 10개 생성 → 11번째 차단
2. 탭 8개 생성 → 9번째 차단
3. 전체 PTY 32개 도달 → 모든 Workspace에서 탭 추가 차단

## 빌드 검증

```bash
# 서버
cd server && npx tsc --noEmit

# 프론트엔드
cd frontend && npx tsc --noEmit && npm run build

# Lint (있는 경우)
npm run lint
```
