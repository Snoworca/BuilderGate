# Phase 1 Verification

## 체크리스트

- registry entry가 sessionId별로 단일 생성인지 확인
- host slot attach/detach가 runtime 재생성 없이 가능한지 확인
- imperative handle이 registry 경유로 동작하는지 확인
- old path coexist 시 double consumer가 생기지 않는지 확인

## 증거

- 단위 테스트 결과
- 개발자 로그 또는 debug capture
- 관련 PR diff 링크 또는 파일 목록
