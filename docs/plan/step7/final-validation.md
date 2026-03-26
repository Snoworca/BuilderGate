# Final Validation — Step 7: CMUX-Style Workspace Pivot

## SRS 인수 조건 체크리스트 (AC 전체)

### AC-701: Workspace 관리
- [ ] Workspace 생성 → 빈 상태
- [ ] Workspace 전환 → PTY 유지
- [ ] Workspace 삭제 → PTY 종료
- [ ] 이름/순서 변경 → 서버 반영
- [ ] 마지막 Workspace 삭제 불가
- [ ] 최대 10개 초과 차단

### AC-702: 탭 시스템
- [ ] 탭 추가 → 8색 순서 할당
- [ ] 9번째 탭 차단
- [ ] 롱프레스 드래그 순서 변경
- [ ] 색상 일관성 (TabBar = Grid = MetadataBar)
- [ ] 활성 탭 닫기 → 우측 인접 활성화
- [ ] 마지막 탭 닫기 → 빈 상태 UI
- [ ] 탭 이름 더블클릭 인라인 편집

### AC-703: Tab/Grid 모드
- [ ] 데스크톱 탭/그리드 전환
- [ ] 모바일 전환 숨김 (항상 탭)
- [ ] Grid 자동 격자 배치
- [ ] 셀 경계 드래그 리사이즈
- [ ] 그리드 드래그 위치 교환
- [ ] 빈 셀 + 아이콘 → 탭 추가
- [ ] 윈도우 리사이즈 대응

### AC-704: 에이전트 상태
- [ ] running → 초록 테두리 + breathing
- [ ] idle → 효과 제거
- [ ] prefers-reduced-motion → 정적 테두리
- [ ] Workspace 뱃지 정확

### AC-705: 메타데이터 바
- [ ] 탭별 이름, 라벨, 경과시간, 복사
- [ ] CWD 복사 동작
- [ ] 경과시간 실시간 갱신

### AC-706: 서버 상태 저장
- [ ] 새로고침 복원
- [ ] 크로스 디바이스 동일
- [ ] IndexedDB 코드 제거
- [ ] 서버 재시작 → disconnected + 재시작
- [ ] 재시작 → 새 PTY 복구
- [ ] JSON 손상 → 백업 복구

### AC-707: 레거시 제거
- [ ] SplitPane 제거
- [ ] 파일 뷰어 제거
- [ ] Prefix Mode 제거

### AC-708: 에지 케이스
- [ ] PTY 크래시 → 에러 오버레이 + 재시작
- [ ] 네트워크 단절 → 배너 + 재연결
- [ ] 전체 PTY 32개 → 추가 차단

## 빌드 검증
- [ ] `server: tsc --noEmit` 에러 0
- [ ] `frontend: tsc --noEmit` 에러 0
- [ ] `frontend: npm run build` 성공
- [ ] 서버 시작 → `/health` 정상 응답
- [ ] 브라우저 접속 → 로그인 → Workspace 표시
