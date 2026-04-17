# 통합 테스트 가이드

## 자동 테스트

1. `frontend`: `npm run build`
2. `server`: `npm test`
3. Playwright:
   - hidden workspace recovery
   - restart lineage invalidation
   - unchanged geometry toggle
   - stale mosaic layout recovery
   - tab/grid runtime reuse
   - pending replay token host reassignment

## 수동 테스트

### 시나리오 A. PowerShell 기본 입력

1. PowerShell 세션 생성
2. 빠르게 문자열 입력 후 Enter
3. 출력 겹침, 검은 화면, focus 손실이 없는지 확인

### 시나리오 B. Codex 세로 출력

1. 세션에서 `codex` 실행
2. `1부터 500까지 종 방향으로 출력해줘` 입력
3. 출력 도중 다른 workspace로 이동
4. 다시 돌아오기
5. tab mode와 grid mode를 왕복
6. 새로고침 후 다시 확인

검증 포인트:

- 검은 화면 대기 시간이 비정상적으로 길지 않은가
- 전체 또는 일부 duplicate 출력이 생기지 않는가
- blank gap이 커지지 않는가
- scrollback이 유지되는가
- runtime recreate count가 증가하지 않는가
- sessionId당 subscribe count가 비정상적으로 늘지 않는가

### 시나리오 C. Workspace-2 grid recovery

1. `Workspace-2` 진입
2. grid mode 전환
3. stale layout에서도 현재 탭 수만큼 pane이 복구되는지 확인

### 시나리오 D. Restart/Delete lifecycle

1. tab restart
2. workspace delete
3. orphan cleanup 유발 경로

검증 포인트:

- zombie runtime이 남지 않는가
- old session 출력이 새 runtime에 섞이지 않는가

## 관측 지표

최소 확인 대상:

- sessionId당 live consumer 수
- host slot 미부착 runtime 수
- restart 후 orphan runtime 수
- replay ack age
- tab/grid 전환 중 runtime recreate count
- sessionId당 subscribe count
- host attach count
