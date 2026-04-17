# Phase 1 검증 문서

## 완료 체크리스트

- [ ] `@xterm/headless` PoC 통과
- [ ] serializer facade 확정
- [ ] snapshot payload 스키마 문서화
- [ ] metrics/fallback 플래그 정의

## 품질 게이트

- 정상 shell, resize, alt-screen, failure fallback, 긴 scrollback 시나리오 모두 재현 가능
- snapshot bytes 와 serialize ms 수집 가능

## 승인 기준

- [ ] PoC 결과가 다음 phase 입력으로 충분하다
- [ ] `@xterm/headless` 사용 지속 여부를 판단할 데이터가 있다
