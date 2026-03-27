# 완료 보고서

## 1. 요약
| 항목 | 값 |
|------|-----|
| 프로젝트 | BuilderGate |
| 계획 문서 | plan.2026-03-27_fix-terminal-double-mount.md |
| 총 Phase 수 | 3 |
| 완료된 Phase | 3 |
| 빌드 검증 | `tsc --noEmit` 통과 (frontend + server) |

## 2. 테스트 결과
| 항목 | 결과 |
|------|------|
| 빌드 성공 | ✅ frontend `tsc --noEmit` 에러 없음 |
| 영문 입력 이중 표시 | ✅ 없음 — `echo TEST_SINGLE` 정상 출력 |
| 커서 개수 | ✅ 1개 (Playwright 스크린샷 확인) |
| DisconnectedOverlay 잔상 | ✅ 없음 — 한 겹만 표시 |
| 한글 IME 이중 표시 | ⏳ Playwright로 composition 시뮬 불가 — 수동 테스트 필요 |

## 3. 변경 파일 목록
| 파일 | 변경 내용 |
|------|-----------|
| `frontend/src/contexts/WebSocketContext.tsx` | `subscribeSession` cleanup에서 핸들러 identity 체크 추가. 자기가 등록한 핸들러인 경우에만 구독 해제 |
| `frontend/src/App.tsx` | `renderTerminal`에서 DisconnectedOverlay 이중 렌더링 제거 (GridCell이 이미 처리) |

## 4. 선행 구현 확인 (이미 적용되어 있던 항목)
| Phase 항목 | 상태 | 설명 |
|-----------|------|------|
| Phase 1-1: key prefix 통일 | ✅ 이미 적용 | 그리드/탭 모두 `ws-` prefix 사용 중 |
| Phase 2-1: WS 중복 구독 방지 | ✅ 이미 적용 | `alreadySubscribed` 체크 존재 |
| Phase 3-1: TerminalContainer memo | ✅ 이미 적용 | `propsAreEqual` 커스텀 비교 함수 |
| Phase 3-2: 콜백 ref 패턴 | ✅ 이미 적용 | `onStatusChangeRef`, `onCwdChangeRef` |
| Phase 3-3: useEffect 의존성 최적화 | ✅ 이미 적용 | `[sessionId, ws]`만 의존 |

## 5. 신규 수정 (이번 작업)
1. **WS 구독 cleanup 핸들러 identity 체크**: 그리드↔탭 전환 시 구(old) 인스턴스의 cleanup이 신(new) 인스턴스의 핸들러를 삭제하는 레이스 컨디션 방지
2. **DisconnectedOverlay 이중 렌더링 제거**: App.tsx `renderTerminal()`에서 overlay 제거 (GridCell이 처리)

## 6. Phase별 평가 점수
| Phase | 제목 | 최종 점수 | 비고 |
|-------|------|-----------|------|
| 1 | key prefix 통일 | 이미 적용 | 변경 불필요 |
| 2 | WS 구독 중복 방지 | 90점 | cleanup identity 체크 추가 |
| 3 | 콜백 안정화 | 이미 적용 | 변경 불필요 |

> 이 점수는 lite 기준(90점/4기준/2인)이며, plan-driven-coder-v2 기준과 직접 비교할 수 없습니다.
